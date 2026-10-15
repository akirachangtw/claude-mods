# Context Bar × Progress Status Host 實作規格

## 執行指令

本規格交由 Claude Opus 5.5 實作。請先讀取公開 repository `akirachangtw/claude-mods` 的 `main/context-bar` 全部原始碼、現有測試及最新提交，再執行重構。不得依本文件示意檔名臆測現況，也不得為符合示意結構而搬動已可運作的檔案。先產出現況盤點與變更計畫，確認後才修改。

目標不是把另一條 progress bar 粗暴塞入 context reducer，而是將現有 plugin 重構為「單一 Status Host renderer + 獨立 Context provider + 獨立 Progress provider」。兩者共用 AbovePrompt 的排版、主題與動畫協調層，但保持各自狀態、事件與測試邊界。Claude Code Mod 可以透過 `ui.render` 在 AbovePrompt 繪製 UI；相關程式運行於 Claude Code runtime 內，應避免不必要的全樹重繪。

## 成功定義

完成後必須達成：

- Progress 位於 Context Bar 上方，兩者屬於同一個整合面板，不再重疊或緊貼。
- Progress 正式百分比只由 workflow 的 stage/checkpoint 推進。
- 工具呼叫與 Subagent 活動只能推動 buffer 和 liveness，不能偽造 committed progress。
- `ticket-author` 取票、執行 ticket 與 RGR 都能使用同一事件契約。
- 長 Bash、Agent 或 MCP 呼叫期間即使百分比不變，仍能透過 activity、elapsed time 與 mascot 呈現存活狀態。
- Desktop 使用動畫 mascot；Terminal 提供可讀且穩定的 fallback。
- plugin reload、重複事件、延遲事件與 RGR rerun 不會造成進度倒退或重複提交。
- 不新增模型呼叫，不用 LLM 猜測進度，不修改原有 context 統計語意。

## 非目標

- 不以工具呼叫數估算真實百分比。
- 不提供 ETA，除非未來有真實歷史資料與可驗證模型。
- 不把 context 與 progress 合併成同一 reducer。
- 不要求所有 workflow 固定七步。
- 不因視覺重構改動 ticket-author、RGR 或執行票的業務判定規則。
- 不直接複製第三方或官方角色圖像；使用原創像素小貓或既有合法資產。

## 先行取證

實作前必須輸出：

1. `context-bar` 完整檔案樹。
2. plugin manifest 與 hooks module 的實際入口。
3. 所有 `ui.render`、AbovePrompt、Svg、Client、timer、tool hook、progress tool 與 state reducer 位置。
4. 現有 Context snapshot 與 Progress 型別。
5. 現有 22 個測試的名稱與覆蓋行為。
6. 目前兩條 bar 為何重疊、目前 85% 步內推進在哪裡計算、哪些事件會 invalidate UI。
7. Desktop 與 Terminal renderer 的分支位置。

若 repository 現況與本規格假設不同，以實際程式為準，但仍需維持下述語意與驗收條件。

## 目標架構

```text
StatusHost
├── ContextProvider
│   ├── context snapshot reducer
│   ├── usage / category selectors
│   └── context row renderer
├── ProgressProvider
│   ├── progress event normalizer
│   ├── three-layer reducer
│   ├── workflow registry
│   └── progress card renderer
├── RenderCoordinator
│   ├── primary run selection
│   ├── responsive layout
│   ├── Desktop / Terminal adapter
│   └── render invalidation scheduler
└── Commands / Tools
    ├── progress event tool
    ├── /progress
    └── mascot / motion settings
```

Status Host 是唯一 AbovePrompt renderer。ContextProvider 不知道 ProgressProvider 的內部狀態，ProgressProvider 也不得讀寫 context snapshot；RenderCoordinator 只組合 view model。Context bar 類 mod 的核心價值是本機估算 context 組成並在 prompt 上方呈現，不需額外模型請求，因此重構後也應維持此特性。

## 三層模型

### Committed

Committed 是唯一可信的完成度來源，只能由以下事件改動：

- workflow start 時建立 stage manifest。
- stage 明確完成。
- checkpoint 明確完成。
- 預先宣告的 child work unit 完成。
- workflow complete。

