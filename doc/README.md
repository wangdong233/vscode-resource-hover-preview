# VSCode 资源预览插件 — 技术设计文档

> 鼠标悬停 VSCode 原生资源管理器中的图片/视频/PDF/字体/音频/3D 文件 → 浮动预览弹窗（**四角缩放 + 智能四象限定位 + 尺寸记忆**）。
>
> v0.1 不做自由位置拖拽——位置按文件项在视口的位置自动四象限展开，避开遮挡（见 [03](03_浮动预览弹窗设计.md#四象限智能定位)）。

## 架构：TIER 1 — DOM Patch Overlay

patch VSCode workbench.html（注入静态 `<script>` 加载 overlay IIFE）+ product.json（抑制 checksum）+ CSP meta（放开 localhost），在 Renderer 中实现原生 Explorer 悬停预览。自愈 patcher 在 VSCode 更新后自动 re-patch（同 cc-status-dot 模式，但**失败域不同级别**——见 [00](00_总览与架构决策.md#-与-cc-status-dot-的关键差异失败域不同级别)）。

> **三条硬约束（调研读 microsoft/vscode 源码确证）**：
> 1. **CSP**：生产 CSP 不含 localhost，patch `connect-src`/`img-src`/`media-src` 加 `http://127.0.0.1:*` 是强制前提（[02](02_workbench注入设计.md#csp-patch完整规格)）。
> 2. **Trusted Types**：workbench 强制 `require-trusted-types-for`，overlay 必须**静态 `<script src>` 加载 + 全程 createElement**（禁 innerHTML，[02](02_workbench注入设计.md)/[03](03_浮动预览弹窗设计.md)）。
> 3. **checksum**：product.json `checksums` 是 object map（非数组），**抑制用重算 SHA256 填回**（Spike 4 实测：删 key 在 reload 场景仍弹"安装损坏"已弃用，[01](01_自愈patch机制设计.md#checksum-抑制productjson-patch)）。

## 文档索引

| # | 文档 | 内容 |
|---|------|------|
| 00 | [总览与架构决策](00_总览与架构决策.md) | TIER1 选型 + cc-status-dot 失败域对比 + 整体架构 |
| 01 | [自愈 Patch 机制](01_自愈patch机制设计.md) | detectAndPatch + checksum 抑制 + **失败域与自愈边界** |
| 02 | [Workbench 注入设计](02_workbench注入设计.md) | **CSP/TT/注入 单一真相源** |
| 03 | [浮动预览弹窗设计](03_浮动预览弹窗设计.md) | **四象限定位 + 四角缩放** + 图片渲染(MVP) |
| 04 | [EH 与 Renderer 通信协议](04_EH与Renderer通信协议.md) | server API + 数据格式 + **安全硬化** |
| 05 | [三平台路径与权限](05_三平台路径与权限.md) | 路径权威落点 + 代码签名 + 支持矩阵 |
| 06 | [DOM 选择器容错](06_DOM选择器容错策略.md) | 选择器 fallback + **文件索引重名消歧** |
| 07 | [开发计划与 MVP](07_开发计划与MVP任务拆解.md) | **Spike 闸门** + 里程碑 + v0.1 验收 |
| 08 | [富媒体渲染器矩阵](08_富媒体渲染器矩阵.md) | video/audio/font/pdf/3d（v0.2-0.5） |
| 09 | [竞品与差异化矩阵](09_竞品与差异化矩阵.md) | 竞品对比 + 差异化 + 被替代风险 |
| 10 | [风险登记册与 Spike 验证](10_风险登记册与spike验证.md) | **make-or-break spike 闸门** + 降级预案 |
| 11 | [Rejected by Design 清单](11_rejected-by-design清单.md) | 被否决方案/feature + 理由 + 复活条件 |

## 快速开始（开发）

1. **先做 [Spike 1-6](10_风险登记册与spike验证.md#一-make-or-break-spike-闸门动工前必须先过)**——这是 make-or-break 验证，全过才进编码。Spike 1/2 是生死点。
2. Spike 全过后按 [07](07_开发计划与MVP任务拆解.md) 的 v0.1 模块级任务实施。
3. v0.1 目标：图片悬停预览 + 四角缩放 + 四象限定位 + 尺寸记忆。

## Spike 8 — Explorer DOM 实测诊断脚本

`spike8-dom.mjs`（项目根）：实测 1.129.1 Explorer 文件项 DOM，一锤定音 Spike 8（aria-label 是否含完整路径）。

**用法**：
```
node spike8-dom.mjs --patch      # 注入 mp-dom-probe.js + 重算 checksum
# Cmd+Q 完全退出 VSCode（不是 Reload Window！）→ 重启
# 打开有多层文件夹的工作区，折叠/展开几个文件夹
# Help → Toggle Developer Tools → Console 看 [mp-spike8] 日志
# 悬停某文件触发 HOVER PROBE；window.__mpScan('manual') 重扫
node spike8-dom.mjs --revert      # 恢复（Cmd+Q 重启）
```

**输出**：selectorTierCounts 表（哪个选择器命中）+ spike8Verdict（ariaLabelLooksLikePath 计数）+ 前 6 行全属性 dump + localStorage `mp.spike8.dom` 完整 JSON。TT 安全（只读 DOM + console + localStorage，无 innerHTML sink）。

## 关键决策摘要

- **方向**：坚持 TIER1（用户决策 2026-08-08，[09](09_竞品与差异化矩阵.md) 证市场真空 + 微软自己也 patch core）。
- **交互**：浮动 + 四角缩放 + 四象限定位，**砍自由拖拽**（[11 F1](11_rejected-by-design清单.md)）。
- **audio**：只播 `<audio>`，**砍波形**（ffmpeg.wasm 需 COOP/COEP，[11 F2](11_rejected-by-design清单.md)）。
- **降级预案**：Spike 1/2 失败或维护税过载 → docked WebviewView 侧边预览（[10](10_风险登记册与spike验证.md#四降级预案若-tier1-维护税过载或-spike-失败)）。
