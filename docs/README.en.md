<div align="center">

# vscode-resource-hover-preview

[![npm](https://img.shields.io/npm/v/vscode-resource-hover-preview?style=flat-square&color=CCA700)](https://www.npmjs.com/package/vscode-resource-hover-preview)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](#license)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)

**Hover over files in VSCode's Explorer — a floating preview pops up instantly**

🖼️ Images · 🎬 Videos · 🎵 Audio · 🔤 Fonts · 🎲 3D — Four-corner resize + smart positioning + size memory + Pin & drag

[简体中文](../README.md) | **English**

<img src="images/预览示例.png" width="720" alt="Explorer hover floating preview demo">

</div>

---

> Browsing files in VSCode's Explorer and want to see what an image/video/font/3D looks like? Install this — **hover over a file name and a floating preview pops up**, without opening the file or taking up editor space. Move away and it disappears. 5 media types covered.

---

## ✨ Features

**① Hover to Preview**　Hover over a file in the Explorer (.png/.mp4/.ttf/.glb...) → a floating preview pops up in ~300ms. No file opened, no editor tab taken.

**② Four-Corner Resize**　Drag any of the four corners to resize (opposite corner stays fixed). Adjust to the perfect size.

**③ Smart Quadrant Positioning**　Automatically picks the best expand direction (top-left/bottom-left/top-right/bottom-right) based on the file item's position — avoids covering the file itself and stays within screen bounds.

**④ Size Memory**　Resized dimensions are saved to localStorage, restored on next hover.

**⑤ Pin & Drag**　Click 📌 to pin the popup (won't disappear when mouse leaves); once pinned, image/font popups can be dragged anywhere for easy side-by-side reference.

**⑥ 5 Types Covered**　🖼️ Images (png/jpg/gif/webp/svg/bmp/ico/avif) · 🎬 Videos (mp4/webm/mov/mkv/avi/m4v/flv) · 🎵 Audio (mp3/wav/ogg/flac/aac/m4a/opus/aiff) · 🔤 Fonts (ttf/otf/woff/woff2) · 🎲 3D (glb/gltf/obj/stl/fbx)

---

## 🚀 Install & Use

**Prerequisite**: Node.js 18+, VSCode (macOS / Windows / Linux).

```bash
npx -y vscode-resource-hover-preview@latest
```

**Fully quit** VSCode and reopen (Mac: Cmd+Q; Windows/Linux: Quit from tray or menu — closing windows alone may not suffice).

Hover over a file in the Explorer → floating preview appears. **Install once, works forever.**

> ⚠️ Must **fully quit** then restart (Mac Cmd+Q / Windows tray Quit / Linux fully quit), NOT `Reload Window` — Reload doesn't re-read the patched workbench, patch won't take effect.

### After VSCode Updates?

VSCode updates overwrite the patch, but **the companion extension automatically re-patches** (you do nothing). Just **Cmd+Q once more** to activate the new patch — the companion will show a notification.

---

## 📂 Supported Types

| Type | Extensions |
|---|---|
| 🖼️ Image | png jpg jpeg gif webp svg bmp ico avif |
| 🎬 Video | mp4 webm mov mkv avi m4v flv |
| 🎵 Audio | mp3 wav ogg flac aac m4a opus aiff |
| 🔤 Font | ttf otf woff woff2 |
| 🎲 3D | glb gltf obj stl fbx |

> 💡 **Video formats**: mp4/webm/mov play natively; AVI/FLV/MKV and other non-native formats require [ffmpeg](https://ffmpeg.org/) installed locally (auto-transcoded to a browser-playable format; brief delay on first hover).

---

## 🔄 Uninstall

```bash
npx -y vscode-resource-hover-preview@latest --revert
```

One command, zero side effects.

---

## 💝 Support

If vscode-resource-hover-preview helps you, buy the author a coffee ☕

<div align="center">

| WeChat | Alipay |
| :---: | :---: |
| <img src="images/support-wechat.jpg" height="200" alt="WeChat"> | <img src="images/support-alipay.jpg" height="200" alt="Alipay"> |

</div>

Or ⭐ Star, open an Issue / PR — all support counts.

---

## License

MIT
