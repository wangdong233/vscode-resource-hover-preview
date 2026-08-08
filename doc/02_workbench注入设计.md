# 02 — Workbench 注入设计

> 本文档是 **workbench 文件 patch 的单一真相源**：workbench.html 注入、CSP patch、Trusted Types 约束都在此定调。04（通信协议）只讲 HTTP server API，CSP 段引用本文。

## 注入目标文件

| 文件 | 作用 |
|------|------|
| **workbench.html**（或 workbench.esm.html / workbench-apc-extension.html） | VSCode UI 根 HTML，注入静态 `<script>` 加载 overlay |
| **product.json** | VSCode 产品配置，patch checksums（抑制逻辑见 [01](01_自愈patch机制设计.md#checksum-抑制productjson-patch)，此处不重复） |
| **mp-overlay.js** | 注入的 overlay IIFE（新建文件，不改原有文件内容） |
| **mp-config.js** | 注入的静态【外链】配置脚本(patch 时烘焙 {port,token,version} 成 window.__MP_CONFIG__)。**非 inline**:script-src 'self' 放行外链加载;Trusted Types 不管 window 属性赋值(Spike6 实证)。**加载序必须在 mp-overlay.js 之前**。 |

> ⚠️ **文件名/路径不硬编码**（[10 Spike 3](10_风险登记册与spike验证.md)）：调研发现 `workbench.esm.html` vs `workbench.html`、`electron-sandbox` vs `electron-browser` 两轴存在歧义（vscode-custom-css 源码注释与官方沙箱博客矛盾）。patcher 用**有序候选数组**遍历，首个命中即用。完整路径定位见 [05](05_三平台路径与权限.md)（路径权威落点）。

## workbench.html 注入

### 注入方式：静态 `<script src>`（强制，旁路 Trusted Types）

> ⚠️ **关键约束**（[10 Spike 1/2](10_风险登记册与spike验证.md)）：VSCode workbench CSP 含 `require-trusted-types-for 'script'` + `script-src` **无 `'unsafe-inline'`**。后果：
> 1. **不能用内联 `<script>...code...</script>`**（被 CSP 拦）。
> 2. **运行时不能用 `innerHTML`/`document.write` 注入 `<script>`**（被 Trusted Types 拦）。
> 3. **唯一可行加载方式 = 在 patch 后的 workbench.html 里写一个静态 `<script src="./mp-overlay.js">`**（解析期加载，HTML parser 直接处理，旁路 TT）。这正是 vscode-custom-css / Custom UI Style 的做法（读源码 performPatch 确证）。
>
> overlay.js 自身被加载后，其内部 DOM 操作仍受 TT 管辖 → **overlay 全程必须用 `createElement`/`appendChild`/`.src=`，禁用 `innerHTML` 字符串赋值**（见 [03](03_浮动预览弹窗设计.md)、[08](08_富媒体渲染器矩阵.md)）。

### Anchor 策略（`</html>` 主锚）

【锚点更正·实证】实测 VSCode 1.129.1 stable workbench.html 尾部结构为：
```
	<body aria-label="">
	</body>

	<!-- Startup (do not modify order of script tags!) -->
	<script src="./workbench.js" type="module"></script>
</html>
```
可见 **`<script src="./workbench.js" type="module">` 在 `</body>` 之后**，且 workbench.js 是 deferred module（解析完才执行）。因此原"在 `</body>` 前……workbench.js 已加载、#workbench DOM 已构建"的论据**事实错误**——`</body>` 前注入反而把我们的 script 放在 workbench.js script 标签之前。执行顺序：无论 `</body>` 还是 `</html>` 锚点，经典 script 都先于 deferred workbench.js module 执行，故 overlay **必须用 MutationObserver 等 #workbench**（锚点选择对执行顺序无影响，只关乎健壮性）。

【定稿锚点优先级】`[ /<\/html>/i, /<\/body>/i, null(EOF append) ]`——`</html>` 为主（vscode-custom-css 数年生产先例 + 本机 spike2.mjs 实证加载成功），`</body>` 与 EOF 兜底。**删除原 ANCHORS 中 `</body>` 为首选项**。

【备选锚点·custom-ui-style 范式】可改为锚定入口串 `<script src="./workbench.js" type="module"></script>`（在其后追加），更贴近加载入口，但入口串跨 flavor/dev 版可能变体；`</html>` 更通用，推荐主用。

【CSP 实证补充】真实 CSP meta 是**多行**（每 directive、每 token 独立成行 + 制表缩进）。doc02 现有正则使用字符类 `[^"']` 与 `[^;]`（非 `.`）天然跨行匹配，**无需 `s` flag，已正确**。实测 `img-src` 已含 `data:`（base64 图片免 patch img-src），故 **v0.1 仅 patch `connect-src` 是功能最小集**（overlay fetch EH server 必需）；`img-src`/`media-src` 为 v0.2+ video/audio/blob 前置，可一并 patch 做前向兼容。路径 B fallback 由"删整段 meta"**改为 custom-ui-style 的清空 http-equiv**（`meta http-equiv=""` 中性化，比删整段少破坏一个 tag，备份原 meta 串供 revert）。evidence: 本机 workbench.html；vscode-custom-css src/extension.js performPatch；vscode-custom-ui-style src/manager/webview.ts fixCSP(L246-258) + src/manager/external.ts(L522-569)。

注入 block 示例（两 script + 顺序说明）：
```html
<!--mp-injected:vX.Y.Z:hash-->
<script src="./mp-config.js"></script>  <!-- 先:烘焙 port/token,纯 window 赋值,script-src 'self' 放行 -->
<script src="./mp-overlay.js"></script>   <!-- 后:读 window.__MP_CONFIG__ 后 fetch -->
<!--/mp-injected-->
```
两个相邻 classic `<script src>`(无 async/defer)严格按文档序执行→config 先于 overlay 就绪。两 script 注入在 `<script type=module workbench.js>` 之后,但 classic parser-blocking 先于 deferred module 执行(不影响 config;overlay 仍须等 Explorer DOM 由 MutationObserver)。

```typescript
// Anchor 字符串（注入查找用，三层 fallback，</html> 主锚）
const ANCHORS = [/<\/html>/i, /<\/body>/i, null /* EOF append */];

function injectScriptTag(html: string, version: string, hash: string): string {
    const block = `<!--mp-injected:${version}:${hash}-->\n<script src="./mp-config.js"></script>\n<script src="./mp-overlay.js"></script>\n<!--/mp-injected-->`;
    // 先清旧标记块（幂等）
    const cleaned = html.replace(/<!--mp-injected:[\s\S]*?<!--\/mp-injected-->\n?/, "");
    for (const anchor of ANCHORS) {
        if (anchor === null) return cleaned + block;
        if (anchor.test(cleaned)) return cleaned.replace(anchor, `${block}\n$&`);
    }
    return cleaned + block;
}
```

### 注入幂等性

注入前检查标记：`MARKER_RE.test(html)` → 已注入则清旧块再注新（或版本匹配直接 return）。

## CSP patch 完整规格（权威落点）

> ⚠️ **事实修正**（[10 Spike 6](10_风险登记册与spike验证.md)）：调研读 microsoft/vscode 源码 workbench.html 确证：
> - CSP 是**静态 `<meta http-equiv="Content-Security-Policy">` 标签**（非主进程动态注入）→ patch meta 可生效。
> - 生产 CSP 精确串（关键字段）：`default-src 'none'; img-src 'self' data: blob: ... https:; media-src 'self'; script-src 'self' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' https: ws:; require-trusted-types-for 'script'; trusted-types <白名单>`。
> - **生产 CSP 不含 `http://127.0.0.1`/localhost** → overlay fetch EH server(:17741) 默认被拦。**patch CSP 是强制前提，不是可选项。**
> - 有趣佐证：开发版 `workbench-dev.html` 的 `connect-src` 自带 `http://localhost:* http://127.0.0.1:*` —— 我们要 patch 的 token 正是 VSCode 自己开发版用的，官方先例，非凭空发明。

### 两条 patch 路径（Spike 2 决定选哪条）

| 路径 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A. Surgical（精确改 meta）** | 找到 CSP meta，在 `connect-src`/`img-src`/`media-src` 各追加 `http://127.0.0.1:*` | 最小侵入，保留 VSCode 原 CSP 的其他约束 | meta 结构变则解析失败 |
| **B. 清空 http-equiv**（custom-ui-style 做法，中性化，优于删整段） | 把 CSP meta 的 `http-equiv` 属性值清空（`http-equiv=""`）使该 meta 失效 | 比删整段 meta 少破坏一个 tag；备份原 meta 串供 revert | 仍放开整个 workbench CSP（攻击面扩大，[10 RK7](10_风险登记册与spike验证.md)） |

**推荐路径 A**（surgical），备份原 CSP meta 供 revert。若 Spike 2 发现路径 A 不稳（meta 结构复杂难解析），退回路径 B（备份原 meta 字符串，revert 时还原）。**两条路都要做 Spike 2 验证**。

### 路径 A：必须 patch 的三条指令

```typescript
// ⚠️ Spike6 实测修正(doc02 原正则在 1.129.1 会静默失效)：
// 1) CSP content 含 'none'/'self' 单引号,原 [^"']* 在首个 ' 处截断,只捕到 22 字符
//    → 必须用 backreference 捕获开引号、用同引号闭合(\3)
const CSP_META_RE = /(<meta\b[^>]*?\bhttp-equiv\s*=\s*(["'])Content-Security-Policy\2[^>]*?\bcontent\s*=\s*(["']))([\s\S]*?)(\3)/i;

function patchCsp(html: string): string {
    // 找 CSP meta
    const match = html.match(CSP_META_RE);
    if (!match) {
        // 无 CSP meta → 无需 patch CSP（罕见）或退路径 B
        return html;
    }
    let csp = match[4];
    const TOKEN = " http://127.0.0.1:*";  // 通配端口（server 会递增 17741→17742...）

    // connect-src：overlay fetch EH server（所有类型前置依赖）
    csp = injectCspDirective(csp, "connect-src", TOKEN);
    // img-src：<img>（图片走 base64 data: 其实免 patch，但 stream/blob 场景需 http）
    csp = injectCspDirective(csp, "img-src", TOKEN);
    // media-src：<video>/<audio> 的 blob/http src（video/audio 必需，[08](08_富媒体渲染器矩阵.md)）
    csp = injectCspDirective(csp, "media-src", TOKEN + " blob:");

    // worker-src：未设 → 回退 script-src 的 blob: → pdf.js/three.js 用 blob worker 免 patch（Spike 7 确认）
    // 若库强制 http worker，补: injectCspDirective(csp, "worker-src", TOKEN + " blob:");

    return html.replace(CSP_META_RE, `$1${csp}$5`);
}

// 2) 幂等:已含 token 则跳过;directive 缺失则不动 CSP(保守)
function injectCspDirective(csp, directive, token) {
  const segRe = new RegExp(`(${directive}\\s+)([^;]*?)(\\s*;)`, 'i');
  const sm = csp.match(segRe);
  if (!sm) return csp;                          // directive 不存在→不动
  if (sm[2].includes(token.trim())) return csp; // 已含→幂等跳过(实测不防则 3 次重patch 变 6 个)
  return csp.replace(segRe, (full, a, b, c) => a + b + token + c);
}
```

> **为什么通配 `http://127.0.0.1:*` 而非固定 17741**：[04](04_EH与Renderer通信协议.md) 的 server 端口冲突会自动递增（17742/17743...）。固定端口 + 端口漂移 = 崩。通配是 VSCode 开发版自用格式。

### 安全声明（放宽 CSP 的代价）

放宽 workbench CSP 会扩大整个 VSCode Renderer 的攻击面（非仅 overlay，[10 RK7](10_风险登记册与spike验证.md)）。任何能注入 DOM 的扩展都可达本机 localhost 服务。**缓解前提**：EH server 必须绑 `127.0.0.1` + origin 校验 + 一次性 token（[04 安全硬化](04_EH与Renderer通信协议.md#安全硬化)）。这条安全边界与 CSP patch 是配套的，不可分割。

## overlay.js 加载后的能力边界（sandbox）

注入的 `<script>` 在 Renderer（Chromium）进程运行。electron-sandbox 只移除 Node.js 集成（`require`/`fs`/`process` 不可用），**不移除 DOM 访问能力** → `document`/`window`/`addEventListener`/`fetch` 全可用（调研读 Electron Sandbox 文档 + vscode-custom-css statusbar.js 活证据）。

- ✅ overlay 能：监听 mouseenter、建浮动 popup、fetch localhost、createElement 渲染。
- ❌ overlay 不能：`require('fs')` 读文件（本来也不需要，文件由 EH server 提供）。

overlay.js IIFE 骨架见 [03](03_浮动预览弹窗设计.md)。

## 多 flavor 支持

VSCode / Insiders / VSCodium / Cursor(experimental) 的 app 目录定位见 [05](05_三平台路径与权限.md)（权威落点）。detectAndPatch 循环 patch 所有发现的安装。

## 安全校验（patch 前后）

- patch 后读回确认注入标记存在。
- `JSON.parse(product.json)` 确保格式没破坏。
- sha256 对比 overlay.js 完整复制。
- 任何校验失败 → revert（从 `.mp.bak` 恢复 workbench.html + product.json）+ 报错（同 cc-status-dot post-verify）。
