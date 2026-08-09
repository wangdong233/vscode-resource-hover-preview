# 待测试清单（人为介入点，统一实施完毕后测）

> 按"不需人为介入的点持续迭代，人为介入点跳过记录统一测"原则。代码状态 ≠ 测试状态——以下区分【代码:已实施】与【真机:待 Cmd+Q 验收】。

## Wave 1 正确性基线（0.3.0 / INJECT v0.7.0）— 代码已实施·待真机验收

**P0 修复**（白盒确认 + 已修）：
- [ ] **serveLib 不再 404**：`unzip -l companion/*.vsix | grep resources/lib` 见 pdf.min.mjs/pdf.worker.min.mjs/mp-three.bundle.js 三件；Cmd+Q → hover `.pdf` → pdf.js 渲染首页（非 "load pdfjs failed: 404"）
- [ ] **3D 诚实化**：hover `.glb` → three.js 渲染可旋转；hover `.obj` → 不弹窗（exts 已砍，非晦涩 GLTF 解析错）
- [ ] hover `.pdf` + `.glb` 后切文件 → 无 GPU/worker 泄漏（dispose 路由）

**disable 开关**：
- [ ] workspace config `resource-hover-preview.enabled=false` → Cmd+Q → hover 任意文件 → 无弹窗、Console `[mp-overlay] disabled`
- [ ] 改回 `true` → Cmd+Q → 恢复

**状态机修复**（审查 3.1/3.2）：
- [ ] hover A → pin → hover B → 内容不切换（锁定生效）
- [ ] closeBtn 关 → 不动鼠标 re-hover 同文件 → 弹窗重现（closeBtn 清 currentHovered）
- [ ] hover A → 移出再回 A（popup 未隐）→ 不重新 loading（lastRenderedItem）

**死代码 + 契约**（代码层已验，无需真机）：
- [x] fileIndex.ts 删 / spawn import 删 / noUnusedLocals 闸门开（tsc 0 error）
- [x] test-contract-sync per-type 分组 + port + marker + 3D-loader（npm test 绿）
- [x] test-patcher-io 真断言 + mutation 守门（mutant→3 FAIL，还原→OK）

## v0.1–v0.5 全类型渲染 — 代码已实施·待真机验收（INJECT v0.7.0）

- [ ] **v0.1 图片**：hover .png/.jpg/.svg → 浮窗；四象限定位 + 四角缩放 + 尺寸记忆 + pin；非媒体(.py)不弹窗
- [ ] **v0.2 视频**：hover .mp4 → `<video>` + Range seek（拖进度）
- [ ] **v0.3 音频/字体**：hover .mp3 → `<audio>`；hover .ttf/.woff2 → FontFace canvas glyph grid
- [ ] **v0.4 PDF**：hover .pdf → pdf.js 渲染首页（依赖 Wave1 serveLib 修复）
- [ ] **v0.5 3D**：hover .glb → three.js + OrbitControls 旋转 + 切文件 dispose（无 GPU 泄漏）
- [ ] **patch 基础**：不弹"安装损坏"（checksum 重算）；自愈（覆盖 workbench.html→重启→companion spawn --patch-only 自愈）；--revert 干净还原；cc-status-dot 不受影响

## Spike 9 — 热生效 patch 前置闸门（Wave 4 GO/NO-GO）⚠️ 待人为验证

> Wave 4（bootstrap/impl 拆分，后续迭代免 Cmd+Q）依赖运行中 overlay 经 `import(blobUrl)` 热替换新 impl。import()/eval 的 Trusted Types 通过性是唯一未闸门点（理论 spec 放行 + loadLibBlob 旁证，非本项目真机铁证）。

**操作**（VSCode workbench DevTools Console，须已 patch 起来 server）：
- [ ] 跑 `fetch("http://127.0.0.1:17741/lib/pdf.min.mjs?token=<TOKEN>").then(r=>r.text()).then(c=>import(URL.createObjectURL(new Blob([c]))))` → **不抛** `TrustedScript/TrustedHTML TypeError` = import 路径通 → Wave 4 GO
- [ ] 备选：`(0,eval)('1+1')` → 不抛 TT 错 = eval 路径通
- [ ] 若都抛 → Wave 4 搁置，回退"每次 bump INJECT_VERSION + Cmd+Q"

（TOKEN 从 INSTALL_DIR/mp-token.json 读，或 Console `window.__MP_CONFIG__.token`）

## Wave 2 浮窗样式（待实施）— 无框/毛玻璃/按钮右侧竖排吸附
- [ ] hover → 无 border + 半透明毛玻璃（backdrop-filter）+ 右侧竖向 rail（pin/reset/close 竖排）
- [ ] 文件项在视口左 → rail 朝左不压文件行
- [ ] rail 是 popup DOM 子元素（保 :hover/mouseleave 协同）

## Wave 3 预加载（待实施）— LRU 缓存 + 相邻预取 + epoch + HTTP 缓存
- [ ] 同图二次 hover ~即时（<50ms，缓存命中）
- [ ] A↔B 快速切换不串内容（epoch 守卫）
- [ ] video seek 正常（HTTP Range 不破坏流式）

## Wave 4 热生效 patch（待 Spike 9 通过）
- [ ] 改 overlay-impl 一行 → rebuild → **不 Cmd+Q** ≤10s → 行为变化（热替换）
- [ ] Console 无 TT TypeError + 无重复 mousemove 监听（dispose 验证）

## v1.0 打磨（待实施）
- [ ] 三平台（macOS✅/Win/Linux）路径 + 权限
- [ ] macOS 代码签名 / Win PATH
