# Context Bar 重構：現況盤點與變更計畫

> 對應規格：`plan/Context Bar × Progress Status Host 實作規格.md`
> 依規格「先產出現況盤點與變更計畫，確認後才修改」，本文件寫完前**未修改任何程式**。
> 基準：`main` @ `d654864`，`claude plugin test context-bar` → **29 pass / 0 fail**；`claude plugin validate` 通過（僅 author 警告）。

---

## 一、先行取證

### 1. 檔案樹

```text
context-bar/
├── .claude-plugin/
│   ├── plugin.json                 # name=context-bar, version 0.1.0, types=./types/index.d.ts
│   └── types/                      # 引擎產生的 API 宣告（.gitignore 為 *，不入庫）
├── hooks/
│   ├── hooks.json                  # { "modules": ["./register.tsx"] }
│   ├── register.tsx   (436 行)     # 全部 hook、atom、context 計算、AbovePrompt renderer
│   ├── progress.tsx   (242 行)     # progress 純函式：tool spec、report fold、creep、段落解析、Clawd SVG、row renderer
│   └── register.test.tsx (531 行)  # 29 個測試
├── types/index.d.ts                # BarCategory、Snapshot、StepProgress、PluginState 宣告
└── tsconfig.json
```

### 2. 實際入口

- manifest：`.claude-plugin/plugin.json`（無 `hooks` 欄位，引擎讀 `hooks/hooks.json`）。
- hooks module：`hooks/register.tsx` 的 `export const register: Register`。

### 3. 關鍵位置

| 項目 | 位置 |
|---|---|
| `ui.render` / AbovePrompt（唯一一個） | `register.tsx:330-435` |
| Svg 解析與 Terminal 分支 | `register.tsx:337-338`（`surface === 'terminal'` 時不給 Svg） |
| Client | **未使用** |
| timer | `register.tsx:254` 只有 `/clear` 後 500ms 的 `$.clock.after`；**無** elapsed/stale timer |
| tool hook | `tool.check` `register.tsx:276`；`tool.call` `register.tsx:281-302` |
| progress tool | spec `progress.tsx:12-28`；處理 `register.tsx:282-287` |
| state reducer | `applyReport` `progress.tsx:56-72`、`seeded` `:49`、`syncTicket` `register.tsx:188-226`、`pauseSteps`/`clearFinished` `:161-171` |
| atoms | `snapshot`、`diag`、`detailsOpen`、`steps`（`register.tsx:19-26`），皆**未帶 `shape`** |
| slash command | **無**（validate 輸出未列任何 command） |

### 4. 現有型別

- `Snapshot`：categories / totalTokens / maxTokens / percentage / threshold。
- `StepProgress`：`source`(skill|ticket|report)、`label`、`sections`、`step`、`mech`（檔案勾選數）、`reported`（模型回報數）、`done = max(mech, reported)`、`total`、`paused`、`calls`（工具呼叫數，供 creep）。
  只有單一 run，無 runId / sequence / workflow / stage weight。

### 5. 測試（實為 29 個，非規格所稱 22 個）

| # | 名稱 | 覆蓋 |
|---|---|---|
| 1 | formats token counts like /context | `formatTokens` |
| 2 | bar fills the width with the compaction tick near the end | `barCells` |
| 3 | details collapsed by default… | legend 開合 |
| 4 | a saved expanded choice is restored at session start | `$.store` 偏好 |
| 5 | pressing the toggle saves the choice… | 偏好寫回 |
| 6 | band draws header, bar and legend on terminal and desktop | 雙 surface |
| 7 | bar is one row of proportional blocks… | desktop 不用字形 |
| 8 | band shows a waiting line before the first measurement | 無 snapshot |
| 9 | after /clear the band measures again… | `session.end(clear)` |
| 10 | without a breakdown the band falls back… | fallback 數值 |
| 11 | the progress tool is allowed without a prompt and draws a row | tool.check + 渲染 |
| 12 | a finished task keeps its ✓ row until the next prompt; an unfinished one pauses | 完成/暫停 |
| 13 | progress reported from a subagent leaves the main row alone | subagent 回報被拒 |
| 14 | the system prompt asks for progress reports only when the tool is offered | prompt.compose |
| 15-18 | ticket row: …（4 個） | 票檔勾選、Pending/ 進出、換票 |
| 19 | between reports the bar creeps within the current step… | **85% creep** |
| 20 | progress sits above the context header, with the Clawd mascot… | 排序、Svg、glyph |
| 21 | a paused row: tool calls leave it paused, a report resumes it, a silent turn drops it | paused |
| 22 | re-reporting the same step keeps its creep; subagent work creeps the main row | creep 保留 |
| 23-25 | ticket sections / skill sections / reports（純函式） | 解析與 fold |
| 26-28 | skill expansion 相關 3 個 | skill 段落種入 |
| 29 | a ticket row survives silent turns (paused), unlike a skill row | ticket 持續 |

