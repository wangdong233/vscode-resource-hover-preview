# pares1 — v0.1 MVP 功能分析（图片悬停浮动预览）

> v0.1 阶段功能分析文档。本文件是 v0.1 实施的指导，定架构、执行路径、不明确点决策、任务清单、验证。实施照此 + doc/00-11。

## 0. v0.1 范围与验收（来自 [07](../07_开发计划与MVP任务拆解.md)）

**范围**：patch 机制 + 图片悬停预览（浮动 + 四角缩放 + 四象限定位 + 尺寸记忆 + pin）。不做自由拖拽（[11 F1](../11_rejected-by-design清单.md)）。

**验收**（07，关键项）：
1. `npx -y vscode-resource-hover-preview@latest` 一键安装（patch + 提示 Cmd+Q 完全退出重启）
2. **完全重启（Cmd+Q 后重开）** 后悬停 .png/.jpg/.gif/.webp → ~300ms 浮动弹窗显示图片
3. 四象限智能定位 + 四角缩放 + 尺寸记忆 + pin
4. 非媒体文件不弹窗
5. `--revert` 干净还原；VSCode 更新后自愈 re-patch（需再 Cmd+Q）
6. **不弹"安装损坏"**（checksum 重算填回）

## 1. 架构定案（cc-status-dot 方案 C 落地，白盒读源码确证）

### 1.1 companion↔patcher 共用：spawn 模式（非 import）

**cc-status-dot 方案**（读 `/Users/wangdong/Documents/Project/vscode-cc-提示插件/claude-code-status-dot` 确证）：
- 根 `patch.ts` → `dist/patch.js`（ESM，bin 入口，patcher 权威实现）
- `companion/extension.ts`（CJS）：`ccPatchState()` 同步判 fresh/stale/absent → 非 fresh 则 `runPatcher()` 异步 `cp.spawn(node, [PATCH_JS, "--patch-only"])`
- spawn 细节：`ELECTRON_RUN_AS_NODE=1`（Electron execPath 退化为 Node，VSCode 自己 spawn EH 的同款 trick）+ `cp.spawn`+Promise（非 execFileSync，非阻塞，EH 事件循环不卡）+ stdio piped（解析 stdout）+ 30s 超时
- `--patch-only`：只 patch（跳过 installRuntimeFiles/installCompanion），幂等

**本项目照搬**：根 `src/patcher.ts` → `dist/patcher.js`（ESM）；`companion/src/extension.ts` activate → `workbenchState()` → `runPatcher()` spawn `dist/patcher.js --patch-only`。

### 1.2 INSTALL_DIR 机制（patcher 产物如何到 companion）

**cc-status-dot**：patcher（npx 默认模式）的 `installRuntimeFiles()` 把 `dist/patch.js + dist/src/*` 复制到 **INSTALL_DIR = companion 扩展安装目录**（`~/.vscode/extensions/<publisher>.<companion-name>-<version>/`）。companion 的 `PATCH_JS = path.join(INSTALL_DIR, "patch.js")`，activate 时 spawn 它。

**本项目**：
- INSTALL_DIR = `~/.vscode/extensions/wangdong.vscode-resource-hover-preview-companion-0.1.0/`
- patcher 默认模式（npx）：discover → installRuntimeFiles（复制 `dist/patcher.js + dist/*.js` 到 INSTALL_DIR + 复制 `resources/overlay.template.js`/lib 到 INSTALL_DIR）→ installCompanion（`code --install-extension` vsix）→ patchWorkbench
- companion activate：spawn `INSTALL_DIR/patcher.js --patch-only`

### 1.3 mp-config.js 分工（server-patch chicken-egg 决策）

**问题**：mp-config.js 烘焙 port/token，但 port/token 来自 companion 起 server（patch 时 server 状态？）。

**决策（分工）**：
- **mp-overlay.js**：overlay IIFE，内容固定 per INJECT_VERSION（bake 自 overlay.template.js）。**patcher 复制**到 workbench 目录（installRuntimeFiles / --patch-only）。
- **mp-config.js**：运行时配置（port/token），**每次 activate 变**（token 随机、port 可能递增）。**companion bake** 到 workbench 目录（companion 起 server 后写）。**不在 product.json checksums**（companion bake 不触发 checksum）。

**companion activate 顺序**：
```
1. 起 server → actualPort + token
2. bake mp-config.js（companion 写 workbench 目录：window.__MP_CONFIG__={port:actualPort,token,version}）
3. spawn INSTALL_DIR/patcher.js --patch-only（注入 <script src mp-config.js + mp-overlay.js> + CSP + checksum + 复制 mp-overlay.js）
4. 若 patched → 提示 Cmd+Q（或 relaunchApp）
```
- mp-config.js（步骤2）在 patcher（步骤3）之前写，确保 patch 后 workbench.html 引用的 mp-config.js 已在。
- mp-overlay.js 由 patcher（步骤3）从 INSTALL_DIR/resources 复制。
- 每次 activate 重 bake mp-config.js（token 变）+ spawn patcher（幂等，fresh 则 no-op）。

