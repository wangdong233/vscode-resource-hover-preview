<div align="center">

# resource-hover-preview

[![npm](https://img.shields.io/npm/v/resource-hover-preview?style=flat-square&color=CCA700)](https://www.npmjs.com/package/resource-hover-preview)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](#license)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Type](https://img.shields.io/badge/Type-VSCode%20Workbench%20Patch-CCA700?style=flat-square)](#-原理)

**鼠标悬停 VSCode 资源管理器里的文件，浮动预览弹窗直接弹出来 —— 图片/视频/PDF/字体/音频/3D 一悬即看**

🖼️ 图片 · 🎬 视频 · 🎵 音频 · 🔤 字体 · 📄 PDF · 🎲 3D —— **浮动弹窗 + 四角缩放 + 智能四象限定位 + 尺寸记忆 + pin**

</div>

---

> 在 VSCode 资源管理器里翻文件，想看图片长啥样、视频内容、PDF 页面、字体字形——得一个个点开，占用编辑区。装上这个，**鼠标悬停文件名直接弹出浮动预览**，不占编辑区，移开鼠标自动消失。6 种媒体类型全覆盖，悬停即看。

---

## ✨ 功能

**① 悬停即预览**　鼠标悬停资源管理器文件项（.png/.mp4/.pdf/.ttf...），~300ms 后弹出浮动预览弹窗，不打开文件、不占编辑区。

**② 四角缩放**　弹窗四个角都可拖拽缩放（对角固定），调整到合适大小。

**③ 智能四象限定位**　按悬停文件项在视口的位置，自动选展开方向（左上/左下/右上/右下展开），避开文件项本身 + 不超出屏幕，定位可预测不遮挡。

**④ 尺寸记忆**　缩放后的尺寸记在 localStorage，下次悬停保持。

**⑤ Pin 固定**　点 📌 固定弹窗（不随鼠标离开消失），方便对照参考。

**⑥ 6 类型全覆盖**　🖼️ 图片(png/jpg/gif/webp/svg/bmp/ico/avif) · 🎬 视频(mp4/webm/mov/mkv/avi/m4v) · 🎵 音频(mp3/wav/ogg/flac/aac/m4a/opus) · 🔤 字体(ttf/otf/woff/woff2) · 📄 PDF · 🎲 3D(glb/gltf/obj/stl/fbx)

> **市场真空**：没有任何 VSCode 扩展做到「原生 Explorer 悬停 → 浮动窗口」——连微软自己的 [issue #270270](https://github.com/microsoft/vscode/issues/270270) 也只能 patch core。本项目填这个空白。

---

## 🚀 三步用上

**前置**：Node.js 18+，VSCode（macOS / Windows / Linux）。

```bash
npx -y resource-hover-preview@latest
```

**Cmd+Q**（Mac）/ 完全退出所有窗口（Win/Linux）→ 重新打开 VSCode。

悬停资源管理器里的图片文件 → 浮动弹窗直接显示。**装一次就生效，不用配任何东西。**

> ⚠️ **必须完全退出重启（Cmd+Q）**，不是 `Reload Window`——Reload 走 Chromium 磁盘缓存不重读 workbench.html，patch 不生效（详见 [doc/10 RK13](doc/10_风险登记册与spike验证.md)）。

---

## 📂 支持类型

| 类型 | 扩展名 | 渲染方式 |
|---|---|---|
| 🖼️ 图片 | png jpg jpeg gif webp svg bmp ico avif | `<img>` base64 |
| 🎬 视频 | mp4 webm mov mkv avi m4v | `<video>` 直 HTTP src（原生 Range seek） |
| 🎵 音频 | mp3 wav ogg flac aac m4a opus | `<audio controls>`（波形砍，ffmpeg.wasm 需 COOP/COEP 不可行） |
| 🔤 字体 | ttf otf woff woff2 | FontFace ArrayBuffer + canvas glyph grid（免 font-src patch） |
| 📄 PDF | pdf | pdf.js v6 ESM（fetch→Blob→dynamic import，blob worker） |
| 🎲 3D | glb gltf obj stl fbx | three.js r185（esbuild bundle，OrbitControls 旋转，forceContextLoss 释放） |

---

## ⚙️ 配置

v0.1 全部默认行为（浮动 + 四角缩放 + 四象限定位 + 尺寸记忆 + pin），无需配置。后续版本加配置面板。

---

## 🔧 原理

**TIER 1 DOM Patch Overlay** —— patch VSCode workbench 实现原生 Explorer 悬停预览（纯公开 API 做不到）：

- patch `workbench.html`：注入静态 `<script src>` 加载 overlay IIFE（旁路 Trusted Types）
- patch `product.json`：重算 SHA256 checksum 填回（不弹"安装损坏"）
- patch CSP meta：放开 localhost（connect-src / img-src / media-src）
- Extension Host localhost server(:17741)：提供文件预览数据（绑 127.0.0.1 + 会话 token + workspace 路径 containment）
- companion 扩展 activate：spawn patcher `--patch-only` 自愈（ELECTRON_RUNAS_NODE，VSCode 更新后自动 re-patch）

完整设计文档（13 篇 + 阶段分析 pares1-6）见 [doc/](doc/)。

---

## ⚠️ 已知限制

| 限制 | 原因 | 缓解 |
|---|---|---|
| VSCode 更新必断 | workbench 文件被覆盖 | companion 自愈 re-patch + Cmd+Q 生效 |
| 不上 Marketplace | patch 内部文件违政策 | GitHub + `npx` 分发 |
| Cmd+Q 才生效 | Reload Window 用 Chromium 缓存 | 完全退出重启（非 Reload） |
| macOS 可能需重签 | 改 .app 内文件 invalidate 签名 | `codesign --remove-signature`（[doc/05](doc/05_三平台路径与权限.md)） |

---

## 🔄 revert

```bash
npx -y resource-hover-preview@latest --revert
```

一键零副作用还原 workbench.html + product.json + 删除 overlay/mp-config。

---

## 📖 文档

| 文档 | 内容 |
|---|---|
| [00 总览与架构决策](doc/00_总览与架构决策.md) | TIER1 选型 + 失败域对比 |
| [07 开发计划](doc/07_开发计划与MVP任务拆解.md) | 里程碑 + 任务 + 验收 |
| [10 风险登记册与 Spike 验证](doc/10_风险登记册与spike验证.md) | make-or-break spike + 风险 |
| [08 富媒体渲染器矩阵](doc/08_富媒体渲染器矩阵.md) | 6 类型渲染实现 |

---

## License

MIT