### 6. Root cause

**(a) 兩條 bar 為何重疊／緊貼**
- Progress 被塞進 context 的 bordered Box 內（`register.tsx:405-406`），只靠 `marginBottom={1}` 隔開，無 divider。
- Desktop mascot 是 `width=26 height=21`（CSS px）的 Svg，卻放在 `height={1}` 的 track row（`progress.tsx:227-231`）。21px 高於一列文字高度，溢出到上方 title 列與下方 context header → 視覺重疊。
- `maxRows < 5` 時整個 progress 被丟掉（`register.tsx:393-399`），`s === null` 分支則無邊框，三種版型不一致。

**(b) 85% 步內推進**
- 計算：`creep()` `progress.tsx:76`；套用：`progressRows` `progress.tsx:240` 的 `fill = done + creep(calls)`。
- 來源：`register.tsx:293` **每一次**非 progress 工具呼叫（含 subagent）`calls + 1`。
- 它不改 `done`，但 fill 與 committed 同色同一段（`backgroundColor={color}`），所以視覺上等同正式進度。

**(c) 「停在 1/7 很久後突然跳到 5/7」**
- 不是 creep 造成（creep 永遠到不了下一步）。來源有二：
  1. `syncTicket`：模型一次勾掉多個 checkbox 後 mtime 變化，`finished` 由 1 直接變 5，`done = max(finished, reported)` 直接跳。
  2. `applyReport`：模型以 `done=5` 一次補報，`reported = max(prev, 5)` 直接採信。
- 兩者都沒有 diagnostic，也無法區分「真的完成」與「漏報後補報」。

**(d) 哪些事件會 invalidate UI**
- 任何 `update(steps)` 都讓 AbovePrompt 整個 render 重跑（`$.state` 訂閱機制），包括**每一次工具呼叫**（`calls+1`）。每次重跑都重算 `barCells`，並重建 Svg 元素。
- `snapshot`/`diag`/`detailsOpen` 的更新同樣整棵重繪。目前無 throttle。

### 7. Desktop / Terminal 分支

- `register.tsx:338`：terminal → Svg 為 undefined。
- `progress.tsx:206-211`：有 Svg 用 `clawdSvg(state)`（SMIL），否則 glyph `▐▛▜▌` / `▝▛▜▘`。

---

## 二、規格與現況的落差（以實際程式為準）

1. **測試數**：規格寫 22，實為 29。以 29 為「保留既有測試」基準。
2. **`/context-bar` 命令**：現況**不存在**，沒有可保留的命令；context 的唯一互動是 `▸ details` 按鈕與 `$.store` 偏好，這些會保留。
3. **Mascot 侵權風險**：現況是 **Clawd**（Claude Code 官方角色，`clawdSvg`、`alt="Clawd …"`）。規格非目標明列不得複製官方角色 → 改為原創像素小貓是**必要修正**，不只是 P3 美化。
4. **路徑寫死**：`ACTIVE_PATH = tmp/verify/active.json`、`PENDING_DIR = plans/cso_briefing/project/Pending` 是 SmartCameraApp1 專屬佈局。
5. **Skill 不在本 repo**：`ticket-author`、執行票流程、RGR 的 Skill 檔不在 `claude-mods`，規格要求的 Progress Contract 需在其所在 repo 修改（見文末問題 3）。
6. **Mutation test 無現成工具**：需自寫小腳本逐一移除 guard 並確認測試失敗。

---

## 三、既有測試中與新規格語意**相反**者（需核准後改寫）

