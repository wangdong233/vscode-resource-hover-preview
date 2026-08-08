# pares2 — v0.2 视频功能分析

> v0.2 = v0.1 + 视频预览。v0.2 是 v0.1 的小增量（3 处），架构不变。基于 [doc/08 §1 video](../08_富媒体渲染器矩阵.md) + [doc/04 serveStream](../04_EH与Renderer通信协议.md) + [doc/02 media-src](../02_workbench注入设计.md)。

## 0. 范围与验收（[07](../07_开发计划与MVP任务拆解.md)）

+ 视频预览（range stream + `<video>`，**直 HTTP src**，原生 Range seek）。验收：hover .mp4/.webm → 浮动弹窗 `<video>` 预览 + Range seek（拖进度）。

## 1. 架构（v0.1 基础上的 3 处增量，无架构变更）

1. **CSP media-src patch**：[02 patchCsp](../02_workbench注入设计.md) v0.1 已含 media-src 加 `http://127.0.0.1:* blob:`（前向兼容）。v0.2 仅验证 media-src 实际放行 `<video>` http src（不需改 patcher，已 patch）。
2. **server serveStream（range 206）**：v0.1 server.ts 只有 serveImage。加 `serveStream`（[04](../04_EH与Renderer通信协议.md) 已给完整实现：`/^bytes=(\d+)-(\d*)$/` 严格校验、clamp end=fileSize-1、start>end 返 416、Accept-Ranges: bytes、createReadStream pipe）。/preview type=video|audio|pdf|3d → serveStream。
3. **overlay renderVideo（直 HTTP src）**：[08 §1](../08_富媒体渲染器矩阵.md) 修正——不用 fetch→blob（破坏流式），改 **直 HTTP src**（`video.src = SERVER_BASE/preview?...&type=video`），浏览器 `<video>` 原生 Range seek。createElement video + autoplay muted 配对（被拦 showPlayButton）。

## 2. 执行路径

```
T1 server.ts: 加 serveStream(range 206 硬化) + /preview type=video → serveStream
T2 overlay.template.js: detectMediaType 加 video exts(mp4/webm/mov/mkv/avi/m4v) + RENDERERS.video = renderVideo(直 HTTP src)
T3 验证 media-src patch 已含(v0.1 patchCsp 已做,确认即可)
T4 审查(03清单) + 更新 07/排期
T5 Cmd+Q hover mp4 → 统一测(test-pending)
```

## 3. 不明确点决策

| 点 | 决策 | 依据 |
|---|---|---|
| video src 方式 | 直 HTTP src（非 blob） | doc/08 §1 修正：blob 破坏流式 + 浪费内存，直 src 原生 Range seek |
| autoplay 策略 | muted+autoplay 配对；被拦 showPlayButton | doc/08 §1 + media-preview videoPreview.js |
| range 实现 | 严格正则 + clamp + 416 + Accept-Ranges | doc/04 serveStream 硬化 |
| video exts | mp4/webm/mov/mkv/avi/m4v | doc/08 TYPE_TABLE |
| media-src blob: | 加（备用，直 src 走 http） | doc/02 patchCsp media-src |

## 4. v0.2 任务清单

- [ ] T1 `companion/src/server.ts` 加 serveStream（range 206）+ /preview video 分支
- [ ] T2 `resources/overlay.template.js` detectMediaType 加 video exts + renderVideo（直 HTTP src，createElement）
- [ ] T3 确认 v0.1 patchCsp 的 media-src patch 含 `http://127.0.0.1:* blob:`
- [ ] T4 03 审查 + 更新 [07](../07_开发计划与MVP任务拆解.md) v0.2 完成态
- [ ] T5 Cmd+Q hover mp4 → [test-pending](test-pending.md)
