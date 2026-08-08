# 01 — 自愈 Patch 机制设计

## 概述

复用 cc-status-dot 的 `detectAndPatch()` 自愈模式，目标从 CC 的 `extension.js` 改为 **VSCode 自己的 workbench 文件**。patch 机制相似，但**失败域不同级别**（见 [00 失败域对比表](00_总览与架构决策.md#-与-cc-status-dot-的关键差异失败域不同级别)与本篇 §失败域与自愈边界）。

## 核心流程

```
扩展 activate(onStartupFinished)
  └── detectAndPatch()
        ├── 1. discoverVscodeInstalls() → 定位 VSCode 安装路径(三平台，多候选，[05](05_三平台路径与权限.md))
        ├── 2. readWorkbenchState() → 读 workbench.html，找注入标记
        ├── 3. 判断:
        │     ├── "fresh"(标记在 + 版本匹配) → return(跳过)
        │     ├── "stale"(标记在但版本旧) → re-patch
        │     └── "absent"(标记不在 = VSCode 更新覆盖) → re-patch
        ├── 4. runPatcher()【⚠️ 顺序关键，见伪代码】:
        │     ├── backupIfAbsent(workbench.html + product.json) → 同目录版本化 .bak
        │     ├── clearExistingPatches + patchCsp + injectScript → 组装新 html
        │     ├── atomicWrite(workbench.html) → ★先落盘最终字节
        │     ├── recomputeChecksum(读回盘上 workbench.html) → sha256/base64/去=
        │     ├── stringReplaceChecksum(product.json) → 重算填回(保格式)
        │     ├── copyOverlayJs → mp-overlay.js + mp-config.js 落盘
        │     └── postVerify → marker ∧ JSON.parse ∧ checksums[wbKey]===recompute(盘)【Cmd+Q 不弹损坏唯一闸门】
        └── 5. 提示用户完全退出重启（Cmd+Q；Reload Window 不重读 workbench.html，patch 不生效）
```

## 与 cc-status-dot 的关键差异

| 维度 | cc-status-dot | 本项目 |
|------|--------------|--------|
| **patch 目标** | `~/.vscode/extensions/anthropic.claude-code-*/extension.js` | VSCode app 目录 `workbench.html` + `product.json`（[路径见 05](05_三平台路径与权限.md)，不在此硬编码） |
| **目标性质** | 第三方扩展文件 | **IDE 核心二进制** |
| **文件权限** | 用户可写 | macOS/Linux 可能需 sudo |
| **代码签名** | 无 | VSCode app 有 Apple 签名（[10 Spike 5](10_风险登记册与spike验证.md)） |
| **checksum 校验** | 无 | 须抑制 product.json checksums（见下） |
| **CSP/Trusted Types** | 无（扩展 host） | workbench 强 CSP + TT（[02](02_workbench注入设计.md)） |
| **更新触发** | CC 扩展更新 | VSCode 月更（频繁） |
| **标记位置** | `extension.js` 内 `/*cc-status-dot-injected:vx.y.z:hash*/` | `workbench.html` 内 `<!--mp-injected:vx.y.z:hash-->` |
| **失败域** | 仅状态点不显示 | 整个编辑器 |
| **分发** | npm + `npx` | 同 |

## 注入标记设计

```html
<!-- 在 workbench.html 的 </html> 前注入（静态 script，旁路 Trusted Types）；</html> 主锚 = vscode-custom-css 数年先例 + 本机 spike2 实证，</body>/EOF 兜底（详见 [02 Anchor](02_workbench注入设计.md)） -->
<!--mp-injected:v0.1.0:a1b2c3d4-->
<script src="./mp-config.js"></script>   <!-- 先：烘焙 port/token，纯 window 赋值，script-src 'self' 放行 -->
<script src="./mp-overlay.js"></script>   <!-- 后：读 window.__MP_CONFIG__ 后干活 -->
<!--/mp-injected-->
```

- `v0.1.0` = INJECT_VERSION（每次 overlay 内容变更 bump）。
- `a1b2c3d4` = overlay.js 内容的 sha256 前 8 位（检测 overlay.js 被篡改/覆盖）。
- detectAndPatch 读标记 → 比对 INJECT_VERSION + hash → fresh/stale/absent。

## detectAndPatch 伪代码

```typescript
const INJECT_VERSION = "v0.1.0";
const MARKER_RE = /<!--mp-injected:(v[\d.]+):(\w+)-->/;

async function detectAndPatch(): Promise<void> {
    const installs = discoverVscodeInstalls(); // 三平台多候选，见 05
    if (installs.length === 0) return;

    for (const { appDir, workbenchHtmlPath, productJsonPath, outDir } of installs) {
        if (!(await acquireLock(appDir))) continue;          // 多窗口锁（10min stale-break，custom-ui-style 范式）
        try {
            const html = fs.readFileSync(workbenchHtmlPath, "utf8");
            const m = html.match(MARKER_RE);
            if (m && m[1] === INJECT_VERSION) continue;       // fresh

            if (!canWrite(workbenchHtmlPath)) { promptChownOrSudo(appDir); continue; } // 权限（扩展无法 sudo 提权）

            await withLock(async () => {
                // ⚠️ 顺序关键：checksum 必须在 workbench.html 写盘【后】算（custom-ui-style index.ts:35 "MUST be the end"）
                // 1. 版本化备份（同目录，VSCode 更新整体替换 app 会擦除同目录 .bak → 下次重备 pristine）
                backupIfAbsent(workbenchHtmlPath, `${workbenchHtmlPath}.mp.bak.${vscode.version}`);
                backupIfAbsent(productJsonPath, `${productJsonPath}.mp.bak.${vscode.version}`);
                // 2. 组装新 workbench.html（清旧标记 + CSP patch + 注入静态 script）
                const injected = injectScriptTag(patchCsp(clearExistingPatches(html)), INJECT_VERSION, sha256first8(overlayJs));
                // 3. 原子写 workbench.html（写 .tmp + rename，防启动期读到半写文件）
                await atomicWrite(workbenchHtmlPath, injected);
                // 4. 复制 overlay.js + mp-config.js（烘焙 port/token）到 workbench 同目录
                copyOverlayJs(outDir);
                // 5. ★ 重算 checksum 填回 product.json（读回【已写盘】的 workbench.html 最终字节）
                patchProductChecksums(productJsonPath, outDir); // 全量遍历重算，见下节
                // 6. post-verify：marker ∧ JSON.parse ∧ checksums[wbKey]===sha256b64(盘上 workbench.html)
                const verifyHtml = fs.readFileSync(workbenchHtmlPath, "utf8");
                const product = JSON.parse(fs.readFileSync(productJsonPath, "utf8"));
                const wbKey = deriveChecksumKey(workbenchHtmlPath, outDir); // 去 out/ 前缀
                if (!verifyHtml.includes(`<!--mp-injected:${INJECT_VERSION}:`)) throw new Error("marker missing");
                if (product.checksums[wbKey] !== sha256b64(verifyHtml)) throw new Error("checksum mismatch");
            });
        } catch (e) {
            await rollbackAll(workbenchHtmlPath, productJsonPath); // 任何失败从 .bak 恢复
            vscode.window.showErrorMessage(`mp: patch failed: ${e.message}`);
        } finally {
            releaseLock(appDir);
        }
    }
    // 提示 Cmd+Q 完全退出重启（Reload Window 用 Chromium disk cache 不重读 workbench.html，patch 不生效，[10 RK13]）
    // 或调 relaunchApp()（三平台 shell relaunch，见自愈流程节；⚠️ 非 nativeHostService.relaunch——扩展 API 无此服务）
}
```

> **顺序 BUG 警示**（7 路深调发现，阻断级）：早期伪代码把 `patchProductChecksums` 放在 `writeFileSync(workbench.html)` **之前** → checksum 基于未注入的旧字节 → 填回值与最终盘上 workbench.html 失配 → Cmd+Q 重启**仍弹"安装损坏"**。正确定稿：workbench.html 写盘 → copyOverlay → 重算 checksum（读回最终字节）→ 填回 product.json → post-verify 断言一致。

> **CSP patch 与注入脚本细节**（patchCsp / injectScriptTag）的单一真相源在 [02 workbench 注入设计](02_workbench注入设计.md)。本篇只讲 patch 编排与 checksum 抑制。

> **overlay.js 编译/打包**（复用 cc-status-dot 的 buildIIFE bake 范式，适配为文件级）：
> - overlay 源 = `resources/overlay.template.js`，顶 banner `/*mp-overlay:__VERSION__:__HASH__*/`，含 `__MP_CONFIG__` 占位（JSON.stringify 烘焙点）。
> - `buildOverlayJs(config)`：`template.replace(banner, 实际版本+hash)` + `replace('__MP_CONFIG__', JSON.stringify({port,token,version}))`；`hash = sha256(js).slice(0,8)`。
> - **单源真相**：port/token/版本只在 patcher.ts 定义，bake 进 `mp-config.js`（静态外链，[02/04](04_EH与Renderer通信协议.md#配置注入porttokenversion--spike6-实证机制替换-l205-223-整段)）；CI 闸门 `test-overlay-hash.mjs` 断言 bake 输出稳定 + `assertCompiles`（`node --check`）通过。
> - workbench.html 注入两个相邻 classic `<script src>`（mp-config.js → mp-overlay.js，文档序执行，config 先于 overlay 就绪）；静态 src 旁路 TT（Spike 2 已验）。
> - **Cmd+Q vs Reload**：Reload Window 用 Chromium disk cache 不重读 workbench.html（patch 不生效）；Cmd+Q 完全退出后 `app.relaunch` 重读盘生效。VSCode 自动更新走 `quitAndInstall→app.relaunch`，自愈后能生效。

## checksum 重算填回(单一真相源,补全方案B)

> 本节取代上文「方案A:删 key」(已弃用)。算法与遍历逻辑经 microsoft/vscode 源码 + subframe7536/vscode-custom-ui-style + RimuruChan fork 三重交叉确证。

### 算法(已锁定,SHA256)
```ts
import { createHash } from 'node:crypto'
function recomputeChecksum(absPath: string): string {
  return createHash('sha256')
    .update(fs.readFileSync(absPath))
    .digest('base64')
    .replace(/=+$/, '')
}
```
- 证据:microsoft/vscode `src/vs/platform/checksum/node/checksumService.ts:21,26`(VSCode 自己用 sha256,非 md5);subframe7536/vscode-custom-ui-style `src/manager/json.ts:12-14`;RimuruChan/vscode-fix-checksums `src/extension.js:83-85`。Spike 4 实测一致。
- ⚠️ 反例警示:lehni/vscode-fix-checksums(原版,2018,engine ^1.25.0)用 **md5**(extension.js:71-75),在 1.129.1 已过时失效。**勿抄 lehni 原版**,抄 RimuruChan fork 或本节算法。

### 遍历(全量 recompute,自然处理多 workbench*.html key)
```ts
function patchProductChecksums(productJsonPath: string, baseOutDir: string): void {
  const product = JSON.parse(readFileAtomic(productJsonPath)) // 原子读
  if (!product.checksums || typeof product.checksums !== 'object') return
  for (const [relKey, oldSum] of Object.entries(product.checksums)) {
    const abs = path.join(baseOutDir, ...relKey.split('/'))   // relKey 不含 out/ 前缀,前置 baseOutDir
    if (!fs.existsSync(abs)) continue                         // 文件不存在→跳过(不报错)
    product.checksums[relKey] = recomputeChecksum(abs)        // 全量重算:workbench.html/workbench.js/任意 key 都覆盖
  }
  writeFileAtomic(productJsonPath, JSON.stringify(product, null, '\t')) // 原子写 + tab 缩进
}
```
要点:
1. **baseOutDir = vscode.env.appRoot + '/out'**(custom-ui-style path.ts:24-28,用官方 API,比 lehni 的 require.main.filename 更稳)。
2. **relKey 不含 `out/` 前缀**(Spike 4):如 `vs/code/electron-browser/workbench/workbench.html`,故 join baseOutDir。
3. **全量遍历**=天然覆盖所有 workbench*.html / workbench*.js key,无需正则匹配(取代旧「方案A 删 workbench*.html key」的 `/workbench.*\.html$/` 正则——recompute 比删 key 更完整且 Spike 4 实测确定生效)。
4. **跳过缺失文件**(`if (!fs.existsSync(abs)) continue`,json.ts:26-28):某 key 对应文件在新版本被删时不崩。
5. **tab 缩进** `JSON.stringify(product, null, '\t')`:对齐 VSCode product.json 原格式(lehni:39 / json.ts:34 均 tab)。功能上 JSON 解析不关心缩进,此为最小 diff。
6. **原子读写**(custom-ui-style 用 `atomically` 包):防写文件中途被 kill 留半截损坏 product.json。MVP 可先 `fs.readFileSync/writeFileSync` + post-verify JSON.parse 兜底,后续上 `atomically`。

### 鸡生蛋?无
VSCode integrityService.ts:105,109 只遍历 `product.checksums` 的 key(都是 app-resource 文件,如 workbench.html/workbench.js)。**product.json 自身从不作为 checksums 的 key**→不存在「改 product.json 又要算 product.json 的 checksum」循环。重算只改 product.json 内容,不新增 product.json key。

### ⚠️ 编排顺序:checksum 重算必须在 workbench.html patch 之后
来源:custom-ui-style index.ts:35 注释「JsonFileManager MUST be the end of built-in file managers」。原因:重算读的是「已 patch 的 workbench.html 磁盘内容」,须先写完 workbench.html/overlay.js 再算。编排伪代码:
```
1. backup(workbench.html, product.json)          // cpSync,版本化名
2. writePatchedWorkbenchHtml()                    // 注入 script + patch CSP
3. copyOverlayJs()                                // mp-overlay.js 落盘
4. patchProductChecksums()                        // ← 最后一步,读 patched workbench.html 算 sha256
5. verifyMarker() + JSON.parse(product.json) 回读校验
```
顺序错(先算 checksum 后 patch workbench)→ product.json 记的是旧 workbench 的 checksum → 重启必弹「安装损坏」。

### 多 workbench*.html key
本机 1.129.1 product.json checksums 含 `.../workbench/workbench.html` 与 `.../workbench/workbench.js` 两 key(Spike 4)。全量遍历自动处理,**无需特殊分支**。仅当未来 patch 了 CSS/JS 文件(workbench.desktop.main.css 等)才需扩展——但 MVP 只 patch workbench.html,workbench.js key 也会被重算成「未改的原始值」(因 workbench.js 未动,recompute === oldSum,JSON 不变),无副作用。

### backup + revert
- **版本化备份名**:`product.json.mp.bak.{vscode.version}`(custom-ui-style path.ts:115 模式),VSCode 更新后版本变→旧 bak 不匹配→自愈判定为「需重 patch」。
- **cpSync 复制备份**(custom-ui-style base.ts:53),非 rename:原文件留在 bak,src 被覆写,互不影响。
- revert:从 `.bak` 复原 product.json + workbench.html + 删 overlay.js。

## 失败域与自愈边界（关键新增）

> 工作流 critic 重点：cc-status-dot 的自愈只覆盖"CC 扩展更新覆盖 extension.js"一种失败。本项目 patch VSCode 本体，引入 **3 类 cc-status-dot 不存在的新失败**，自愈机制须分别处理：

| 失败类别 | 触发 | 自愈能否覆盖 | 处理 |
|---|---|---|---|
| **文件被覆盖** | VSCode 自动更新覆盖 workbench.html/product.json | ✅ 能（detectAndPatch 重新 patch） | onStartupFinished 重 patch，同 cc-status-dot |
| **sudo 权限不足** | macOS `/Applications/`、Linux `/usr/share/` 只读 | ❌ 不能（扩展进程无法 sudo 提权） | 检测 W_OK 失败 → 提示用户在管理员终端跑 `sudo npx vscode-media-preview@latest` |
| **代码签名失效** | 改 `.app` 内文件 invalidate Apple 签名 | ❌ 不能 | [10 Spike 5](10_风险登记册与spike验证.md)：`codesign --remove-signature` 或 ad-hoc 重签 |
| **checksum 抑制失败** | product.json 结构变/写失败 | 部分（重试） | post-verify 捕获 → revert + 报错；最坏留下可忽略警告 |

**patch 失败处理矩阵**：

| 场景 | 处理 |
|------|------|
| 文件只读（macOS sudo / Linux root） | 提示 `sudo npx vscode-media-preview@latest` |
| workbench.html 结构变了（Anchor 找不到） | 降级到 `</body>`/`</html>` 前注入（通用 fallback，[02](02_workbench注入设计.md)） |
| product.json 格式变 | catch + revert（从 `.mp.bak` 恢复）+ 提示用户 |
| overlay.js 复制失败 | revert + 指引 |
| 任何 post-verify 失败 | revert（`.mp.bak` 恢复 workbench.html + product.json）+ 报错 |

## 自愈完整流程(三层 + 三平台 relaunch)

### 自愈触发:onActivate 检测版本化 bak 缺失
```ts
// activate() 内(≈ onStartupFinished 时点,扩展加载即跑一次)
const bakPath = `product.json.mp.bak.${vscode.version}`  // 版本化
const isFresh = fs.existsSync(bakPath) && markerMatches(workbenchHtml, INJECT_VERSION)
if (!isFresh) {
  // stale(版本旧)或 absent(VSCode 更新覆盖了 workbench/product)
  await withLockFile(async () => {                       // 多窗口锁,见下
    if (!canWrite(appDir)) return promptChownOrSudo()    // 权限不足
    await detectAndPatch()                                // backup→patchHtml→copyOverlay→重算checksum→verify
    await promptRestart()                                 // 见下「重启」
  })
}
```
- **不用 product.commit 比对**:commit 在 product.json 内部,改 product.json 后比对易自我干扰;版本化 bak 名(`.{vscode.version}`)天然承担版本比对——VSCode 月更后 version 变→新版本 bak 不存在→触发重 patch。来源 custom-ui-style src/index.ts:24-25(hasBakFile)+ path.ts:115。
- **onActivate 时点**:activate 在扩展加载时跑一次(EH 生命周期内一次),紧随 `onStartupFinished`。VSCode 更新后 `quitAndInstall→app.relaunch` 完全重启→新进程 activate→检测到新版本无 bak→自愈跑。**自愈天然在「更新重启后」跑**,无需额外 hook 更新事件。来源:VSCode 更新走 `quitAndInstall`(main 进程完全重启)。

### 多窗口/多实例:lock file
```ts
const lockPath = path.join(baseOutDir, '__mp-preview__.lock')
async function withLockFile(fn) {
  let n = 5; while (fs.existsSync(lockPath) && n--) await sleep(1000)
  if (!n && fs.existsSync(lockPath)
      && Number(fs.readFileSync(lockPath,'utf8')) - Date.now() > 6e5) {
    fs.rmSync(lockPath)  // >10min 当死锁清
  } else if (fs.existsSync(lockPath)) { log('locked, skip'); return }
  fs.writeFileSync(lockPath, String(Date.now()))
  try { await fn() } finally { fs.rmSync(lockPath) }
}
```
来源 custom-ui-style utils.ts:20,52-67。防同装目录被多窗口并发 patch 损坏。

### 重启:三平台 shell relaunch(⚠️ 非 nativeHostService.relaunch,非 reloadWindow)
```ts
import { spawn } from 'node:child_process'
function relaunchApp() {
  let p: ChildProcess
  if (process.platform === 'darwin') {
    const nameLong = JSON.parse(fs.readFileSync(productJsonPath,'utf8')).nameLong
    const m = /(.*\.app)\/Contents\/Frameworks\//.exec(process.execPath)
    const appPath = m ? m[1] : `/Applications/${nameLong}.app`
    const bin = locateBin(`${appPath}/Contents/Resources/app/bin/`)
    p = spawn('osascript','-e',`quit app "${nameLong}"`,'-e','repeat 100','-e',
      `if not(application "${nameLong}" is running) then exit repeat`,'-e','delay 0.1',
      '-e','end repeat','-e',`do shell script quoted form of "${bin}"`,{detached:true,stdio:'ignore'})
  } else if (process.platform === 'win32') {
    const exe = path.basename(process.execPath,'.exe')
    const bin = locateBin(`${path.dirname(process.execPath)}\\bin\\`)
    p = spawn(process.env.comspec??'cmd',[`/C taskkill /F /IM "${exe}.exe" >nul && powershell -Command "for($i=0;$i -lt 100;$i++){if((Get-Process '${exe}' -EA SilentlyContinue) -eq $null){exit};Start-Sleep -Ms 100}" && "${bin}"`],{detached:true,stdio:'ignore',windowsVerbatimArguments:true})
  } else { // linux
    const pid = Number(process.env.VSCODE_PID)
    if (!Number.isInteger(pid) || pid<=0) throw new ManualRestartRequiredError(
      'Cannot determine VS Code main process. Please fully quit and reopen VS Code.')
    const bin = locateBin(`${path.dirname(process.execPath)}/bin/`)
    p = spawn('/bin/sh',['-c',`kill ${pid} 2>/dev/null;c=0;while kill -0 ${pid} 2>/dev/null&&[ $c -lt 100 ];do sleep 0.1;c=$((c+1));done;"${bin}"`],{detached:true,stdio:'ignore'})
  }
  p.unref()
}
```
- ⚠️ **纠正**:旧文档「自愈用 `nativeHostService.relaunch()`」**错误**。`nativeHostService.relaunch()` 是 VSCode 内部 workbench DI 服务,**不在 `vscode` 扩展 API**(vscode.d.ts 21235 行无 relaunch/restart/quitAndInstall app 级 API),扩展无法 import。上述 shell relaunch 是 custom-ui-style(restart.ts:17-149)与 vscode-custom-css 共用的成熟方案,直接抄。
- **Linux 退化**:VSCODE_PID 取不到→抛 ManualRestartRequiredError→提示用户「完全退出再开」。来源 restart.ts:124-127。
- **reloadWindow 绝对不能用**:`workbench.action.reloadWindow` 只重载 renderer、用 Chromium HTTP cache 不重读磁盘 workbench.html(RK13 源码 main.js webContents.reload),patch 不生效。
- locateBin:扫 `<app>/bin/` 过滤 `-tunnel`,fallback `which code-insiders`/`code`(restart.ts:32-63)。

### 运行时哨兵 globalThis.__mpPatchRev(补 reload-cache 盲区)
```ts
// overlay.js(mp-overlay.js,Renderer 侧,首行):
;(globalThis.__mpPatchRev = 'v0.1.0:a1b2c3d4') // INJECT_VERSION:overlaySha前8位,patch 时注入
// EH 在 detectAndPatch verify 后写一份到磁盘 manifest:
fs.writeFileSync(path.join(baseOutDir,'..','mp-manifest.json'), JSON.stringify({rev:'v0.1.0:a1b2c3d4',vscodeVersion:vscode.version}))
// overlay.js 启动后 fetch /mp-manifest.json 比对:
if (globalThis.__mpPatchRev !== manifest.rev) { signalCacheMismatch() }
```
- **作用**:integrity 检查读「磁盘」(已 patched,pass)但 renderer 可能跑「缓存旧 overlay」(Reload Window 场景)。sentinel 抓这一层:integrity 抓不到的。两层互补。
- signalCacheMismatch:overlay 调 EH 的 notificationAPI(或 console.warn + 标记)→提示「请完全退出(Cmd+Q)重启,Reload Window 未加载新补丁」。
- **注意**:manifest fetch 走 EH server(CSP 已放行 127.0.0.1:*,04 协议);或直接在 overlay 注入时把 rev 烧进 script 标签的 data-rev 属性,sentinel 仅比自身属性(更简,不依赖 fetch)。

### 把「安装损坏」通知当 cache-mismatch 探针(仅完全重启后可信)
- 通知来源:VSCode integrityService.ts:146-177,Severity.Warning sticky urgent,非 modal dialog。
- **完全重启后**(main 进程重读 product.json):通知出现=product.checksums 与磁盘 workbench.html 不符=patch/checksum 失败,是真实探针。
- **Reload Window 后不可信**:renderer 重载但 main 进程 productService 可能持旧 product.json→假阳性(RK13)。故探针仅在「完全重启」验收时用,禁用 reload 验收。
- dontShowPrompt 抑制:integrityService.ts:97-99,`dontShowPrompt && storedCommit===product.commit` 才抑制;VSCode 更新(commit 变)→抑制自动解除→通知复现。故 patch 不靠「用户点 Don't Show Again」掩盖,靠重算填回根治。

### 权限不足(sudo/chown)
- **首选 chown(一次性,后续自愈免 sudo)**:`sudo chown -R $(whoami) '<appRoot>'`(custom-ui-style utils.ts:85)。比 lehni「每次以 sudo 跑 VSCode」(README:43-51)体验好。
- 检测:`fs.accessSync(appDir, fs.constants.W_OK)` 抛 EACCES/EROFS→提示 chown 或换安装方式(utils.ts:74-89)。
- 扩展进程**无法** sudo 提权,这是硬限制。

### 完整自愈时序(VSCode 月更场景)
```
T0 VSCode 1.x 运行中,workbench.html 已 patch,product.checksums 已重算,无通知
T1 VSCode 自动更新下载完,用户点「重启更新」
T2 quitAndInstall→app.relaunch:main 进程完全退出重启
T3 新 main 进程:更新覆写 workbench.html(还原未 patch)+ product.json(原始 checksums)
T4 EH 启动→本扩展 activate(≈onStartupFinished)
T5 withLockFile→exists(bak.{新version})=false(版本变了)→detectAndPatch
T6 backup(new ver)→patchHtml→copyOverlay→重算 checksum 填回→verify
T7 promptRestart→relaunchApp(osascript/taskkill+kill)
T8 完全重启后:integrity 跑(LifecyclePhase.Eventually)→product.checksums===actual→isPure=true→无通知
T9 overlay.js 载入→__mpPatchRev===manifest→无 cache-mismatch 信号
```
自愈**必须在更新重启后跑**(T4 之后),而 activate 天然在每次 EH 启动跑→满足,无需额外事件订阅。

## 跨窗口/多 VSCode 实例

同 cc-status-dot：
- `ran` Set 防止同一 EH 生命周期内重复 patch 同一 appDir。
- 多 VSCode 窗口共享同一安装目录 → 第一个窗口 patch 并完全重启后，其它已开窗口也须 Cmd+Q 完全重启才生效（Reload Window 用缓存不重读 workbench.html，patch 不生效，详见 [10 RK13](10_风险登记册与spike验证.md)）。
- 多 flavor（VSCode / Insiders / VSCodium）→ `discoverVscodeInstalls` 分别返回，循环 patch。

## revert 机制

`--revert`（同 cc-status-dot）：
1. 读 workbench.html，移除 `<!--mp-injected:...-->` 到 `<!--/mp-injected-->` 之间的内容。
2. 恢复 CSP meta（从 `.mp.bak` 或记录的原 CSP）。
3. 恢复 product.json checksums（从 `.mp.bak`）。
4. 删除 overlay.js。
5. 一键零副作用还原。

```bash
npx vscode-media-preview@latest --revert
```
