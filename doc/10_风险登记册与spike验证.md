# 10 — 风险登记册与 Spike 验证记录

> 本文档是项目的**风险真相源**与**动手前的闸门**。5 维调研产出 50+ 条 confidence 标注的 finding，此处沉淀为可追踪的风险条目 + 必须先过的 spike 闸门。
>
> **铁律：下列 make-or-break spike 全部通过前，不进入 v0.1 编码。** 每条 spike 有明确的 GO/NO-GO 判据与记录槽位（spike 跑完填结果）。

## 一、Make-or-Break Spike 闸门（动工前必须先过）

> 顺序即优先级。Spike 1/2 是真正的生死验证——失败则整个 TIER1 路径动摇，触发降级（见 §三）。

### Spike 1 · Trusted Types 对 innerHTML 的约束（最高优先）

- **风险**：VSCode workbench 强制 `require-trusted-types-for 'script'`（调研 high-conf，读源码 workbench.html）。`Element.innerHTML` 是该指令下的受管 injection sink，裸字符串赋值被浏览器拒绝。当前 [03](03_浮动预览弹窗设计.md) 全部渲染用 `content.innerHTML='<img...>'` → **overlay 能加载但一个字节都渲染不出，且静默失败难调试**。
- **判据**：目标 VSCode 版本 Help→Toggle DevTools，Console 执行 `document.body.innerHTML='<div>x</div>'`：
  - **抛 `TypeError: This document requires 'TrustedHTML'`** → TT 生效，GO 前提是 overlay 全程改 `createElement`/`appendChild`/`textContent`/`.src=`，或 patch CSP `trusted-types` 白名单加自定义 policy 名 + `createPolicy`。
  - **不抛** → TT 未启用或被旁路，`innerHTML` 可用（仍建议 createElement 以防未来收紧）。
- **结果记录**：`[x] 已验证 2026-08-08（本机 VSCode 1.129.1 stable）` — 读 workbench.html 真相源确认 CSP meta 含 `require-trusted-types-for 'script'` + `trusted-types` 白名单（amdLoader/dompurify/lit-html 等 18 个 VSCode 内部 policy，**无项目可用**）+ `script-src` 无 `'unsafe-inline'`。**TT 确认生效**：Chromium 见该指令即 enforce TrustedHTML，无旁路可能。**结论：overlay 全程必须 createElement，禁 innerHTML**（doc03/08 改造成立）。可选运行时双保险：DevTools Console 跑 `document.body.innerHTML='<div>x</div>'` 应抛 `TypeError: This document requires 'TrustedHTML'`。
- **影响范围**：决定 overlay **全部 DOM 代码写法**（03/08 所有渲染器）。不验证不能动 v0.1。

### Spike 2 · 静态 `<script src>` 注入 + CSP 真相（生死验证）

- **风险**：① v1.94+ Electron 样式加载变更后，patch workbench.html 注入 `<script src="./test.js">` 是否仍加载执行；② 除 workbench.html 的 meta 外，electron-main 是否注入第二条 CSP HTTP 头（CSP 规范 meta+header 取交集，最严者赢）；③ `workbench.esm.html` 是否带 SRI/Subresource Integrity 模块完整性校验。
- **判据**：目标 VSCode 版本 patch 一个最小 `test.js`（仅 `console.log('overlay alive')`）到 workbench.html（`</body>` 前静态 `<script src>`）→ **Cmd+Q 完全退出重启**（⚠️ Reload Window 用缓存不重读 workbench.html，patch 不生效，不能用 reload 测）→ DevTools Console 见日志 = **加载成功**；同时 Application 面板查 CSP + Network 响应头确认无第二 CSP / 无 SRI。
- **结果记录**：`[x] 已验证 2026-08-08（VSCode 1.129.1 stable）` — patch `mp-test.js` 到 workbench.html 静态 `<script src>`，**Cmd+Q 完全重启**后 DevTools Console 见 `mp-test.js LOADED`。script-src 'self' 允许同源 script 加载，CSP 单一静态 meta（无第二 HTTP 头、无 SRI）。**决策：路径 A（surgical patch meta）可行**。
- **决策分支**：
  - 加载成功 + 单一 CSP meta → patch CSP 指令（surgical，加 `connect-src http://127.0.0.1:*` 等到现有 meta）。
  - 加载失败或发现第二 CSP 头 → 退回 vscode-custom-css 的"删整段 CSP meta"做法（更激进，备份原 meta 供 revert）。

