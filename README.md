# Resource Hover Preview

VSCode 扩展：鼠标**悬停原生资源管理器**中的图片/视频/PDF/字体/音频/3D 文件 → **浮动预览弹窗**（四角缩放 + 智能四象限定位 + 尺寸记忆）。

> ⚠️ 通过 patch VSCode workbench 实现（非 Marketplace 分发，走 `npx`）。市场真空：无任何扩展做到「原生 Explorer 悬停 → 浮动窗口」，连微软自己的 issue #270270 也只能 patch core。

## 架构
**TIER 1 DOM Patch Overlay**：patch workbench.html（注入静态 `<script>` 加载 overlay IIFE）+ product.json（重算 SHA256 checksum 填回）+ CSP meta（放开 localhost）。详见 [doc/00_总览与架构决策.md](doc/00_总览与架构决策.md)。

## 状态
v0.1 开发中。骨架已就绪，Spike 1-4 实测通过（Trusted Types / 静态 script 注入 / workbench 路径 / checksum 重算），reload 缓存根因白盒确证。

## 开发
- **设计文档**：[doc/](doc/)（00-11 + README，经 7 路深调 + 8-agent 固化，无黑盒）
- **开发计划**：[doc/07_开发计划与MVP任务拆解.md](doc/07_开发计划与MVP任务拆解.md)
- **风险与 Spike 闸门**：[doc/10_风险登记册与spike验证.md](doc/10_风险登记册与spike验证.md)
- 安装：`npm install && (cd companion && npm install)`
- 构建：`npm run build && (cd companion && npm run build)`
- CLI：`npm run status`（只读三态）/ `npm run patch` / `npm run revert`

## 关键技术约束（实测确证）
1. **Trusted Types**：workbench 强制 `require-trusted-types-for`，overlay 全程须 `createElement`（禁 innerHTML）
2. **checksum 重算填回**：product.json checksums 是 object map，算法 `sha256/base64/去=`；删 key 实测失败
3. **Cmd+Q 完全重启**：Reload Window 用 Chromium disk cache 不重读 workbench.html，patch 必须 Cmd+Q 完全退出重启才生效
