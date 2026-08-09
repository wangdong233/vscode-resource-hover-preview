<div align="center">

# resource-hover-preview

[![npm](https://img.shields.io/npm/v/resource-hover-preview?style=flat-square&color=CCA700)](https://www.npmjs.com/package/resource-hover-preview)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](#license)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)

**鼠标悬停 VSCode 资源管理器里的文件，浮动预览弹窗直接弹出来**

🖼️ 图片 · 🎬 视频 · 🎵 音频 · 🔤 字体 · 📄 PDF · 🎲 3D —— 四角缩放 + 智能四象限定位 + 尺寸记忆

**简体中文** | [English](docs/README.en.md)

</div>

---

> 翻 VSCode 资源管理器里的文件，想看图片/视频/PDF/字体长啥样？装上这个，**鼠标悬停文件名直接弹出浮动预览**，不打开文件、不占编辑区，移开鼠标自动消失。6 种媒体类型全覆盖。

---

## ✨ 功能

**① 悬停即预览**　鼠标悬停资源管理器文件项（.png/.mp4/.pdf/.ttf...），~300ms 后弹出浮动预览弹窗，不打开文件、不占编辑区。

**② 四角缩放**　弹窗四个角都可拖拽缩放（对角固定），调到合适大小。

**③ 智能四象限定位**　按悬停文件项在视口的位置，自动选展开方向（左上/左下/右上/右下），避开文件项 + 不超出屏幕。

**④ 尺寸记忆**　缩放后的尺寸记在 localStorage，下次悬停保持。

**⑤ Pin 固定**　点 📌 固定弹窗（不随鼠标离开消失），方便对照参考。

**⑥ 6 类型全覆盖**　🖼️ 图片(png/jpg/gif/webp/svg/bmp/ico/avif) · 🎬 视频(mp4/webm/mov/mkv/avi/m4v) · 🎵 音频(mp3/wav/ogg/flac/aac/m4a/opus) · 🔤 字体(ttf/otf/woff/woff2) · 📄 PDF · 🎲 3D(glb/gltf/obj/stl/fbx)

---

## 🚀 安装使用

**前置**：Node.js 18+，VSCode（macOS / Windows / Linux）。

```bash
npx -y resource-hover-preview@latest
```

**Cmd+Q**（Mac）/ 关闭所有窗口（Win/Linux）→ 重新打开 VSCode。

悬停资源管理器里的文件 → 浮动弹窗直接显示。**装一次就生效。**

> ⚠️ 必须**完全退出重启**（Cmd+Q），不是 `Reload Window`——Reload 不重读 workbench，patch 不生效。

### VSCode 更新后怎么办？

VSCode 更新会覆盖 patch，但 **companion 扩展会自动 re-patch**（你什么都不用做）。只需**再 Cmd+Q 一次**让新 patch 生效——companion 会弹通知提示你。

---

## 📂 支持类型

| 类型 | 扩展名 |
|---|---|
| 🖼️ 图片 | png jpg jpeg gif webp svg bmp ico avif |
| 🎬 视频 | mp4 webm mov mkv avi m4v |
| 🎵 音频 | mp3 wav ogg flac aac m4a opus |
| 🔤 字体 | ttf otf woff woff2 |
| 📄 PDF | pdf |
| 🎲 3D | glb gltf obj stl fbx |

---

## 🔄 卸载

```bash
npx -y resource-hover-preview@latest --revert
```

一键还原，零副作用。

---

## License

MIT