Committed 必須單調不減。重複 checkpoint 必須 idempotent；舊 sequence、未知 run 或已結束 run 的事件不得改動狀態。

### Buffer

Buffer 表示目前 stage 中「正在發生但尚未提交」的活動範圍：

- tool start / end。
- Read、Bash、Agent、MCP 活動。
- Subagent 執行。
- 已知 child work unit 的 running 狀態。

Buffer 可以在 committed 末端向前延伸，但不可跨過目前 stage 的 committed ceiling，也不可改變畫面上的正式百分比、done/total 或已完成 checkpoint 數。現有「每次工具呼叫推進、最多到下一步 85%」邏輯應改造成純視覺 buffer；buffer 是 determinate progress 的補充層，而非已完成工作。

### Liveness

Liveness 表示執行狀態，而不是完成度：

```ts
type LivenessStatus =
  | "queued"
  | "running"
  | "waiting-tool"
  | "waiting-user"
  | "paused"
  | "stale"
  | "completed"
  | "failed"
  | "cancelled"
  | "orphaned";
```

Liveness 保存 current activity、active tool count、active child count、last event time、elapsed time、pause reason 與 error summary。長時間單一 tool call 不得自行增加 committed；只更新 elapsed、activity 文字與 mascot 狀態。

## 狀態型別

以下是語意要求，不強制沿用檔名或逐字型別；若現有型別已成熟，應以相容方式擴充。

```ts
type RunId = string;
type WorkflowId = string;
type StageId = string;
type CheckpointId = string;

type WorkflowManifest = {
  id: WorkflowId;
  label: string;
  version: number;
  stages: StageDefinition[];
};

type StageDefinition = {
  id: StageId;
  label: string;
  weight: number;
  checkpoints?: CheckpointDefinition[];
  childUnits?: ChildUnitDefinition[];
};

type ProgressEvent = {
  runId: RunId;
  workflowId: WorkflowId;
  manifestVersion: number;
  sequence: number;
  timestamp: string;
  sourceSessionId?: string;
  actor?: "main" | "subagent" | "tool" | "system";
  type:
    | "run.started"
    | "stage.started"
    | "checkpoint.completed"
    | "child.started"
    | "child.completed"
    | "activity.started"
    | "activity.completed"
    | "run.waiting"
    | "run.paused"
    | "run.resumed"
    | "run.completed"
    | "run.failed"
    | "run.cancelled"
    | "heartbeat";
  stageId?: StageId;
  checkpointId?: CheckpointId;
  childUnitId?: string;
  activityId?: string;
  message?: string;
  metadata?: Record<string, unknown>;
};

type ProgressRunState = {
  runId: RunId;
  workflowId: WorkflowId;
  manifestVersion: number;
  lastSequence: number;
  status: LivenessStatus;
  committed: {
    completedStages: StageId[];
    completedCheckpoints: Record<StageId, CheckpointId[]>;
    completedChildUnits: Record<StageId, string[]>;
    percent: number;
  };
  buffer: {
    visualPercent: number;
    activeActivities: Record<string, ActivityState>;
  };
  liveness: {
    currentMessage?: string;
    activeToolCount: number;
    activeChildCount: number;
    startedAt: string;
    lastEventAt: string;
    waitingSince?: string;
    errorSummary?: string;
  };
};
```

所有 manifest stage weight 總和須正規化為 100。Committed percent 由 reducer 計算，事件不得直接傳入任意 percentage 覆蓋值。

## Reducer 規則

1. 對每個 `runId` 保存 `lastSequence`；`sequence <= lastSequence` 的非冪等事件直接忽略並記錄 diagnostic。
2. `checkpoint.completed` 以 `stageId + checkpointId` 去重。
3. stage 或 checkpoint 不得倒退；跨 stage 跳報時，不得自動假定中間 checkpoint 已完成。
4. 如果收到 `1/7 → 5/7` 類 legacy 回報，正式 committed 只更新可證實的 stage，並建立 `protocolViolation: missing-checkpoints` diagnostic；不得用動畫假裝中間步驟逐一完成。
5. tool call 只建立/結束 activity；它不能改變 committed。
6. Subagent activity 只更新 liveness/buffer；只有預先宣告的 child unit 完成才提交該 unit 權重。
7. 同一 stage 內重複回報不能讓 buffer 或 committed 往回跳。
8. `run.completed` 只有在必要 stage 已完成時才設為 100%；否則標記 inconsistent completion，UI 顯示 completed-with-warning 或 failed validation。
9. failed/cancelled 不應清除已 committed 的歷史值。
10. plugin reload 後應從現有持久狀態或可重建事件恢復；不得重複 start 或重新提交 checkpoint。

