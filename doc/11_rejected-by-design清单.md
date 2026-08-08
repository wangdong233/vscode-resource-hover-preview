# 11 — Rejected by Design 清单（故意不做及理由）

> 本清单记录被显式否决的方案、架构与 feature，**每条附理由与复活条件**。
> 存在的意义（R-CI-06）：没有记录的否决依据，就没有阻止"重新论证"的锚点——尤其这些项会被协作者或未来的自己反复重提。任何人想复活其中一条，先读完它的否决理由与"复活条件"。

## 0. 如何读本清单

| 字段 | 含义 |
|---|---|
| **否决项** | 被拒绝的方案/feature |
| **理由** | 为什么不做（引用调研事实，标注 confidence） |
| **代价** | 接受这个否决要放弃什么 |
| **复活条件** | 什么情况下重新评估（可量化，避免模糊） |

---

## 一、架构路径否决

### R1. TIER 3 — 纯公开 API 做"原生 Explorer 悬停富媒体预览"

- **理由**：调研穷尽确证（confidence=high，读 microsoft/vscode + 官方 API 文档 + issue #270270）：
  - `TreeItem.tooltip` 接受 `MarkdownString` 且可内联图片，**但仅作用于扩展自定义的 tree view，无法注入内置 File Explorer**（内置 Explorer 的 tree item 由 VSCode 拥有）。
  - `HoverProvider` 只作用于编辑器内 `TextDocument+Position`，不作用于 Explorer tree item。
  - `createWebviewPanel` 固定到 editor/viewColumn（docked），**无公开或 proposed 的"扩展可创建独立浮动 overlay 窗口"API**。
  - feature-request #270270 "Explorer 悬停图片预览" 截至 2026-08 仍 Open/Backlog，关联 PR #279743 是**直接改 VSCode core**（explorerViewer.ts）非扩展 API——微软自己也只能 patch core。
- **代价**：放弃"零 patch 零脆弱"的理想。
- **复活条件**：VSCode 合入原生 Explorer hover preview 公开 API（监控 PR #279743 / issue #270270）。一旦合入，**图片**子场景应切回纯 API（多格式仍需 TIER1）。

### R2. TIER 3 降级 pivot — 自建侧边栏 custom tree + tooltip 静态图

- **理由**：技术上可行（零 patch），但要求两个重大产品妥协（confidence=high）：① 放弃原生 Explorer，改用扩展自建树；② tooltip 仅能渲染**静态图片**（`MarkdownString` 不支持 video/canvas/script，webp 不支持 #144188，inline SVG 被 strip，VSCode 声明 #167186 不再扩展 tooltip markdown）。即它满足的是"另一个更窄的产品形态"，非本项目定义的形态。
- **代价**：放弃一条零维护成本的兜底路径。
- **保留为降级预案**：见 [10_风险登记册](10_风险登记册与spike验证.md) D 级降级——若 TIER1 维护税过载，此路径作为"图片预览"的优雅退路，**但明确它是 scope 收缩不是等价替代**。

### R3. TIER 2 — Electron sidecar 独立窗口

- **理由**：① ~150MB 体积（捆绑 Electron）；② 独立 OS 窗口（任务栏条目，非 VSCode 内 overlay）；③ VSCode API 不暴露鼠标坐标 → 无法定位到鼠标位置；④ 被 TIER1 完全 dominate。
- **代价**：无（无场景优于 TIER1）。
- **复活条件**：无（除非 VSCode 未来禁掉所有 workbench patch 路径，概率极低）。

### R4. Marketplace 发布

- **理由**：patch VSCode 内部文件（workbench.html/product.json）违反 Marketplace 政策。`vscode-custom-css` 同样非 Marketplace 分发；Custom UI Style(106k) 是边界情况。
- **代价**：放弃一键安装的发现性。
- **补偿**：`npx -y vscode-media-preview@latest` + GitHub release（同 cc-status-dot 模式）。
- **复活条件**：无（除非 VSCode 开放合规的 workbench 定制 API）。

### R5. blob-only CSP 绕过（免 patch connect-src）

