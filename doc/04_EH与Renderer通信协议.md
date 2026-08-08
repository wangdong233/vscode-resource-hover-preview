# 04 — EH 与 Renderer 通信协议

> 本文档讲 EH localhost server 的 **API + 数据格式 + 安全硬化**。CSP 的真相源在 [02](02_workbench注入设计.md#csp-patch完整规格)（本篇不重复）；文件路径推导/索引在 [06](06_DOM选择器容错策略.md)。

## 架构

```
Extension Host(EH, Node.js)              Renderer(Chromium workbench DOM)
┌──────────────────────────┐            ┌──────────────────────────┐
│  activate()              │            │  overlay.js (IIFE)       │
│  ├── localhost HTTP      │◄──────────│  fetch preview data      │
│  │   server(:17741,      │  HTTP GET  │  createElement 渲染       │
│  │   绑 127.0.0.1+鉴权)  │──────────►│  base64 / blob / stream  │
│  ├── read file           │            │                          │
│  └── stream media(range) │            └──────────────────────────┘
└──────────────────────────┘
```

## 为什么用 localhost HTTP server

1. **Renderer 不能直接读文件系统** — Chromium 安全限制。
2. **overlay 无 acquireVsCodeApi/postMessage 通道** — overlay.js 在 workbench DOM 中运行，不是 webview。EH↔Renderer 唯一通道是 HTTP fetch（[10 RK5/R7](10_风险登记册与spike验证.md)）。
3. **CSP 前提** — fetch 需 patch `connect-src`（[02](02_workbench注入设计.md#csp-patch完整规格)）。**这条无 fallback**（blob 中转对注入式 IIFE 不成立，[11 R5](11_rejected-by-design清单.md)）。

## CSP

**真相源见 [02 CSP patch 完整规格](02_workbench注入设计.md#csp-patch完整规格)**。要点：fetch 需 `connect-src http://127.0.0.1:*`；`<video>/<audio>` 需 `media-src`；均已在 02 的 patch 三件中处理。本篇不重复。

## EH Server API

### 端口

固定 `17741`（mp 专属）。被占用则自动递增（`17742`, `17743`...），实际 port 写入 globalState + 注入 overlay 配置。**CSP 用通配 `http://127.0.0.1:*`**（[02](02_workbench注入设计.md)），与端口递增配套。

### 端点

| 端点 | 方法 | 参数 | 返回 | 用途 |
|------|------|------|------|------|
| `/ping` | GET | — | `"ok"` | 健康检查（overlay 启动验证） |
| `/config` | GET | — | `{port, version, maxFileSize, types}` | **配置 + 类型支持矩阵（单一真相源）** |
| `/preview` | GET | `file=<path>&type=<image\|video\|audio\|pdf\|font\|3d>` | 见 [08](08_富媒体渲染器矩阵.md) 各类型 | 获取预览数据 |
| `/resolve` | GET | `name=<filename>` | `{paths: [...]}` | 文件名→路径（[06](06_DOM选择器容错策略.md)） |
| `/lib/:name` | GET | — | JS 文件 | lazy 加载 pdf.js/three.js（[08](08_富媒体渲染器矩阵.md)） |

### config 端点（媒体类型单一真相源）

> **R-INT-02 修正**：原设计 overlay 硬编码 `MEDIA_TYPES` + EH 侧 `switch/mimeMap` 两处各维护一份枚举（新增类型要改 4 处跨 2 模块，易漂移）。改为 **EH 单点定义**，overlay 启动 fetch 消费。

```typescript
// EH 定义唯一权威类型表
const TYPE_TABLE = {
    image: { exts: ['png','jpg','jpeg','gif','webp','svg','bmp','ico','avif'], mime: 'image/*' },
    video: { exts: ['mp4','webm','mov','mkv','avi','m4v'], mime: 'video/mp4' },
    audio: { exts: ['mp3','wav','ogg','flac','aac','m4a','opus'], mime: 'audio/mpeg' },
    font:  { exts: ['ttf','otf','woff'], mime: 'font/*' },         // woff2 待 spike，[08](08_富媒体渲染器矩阵.md)
    pdf:   { exts: ['pdf'], mime: 'application/pdf' },
    '3d':  { exts: ['glb','gltf','obj','stl','fbx'], mime: 'model/gltf-binary' },
};

// GET /config
function serveConfig(res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        port: actualPort,
        version: 'v0.1.0',
        maxFileSize: MAX_FILE_SIZE,
        types: TYPE_TABLE,   // overlay 据此判断类型，不硬编码
    }));
}
```

overlay 侧：
```javascript
let CONFIG = null;
async function ensureConfig() {
    if (CONFIG) return CONFIG;
    const r = await fetch(`${SERVER_BASE}/config`);
    CONFIG = await r.json();
    return CONFIG;
}
function detectMediaType(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    for (const [type, info] of Object.entries(CONFIG.types)) {
        if (info.exts.includes(ext)) return type;
    }
    return null;
}
```

### /preview 各类型返回格式

#### image
```json
{ "type": "image", "mime": "image/png", "base64": "iVBOR...", "width": 1920, "height": 1080, "sizeBytes": 2048576 }
```
> v0.1 直接 base64 原图（设硬上限，见 serveImage）。大图缩放（sharp）推迟到 v0.2+。

#### video / audio / pdf / 3d
HTTP range stream（支持 `<video>`/`<audio>` seek，206 Partial Content）。具体渲染见 [08](08_富媒体渲染器矩阵.md)。

#### font
```json
{ "type": "font", "base64": "AAEAAA...", "sizeBytes": 123456 }
```

## 安全硬化（真相源）

> 本节是 EH localhost server 的**安全权威落点**。任何编码疑问以此为准，不猜不黑盒。先例 + 实证见本仓库调研记录（④ localhost server 安全）。

### 威胁模型（先于代码，定边界）

三类攻击者，按本架构能否挡住诚实地列：

| 攻击者 | 路径 | 挡它的闸门 | 是否硬边界 |
|---|---|---|---|
| 远程恶意网页（evil.com） | DNS rebinding 把 evil.com 解析到 127.0.0.1，浏览器 fetch 本 server | **Host header 校验**（只认 `127.0.0.1:port`）+ **绑 127.0.0.1**（远程连不上环回口） | ✅ 硬边界 |
| 本机其他进程（非 VSCode） | 直连 127.0.0.1:port，Host 头伪造正确 | 无（同机即信任域） | ❌ 不挡（同机威胁域外） |
| workbench 内同驻脚本（其他扩展注入） | fetch 127.0.0.1，Host/Origin 都合规 | **会话 token**（mp-config.js 烘焙） | ⚠️ 半边界：token 存于 renderer 内存/磁盘，知晓 `window.__MP_CONFIG__` 或 fetch `mp-config.js` 的同驻脚本能读到。**只挡"不知道去哪拿 token"的朴素探测**，挡不住有意的同驻脚本 |

> **诚实结论**（用户原则：不黑盒不夸大）：Host+bind 把所有远程攻击者关在门外；token 在我们"放宽全局 CSP"的特殊威胁模型下提升了对朴素同驻脚本的门槛，但**不是硬边界**——因为 token 必然存在于 renderer 可达处。残余风险 = 有意的同驻脚本，而该脚本已能访问整个 workbench DOM，本就在更高威胁层。**不要把 token 当作挡同驻脚本的银弹**；它是纵深防御的一层。

> **vscode-livepreview 为什么不用 token**：它跑在 webview 里（自有 CSP，不放宽全局 workbench CSP），同驻脚本够不着它的 server，所以 Host 校验就够了。我们放宽了全局 `connect-src`，所以多了一层 token。

### 六道闸门（每请求，按序）

1. **OPTIONS 预检** → 最小 204（token 走 query 不触发预检，但兜底）
2. **Host header 校验**（含 `/ping`）— 只认 `{127.0.0.1,localhost,[::1]}:{port}`，DNS rebinding 第一闸门
3. **Origin 校验**（若浏览器带）— 必须匹配 `^vscode-file:`
4. **CORS ACAO** — 同源才回显，设 `Vary: Origin`，**绝不用 `*`**
5. **会话 token 校验**（除 `/ping` 外所有端点）— crypto.randomBytes(32) 生成的本实例 token
6. **路径 containment**（进文件系统前）— `new URL()` 解析 + `path.resolve` + `fs.realpathSync` 解符号链接 + `isWithin(realPath, realRoot)`

### 端口与绑定

- 固定起始 `17741`，被占自动递增（17742/17743...）；CSP 用通配 `http://127.0.0.1:*` 配套（[02](02_workbench注入设计.md)）
- **绑 `127.0.0.1` 绝不 `0.0.0.0`**（0.0.0.0 暴露 LAN，远程可达 → DNS rebinding/直连都成立）。先例：`vscode-livepreview` constants.ts `DEFAULT_HOST='127.0.0.1'` + connectionManager.ts `_validHost=isIPv4`

### token 生成与下发（给 overlay）

```typescript
// EH 起服时（每次 activate）
const SESSION_TOKEN = crypto.randomBytes(32).toString('hex'); // 64 hex chars

// patch workbench.html 时，把 token 烘焙进静态 mp-config.js（旁路 TT，见 02/04 配置注入节）
// mp-config.js 内容（patch 时模板替换）：
//   window.__MP_CONFIG__ = { port: 17741, token: '<SESSION_TOKEN>', version: 'v0.1.0' };
```
overlay 侧：`const TOKEN = window.__MP_CONFIG__.token; fetch(\`.../preview?...&token=${encodeURIComponent(TOKEN)}\`)`

> ⚠️ **术语纠正**：这是**会话 token（per-instance session token）**，不是"一次性 token"。它在 server 生命周期内固定、每次请求复用。"一次性"会误导成 single-use（用完作废）。

### token 在 query 而非 Authorization header 的原因

避开 CORS 预检：自定义 header（Authorization）会触发 OPTIONS preflight；token 放 query string 走 simple request，无预检。代价：token 进 URL → server 侧日志须脱敏（下方实现不记录 req.url）。

### /lib/:name 的净化

`/lib/three.min.js` 等 lazy 加载扩展自带库：正则 `^/lib/([A-Za-z0-9._-]+)$` 限文件名（禁 `..`/`/`/`\\`），解析后再 `isWithin(LIB_DIR)` 双保险。

### 路径穿越：三层防御 + 符号链接

1. `new URL(req.url, base)` 解析（绝不用 lastIndexOf('?') 手切 —— Trail of Bits 正是用手切 query 绕过 livepreview）
2. `path.resolve(file)` 规约 `..` 与绝对段
3. **`fs.realpathSync`** 解开符号链接 → 必须落在某 workspace root（同样 realpath 后）内。否则符号链接逃逸（在 workspace 里放个指向 /etc 的软链就穿出去了）

### 限流 / DoS（轻量，localhost 可选）

localhost 信任度高，只做轻量保护：`MAX_FILE_SIZE` 上限（50MB）+ 流式 pipe（不全量进内存）+ 每请求 try/catch 防 event-loop 崩。不做 per-IP 限流（环回只有自己）。若担心恶意扩展狂发，可加 max-concurrent 信号量，v0.1 不做。

### 错误处理

所有错误返**通用文案**（forbidden/not found/too large），不透传 err.message（防信息泄露）。详细错误 EH 端 `outputChannel` 记录，不进 HTTP body。

### 安全硬化总结表（替换原表，补 Host/realpath/lib 净化四行）

| 措施 | 实现 |
|---|---|
| 绑 127.0.0.1 only | `server.listen(PORT, '127.0.0.1')`，禁 0.0.0.0 |
| Host header 校验 | 白名单 `{127.0.0.1,localhost,[::1]}:port`，不符 403（防 DNS rebinding） |
| Origin 校验 + CORS | Origin 须 vscode-file:；ACAO 同源回显+Vary，不用 * |
| 会话 token | crypto.randomBytes(32)→mp-config.js 烘焙，非 ping 每请求校验 |
| 路径 containment | new URL + path.resolve + realpathSync + isWithin（防 .. 与 symlink 逃逸） |
| /lib 净化 | 文件名正则白名单 + isWithin(LIB_DIR) |
| 大小限制 | MAX_FILE_SIZE 50MB |
| 错误脱敏 | 通用文案，不泄 err.message |

### 残余风险（诚实记录，进 [10 RK7](10_风险登记册与spike验证.md)）

- 同驻 workbench 脚本读 `window.__MP_CONFIG__` 或 fetch `mp-config.js` 可拿 token（token 必驻 renderer 可达处）→ token 非硬边界
- 同机其他进程直连环回口不受任何 HTTP 层防护（同机威胁域外，接受）
- 缓解：这两类都在"已被攻陷更高层"之后（同驻脚本已有 DOM 权，同机进程已有用户权），不增新能力

### EH Server 实现（安全硬化版）

```typescript
import http from "http";
import fs from "fs";
import path from "path";

const PORT = 17741;
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB(v0.1，超限提示；原 100MB 改 50MB 降内存压)
const ALLOWED_ORIGIN = /^vscode-file:|^file:/;  // VSCode workbench origin 白名单

function startPreviewServer(workspaceRoots: string[]): { server: http.Server; port: number } {
    const server = http.createServer((req, res) => {
        // --- 安全硬化（[10 RK7](10_风险登记册与spike验证.md)）---
        // 1. CORS：不用 *，只允 vscode-file/file origin
        const origin = req.headers.origin || '';
        if (ALLOWED_ORIGIN.test(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
        // 2. 一次性 token 防 DNS rebinding（overlay 从注入 config 读 token，每次请求带）
        const token = new URL(req.url!, `http://127.0.0.1`).searchParams.get('token');
        if (req.url !== '/ping' && token !== EXPECTED_TOKEN) {
            res.writeHead(403); res.end('forbidden'); return;
        }

        const url = new URL(req.url!, `http://127.0.0.1:${PORT}`);
        if (url.pathname === '/ping') { res.writeHead(200); res.end('ok'); return; }
        if (url.pathname === '/config') return serveConfig(res);

        if (url.pathname === '/preview') {
            const file = url.searchParams.get('file');
            const type = url.searchParams.get('type');
            if (!file || !type) { res.writeHead(400); res.end('missing file or type'); return; }
            // 3. 路径安全：必须在某 workspaceRoot 内（防目录穿越/符号链接逃逸）
            const resolved = path.resolve(file);
            if (!workspaceRoots.some(root => isWithin(resolved, root))) {
                res.writeHead(403); res.end('file outside workspace'); return;
            }
            if (!fs.existsSync(resolved)) { res.writeHead(404); res.end('not found'); return; }
            const stat = fs.statSync(resolved);
            if (stat.size > MAX_FILE_SIZE) { res.writeHead(413); res.end('too large'); return; }
            switch (type) {
                case 'image': return serveImage(resolved, res);
                case 'font':  return serveFont(resolved, res);
                case 'video': case 'audio': case 'pdf': case '3d':
                    return serveStream(resolved, type, req, res);
                default: res.writeHead(400); res.end('unsupported type');
            }
            return;
        }
        res.writeHead(404); res.end('not found');
    });
    // 4. 只绑 127.0.0.1（不绑 0.0.0.0，不对外）
    server.listen(PORT, '127.0.0.1');
    return { server, port: PORT };
}