### Spike 3 · workbench 入口路径一锤定音

- **风险**：`workbench.esm.html` vs `workbench.html`、`electron-sandbox` vs `electron-browser` 两轴歧义（vscode-custom-css 源码注释把 electron-browser 标 "v1.102+ path"，与官方沙箱博客矛盾）。硬编码单路径必在某版本/平台崩。
- **判据**：本机 `find /Applications/Visual\ Studio\ Code.app -name 'workbench*.html'` 一锤定音目标版本实际路径与文件名，patcher 候选数组据此定稿。
- **结果记录**：`[x] 已验证 2026-08-08` — 实际路径 `out/vs/code/electron-browser/workbench/workbench.html`（**非** electron-sandbox，**非** .esm.html）。electron-sandbox/workbench 在本机**不存在**。印证"官方博客说 sandbox 现行 vs vscode-custom-css 注释说 electron-browser v1.102+"矛盾——patcher 必须多候选遍历。workbench.js 仍存在（30882 字节，被 `<script src="./workbench.js" type="module">` 引用）。权限：workbench.html + product.json 当前用户均可写（不需 sudo）。
- **patcher 策略**（不靠 glob 顺序碰运气）：有序候选数组（顺序据 1.129.1 实证，与 [05](05_三平台路径与权限.md) 单源一致）：`['electron-browser/workbench.html'(✅ 实证命中), 'electron-sandbox/workbench.esm.html', 'electron-sandbox/workbench.html', 'electron-browser/workbench.esm.html', 'electron-sandbox/workbench/workbench-apc-extension.html'(Cursor)]`，首个命中即用。

### Spike 4 · checksum 抑制策略确认

- **风险**：当前 [01](01_自愈patch机制设计.md)/[02](02_workbench注入设计.md) 把 product.json `checksums` 当数组（`.filter()`），**源码确证是 object map**（key=app-resource 路径）。照写静默失效仍弹"安装损坏"。字段是 `checksumFailMoreInfoUrl` 非 `checksumFailures`。
- **判据**：目标版本打开 product.json 复核 `checksums` 结构（object map）+ key 命名（如 `vs/code/electron-browser/workbench/workbench.html`，key 不含 `out/` 前缀，段名随版本可能为 electron-sandbox/electron-browser）。
- **结果记录**：`[x] 已验证 2026-08-08` — 1.129.1 stable 实测：checksums 是 **OBJECT MAP**（10 个 key，**非数组**），key **不含 `out/` 前缀**（如 `vs/code/electron-browser/workbench/workbench.html`）。workbench.html **在 checksums 列表内** → patch 后必删该 key 或重算，否则触发校验。字段 `checksumFailMoreInfoUrl` 存在，`checksumFailures` **不存在**。
- **决策**：MVP 用 **重算 SHA256+base64去`=`填回**（算法：`crypto.createHash('sha256').update(buf).digest('base64').replace(/=+$/,'')`，Spike 4 实测 2026-08-08 唯一确定生效）。**删 key 方案实测失败**（reload 后仍弹"安装损坏"——Reload Window 不重读磁盘 workbench.html、旧缓存与改后 product.json 失配；完全重启后是否生效未单独验证），弃用。

### Spike 5 · macOS 代码签名

- **风险**：改 `.app` 内文件（workbench.html/product.json）invalidate Apple 代码签名，Gatekeeper 可能对未清 quarantine 的 app 弹"已损坏/无法验证开发者"。当前 [05](05_三平台路径与权限.md) 只提 `sudo chmod`，未提 `codesign --remove-signature` 或 ad-hoc 重签。
- **判据**：macOS 上 patch 后重启 VSCode，观察是否弹签名警告。
- **结果记录**：`[~] 初步通过 2026-08-08` — VSCode 1.129.1 stable patch 后 Cmd+Q 完全重启，**未弹签名警告**（好迹象）。仅单状态/单次验证，待多状态（多次启停、quarantine 未清场景、不同 flavor）确认后转 ✅。
- **预案**：若触发，文档补 `codesign --remove-signature "/Applications/Visual Studio Code.app"` 或 ad-hoc 重签步骤。