## 2. 执行路径（v0.1 实施顺序，依赖驱动）

```
T1 [patcher 核心] dist/patcher.js 三态 + patch workbench（注入+CSP+checksum+复制overlay.js）+ --patch-only 分支
   └ 依赖：src/{patcher,csp,discover,checksum,atomic,lock,overlay-bake,patcher-state}.ts（骨架已搭，填实现）
T2 [installRuntimeFiles] npx 默认模式：复制 dist/patcher.js+dist/*.js+resources 到 INSTALL_DIR + installCompanion(vsix)
T3 [companion activate] workbenchState + 起 server + bake mp-config.js + spawn patcher --patch-only + relaunchApp
T4 [overlay.js] resources/overlay.template.js 填实现：popup 骨架(createElement)+四象限定位+四角缩放+尺寸记忆+pin+hover(event delegation)+aria-label 路径+renderImage(createElement img)
T5 [server] companion/src/server.ts 填实现：六道闸门 + /ping//config//preview(image→base64)//resolve(aria-label 免索引)
T6 [端到端 Spike6 真机] npx patch → Cmd+Q → hover png → 浮动弹窗（图片预览完整链路）
```

## 3. 不明确点决策（pares1 钉死，实施不犹豫）

| 不明确点 | 决策 | 依据 |
|---|---|---|
| companion↔patcher 共用 | spawn（方案C），非 import | cc-status-dot 成熟先例 |
| patcher 产物定位 | INSTALL_DIR（companion 扩展目录） | cc-status-dot installRuntimeFiles |
| mp-config.js 谁 bake | companion（运行时 port/token），非 patcher | port 来自 server，patch 时未必起 |
| mp-overlay.js 谁复制 | patcher（--patch-only + install） | 内容固定，patcher 管 |
| server-patch 顺序 | companion 起 server → bake mp-config.js → spawn patcher --patch-only | chicken-egg 解 |
| token 生命周期 | per-session（每次 activate 随机） | 安全（[04] 会话 token） |
| Electron execPath 当 Node | `ELECTRON_RUN_AS_NODE=1` env | cc-status-dot findNodeBin |
| --patch-only 幂等 | patcher 检测 fresh 则 no-op | companion 每次 activate 安全 spawn |
| mp-config.js 与 checksum | 不在 product.json checksums，bake 不触发 | Spike4 workbench.html key 唯一相关 |

## 4. 端到端验证（Spike6 真机 = v0.1 收尾）

```
1. npm run build && cd companion && npm run build && npm run package → .vsix
2. node dist/patcher.js（默认模式：install + patch + 提示 Cmd+Q）
3. Cmd+Q 完全退出 VSCode → 重开
4. hover .png → ~300ms 浮动弹窗显示图片
5. DevTools Console：[mp-overlay] loaded + 无"安装损坏" + 无 CSP/TT 报错
6. 四象限定位 + 四角缩放 + 尺寸记忆 + pin
7. --revert → Cmd+Q → 干净还原
```

## 5. v0.1 任务清单（细化 [07](../07_开发计划与MVP任务拆解.md)）

- [ ] T1 patcher 核心：填 `src/patcher.ts` detectAndPatch（顺序关键：workbench 写盘→重算 checksum）+ --patch-only 分支 + --revert
- [ ] T1a `src/overlay-bake.ts` buildOverlayJs（banner hash 迭代）+ buildConfigJs（companion 用）
- [ ] T2 installRuntimeFiles（复制 dist + resources 到 INSTALL_DIR）+ installCompanion（vsce package + code --install-extension）
- [ ] T3 `companion/src/extension.ts`：workbenchState + startServer + bake mp-config.js + runPatcher(spawn --patch-only) + relaunchApp 提示
- [ ] T3a `companion/src/server.ts`：六道闸门 + /ping /config /preview(image) /resolve
- [ ] T4 `resources/overlay.template.js`：popup(createElement) + 四象限定位 + 四角缩放 + 尺寸记忆 + pin + hover(aria-label) + renderImage
- [ ] T6 端到端真机验收（上面 §4）
- [ ] 审查（03 清单）+ 更新 07/排期

## 6. 边界与已知风险（实施时注意）

- **Cmd+Q 强制**：reload window 不生效（RK13），所有"生效"验收用 Cmd+Q
- **createElement 强制**：TT 拦 innerHTML（Spike1），overlay 全程 createElement
- **checksum 顺序**：workbench 写盘后算（阻断级，已修）
- **aria-label 方案0**：.monaco-icon-label aria-label=完整路径（Spike8 白盒），免 EH 索引；fallback 留方案B
- **本阶段不碰**：v0.2+ 视频/PDF/3D（[08]），audio 波形 NO-GO（[11 F2]）