規格要求「保留所有既有測試」，但下列 5 個測試鎖定的正是要移除的行為。計畫是**改寫斷言以表達新語意**，並在 commit 中逐一註明，而非靜默修改：

| 測試 | 現況斷言 | 新語意 |
|---|---|---|
| #19 creeps within the current step | `track.children[0].flexGrow` > 1.5 | committed fill 保持 1；buffer 段（另一個 key）成長但 ≤ stage ceiling；`1/4` 不變 |
| #22 subagent work creeps the main row | creep 後 fill 不回跳 | subagent 活動只更新 buffer/liveness；buffer 不回跳 |
| #20 Clawd mascot … animateTransform | Svg alt/SMIL 為 Clawd | 原創小貓 Svg；terminal 為文字 fallback；位置改在 Context 上方的獨立區 |
| #21 a silent turn drops it | 第二個無回報 turn 後 row 消失 | 轉 `paused`→ 120s 無事件轉 `stale`（灰）但**不移除** |
| #12 ✓ row until the next prompt | ✓ 留到下一個 prompt | completed 約 2 秒後淡出（以 `$.clock.after` 移除）；failed 持續顯示 |

其餘 24 個測試語意不變，只可能因 key 名稱調整而更新選擇器。

---

## 四、變更計畫

### 檔案切分（新增／改動）

```text
hooks/
├── register.tsx          # 只剩 hook 綁定 + atoms；所有邏輯委派
├── context/
│   ├── snapshot.ts       # 由 register.tsx 搬出 refresh / formatTokens / barCells（語意不變）
│   └── view.tsx          # context row renderer（header + stacked bar + legend）
├── progress/
│   ├── events.ts         # ProgressEvent 型別、normalizer、legacy adapter (done/total → stage.completed)
│   ├── reducer.ts        # 三層 reducer：committed / buffer / liveness，純函式
│   ├── manifests.ts      # ticket-author / execution-ticket / rgr / legacy-skill manifests
│   ├── rgr.ts            # RGR 子狀態機
│   ├── sources.ts        # 票檔勾選、skill 段落（由 progress.tsx 搬出，路徑改為可設定）
│   ├── tool.ts           # progress.emit + helper wrappers 的 tool spec
│   ├── mascot.ts         # 原創像素小貓 SVG + terminal 文字 fallback
│   └── view.tsx          # progress card renderer
├── host/
│   ├── coordinator.ts    # primary run 選擇（含黏著時間）、responsive layout、+N background
│   └── scheduler.ts      # render 合併：committed/status 立即；activity 250ms；elapsed 1s
└── register.test.tsx + reducer.test.ts + host.test.tsx
```

> `register.tsx` 中可運作的 context 邏輯只**搬移**不改寫；`barCells`、`formatTokens`、`sharePercent` 仍由 `register.tsx` re-export，既有測試的 import 不變。

### State schema

- 新 atom `runs`（`shape: 'progress-v2'`）存 `Record<RunId, ProgressRunState>` + diagnostics ring buffer（上限 50 筆，不含 tool arguments／票內容）。
- 舊 `steps` atom 保留讀取一次做 migration → 轉成一個 legacy run；失敗則安全退回空 progress，**context atoms 不動**。
- `$.state` 可撐過 hot reload → reload 不重發 start；`lastSequence` 與 checkpoint 集合使重送為 no-op。
- 設定（mascot / motion）存 `$.store`。

### 三層如何從事件得到

| 層 | 唯一來源 | 不可做 |
|---|---|---|
| Committed | `run.started`（建立 manifest）、`stage.completed`*、`checkpoint.completed`、`child.completed`（須預先宣告）、`run.completed`；票檔勾選 → 對應 checkpoint；legacy `done` → stage 完成 | 工具呼叫、heartbeat、subagent 活動 |
| Buffer | `activity.started/completed`、一般 tool.call、subagent tool.call、`child.started` | 越過目前 stage ceiling；改 done/total/percent |
| Liveness | 所有有效事件更新 `lastEventAt`；tool 進出更新 `activeToolCount`；`run.waiting/paused/resumed`；timer 判 stale | 提交進度；heartbeat 解除 paused/waiting-user |