### Spike 6 · CSP patch 三件通配端口定稿

- **风险**：当前 [04](04_EH与Renderer通信协议.md) CSP 只 patch `connect-src`+`img-src` 用固定端口 17741——但 server 端口冲突会自动递增（17742/17743）→ CSP 必须用通配 `http://127.0.0.1:*`；且漏 `media-src`（video/audio 的 blob/http src 被 `media-src='self'` 拦）。
- **判据**：确认 patch 这三条指令：`connect-src`（fetch）、`img-src`（图片）、`media-src`（video/audio），均加 `http://127.0.0.1:*`（VSCode 开发版 workbench-dev.html 自用格式，官方先例）。`worker-src` 未设→回退 `script-src` 的 `blob:`→pdf.js/three.js 用 blob worker 免 patch（Spike 7 确认）。
- **结果记录**：`[x] 已验证 2026-08-08（fixture 端到端通，真机 Cmd+Q 步留给编码者）` — spike6.mjs 在 /tmp 仿 app fixture 上跑通：① CSP patch 三件幂等（backreference 正则修正 doc02 原 bug：content 含 'none' 单引号，原 `[^"']*` 在 `'` 处截断只捕 22 字符→改 backreference）；② mp-config.js 烘焙实际 port=17741，token 校验生效（错 token /config→403）；③ /ping→200 "ok"；④ 端口冲突测试：占用 17741 后 patch 自动递增到 17742 并烘焙，17741 仍归占用进程（未抢）；⑤ revert 后 workbench.html 与出厂 byte-identical，product.json checksum 一致。**mp-config.js 作为静态【外链】script，window.__MP_CONFIG__={...} 赋值：CSP script-src 'self' 放行（非 inline）+ TT 不管属性赋值（W3C/MDN 确证）→ 通**。配置传递定案：烘焙式静态外链。**发现 doc02 CSP 正则 bug + 幂等缺失**（已记入 doc02 修正）。官方 CSP 先例：microsoft/vscode workbench-dev.html connect-src 含 `http://localhost:* http://127.0.0.1:*`。真机最后一步（编码者做）：`node spike6.mjs --patch` → Cmd+Q 完全退出 VSCode → 重开 → DevTools Console 见 `[mp-config] loaded` + `[mp-overlay] /ping -> 200 "ok" ✅`。

---

## 二、v0.2+ 前置 Spike（不挡 v0.1，但挡对应类型）

### Spike 7 · pdf.js / three.js 在 workbench Renderer 可运行性（v0.4/v0.5 前必做）

- **风险**：pdf.js 依赖 Worker（须确认走 blob worker 符合 worker-src 回退）+ 内部 `innerHTML` 建 text layer（TT 拦，可能致文字层失败）+ `eval/Function`（在 `unsafe-eval` 下 OK）；three.js `requestAnimationFrame` 渲染循环在 popup 隐藏时若不 dispose 会 GPU 内存泄漏。
- **判据**：目标版本用最小 PDF/glTF 跑通"渲染首页/首帧"。pdf.js 可关 text layer（只渲页面图像）绕 TT。
- **结果记录**：`[ ] 待填` — 成功才动 PDF/3D，失败则该类型推迟。

### Spike 8 · resolve 索引冲突策略（v0.1 前必做）