## 百分比計算

Stage 不是平均權重。Overall committed percent 應使用 manifest weight：

```ts
committedPercent =
  completedStageWeight +
  currentStageWeight * verifiedFractionWithinCurrentStage;
```

`verifiedFractionWithinCurrentStage` 只能由已完成 checkpoint 或 child unit 計算。若 stage 沒有可量化 checkpoint，該 stage 在完成前不增加 committed percent，UI 改用 activity buffer、elapsed time 和狀態文字表達進行中。

如果現有 workflow 只能提供 `done/total`，先建立 legacy adapter，將每個 done 視為 stage completion；但工具呼叫仍不得補足中間 committed。後續再逐步把 Skill 改成 checkpoint 事件。

## Workflow Registry

### Ticket Author

先從既有 Skill 實際程序萃取 stage，不要盲目照抄以下範例；最低要求是將長時間證據工作與 RGR 分離：

| Stage | 建議權重 | 最低 checkpoint |
|---|---:|---|
| bootstrap | 8 | 模板與規範載入完成 |
| intake | 7 | Parent／Review Note 解析完成 |
| evidence | 24 | 來源定位、承重來源抽驗、衝突裁決 |
| mapping | 12 | 主張、依賴與交付物映射完成 |
| draft | 22 | Ticket 草稿完成 |
| rgr | 22 | Review／Repair／Rerun 通過 |
| finalize | 5 | 驗證與正式寫入完成 |

### Execution Ticket

Stage 應從票面 phase、acceptance criteria 或執行計畫建立，而不是固定套用 Ticket Author 的七步。若票面沒有 manifest，啟動時建立 run-specific manifest，之後不可在無版本升級的情況下任意改權重。

最低 stage 建議：load、plan、implement、verify、finalize。大型票可由票面 checkpoint 取代這組 fallback。

### RGR

RGR 是可重入子狀態機，不是固定線性 step：

```text
review → repair → rerun → repair → rerun → passed
                         └──────────────→ needs-user
```

父 workflow 將 RGR 視為單一 stage；子 view 顯示 round、findings 與修復數。新增 round 不得讓父 committed 倒退。

RGR view model 至少包含：

```ts
type RgrState = {
  round: number;
  maxRounds: number;
  phase: "review" | "repair" | "rerun" | "passed" | "needs-user";
  findingsTotal?: number;
  findingsRepaired?: number;
};
```

## Progress Tool 契約

優先提供單一事件入口，而不是多個彼此難以排序的工具：

```ts
progress.emit(event: ProgressEvent): Result
```

為相容現有 Skill，可提供 helper wrapper：

```ts
progress.start(...)
progress.stage(...)
progress.checkpoint(...)
progress.activity(...)
progress.wait(...)
progress.complete(...)
progress.fail(...)
```

Wrapper 最終都轉成 `progress.emit`。工具回傳應包含 accepted/ignored、目前 sequence、diagnostic code 與新的 committed percent，方便 Skill 發現錯序或重複回報。

不得把 progress tool 暴露成可執行任意檔案、shell 或網路請求的接口。

## Skill Progress Contract

在 `ticket-author`、執行票流程和 RGR 的正式 Skill 指令內加入：

```markdown
## Progress Contract

開始工作後立即建立唯一 runId，呼叫 progress.start。
進入 stage 前呼叫 progress.stage，再執行該 stage 工具。
完成已定義 checkpoint 時立即呼叫 progress.checkpoint；禁止累積多個 checkpoint 後一次補報。
工具呼叫不能代替 checkpoint，且不得自行估算百分比。
等待使用者、失敗、取消與完成時必須回報對應終止狀態。
RGR rerun 保持同一父 runId，使用 round metadata，不建立假步驟。
```