\* 規格事件清單沒有 `stage.completed`，但 Committed 允許「stage 明確完成」。計畫以「`stage.started` 下一個 stage 時，**只有前一 stage 的必要 checkpoint 全部完成**才視為完成，否則記 `missing-checkpoints`」實作，不另增事件型別。若希望有顯式 `stage.completed`，請於問題 1 註明。

### Legacy 相容

- 舊 `progress(done,total,label,step)` 呼叫保留，標記 deprecated，轉為 legacy manifest（每 done = 等權 stage 完成）。
- 跳報（1→5）只提交 5、記 `protocolViolation: missing-checkpoints`；UI 不逐格動畫。
- 票檔一次勾多個：同樣提交但記 diagnostic（因為檔案是可驗證來源，勾選本身是真實的）。

### 新增命令

- `$.command.register`：`/progress`（列 runs 與 diagnostics）、`/progress mascot cat|minimal|off`、`/progress motion full|reduced|off`、`/progress dismiss`。

### 分階段

1. **P0+P1**：events / reducer / manifests / rgr / legacy adapter / tool / diagnostics + 規格測試 1–15 + property 測試 + mutation 腳本。→ 全部測試通過後回報，**等你確認**。
2. **P2**：Status Host 版型（Progress 上、divider、Context 下）、primary run、`+N background`、80/120/160 columns snapshot、無 run 不留白。→ 交 render snapshot 給你**人工確認排版**。
3. **P3**：原創小貓、motion 設定、scheduler、動畫 identity 穩定（固定 key + `begin` 以 state 起點計算；不行則改 `Client` 自帶 frame clock）。

### 不會動的部分

context 類別、配色、compact tick、token 計算、`details` 開合與偏好、plugin name 與安裝方式。

---

## 五、P0+P1 交付紀錄（2026-10-15）

### 與上方計畫的差異

- **未搬移 context 程式**：規格明訂「不得為符合示意結構而搬動已可運作的檔案」，因此 `register.tsx` 的 context 邏輯原地保留，`progress.tsx` 保留段落解析與 renderer；新程式全部放在新目錄 `hooks/progress/`。`host/coordinator.ts`、`scheduler.ts` 屬 P2/P3，尚未建立。
- **Clawd 已在本階段換成原創像素小貓**（`catSvg`），因為這是合規修正而非美化；姿態對應 liveness，動畫細節留給 P3。
- **主 turn 結束 → `waiting-user`**（取代 v1 的 paused）；下一個 prompt 或 workflow 事件會恢復，`run.paused` 只能用 `run.resumed` 解除。
- **`$.clock` 不可用時退回 `Date.now()`**：測試環境沒有預設 clock，正式 host 有。
- **`activity.started` 必須帶 `activityId`**，否則被拒（`invalid-event`）：沒有 id 的 activity 永遠配不到 completed，run 會一直停在 waiting-tool。RGR 狀態改由對 rgr stage 重複送 `stage.started` 攜帶，不再開 activity。
- **被拒事件也會回傳目前的 `sequence` 與 `committedPercent`**，方便 Skill 重新同步。
- **emit run 進行中時，legacy 來源一律讓位**：skill 標題不建立新 row、票檔勾選不同步、`progress(done,total)` 回 `ignored`。避免同一份工作出現兩個 foreground run。
- **tool hook 的進度紀錄失敗時不影響工具本身**：start／end 的紀錄都包在 try/catch 中，工具仍只會執行一次。

### 新增／修改檔案