- **风险**：当前 [06](06_DOM选择器容错策略.md) 方案B `index.set(name,full)` 同名覆盖 → 悬停 `logo.png` 看到的是另一个 `logo.png`（比没有更糟）。大 workspace 递归 walk 阻塞 EH event loop。
- **白盒预填（2026-08-08，confidence high，待 probe 实测转 ✅）**：源码 trace 端到端确证——`.monaco-icon-label` 元素的 aria-label = `labelService.getUriLabel(stat.resource)` = 完整绝对路径（explorerViewer.ts:1014 setResource 无 title → labels.ts render: title=computedPathLabel=getUriLabel(resource) → iconLabel.ts setLabel: setAttribute('aria-label', title)）。若有 FileDecorationProvider(Git/filesize) tooltip 则为 `<path> • <tooltip>`。
  - **结论：方案 0 成立**——overlay 直接读 `.monaco-icon-label` aria-label（按首个 ` • ` 切分取前段）即得完整路径，**删除整个 EH 文件索引子系统**（walk/findFiles/Watcher/Map<basename,string[]>/重名消歧全部不需要）。
  - **必读层级**：aria-label 在 `.monaco-icon-label`（内层），不是行 `.monaco-list-row`（行 aria-label=element.name 仅文件名，listWidget AccessibiltyRenderer:1332）。doc06 已修正。
  - **保留 fallback（不删 EH 索引代码，降级启用）**：① remote workspace（aria-label=远程 URI label 非 fsPath，EH 仍需 URI→fsPath）② compressed folder（多段 a.label-name，aria-label 行为待 probe）③ 路径本身含 ` • `（罕见，probe 可发现）。
- **判据**：跑 `node spike8-dom.mjs --patch` → Cmd+Q 完全退出重启 → DevTools 看 [mp-spike8] spike8Verdict：`rowsWhereAriaLabelLooksLikePath` 应 ≈ 总行数（文件夹行也可能命中，因其 aria-label=目录全路径含 /）→ ✅ 方案 0。
- **结果记录**：`[ ] 待用户跑 probe 填` —— 预期 spike8Verdict.rowsWithIconLabelAriaLabel 高、rowsWhereAriaLabelLooksLikePath 高、rowsWithNativeTitle 低或 0（managed hover 不写原生 title）。

---

## 三、风险登记表（按严重度）