若 Skill 忘記回報，Mod 只顯示 active/stale，不得自行把工具活動轉換成 committed。

## Status Host UI

Status Host 在 AbovePrompt 只畫一張整合卡。Context-bar 類工具一般用一條滿寬 stacked bar 顯示 context 類別，並能在主要 turn 或 compaction 後更新；這個資訊架構應保留，但放在 Progress 下方。

Desktop 建議版型：

```text
┌──────────────────────────────────────────────────────────────┐
│ ● TICKET AUTHOR  抽驗承重來源                   3/7 · 41% │
│ ━━━━━━━━━━━━━━━━━━━━━━━━▓▓▓▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒ │
│                         [cat]  2 agents · 38s              │
│ ─────────────────────────────────────────────────────────── │
│ Context 62K / 200K · 31%             Compact at 78%       │
│ [existing stacked context-category bar]                    │
└──────────────────────────────────────────────────────────────┘
```

UI 規則：

- Progress 永遠在 Context 上方。
- 兩區以至少一個 spacing token或低對比 divider 分隔。
- Header 左側：status dot、workflow label、current stage。
- Header 右側：stage count 與 committed percent。
- 實色 fill 表示 committed；淡色或斜紋 extension 表示 buffer。
- Buffer 的終點不得覆蓋 committed 數值語意。
- 沒有 active run 時只呈現 context 區，不保留空 progress 高度。
- completed 保留約 2 秒後淡出；failed 持續顯示直到關閉或 retry。
- 多個 run 同時活動時，AbovePrompt 只顯示 primary run；額外 run 顯示 `+N background`，詳細內容放 `/progress` Pane。
- 80-column Terminal 不得截斷核心狀態；優先縮短 message，再隱藏非必要 metadata。

## Primary Run 選擇

順序建議：

1. waiting-user / failed，需要立即注意者。
2. 最近收到 committed event 的 foreground run。
3. 最近收到使用者啟動的主 run。
4. 最近 active 的 background run。

切換 primary run 時須保持穩定，避免每個 Subagent event 都讓畫面跳來跳去。至少設置短暫黏著時間，除非更高優先狀態出現。

## 動畫與吉祥物

第一版使用原創像素小貓，提供設定：

```text
/progress mascot cat|minimal|off
/progress motion full|reduced|off
```

狀態動畫：

| Liveness | 動作 |
|---|---|
| running | 沿 buffer 區小跑，尾巴擺動 |
| waiting-tool | 原地踏步或望向前方 |
| waiting-user | 坐下看向使用者 |
| paused | 坐下舔手 |
| completed | 小跳一次後停下 |
| failed | 停下、耳朵垂下 |
| stale | 睡著，旁邊顯示最後活動時間 |

吉祥物只表達 liveness，不表示精確完成度。它可在 committed 終點至 buffer 終點之間活動，但不能越過 buffer ceiling。

Desktop 可使用支援的 Svg/Client 能力；Terminal 使用穩定文字 fallback。不要為動畫每幀呼叫整個 `ui.render`。狀態或 committed/buffer view model 改變時才 invalidate；高頻 tool event 以 250–500ms 合併更新。Claude Code Mods API 可執行 timer、加入工具與命令，但應把動畫留在 UI 端，避免高頻 runtime 工作。

若 SVG tree 在 invalidate 後會重建並重置動畫，需改為：

- 使用穩定 key/identity。
- 動畫時間從 run start 或 liveness state start 計算。
- 或改用 Client / 局部繪製。
- 禁止以提高 invalidate 頻率掩蓋重置問題。

## Render Scheduler

建立集中式 scheduler：

- committed、status、primary-run 變化：立即 render。
- activity start/end：合併至最多每 250ms 一次。
- elapsed time：最多每秒更新一次，Terminal 可更低頻。
- 純 mascot 動畫：UI 端自行播放，不觸發 reducer。
- context snapshot：維持原有更新時機，不因 progress heartbeat 重算。
- progress 事件不得觸發昂貴的 context breakdown 計算；context 更新也不得重建 progress reducer。