| 檔案 | 用途 |
|---|---|
| `types/index.d.ts` | 新增 v2 型別：`ProgressEvent`、`ProgressRunState`（committed／buffer／liveness）、`WorkflowManifest`、`RgrState`、`Diagnostic`、`ProgressState`；`progress` atom 以 shape `progress-v2` 版本化 |
| `hooks/progress/reducer.ts` | 三層 reducer（純函式）：sequence guard、checkpoint／child 去重、stage 單調、跳報診斷、`run.completed` 一致性檢查、stale／fade tick、reload → orphaned |
| `hooks/progress/manifests.ts` | Ticket Author（7 stage，加權 8/7/24/12/22/22/5）、Execution Ticket fallback（load/plan/implement/verify/finalize）、RGR；權重正規化為 100；legacy 等權 manifest |
| `hooks/progress/rgr.ts` | RGR 子狀態機：round 不可倒退、phase 轉移受限、`passed` 才提交 RGR stage、`needs-user` → waiting-user |
| `hooks/progress/legacy.ts` | Legacy adapter（deprecated）：`progress(done,total)`、票檔勾選、skill 標題 → 等權 stage；v1 `steps` atom 遷移，失敗則空 progress |
| `hooks/progress/events.ts` | `progress_emit` 單一事件入口（tool spec + 正規化，欄位長度上限，不接受 percent，不讀檔、不執行、不連網） |
| `hooks/progress/view.ts` | view model、primary run 選擇（未含黏著時間，P2）、`/progress` 診斷文字（不含 tool arguments） |
| `hooks/progress.tsx` | 移除 `creep`（移入 reducer，只作用在 buffer）；`ticketSectionStates` 回傳逐段勾選結果；新 renderer：committed 實色、buffer 淺色、liveness 列（activity／RGR／elapsed） |
| `hooks/register.tsx` | 工具呼叫 → `tool.start/end` activity；`progress_emit` 與 `/progress [dismiss]` 指令；turn／prompt／reload 事件；單一 timer 處理 stale 與 fade |
| `hooks/register.test.tsx` | 依核准改寫 5 個測試（#12 改為 mock clock：✓ 約 2 秒後淡出，prompt 會更早清掉） |
| `hooks/progress.test.tsx` | 新增 25 個測試：規格 1–15、property ×3、遷移、emit 整合（含被拒時回傳的 sequence）、emit 優先於 legacy、無 run 不留白、context／progress 隔離、`/progress` |
| `scripts/mutation.mjs` | Mutation 檢查：逐一移除 6 個 guard，確認測試會失敗 |

### 三層如何由事件取得

- **Committed**：只有 `run.started`（manifest）、`stage.started`（離開無 checkpoint 的 stage 才算完成）、`checkpoint.completed`、宣告過的 `child.completed`、`run.completed`、`rgr.phase = passed`，以及 legacy adapter 的 stage 完成（`done` 或票檔逐段勾選）。百分比 = Σ 已完成 stage 權重 + Σ 未完成 stage 權重 × 已驗證 checkpoint／child 比例。
- **Buffer**：每次工具呼叫（含 subagent）與 `activity.*`、`child.started` 都會讓 `activityCount` +1；`visual = committed + creep(n) × (ceiling − committed)`，`ceiling` = committed + 目前 stage 尚未驗證的權重；同一 stage 內不回退。
- **Liveness**：`status` = base（running／waiting-user／paused／orphaned／終止狀態）疊加 overlay：有進行中的工具 → `waiting-tool`；超過 120 秒沒有事件 → `stale`。elapsed 在 render 時由 `startedAt` 計算。

**會被忽略（並記錄 diagnostic）的事件**：沒有 `activityId` 的 `activity.started`、`stale-sequence`、`duplicate-checkpoint`／`duplicate-child`、`duplicate-start`、`unknown-run`、`run-ended`、`unknown-workflow`、`manifest-mismatch`、`unknown-stage`／`unknown-checkpoint`、`stage-regression`、尚未 passed 就送出的 `rgr-passed`。
**接受但記錄的事件**：`missing-checkpoints`（跳報）、`undeclared-child`、`inconsistent-completion`、`rgr-regression`。

### 驗證結果

- `claude plugin test context-bar`：**54 pass / 0 fail**（原有 29 個，其中 5 個依核准改寫；新增 25 個）。
- `node context-bar/scripts/mutation.mjs`：**6/6 mutants killed**，涵蓋 sequence guard、checkpoint dedupe、paused guard ×2、buffer ceiling、工具呼叫提交 committed。
- `claude plugin validate context-bar`：通過（只有原本就有的 author 警告）。
- `tsc --noEmit`：新檔案沒有新增錯誤（repo 基準原本就有約 30 個 strict 錯誤，集中在既有的解析與 JSX 型別）。
- **工具呼叫不再改變正式百分比的證據**：規格測試 1（20 次工具呼叫後 committed = 0）、改寫後的 #19（33 次呼叫後 committed fill 維持 25，只有 buffer 增長）、mutant「tool calls commit the current stage」會被抓到。

