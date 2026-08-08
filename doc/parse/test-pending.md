# 待测试清单（人为介入点，统一实施完毕后测）

> 按"不需人为介入的点持续迭代，人为介入点跳过记录统一测"原则，各阶段代码实施完成后，Cmd+Q 真机测试统一在此。每项标【阶段】+ 状态。

## v0.1（图片悬停浮动预览）— 代码完成 + patch 成功（commit 8da6126）
- [ ] **Cmd+Q hover png**：Cmd+Q 完全退出 → 重开 → hover .png → 浮动弹窗显示图片？
- [ ] DevTools Console `[mp-overlay] loaded` + `hover listeners attached`，hover 无报错（fetch/CSP/TT）
- [ ] 四象限定位（左上项→右下展开等）+ 四角缩放（对角固定）+ 尺寸记忆（reload/重启恢复）+ pin
- [ ] 非媒体文件（.py/.ts）不弹窗
- [ ] **不弹"安装损坏"**（checksum 重算填回生效）
- [ ] **自愈**：模拟 VSCode 更新（覆盖 workbench.html）→ 重启 → companion activate spawn --patch-only 自愈 → 再 Cmd+Q 生效
- [ ] **--revert**：`node dist/patcher.js --revert` → Cmd+Q → 干净还原（workbench + product + 删 overlay/config）
- [ ] cc-status-dot 不受影响（VSCode 正常运行，仅 patch workbench）

## v0.2（视频）— 待实施
- [ ] Cmd+Q hover .mp4 → `<video>` 浮动预览 + Range seek（拖进度）

## v0.3（音频 + 字体）— 待实施
- [ ] hover .mp3 → `<audio>` 播放（波形砍）
- [ ] hover .ttf/.woff2 → FontFace canvas glyph grid

## v0.4（PDF）— 待实施（前置 Spike 7）
- [ ] hover .pdf → pdf.js blob ESM 渲染首页

## v0.5（3D）— 待实施（前置 Spike 7）
- [ ] hover .glb → three.js bundle 渲染 + OrbitControls 旋转 + 切文件 dispose（无 GPU 泄漏）

## v1.0（打磨）— 待实施
- [ ] 三平台（macOS✅/Win/Linux）路径 + 权限
- [ ] macOS 代码签名（多状态）
- [ ] 错误处理 + README demo + `npx` 分发

## 统一测试流程（实施完毕后）
1. `node dist/patcher.js`（install + patch）→ Cmd+Q
2. 逐阶段 hover 各类型文件 → 验收
3. --revert 还原
4. DevTools Console全程监控 [mp-overlay] 日志 + CSP/TT 报错
