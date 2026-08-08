# pares4 — v0.4 PDF 功能分析

> v0.4 = v0.3 + PDF。前置 **Spike 7**（pdf.js 在 workbench Renderer 可运行性）。基于 [doc/08 §4 pdf](../08_富媒体渲染器矩阵.md)。

## 0. 范围
hover .pdf → pdf.js 渲染首页 canvas。

## 1. 架构（关键：pdf.js v6 ESM-only + blob 加载）

- **pdf.js v6 是 ESM-only**（.mjs，无 legacy UMD）。经典 `<script src>` 加载抛 SyntaxError。
- **blob dynamic import**（[08 §6 lazy loader](../08_富媒体渲染器矩阵.md)）：fetch /lib/pdf.min.mjs（connect-src 已 patch）→ Blob → import(blobUrl)（script-src blob: 允许）。blob worker（pdf.worker.min.mjs，worker-src 回退 script-src blob:）。
- **text layer 非 TT 问题**（[08 §4 修正](../08_富媒体渲染器矩阵.md)）：现代 pdf.js text_layer 全 createElement，且本渲染只 page.render(canvas) 不实例化 TextLayer。
- **EH /lib/:name 端点**：返回扩展 resources/lib/ 的 pdf.min.mjs + pdf.worker.min.mjs（正则净化文件名）。

## 2. 前置 Spike 7（v0.4 编码前必过）
- pdf.js v6 ESM blob import 在 workbench Renderer 可加载？
- blob worker（pdf.worker.min.mjs）可创建 + getDocument 渲染首页 canvas？
- 真机 Cmd+Q 验证。

## 3. 执行路径（Spike 7 过后）
```
T0 Spike 7: 真机验证 pdf.js blob ESM + worker + 渲染首页
T1 EH /lib/:name 端点（resources/lib/pdf.min.mjs + pdf.worker.min.mjs）
T2 overlay loadLibBlob（§6 lazy loader）+ ensurePdfjs + renderPdf（page.render canvas）
T3 overlay detectMediaType 加 pdf + dispatch
T4 审查 + Cmd+Q hover pdf
```

## 4. 依赖
- pdfjs-dist v6.2+（npm 装，copy build/pdf.min.mjs + pdf.worker.min.mjs 到 resources/lib/）
- Spike 7 真机验证

## 5. v0.4 任务清单（Spike 7 过后）
- [ ] T0 Spike 7（真机 pdf.js blob 渲染首页）
- [ ] T1 /lib/:name 端点 + resources/lib/ pdf 文件
- [ ] T2 overlay loadLibBlob + renderPdf
- [ ] T3 detectMediaType pdf + dispatch
- [ ] T4 审查 + Cmd+Q hover pdf