## 暫停、等待與失聯

- `waiting-tool`：保持到 tool completion；不以固定時間刪除。
- `waiting-user`：保持到下一個 prompt、resume 或 cancel。
- `paused`：保持且可摺疊，不因無關 tool call 恢復。
- `stale`：預設 120 秒無有效事件後轉灰，但不立即刪除。
- `orphaned`：reload 後恢復到 state，但找不到 owner/runtime activity 時使用。
- `completed`：短暫保留後淡出。
- `failed`：持續顯示，直到 retry、dismiss 或新 run 取代。

Heartbeat 只能更新 `lastEventAt`，不能解除 paused/waiting-user 或提交進度。

## 相容與遷移

1. 保留現有 `/context-bar` 命令與設定行為。
2. 如果已有 `progress(done,total)` 工具，先保留 legacy adapter，標記 deprecated。
3. 舊事件轉成 legacy stage completion；不得把舊工具呼叫推進當 committed。
4. 不破壞現有 context 類別、配色、compact marker 與 token 計算。
5. 不因重構更改 plugin name 或安裝方式，除非 manifest migration 有明確必要。
6. 任何 state schema 變更需有版本號與 migration；migration 失敗時安全退回空 progress，而不能破壞 context bar。

## Diagnostics

提供 `/progress` Pane 或 command，至少顯示：

- active/completed/failed runs。
- runId、workflow、manifest version、last sequence。
- committed percent、current stage、completed checkpoints。
- active tools/children、last event age。
- ignored duplicate/stale events。
- protocol violations。
- renderer surface 與 motion/mascot 設定。

另提供 debug mode，但預設關閉；不得把完整 ticket、prompt 或敏感 tool arguments寫入 log。

## 測試要求

保留所有既有測試並新增以下測試；不得只更新 snapshot 讓錯誤通過。

### Reducer

1. `0/7` 後 20 次 tool call：committed 不變，buffer/liveness 更新。
2. 重複 checkpoint：idempotent。
3. 舊 sequence 晚到：忽略且不倒退。
4. legacy `1/7 → 5/7`：記錄 protocol violation，不補造中間 checkpoint。
5. Subagent tool call：只更新 buffer/liveness。
6. 宣告 child unit 完成：只提交該 child weight。
7. RGR 第二輪：父 committed 不倒退。
8. `run.completed` 但必要 stage 缺失：不可靜默設為 100%。
9. failed/cancelled 保留已 committed 值。
10. reload 恢復不重複 start/checkpoint。

### Liveness

11. 長 Bash 三分鐘：percent 不變、elapsed 增長、狀態為 waiting-tool。
12. paused 不因無關 tool call 恢復。
13. heartbeat 不解除 waiting-user。
14. stale TTL 後轉 stale，不立即移除。
15. completed 淡出與 failed 持續顯示的 policy。

### UI

16. Progress 位於 Context 上方。
17. 兩區不重疊，存在 divider/spacing。
18. Desktop 顯示 committed、buffer、mascot。
19. Terminal 不輸出空 Svg，使用文字 fallback。
20. 80、120、160 columns snapshot。
21. 無 active run 時不保留空白 progress 區。
22. 多 run 時只顯示 primary 與 `+N background`。
23. animation identity 在 activity update 後不重置。
24. motion off/reduced 時使用靜態 mascot。
25. context update 不改變 progress reducer；progress heartbeat 不重算 context。

### Property / mutation

- committed percent 永遠介於 0–100，且在正常 run 中單調不減。
- buffer visual percent 不小於 committed，且不超過 stage ceiling。
- 任意重複事件序列不得改變最終 committed 結果。
- 交換兩個無依賴 activity event 的順序，不得改變 committed。
- mutation test 必須能抓到 sequence guard、checkpoint dedupe、paused guard 與 buffer ceiling 被移除。

## 驗收場景

### Ticket Author

- 啟動顯示 `0/7` 或 manifest 的首 stage。
- 連續 Read/Bash 時 committed 不動，但 buffer 有活動、小貓 running、elapsed 增長。
- 每個 checkpoint 完成後 committed 平滑移至新值。
- 不再出現停在 `1/7` 很久後因工具呼叫突然假跳到 `5/7`。

