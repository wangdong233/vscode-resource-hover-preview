# 07 — 开发计划与 MVP 任务拆解

> critic 纠偏：原 07 的逐文件 0.5 天任务清单像"教程 walkthrough"，对计划文档过度规定实现细节。本篇精简为 **spike 闸门 + 里程碑 + 验收 + 模块级任务** 四块；逐文件实现细节移到代码注释。

## ⚠️ 第 0 阶段：Spike 闸门（v0.1 编码前必须先过）

> **铁律**：[10 风险登记册](10_风险登记册与spike验证.md) 的 Spike 1-6 全部 GO 前，不进入 v0.1 编码。这是 5 维调研识别的 make-or-break 点，跳过 = v0.1 静默失败。

| Spike | 验证内容 | 判据 | 阻断什么 |
|---|---|---|---|
| **1** | Trusted Types 对 innerHTML 的约束 | DevTools 测 `innerHTML='<div>'` 是否抛 TrustedHTML | 整个渲染层写法（createElement vs patch TT 白名单） |
| **2** | 静态 `<script src>` 注入 + CSP 真相 | patch test.js **Cmd+Q 完全重启**（非 reload，reload 用缓存不生效）见 console.log；确认无第二 CSP 头/SRI | patch CSP 路径（surgical vs 删 meta） |
| **3** | workbench 入口路径 | 本机 find 确认实际 workbench*.html 路径 | patcher 候选数组定稿 |
| **4** | checksum 抑制策略 | 打开 product.json 确认 object map + key 命名 | checksum patch 代码（删 key vs 重算） |
| **5** | macOS 代码签名 | patch 后重启观察签名警告 | macOS codesign 重签流程 |
| **6** | **CSP patch 三件通配端口 + mp-config.js 配置注入端到端** | `node spike6.mjs --patch`(已交付项目根,280 行)→ Cmd+Q 完全退出 → 重开 → DevTools Console 见 `[mp-config] loaded` + `[mp-overlay] /ping -> 200 "ok" ✅`;Network 面板 ping 请求 200 + 无第二 CSP 头 | v0.1 编码(任何需 fetch 的类型) |
| (8) | resolve 索引重名 + title 先验 | 验证 DOM title 是否含全路径 | 文件路径推导方案（免索引 vs 消歧索引） |