### 尚未完成（P2／P3）

- 規格 UI 測試 17、18、20、22、23、24：版面 divider、80/120/160 columns snapshot、`+N background`、primary 黏著、動畫 identity、motion/mascot 設定。
- Desktop Svg 高度溢出（重疊的主因）尚未修正，屬 P2 版面工作。
- **elapsed 不會即時跳動**：規格測試 11 是以指定的 `now` 呼叫 `runView` 來驗證。實際在 band 上，長時間 Bash 執行期間沒有任何 state 寫入，所以畫面上的 elapsed 會停住，要等 P3 scheduler 的每秒更新。
- **reload 恢復尚未實機驗證**：目前依賴 `/reload-plugins` 會觸發 `session.start`，這只根據 API 文件，需在實際 session 中確認。
- **省略 `sequence` 時由 host 自動補號**：這種情況下，重送的 `run.paused`／`stage.started` 都會通過 sequence guard，只剩去重機制能擋。之後的 Skill Contract 應要求明確送 `sequence`。
- 每次工具呼叫會寫兩次 state（start／end）→ 兩次重繪；250ms 合併屬 P3 scheduler。
- Skill 端的 Progress Contract：依使用者決定另開。

## 六、P1.5 交付紀錄：Desktop 版面與實機驗證（2026-10-15，已通過）

### 修正內容

- **軌道列高度**：Desktop 的軌道列不再固定為一列高，改由小貓的高度決定（`minHeight: 1`、置中）；進度條各段仍維持一列高。Terminal 維持一列。
- **小貓尺寸**：26×20 改為 21×16 CSS px，約一列文字高。
- **動畫不重播**：`running` 與 `waiting-tool` 共用同一個姿態。修正前每次工具呼叫都會在兩個狀態間切換，SVG `source` 跟著改變，動畫就會重播。測試已證實：把舊的對應改回去時，新測試會失敗。
- **buffer 顏色**：改為主色的淺色調 `#EDC3AE`；非執行中時改用剩餘段的中性灰。
- **被取消的 run 也會淡出**：錄影發現被取消的 run 會一直留在畫面上，下一個 run 淡出後又會冒出來。現在 cancelled 和 completed 一樣，約 2 秒後淡出；failed 仍持續顯示到被關閉為止。
- **移除所有秒數（方案 A）**：錄影顯示一個 20 秒的 Bash 期間，畫面一直停在 `⧗ Bash 2s` 與 `Run 7s`。原因是工具執行期間沒有任何 state 寫入，所以不會重繪。依裁決，工具耗時與 run 累計時間都不再顯示，改為狀態標籤：`⧗ <工具>`、`working`、`waiting for you`、`paused`、`no recent activity`、`lost track after a reload`、`done`、`cancelled`。`/progress` 的 last event 時間是在執行指令當下才計算，所以保留。

### 實機驗證（錄影 0:20～1:05，以 OpenCV 每秒抽一格、小貓區塊逐格 30fps 分析）

| 項目 | 結果 | 依據 |
|---|---|---|
| Progress 與 Context 不重疊 | **已驗證** | 整段沒有重疊；context 區在每一格的位置都沒變 |
| band 高度穩定 | **已驗證** | 下方狀態列有沒有內容時，context 區都不會移動 |
| buffer 淺色調 | **已驗證** | 0:24 起可見淺橘色 buffer，比 committed 淡、和剩餘段分得開 |
| 正式進度只依 checkpoint 推進 | **已驗證** | 工具活動期間停在 `1/7 8%`；0:51 起依 checkpoint 逐步到 `7/7 100%` |
| completed 約 2 秒淡出 | **已驗證** | 0:62～0:63 顯示 `✓`，0:64 消失 |
| 小貓不閃爍 | **已驗證（依畫格判讀）** | 0:22～0:50 共 840 格，沒有任何一格小貓消失或只畫一半 |
| 動畫不重播 | **已驗證（依畫格判讀）** | 7 次重繪，上下跳動週期量得 0.37 秒（設定 0.36 秒），每次重繪後的位置都不同 |

### 根因說明

- **已驗證**：修正後 Desktop band 不重疊。
- **合理推測**：舊版重疊和小貓高度、固定一列高的軌道列，以及縮放後的實際邊界有關。
- **未驗證**：沒有在舊 commit 上實機重現原本的問題。