- **理由**：CSP 允许 `img-src data: blob:`、`script-src blob:`，理论上 EH 读文件经 IPC 传 Renderer 转 blob URL 可绕 `connect-src`。但 overlay 是**注入式 IIFE（无 `acquireVsCodeApi`/postMessage 通道）**，EH↔Renderer 唯一通道就是 HTTP fetch——"blob 中转免 patch"对注入式 IIFE 不成立（confidence=medium-high）。即便用主进程 IPC 中转，大文件（PDF/3D/视频）全量进内存且 IPC 不适合大数据流。
- **代价**：放弃一条理论上少 patch 一条 CSP 指令的路径。
- **复活条件**：若发现可靠的 EH→Renderer 注入式 IPC 通道（spike 验证），可重新评估用于轻量资源（图片缩略图）。

---

## 二、Feature 否决

### F1. 浮动弹窗的自由拖拽移动（toolbar 拖动改变位置）

- **理由**（用户决策 2026-08-08）：自由拖拽是"在 VSCode 里重造窗口管理器"，对"悬停一瞥"交互是过度设计；且与 VSCode 已有的"单击→内置 media-preview 打开文件"职责重叠。**位置改为智能四象限固定定位**（见 [03](03_浮动预览弹窗设计.md#四象限智能定位)）：按悬停文件项在视口的位置，自动选左上/左下/右上/右下展开，避开文件项本身与屏幕边缘，定位可预测不遮挡。
- **代价**：用户不能把 popup 挪到自己想要的位置。
- **保留**：**四角缩放**保留（四角都有 resize handle，可调大小）；位置固定不可拖。
- **复活条件**：若用户反馈强烈需要临时挪位，考虑加"钉住后可拖"（pin 状态下解锁拖拽），但不进 v0.1。

### F2. 音频波形图（waveform）

- **理由**（confidence=high）：waveform 生成强依赖 ffmpeg。`ffmpeg.wasm` ~25MB + 需 `SharedArrayBuffer` → 需 COOP/COEP cross-origin isolation 头，**VSCode workbench 不会有这些头 → ffmpeg.wasm 在 Renderer 不可行**。系统 ffmpeg 二进制需跨平台捆绑（每平台 ~70MB）+ 许可证复杂性（LGPL/GPL 动态链接）+ 用户无 ffmpeg 时降级，工程量远超 +3 天排期。
- **代价**：音频预览只有 `<audio controls>` 播放，无可视化波形。
- **复活条件**：v1.0+ 改用轻量方案——纯 JS `decodeAudioData` 解码 PCM 画波形（免 ffmpeg，仅限浏览器可解码格式），或 EH 端可选调用用户自装系统 ffmpeg 生成 PNG 波形。

### F3. 尺寸记忆（localStorage 持久化 popup 尺寸）

- **状态**：**保留但重新定位**。critic 质疑"尺寸记忆预设用户反复调同一尺寸"——但对四角缩放而言，记住上次尺寸是合理 UX（用户调过一次后续保持），且成本低（一行 localStorage）。
- **决策**：保留尺寸记忆（缩放结果持久化）；但 v0.1 不做"每类型/每文件分别记忆"的复杂分级，只记一个全局 popup 尺寸。

---

## 三、命名否决

### N1. npm 包名 `media-preview`

- **理由**：与 VSCode 内置扩展 id `vscode.media-preview` 在概念上撞名（虽 npm 与扩展 id 不同注册表），易混。
- **决策**：npm 包名锁定 `vscode-media-preview`（调研实测 npm registry E404 可用，confidence=high）。仍需在发布前 spike 核实 `vscode` npm 组织的命名空间/商标 policy（critic 风险点）。

---

## 四、平台支持否决

### P1. Flatpak 版 VSCode

- **理由**：Flatpak 沙箱禁止写宿主文件 → patch 不了 workbench.html。HARD NO-GO。
- **复活条件**：无。README 明示"不支持 Flatpak"。

### P2. Snap 版 VSCode（待定）

- **理由**：Snap 只读 squashfs 通常不可写。需 spike 确认；若不可写则排除。
- **状态**：暂列"不支持"，spike 后定。

### P3. Cursor（fork）— experimental

- **理由**：Cursor 用 `workbench-apc-extension.html`（非标准文件名）。patcher 候选数组会纳入此名，但未验证。
- **状态**：标 experimental，不保证。
