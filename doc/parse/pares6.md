# pares6 — v1.0 打磨阶段分析

> v1.0 = v0.5 + 打磨。多数为人为/跨平台验证（三平台测试、代码签名多状态、Cmd+Q 统一测），代码增量小。基于 [07](../07_开发计划与MVP任务拆解.md) v1.0。

## 0. 范围
三平台测试 / macOS 代码签名 / 错误处理加固 / README demo / `npx` 分发。

## 1. 各项分析

| 项 | 类型 | 状态/决策 |
|---|---|---|
| **三平台路径权限** | 人为验证（Win/Linux） | discover.ts 已有三平台候选（macOS✅实证/Win/Linux 推断）。Win/Linux 真机验证（人为，[test-pending](test-pending.md)）。PATH 分隔符 🟡（审查：Win split(':') 错，应 path.delimiter）待修。 |
| **macOS 代码签名** | 人为验证（多状态） | Spike5 初步通过（完全重启未弹）。多状态（quarantine/Insiders/VSCodium）Cmd+Q 验证（人为）。codesign --remove-signature 流程在 [05](../05_三平台路径与权限.md)。 |
| **错误处理加固** | 代码（边际） | overlay/server 已有基本 try/catch + showPopupError。审查 🔵（overlay cfg 降等/fresh 校验 mp-overlay.js）待修。 |
| **README demo** | 文字+gif（gif 人为） | 根 README 已有（架构/状态/约束）。demo gif 录制（人为）。文字补 v0.1-v0.5 全类型。 |
| **npx 分发** | 配置（已就绪） | prepublishOnly 已配（build+build:lib+companion:build+package）。npm publish 即可。files 含 dist/resources/lib/companion vsix。 |

## 2. v1.0 代码增量（非人为，可做）
- 🔵 overlay cfg 降等保护（mp-config 缺失时 warn + abort，不 fetch undefined）
- 🔵 fresh 分支校验 mp-overlay.js 存在（被删则补拷）
- 🟡 Win PATH.delimiter（installCompanion code 探测）
- 🟡 死代码清理（restart.ts/fileIndex.ts/buildConfigJs 标 v0.2 或删）+ locateInstallDir cmpVerStr + lock wx 原子 + mp-config 单 bake

## 3. v1.0 人为验证（test-pending 统一测）
- v0.1-v0.5 各类型 Cmd+Q hover（img/video/audio/font/pdf/3d）
- 三平台（macOS✅/Win/Linux）
- 代码签名多状态
- 自愈（VSCode 更新后）
- --revert

## 4. v1.0 任务清单
- [ ] 代码增量（§2 🟡/🔵，审查遗留）
- [ ] README 补全类型 + 安装/使用/排错
- [ ] 人为验证（§3，test-pending）
- [ ] npm publish（prepublishOnly 就绪）