**Spike 1/2 是真正的生死验证**——失败则 TIER1 路径动摇，触发 [10 降级预案](10_风险登记册与spike验证.md#四降级预案若-tier1-维护税过载或-spike-失败)（评估 docked WebviewView 侧边预览）。

> Spike6 已在 fixture 跑通全链(CSP 三件幂等/port 递增烘焙/token 403/revert byte-identical);真机 Cmd+Q 步是编码者第一动作,见 spike6.mjs 头注释 + doc10 结果记录。

## 里程碑

| 里程碑 | 内容 | 预估（单人） | 前置 |
|--------|------|--------------|------|
| **v0.1 MVP** | patch 机制 + 图片悬停预览（浮动 + 四角缩放 + 四象限定位 + 尺寸记忆） | ~1.5 周 | Spike 1-6 + 8 全过 |
| **v0.2** | + 视频预览（range stream + `<video>`） | +2 天 | media-src patch |
| **v0.3** | + 音频（`<audio>`，**波形砍**）+ 字体（FontFace glyph） | +3 天 | [11 F2](11_rejected-by-design清单.md) |
| **v0.4** | + PDF（pdf.js） | +3 天 | [Spike 7](10_风险登记册与spike验证.md) 过 |
| **v0.5** | + 3D（three.js + OrbitControls） | +4 天 | Spike 7 过 |
| **v1.0** | 打磨（三平台测试/codesign 流程/pin/错误处理/README demo/`npx` 分发） | +1 周 | |

> **预估修正**：原 07 "v0.1 ~1 周"低估（5 个 must-fix + 6 个 spike + 失败域处理）。v0.1 调整为 ~1.5 周。audio 波形 NO-GO（原 +3 天含波形，现砍）。

## v0.1 MVP 范围（用户决策 2026-08-08）

- ✅ 浮动弹窗（position:fixed）
- ✅ **四角缩放**（4 个 resize handle，对角固定）
- ✅ **智能四象限定位**（按文件项位置自动选展开方向，位置固定）
- ✅ 尺寸记忆（全局单一尺寸，localStorage）
- ✅ 图片预览（png/jpg/jpeg/gif/webp/svg/bmp/ico/avif）
- ✅ pin（固定不随 mouseleave 消失，可选）
- ❌ **不做自由位置拖拽**（[11 F1](11_rejected-by-design清单.md)）

## v0.1 模块级任务

> 不再逐行 walkthrough，只列模块 + 关键修正点。实现细节进代码注释。

1. **项目初始化**(展开规格,直接落地):

   ```json
   // package.json(根,patcher 包)
   {
     "name": "vscode-media-preview",
     "version": "0.1.0",
     "type": "module",
     "bin": { "vscode-media-preview": "dist/patch.js" },
     "scripts": {
       "build": "tsc",
       "prepublishOnly": "npm run build && npm run companion:build && npm run companion:package && cp companion/*.vsix dist/",
       "patch": "npx tsx src/patcher.ts",
       "revert": "npx tsx src/patcher.ts --revert",
       "status": "npx tsx src/patcher.ts --status",
       "test": "node hooks/test-patcher-io.mjs && node hooks/test-overlay-hash.mjs"
     },
     "engines": { "node": ">=18" },
     "files": ["dist/", "resources/", "hooks/", "docs/", "*.md", "LICENSE", "tsconfig.json", "companion/"],
     "devDependencies": {
       "@types/node": "^20.11.0",
       "typescript": "^5.4.0",
       "prettier": "^3.3.0",
       "@types/vscode": "^1.84.0",
       "@vscode/vsce": "^3.2.0"
     }
   }
   ```

   **两个 tsconfig 的关键差异**(复用 cc-status-dot 铁律):
   - 根 `tsconfig.json`(patcher): `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`, `"type": "module"`(package.json), `"include": ["src/**/*.ts"]`, `"outDir": "dist"`, `rootDir` 指 src → dist/patch.js 是 ESM。
   - `companion/tsconfig.json`(VSCode 扩展): **`"module": "CommonJS"`, `"moduleResolution": "Node"`**(VSCode 扩展宿主至今是 CJS,这点与 patcher 相反), `"include": ["extension.ts"]`, `"outDir": "dist"` → companion/dist/extension.js 是 CJS。

   **src/ 目录结构**(逐文件职责):
   ```
   src/
     patcher.ts          # CLI 入口 run(argv): --patch/--revert/--status/--patch-only; 编译为 dist/patch.js = bin
     discover.ts         # discoverVscodeInstalls(): 三平台[05] + workbench 多候选路径; 返回 [{appDir, workbenchHtmlPath, productJsonPath, flavor}]
     checksum.ts         # recomputeChecksum(filePath): crypto SHA256→base64→去=; patchProductChecksums(object map,重算填回)
     atomic.ts           # writeAtomicSync / writeAtomicSyncBuf / atomicCopyFileSync / backupOnce(复用 cc-status-dot 原样)
     semver.ts           # cmpVerStr(从 cc-status-dot 复制,pure)
   patcher-state.ts     # readWorkbenchState() fresh/stale/absent; INJECT_VERSION / MARKER 常量
     overlay-bake.ts     # buildOverlayJs(config): 读 resources/overlay.template.js, 占位符替换, 返回 {js, hash}; installOverlayJs(): atomic 复制到 workbench 同目录 + stale-sweep
   resources/
     overlay.template.js # overlay.js 模板, 顶banner `/*mp-overlay:__VERSION__:__HASH__*/`, 内含 __MP_CONFIG__ 占位
   companion/
     extension.ts        # activate(onStartupFinished): loadConfig→detectAndPatch→startServer→buildIndex; deactivate
     package.json        # main: ./dist/extension.js; activationEvents: ["onStartupFinished"]
     tsconfig.json       # CJS(见上)
     .vscodeignore       # 排除 **/*.ts / extension.ts / tsconfig.json / node_modules
   hooks/
     test-patcher-io.mjs # spawn dist/patch.js --self-test-io, 断言 fresh/stale/absent + checksum 重算
     test-overlay-hash.mjs# 断言 buildOverlayJs 输出稳定 + assertCompiles 通过
   ```

   **build 流程**: `tsc`(根,ESM)→ `dist/patch.js` + `dist/*.js`; companion `tsc -p companion/tsconfig.json`(CJS)→ `companion/dist/extension.js`; `vsce package --no-dependencies`(companion)→ `.vsix`; `cp companion/*.vsix dist/`。`npx -y vscode-media-preview@latest` 跑 `dist/patch.js` 默认 install 分支。

   **bin 入口四态**(复用 cc-status-dot 适配):
   - 默认(无参): discover → installRuntimeFiles(复制 overlay.js 到 workbench 同目录) → patchWorkbench(checksum重算+CSP patch+注入script) → post-verify → reloadHint(**提示 Cmd+Q 完全退出,非 Reload Window**)
   - `--revert`: per-step try/catch(restoreWorkbench/restoreProduct/copyCsp/移除overlay.js), 收集失败, 汇总, **提示 Cmd+Q**
   - `--status`: 只读三态报告, 不改盘
   - `--patch-only`(companion 调): 仅 discover+patchWorkbench, 跳过 install/companion(幂等, 每次 onStartupFinished 安全调)

2. **discover.ts**（[05](05_三平台路径与权限.md)）：三平台发现 + workbench 多候选路径。

3. **patcher.ts**（[01](01_自愈patch机制设计.md)+[02](02_workbench注入设计.md)）— 定稿职责清单(编码者照此实现,零歧义):
   1. `locateWorkbench(appDir)`:env.appRoot 优先(扩展态)+ 平台发现(CLI 态);嵌套候选 workbenchDir×htmlName 首存在即返;返回 `{workbenchPath, productPath, outDir}`。
   2. `backupIfAbsent(src,bak)`:同目录 .bak,已存在不覆盖;`rollbackAll` 从 .bak 还原两文件。
   3. `acquireLock()/releaseLock()`:`<appDir>/__mp-patcher.lock`,10min stale-break。
   4. `clearExistingPatches(html)`:strip `<!--mp-injected:...-->` 到 `<!--/mp-injected-->` 整块(含 script)。
   5. `patchCsp(html)`:多行 meta 解析,connect-src/img-src/media-src 各追加 ` http://127.0.0.1:*`(media-src 再加 ` blob:`);无 meta 或解析失败 → 路径 B 清空 http-equiv(记原 meta 入 .bak 已含);返回 patched html。
   6. `injectScript(html,version,hash)`:`</html>` 前插标记块(主锚)+ `</body>`/EOF 兜底。
   7. `recomputeChecksum(buf)`:`sha256.base64.replace(/=+$/,'')`。
   8. `stringReplaceChecksum(productRaw, wbKey, newCk)`:正则替单 key 保格式;或 iterate-all-on-disk 重算(custom-ui-style 范式,更防御)。
   9. `atomicWrite(path,content)`:tmp+rename(或 atomically dep)。
   10. `postVerify(...)`:marker 在 ∧ `JSON.parse(product)` ok ∧ `checksums[wbKey]===recompute(盘上 workbench.html)` ∧ overlay.js 存在。
   11. `detectAndPatch()`:`ran`Set 去重 + readState(fresh/stale/absent via marker+version stamp + mtime 快路径) + 顺序(backup→patch html→write html→recompute→patch product→copy overlay→postVerify) + 失败 revert + 提示 Cmd+Q(或调 restartApp)。
   12. `--revert` CLI:rollback 两文件 + 删 overlay.js + 清锁。

   关键不变量:**checksum 必须在 workbench.html 写盘后重算**(见 doc01 更正)。evidence 汇总见 references。

4. **server.ts**（[04](04_EH与Renderer通信协议.md)）：localhost :17741 绑 127.0.0.1 + token + origin 白名单 + 路径穿越防护 + /ping//config//preview//resolve + range stream 硬化。
5. **fileIndex.ts**（[06](06_DOM选择器容错策略.md)）：findFiles 建索引(Map<basename,[]>) + watcher 增量 + resolve 消歧。**先做 title 先验 spike**。
6. **overlay.js**（[03](03_浮动预览弹窗设计.md)）：等 Explorer + event delegation + 四象限定位 + 四角缩放 + 尺寸记忆 + 图片渲染(createElement) + pin + hide/dispose。**全程 createElement，禁 innerHTML（Spike 1）**。
7. **companion/extension.ts**：activate(onStartupFinished→detectAndPatch + start server + build index) / deactivate。
8. **测试**：macOS 端到端（patch→**Cmd+Q 完全重启**→hover png→四象限定位→四角缩放→记忆→pin→revert）+ 更新模拟 re-patch（注：Reload Window 不重读 workbench.html、patch 不生效，不能用 reload 验收）。

## v0.1 自愈 + checksum 任务清单(调研已闭环,可直接编码)

- [ ] T-self-1 baseOutDir 解析:优先 `vscode.env.appRoot+'/out'`,fallback `require.main.filename` 目录(custom-ui-style path.ts:24-38)。写 `discoverVscodeInstalls` 之外新增 `resolveBaseOutDir()`。
- [ ] T-self-2 recomputeChecksum(sha256+base64去=,锁 SHA256 勿用 md5,勿抄 lehni 原版)。
- [ ] T-self-3 patchProductChecksums:遍历 product.checksums object map,join baseOutDir,existsSync skip,recompute,tab 缩序列化。**必须排在 patch workbench.html + copyOverlay 之后**。
- [ ] T-self-4 版本化备份:`product.json.mp.bak.{vscode.version}` + `workbench.html.mp.bak.{vscode.version}`(cpSync 非 rename)。
- [ ] T-self-5 多窗口 lock file:withLockFile(5s 等,stale 10min 清)。
- [ ] T-self-6 权限检测:W_OK 失败→EACCES 提示 chown,EROFS 提示换安装方式。
- [ ] T-self-7 onActivate 自愈触发:exists(bak.{version}) && markerMatches?→fresh 跳过:else detectAndPatch。
- [ ] T-self-8 三平台 relaunchApp(spawn detached+unref):macOS osascript / Windows taskkill / Linux kill VSCODE_PID(取不到抛 ManualRestartRequiredError)。**禁 reloadWindow**。
- [ ] T-self-9 运行时哨兵:overlay.js 注入 rev 标记 + EH 写磁盘 manifest + overlay 启动比对→不符 signalCacheMismatch(提示 Cmd+Q)。
- [ ] T-self-10 post-verify:JSON.parse(product.json) + 读回 marker,任一失败从 bak revert。
- [ ] T-self-11 revert 命令(`--revert`/command):清 marker+还原 CSP+还原 checksums+删 overlay。
- [ ] T-self-12 验收:Cmd+Q 完全重启后无「安装损坏」通知 + DevTools 见 overlay LOADED + __mpPatchRev===manifest;Reload Window 后 sentinel 触发 cache-mismatch 信号(反向验证 L3)。

依赖文档:01 checksum 节 + 自愈流程节(本调研产出)、10 RK13、02 CSP/注入、05 路径。

## v0.1 验收标准

1. ✅ `npx -y vscode-media-preview@latest` 一键安装（patch + 提示 Cmd+Q 完全退出重启）。
2. ✅ **完全重启（Cmd+Q 后重开）** 后悬停 .png/.jpg/.gif/.webp → ~300ms 浮动弹窗显示图片（Reload Window 不生效）。
3. ✅ 弹窗按文件项位置自动四象限定位（左上项→右下展开等），不遮挡文件项，不超出屏幕。
4. ✅ 四角均可拖拽缩放（对角固定）。
5. ✅ 缩放尺寸 重启后恢复（localStorage，reload/重启皆持久）。
6. ✅ pin 后弹窗不随 mouseleave 消失；非 pin 时离开 200ms 隐藏。
7. ✅ 非媒体文件（.py/.ts/.md）不弹窗。
8. ✅ 同名文件不静默返错文件（消歧或诚实提示）。
9. ✅ `--revert` 干净还原 workbench.html + product.json。
10. ✅ VSCode 更新覆盖后，下次启动（onStartupFinished）触发自愈 re-patch 写盘；**patch 生效需再 Cmd+Q 完全重启一次**（re-patch 写盘 vs 生效是两步，Reload Window 不生效）。
11. ✅ macOS patch 后无签名警告（或按 Spike 5 流程重签）。

## 技术栈

| 组件 | 技术 | 说明 |
|------|------|------|
| Patcher | TypeScript + tsx | 同 cc-status-dot |
| EH Server | Node.js `http` | 无依赖（标准库） |
| Extension | VSCode Extension API | activate/deactivate |
| Overlay | Vanilla JS(IIFE) | 注入 workbench，**全程 createElement**（TT） |
| 图片 | base64 → `<img src=data:>` | v0.1 原图（≤50MB），sharp 缩放推迟 v0.2 |
| 视频 | HTTP Range(206) | createReadStream，硬化边界 |
| pdf.js / three.js | lazy appendChild `<script src>` | 首次遇类型才加载，blob worker（[08](08_富媒体渲染器矩阵.md)） |
| 字体 | FontFace API | 免 opentype.js 体积 |

## 分发（[11 R4](11_rejected-by-design清单.md)）

- npm：`npm publish`（包名 `vscode-media-preview`，发布前 spike 核实 npm `vscode` 组织 policy，[10 RK12](10_风险登记册与spike验证.md)）。
- 用户：`npx -y vscode-media-preview@latest`。
- **不上 Marketplace**（patch 内部文件违政策）。
- GitHub：版本 + release notes + rollback 指引 + demo gif。

## 命名

- npm 包名：`vscode-media-preview`（实测可用，待核实 policy）
- GitHub：`vscode-media-preview`
- 注入标记：`<!--mp-injected:vX.Y.Z:hash-->`
- 端口：`17741`
- localStorage 前缀：`mp.`
- overlay 文件：`mp-overlay.js`