### 驗收素材

截圖與錄影只用於 Desktop UI 差距診斷，存放在 `tmp/`，已加入 `.gitignore`，不追蹤也不提交。

## 七、P2 交付紀錄：divider、多 run 摘要、切換防抖、欄寬 fallback（2026-10-15）

範圍依裁決，只做這四項；不碰 P3 timer、Skill Progress Contract、動畫擴充或檔案結構重整。

| 項目 | 做法 | 測試 |
|---|---|---|
| divider | progress 與 context header 之間加一列淡色 `─`，以 `truncate-end` 截成一行，Desktop 的寬字形也不會折行。沒有 run 時不顯示 | 兩種 surface 都確認排列順序為 progress → divider → header；沒有 run 時沒有 divider |
| 多 run 摘要 | 只顯示 primary run；其他進行中的 run 在狀態列右側顯示 `+N background`。已結束的不計入 | 3 個 run 時顯示一張卡和 `+2 background`；取消一個後變成 `+1 background` |
| 切換防抖 | 目前顯示的 run 至少維持 3 秒（`PRIMARY_HOLD_MS`），才會被同等優先的 run 取代；需要使用者處理的 run（waiting-user、failed）立即取代；目前的 run 離開畫面時立即交棒。等待中的切換由既有的單一 timer 在 3 秒到期時處理 | 等待期間的工具活動不會造成切換、3 秒後才切換、waiting-user 立即搶回、run 離開時立即交棒。把等待時間設為 0 時，這兩個測試會失敗 |
| 80/120/160 欄 | 未滿 100 欄時，`+N background` 縮成 `+N`；標題與目前 stage 一起截斷，`done/total` 與百分比保持完整 | 80、120、160 欄分別驗證 |

**狀態變更**：`ProgressState` 新增選填欄位 `primary: { runId, since, held? }`。這是相容擴充：舊值沒有這個欄位時，下一個事件就會補上，所以 shape tag 不需要升版。

**驗證結果**：`claude plugin test context-bar` 64 pass / 0 fail；`mutation.mjs` 6/6 mutants killed；`claude plugin validate` 通過；新檔案沒有新增 TypeScript 錯誤。

### P2 實機驗證（錄影 0:06～0:58，每秒抽一格）

| 項目 | 結果 | 依據 |
|---|---|---|
| 沒有 run 時沒有 divider、不留空白 | **已驗證** | 0:06～0:07 只有 context bar |
| `+N background` 顯示與遞減 | **已驗證** | 0:15 出現 `+1`、0:16 起 `+2`；取消後 0:49 變 `+1`、0:50 消失 |
| waiting-user 立即搶回 band | **已驗證** | A 在 0:39 轉為 `⏸ 需要你確認`、`waiting for you` |
| 全部取消後淡出、不留空白 | **已驗證** | 0:51～0:52 顯示 `cancelled`，0:53 只剩 context bar |
| 同等優先的 run 在 3 秒後接手 | **未通過 → 已修正** | C 在約 0:27 推進 stage 後，畫面一直停在 A |
| divider 在 Desktop 上 | **未通過 → 已修正** | 線的右端出現 `…` |
| `+N background` 全字顯示 | **未通過 → 已修正** | Desktop 只顯示 `+2` |

### 錄影發現的問題與修正

1. **用推進 stage 完成的提交不算數**：C 是 execution ticket，它的 stage 沒有 checkpoint，所以是「進入下一個 stage」才完成上一個 stage。原本只有 checkpoint 與 child unit 會記錄提交時間（`lastCommittedAt`），導致 C 的提交不被計入，主 run 選擇永遠不會挑中 C。修正：只要 committed 百分比上升，不論原因都記錄提交時間。新增迴歸測試。
2. **Desktop divider 出現 `…`**：Desktop 畫 `─` 比一格寬，`bodyColumns - 4` 個字元超出寬度，被截斷時補上省略號；所有 `truncate` 模式都會加省略號。修正：Desktop 改用 1px 的 SVG 線，寬度跟著所在位置；Terminal 維持文字線。
3. **Desktop 只顯示 `+2`**：Desktop band 約 95 格寬，低於原本 100 欄的精簡門檻。修正：門檻改為 80 欄，80 欄以上顯示全字，60 欄測試顯示 `+2`。
4. **等待理由殘留**：A 被取消後，標題仍顯示等待時的 `需要你確認`。修正：`run.waiting`／`run.paused` 的文字只存為等待理由，只在等待或暫停期間顯示；host 自己標記的 `turn ended` 不顯示。

