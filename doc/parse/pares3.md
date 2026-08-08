# pares3 — v0.3 音频 + 字体功能分析

> v0.3 = v0.2 + 音频 + 字体。增量小。基于 [doc/08 §2 audio](../08_富媒体渲染器矩阵.md) + [doc/08 §3 font](../08_富媒体渲染器矩阵.md)。

## 0. 范围与验收（[07](../07_开发计划与MVP任务拆解.md)）

+ 音频（`<audio>`，**波形砍** [11 F2](../11_rejected-by-design清单.md)）+ 字体（FontFace glyph grid）。验收：hover .mp3 → `<audio>` 播放；hover .ttf/.woff2 → canvas glyph。

## 1. 架构（v0.2 基础上的增量）

1. **音频**：复用 v0.2 serveStream（type=audio → range stream）+ overlay renderAudio（`<audio controls>` 直 HTTP src，同 video 路径）。波形 NO-GO（[11 F2](../11_rejected-by-design清单.md)，ffmpeg.wasm 需 COOP/COEP）。
2. **字体**：FontFace API + ArrayBuffer 源（**免 font-src CSP patch**，无网络请求）+ canvas 绘样本 glyph grid（[08 §3](../08_富媒体渲染器矩阵.md)）。server /preview type=font → 返回二进制（overlay arrayBuffer → FontFace）。v0.3 server 加 font 分支（返二进制 stream 或 base64）。

## 2. 执行路径

```
T1 overlay: detectMediaType 加 audio/font exts + renderAudio(<audio> 直 src) + renderFont(FontFace+canvas)
T2 server: /preview type=audio → serveStream（v0.2 已有）；type=font → 返回二进制（stream 或 base64 JSON）
T3 审查 + 更新 07
T4 Cmd+Q hover mp3/ttf → 统一测
```

## 3. 不明确点决策

| 点 | 决策 | 依据 |
|---|---|---|
| audio src | 直 HTTP src（复用 video 路径，serveStream range） | doc/08 §2 |
| 波形 | 砍（NO-GO） | [11 F2](../11_rejected-by-design清单.md) |
| font 渲染 | FontFace ArrayBuffer 源 + canvas glyph（免 opentype.js ~150KB） | doc/08 §3 |
| font CSP | ArrayBuffer 源不经 font-src（无网络）→ 免 patch font-src | doc/08 §3 + 08 §0 CSP 基线 |
| font 格式 | ttf/otf/woff/woff2（FontFace 原生解 woff2，Brotli 内置） | doc/08 §3 |
| font server 返回 | 二进制 stream（overlay arrayBuffer）| 省内存 vs base64 JSON |

## 4. v0.3 任务清单

- [ ] T1 `resources/overlay.template.js`：detectMediaType 加 audio/font exts + renderAudio + renderFont（FontFace+canvas，createElement）
- [ ] T2 `companion/src/server.ts`：/preview type=font → 二进制 stream（serveStream 复用？font 不是 range seek，直接 stream）；audio 复用 serveStream
- [ ] T3 03 审查 + 更新 07 v0.3 完成态
- [ ] T4 Cmd+Q hover mp3/ttf → [test-pending](test-pending.md)