### RGR

- 顯示 `RGR · Round 1/3 · Reviewing`。
- 進入 repair 時更新 phase/findings，不使父進度倒退。
- rerun 顯示新 round，父 stage 保持同一位置。
- passed 後才提交 RGR stage。

### 長工具

- 單一 Bash/Agent 長時間執行時，畫面顯示 `waiting-tool`、工具名稱與 elapsed。
- 吉祥物維持 waiting-tool 動作。
- 不製造虛假百分比。

### 多 run

- foreground ticket-author 顯示在 AbovePrompt。
- background Subagent/RGR 收在 `+N background`。
- waiting-user 或 failed run 可提升優先權，但切換不閃爍。

## 實作交付

完成時需提供：

1. 現況分析與 root cause。
2. 修改檔案清單及各檔目的。
3. reducer 與事件契約說明。
4. workflow manifests。
5. Desktop 與 Terminal 的 before/after 截圖或 render snapshot。
6. 全部測試結果與 mutation 結果。
7. 未解風險，尤其是 Desktop SVG 動畫重置、reload persistence 與 Skill 漏報。
8. 手動驗證步驟：`/reload-plugins` 後依序示範 Ticket Author、RGR、長 tool call 與多 run。

不得只回報「測試通過」；必須說明 committed、buffer、liveness 各自如何從事件得到、哪些事件被忽略，以及如何證明工具呼叫不再改變正式百分比。

## 實作優先級

### P0：可信度

- 三層 reducer。
- sequence、dedupe、monotonicity。
- 工具呼叫不再改 committed。
- legacy adapter 與 diagnostics。

### P1：Workflow

- Ticket Author、Execution Ticket、RGR manifest。
- Skill Progress Contract。
- RGR nested state machine。

### P2：Status Host

- 單一 AbovePrompt renderer。
- Progress 上、Context 下。
- responsive layout、多 run primary selection。

### P3：互動與動畫

- 原創小貓狀態機。
- Desktop animation、Terminal fallback。
- reduced motion、render scheduler、閃爍修正。

P0 與 P1 驗收前，不應用動畫掩蓋不準確的進度。P2 完成後先人工確認排版，再進入 P3。

## 最終完成條件

只有在以下條件全部成立時才算完成：

- 真實 progress 不再由工具呼叫推進。
- Ticket Author、Execution Ticket 與 RGR 都有明確 workflow/checkpoint 契約。
- Status Host 統一排版但 provider 狀態保持分離。
- Desktop 與 Terminal 都有可靠 fallback。
- 長工具期間有 liveness、沒有虛假百分比。
- 多 run、reload、重複與錯序事件均通過測試。
- 吉祥物動畫不因一般 activity update 閃爍或重新開始。
- 原有 Context Bar 功能及命令無回歸。

---

## References

1. [Mods reference - Claude Code Docs](https://code.claude.com/docs/en/plugins/mods/reference)

2. [Claude Mods: What They Are and How to Build One in TypeScript](https://www.firecrawl.dev/blog/claude-mods) - Claude Mods are Claude Code plugins whose TypeScript runs inside Claude Code itself. The ui.render h...

3. [claude-code-mods/docs/mods.md at main · hamzafer/claude-code-mods](https://github.com/hamzafer/claude-code-mods/blob/main/docs/mods.md) - Claude Code mods: plugins built on hooks that add live lines above the prompt, guards, panes and gam...

4. [claude-mods.com · context-barcontext-bar: Claude Code context window as a stacked bar](https://claude-mods.com/context-bar/) - context-bar shows what fills your Claude Code context window: one stacked bar above the prompt, a co...

5. [Progress indicators – Material Design 3](https://m3.material.io/components/progress-indicators/guidelines) - Determinate progress indicators fill from 0% to 100% · Indeterminate progress indicators move along ...

6. [Progress indicators - Material Web](https://material-web.dev/components/progress/) - Linear progress indicators may show a buffer to communicate both determinate and indeterminate progr...

7. [Use the mods API - Claude Code Docs](https://code.claude.com/docs/en/plugins/mods/api)