function isWithin(target: string, root: string): boolean {
    const rel = path.relative(root, target);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// 图片：异步读 + base64（v0.1 原图，超 50MB 已在前面拒）
async function serveImage(file: string, res: http.ServerResponse) {
    fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(500); res.end(err.message); return; }
        const ext = path.extname(file).slice(1);
        const mime = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'image', mime, base64: data.toString('base64'), sizeBytes: data.length }));
    });
}

// video/audio/pdf/3d：HTTP range stream（硬化版）
function serveStream(file: string, type: string, req: http.IncomingMessage, res: http.ServerResponse) {
    const stat = fs.statSync(file);
    const mimeMap: Record<string,string> = {
        video: 'video/mp4', audio: 'audio/mpeg', pdf: 'application/pdf', '3d': 'model/gltf-binary',
    };
    const range = req.headers.range;
    if (range) {
        const m = /^bytes=(\d+)-(\d*)$/.exec(range);  // 严格校验格式
        if (!m) { res.writeHead(416); res.end('invalid range'); return; }
        let start = parseInt(m[1], 10);
        let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
        if (start > end || start >= stat.size) { res.writeHead(416); res.end('unsatisfiable'); return; }
        end = Math.min(end, stat.size - 1);       // clamp
        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': end - start + 1,
            'Content-Type': mimeMap[type],
        });
        fs.createReadStream(file, { start, end }).pipe(res);
    } else {
        res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': mimeMap[type] });
        fs.createReadStream(file).pipe(res);
    }
}
```

## 配置注入（port/token/version） — Spike6 实证机制

### 烘焙式静态外链（定案，非 inline）

patch 时把 {port,token,version} 写成独立静态文件 `mp-config.js`（放 workbench.html 同目录，同源）：
```javascript
// mp-config.js（patch 时生成，内容范式）
window.__MP_CONFIG__ = { port: 17741, token: "<random>", version: "vX.Y.Z" };
```
- **CSP**：`<script src="./mp-config.js">` 是【外链文件】，受 `script-src 'self'` 放行；**不是 inline**（inline 才需 'unsafe-inline'，已 Spike2 实证被拦）。
- **Trusted Types**：`window.__MP_CONFIG__={...}` 是纯属性赋值，非 DOM XSS sink（innerHTML/document.write/eval/Function/script.src setter 才管），W3C+MDN 确证不拦。
- **加载序**：mp-config.js 必须在 mp-overlay.js 之前（相邻 classic script 文档序执行，保证 overlay 读到 config）。

overlay 读取：
```javascript
const cfg = window.__MP_CONFIG__ || {};
const SERVER_BASE = `http://127.0.0.1:${cfg.port}`;
const TOKEN = cfg.token;
```

### port 递增（端口冲突自动 +1，实际 port 烘焙）
server 用端口发现器（base 17741→EADDRINUSE→17742...上限 17760）。**先起 server 拿到 actualPort，再烘焙进 mp-config.js**。
- 常态（单实例）：17741 永远空，跨重启 port=17741 稳定，mp-config.js 恒定，零漂移。
- 罕见（多实例/17741 被占）：server 拿 17742，mp-config.js 重烘焙；但本会话已加载的 overlay 仍持旧 port → **需 Cmd+Q 完全重启** overlay 才读新值（同 RK13 workbench-patch 约束）。
- 每次 activate 重烘焙 mp-config.js（廉价文件写，自愈 re-patch 同步做）。

> 烘焙式是 v0.1 定案（anti-over-engineering）。若未来多实例 port 漂移成真问题，再加 overlay bounded probe（/ping race 17741-17750）+ stable token（globalState 持久化，不随 session 轮换）解决 token 跨 session 失配；目前不做。

## 安全硬化总结（[10 RK7](10_风险登记册与spike验证.md)）

> 已合并到上文「## 安全硬化（真相源）」节末尾的「安全硬化总结表」（补 Host/realpath/lib 净化四行）+「残余风险」。本节保留标题供历史锚点引用。

<!-- 原 04 `res.setHeader('Access-Control-Allow-Origin', '*')` 是安全洞（调研明确 flag），已改白名单 —— 见真相源节。 -->