| ID | 风险 | 严重度 | confidence | 缓解/降级 |
|---|---|---|---|---|
| RK1 | TT 拦 innerHTML 致渲染全崩 | 🔴 阻断 | high | Spike 1 → createElement 改造 |
| RK2 | checksum 数据结构错（array vs map） | 🔴 阻断 | high | Spike 4 → 改 object map 操作 |
| RK3 | CSP 漏 media-src / 固定端口 | 🔴 阻断 | high | Spike 6 → 三件通配端口 |
| RK4 | workbench 路径/文件名漂移 | 🔴 阻断 | high | Spike 3 → 多候选数组 |
| RK5 | 文件索引重名返错文件 | 🟡 严重 | high | Spike 8 → Map<basename,[]>+title 先验 |
| RK6 | macOS 代码签名失效 | 🟡 严重 | low-medium | Spike 5 → codesign 重签 |
| RK7 | EH server 安全（DNS rebinding / 路径穿越 / 符号链接逃逸 / 放宽全局 CSP 后的同驻脚本） | 🟡 严重 | high（调研升级） | 六道闸门见 [04 安全硬化](04_EH与Renderer通信协议.md#安全硬化)；Host+bind 挡远程（硬边界），token 挡朴素同驻脚本（非硬边界，见 04 残余风险） |
| RK8 | VSCode 月更致 patch/选择器/CSP 漂移（永久维护税） | 🟡 长期 | high | 自愈 re-patch + 选择器多 fallback + 选择器命中遥测 |
| RK9 | v1.94+ Electron 样式加载变更吞掉注入 `<script>` | 🟡 | medium | Spike 2 验证 |
| RK13 | Reload Window 不重读 workbench.html（Chromium disk HTTP cache，源码 main.js:1068345 webContents.reload 普通模式）→ patch 不生效 + 与新 product.json checksum 失配弹"安装损坏" | 🟡 严重 | high（实测+源码确证） | 文档/提示/验收/Spike 判据统一要求 Cmd+Q 完全退出重启；自愈用 `nativeHostService.relaunch()` 非 reloadWindow；加运行时哨兵 `globalThis.__mpPatchRev` 检测缓存未更新；禁 reload 验收 |
| RK10 | audio waveform NO-GO（ffmpeg.wasm 需 COOP/COEP） | 🔵 已决策 | high | [11 F2](11_rejected-by-design清单.md)：audio 只播 `<audio>` 砍波形 |
| RK11 | critic 警告 PR #279743 引用可能幻觉 | 🔵 待核实 | — | 查证 microsoft/vscode PR #279743 是否存在；不影响主结论（issue #270270 真实） |
| RK12 | npm 名 `vscode-media-preview` 撞 `vscode` 组织 policy | 🔵 待核实 | medium | 发布前 spike npm org 命名空间 |
| RK14 | token 非硬边界：同驻 workbench 脚本可读 window.__MP_CONFIG__/fetch mp-config.js 拿 token | 🔵 接受 | high | 放宽全局 CSP 的固有代价；token 仅纵深防御；同驻脚本已有更高层 DOM 权，不增新能力 |

### RK13 自愈侧补强（三层探针 + 三平台 relaunch）

原 RK13 已确证 ReloadWindow 不重读 workbench.html（main.js:1068345 webContents.reload 普通模式 + Chromium disk HTTP cache）。调研补强自愈侧：

1. **relaunch 机制更正**：扩展 API（`vscode.d.ts` 21235 行）无 app 级 relaunch/restart/quitAndInstall；`nativeHostService.relaunch()` 是 VSCode 内部 DI 服务，扩展不可 import。成熟方案 = 三平台 shell relaunch（`child_process.spawn({detached:true,stdio:'ignore'})` + `unref()`）：macOS osascript quit+relaunch / Windows taskkill+relaunch / Linux kill VSCODE_PID+relaunch（VSCODE_PID 取不到 → ManualRestartRequiredError）。来源 subframe7536/vscode-custom-ui-style `src/restart.ts:17-149`。旧文档「调 nativeHostService.relaunch()」需更正。
2. **自愈触发 = 版本化 bak 缺失检测（onActivate）**，非 product.commit 比对：版本化备份名 `product.json.mp.bak.{vscode.version}` 天然承担版本比对，VSCode 更新后 version 变 → 新版本 bak 不存在 → 触发重 patch。来源 custom-ui-style `src/index.ts:24-25` + `src/path.ts:115`。activate 时点紧随 onStartupFinished 且在「更新完全重启」后天然跑，无需额外 hook。
3. **三层探针**（互补，各抓一层）：
   - L1 磁盘 integrity（VSCode 自带，integrityService.ts:104-135 读 product.checksums vs 磁盘 sha256）：patch+重算填回后 isPure=true 无通知。**仅完全重启后可信**；Reload Window 后 main 进程 productService 持旧 product.json → 假阳性。
   - L2 版本化 bak 缺失（onActivate）：抓「VSCode 更新覆盖了 workbench+product」→ 重 patch。
   - L3 运行时哨兵 globalThis.__mpPatchRev：overlay.js 启动比自身 rev 标记 vs 磁盘 manifest，抓「renderer 跑缓存旧 overlay」（Reload Window 场景，L1/L2 抓不到）。
4. **多窗口锁**：lock file `__mp-preview__.lock`（stale>10min 清）防同装目录并发 patch 损坏。来源 utils.ts:52-67。
5. **权限**：EACCES → `sudo chown -R $(whoami) '<appRoot>'`（一次性，优于 lehni「以 sudo 跑 VSCode」）。EROFS → 提示换安装方式。

confidence: high（VSCode 源码 + 两开源实现交叉确证）。

---

## 四、降级预案（若 TIER1 维护税过载或 spike 失败）

| 触发条件 | 降级到 | 代价 |
|---|---|---|
| Spike 1/2 失败（TT/CSP 不可绕） | **暂停 TIER1**，评估 docked WebviewView 侧边预览（零 patch，[11 R2](11_rejected-by-design清单.md)） | 放弃"悬停原生 Explorer"交互 |
| VSCode 连续两次大版本 patch 全断 + 自愈失效 | 同上 docked 降级，或仅保留图片 tooltip（自建树） | scope 大幅收缩 |
| 维护税超过单人可承受（月度 re-patch 频繁崩） | 收缩到"仅图片 + 固定尺寸"，砍多格式 | 放弃视频/PDF/3D 差异化 |

> 这些降级不是失败，是预设的边界。诚实记录它们，避免项目在沉默中崩盘。
