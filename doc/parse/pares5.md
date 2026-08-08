# pares5 — v0.5 3D 功能分析

> v0.5 = v0.4 + 3D。前置 **Spike 7**（three.js 在 workbench Renderer）。基于 [doc/08 §5 3D](../08_富媒体渲染器矩阵.md)。

## 0. 范围
hover .glb/.gltf → three.js 渲染 + OrbitControls 旋转。

## 1. 架构（关键：three.js r185 无 UMD + esbuild bundle + dispose）

- **three.js r185 无 UMD build**（build/three.min.js 404 删除）。核心 three.module.min.js 自包含，但 OrbitControls/GLTFLoader 是独立 ES module + `import { ... } from 'three'` 裸说明符——blob 加载无法解析裸 import。
- **esbuild bundle**（构建时）：entry-three.js（import THREE + OrbitControls + GLTFLoader → globalThis.MP_THREE）→ esbuild --bundle --format=iife → resources/lib/mp-three.bundle.js。overlay loadLibBlob import。
- **dispose（防 GPU 泄漏）**：hidePopup cancelAnimationFrame + controls.dispose + 几何体/材质/纹理遍历 dispose + **renderer.forceContextLoss**（真正释放 WebGL context，否则 >16 context 必崩）。
- **事件分层**：OrbitControls 绑 canvas pointerdown/wheel；popup 四角 resize handle 是 canvas 兄弟 + stopPropagation → 互不干扰。

## 2. 前置 Spike 7（v0.5 编码前必过）
- three.js esbuild bundle 在 workbench blob import 可加载？
- WebGLRenderer canvas 渲染 + OrbitControls + GLTFLoader.parseAsync？
- 反复悬停多个 3D 文件 dispose 无 GPU 泄漏（forceContextLoss）？

## 3. 执行路径（Spike 7 过后）
```
T0 Spike 7: 真机 three.js bundle + 渲染 + dispose 无泄漏
T1 构建脚本: esbuild entry-three.js → resources/lib/mp-three.bundle.js（构建步骤入 prepublishOnly）
T2 overlay loadLibBlob(three) + render3D（scene/camera/renderer/controls/GLTFLoader/rAF）+ dispose3D（forceContextLoss）
T3 overlay detectMediaType 加 3d + dispatch
T4 审查 + Cmd+Q hover glb
```

## 4. 依赖
- three@r185（npm）+ esbuild（devDep，构建 bundle）
- Spike 7 真机验证

## 5. v0.5 任务清单（Spike 7 过后）
- [ ] T0 Spike 7（真机 three bundle + 渲染 + dispose）
- [ ] T1 esbuild 构建脚本 + resources/lib/mp-three.bundle.js
- [ ] T2 overlay loadLibBlob(three) + render3D + dispose3D
- [ ] T3 detectMediaType 3d + dispatch
- [ ] T4 审查 + Cmd+Q hover glb