**修正後結果**：66 pass / 0 fail；6/6 mutants killed；`claude plugin validate` 通過。

### P2 第二次實機驗證（錄影 0:04～0:50，2026-10-16）

| 項目 | 結果 | 依據 |
|---|---|---|
| `+N background` 全字顯示 | **已驗證** | 0:13 `+1 background`、0:14 起 `+2 background` |
| 同等優先的 run 在等待後接手 | **已驗證** | C 約 0:20 推進 stage，0:24 換成 `C 執行票 1/5 10%`（約 3～4 秒） |
| waiting-user 立即搶回 band | **已驗證** | 0:40 為 `⏸ A 主 run 需要你確認` |
| 等待理由不殘留 | **已驗證** | 0:49 A 取消後標題回到 `Bootstrap` |
| 全部取消後淡出 | **已驗證** | 0:50 只剩 context bar |
| Desktop divider | **未通過 → 已修正** | 該列每一行像素亮度都是 238，SVG 線根本沒畫出來 |
| 一起結束時不閃動 | **未通過 → 已修正** | 0:48 顯示淡出中的 C，0:49 又換成淡出中的 A |

**修正**
5. **divider 沒畫出來**：SVG 沒有指定寬度時，會取所在位置的寬度，但它所在的那一列本身沒有明確寬度，所以畫成 0 寬。修正：divider 那一列改為 `width="100%"`，SVG 就能撐滿整列。
6. **一起結束時閃動**：淡出中的 run 原本也能搶走 band。修正：淡出中的 run 可以保留 band，但只能在它結束的那一刻、而且 band 上沒有其他 run 時才能取得 band；之後不會再中途插入。failed 不算淡出，仍會立即搶回 band。新增迴歸測試。

**結果**：67 pass / 0 fail；6/6 mutants killed；validate 通過。修正 5、6 需要再跑一次實機確認。

### P2 第三次實機驗證（錄影 0:14～1:01）

| 項目 | 結果 | 依據 |
|---|---|---|
| 一起取消時不閃動 | **已驗證** | 0:58 `+1 background`，0:59～1:00 只顯示 A `cancelled`，1:01 只剩 context bar，中途沒有換成 B 或 C |
| Desktop divider | **未通過 → 已修正** | 第二次修正後依然沒有畫出線：那一列像素亮度沒有變化 |

**修正 7：放棄 SVG 線，改用文字線。** 第一次錄影已證實文字線畫得出來，只是 Desktop 上 `─` 比一格寬，整列放滿會溢出並被補上 `…`。現在 Terminal 仍是整列的文字線；Desktop 只放可用寬度 85% 的 `─` 並置中，看起來是一條內縮的分隔線。SVG 線之所以畫不出來，**合理推測**是它沒有自己的寬度，被排版成 0 寬（未驗證）。

**結果**：67 pass / 0 fail；6/6 mutants killed；validate 通過。修正 7 需要再跑一次實機確認，只看 divider。

**觀察（不在 P2 範圍）**：主對話的工具呼叫會歸到「最新的 foreground run」，不一定是畫面上顯示的那個 run（0:25～0:32 C 顯示 `⧗ Bash`）。實務上子 run 多半由 subagent 建立、屬於 background，影響有限；記錄待後續評估。

## 八、未解風險（先列，實作中驗證）

- ~~**SMIL 在 redraw 後是否重置**~~：P1.5 錄影依畫格判讀為不重置（見第六節）。退路仍是 `Client`。
- **工具執行期間不會重繪**：秒數已拿掉，但狀態列在長工具期間依然是靜止的。真正的即時更新屬 P3 timer。
- **Skill 漏報**：只能顯示 active/stale，committed 會停住——這是規格要的行為，但使用者觀感上會「卡住」。
- **Mutation 腳本**屬自製，非標準工具。
