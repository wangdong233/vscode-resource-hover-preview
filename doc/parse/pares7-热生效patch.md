# pares7 — 热生效 patch（免 Cmd+Q 迭代）设计

> 状态：**设计就绪·待 Spike 9 人为验证后实施**。本文是实施就绪的精确蓝图，Spike 9 一通过即可机械化执行。
> 来源：Wave 研究工作流 hot-patch agent 深度白盒结论 + 综合 impl_sketch。

## 核心洞察（白盒确证）

overlay IIFE 一旦加载就**常驻 workbench renderer 进程**，具备完整 DOM/fetch 能力。因此"overlay 逻辑/样式/预加载的迭代"可让**运行中的 overlay 自己 fetch 新版 impl 并 re-init**，完全绕过 workbench.html 重载（磁盘缓存盲区）。

**仍需 Cmd+Q 的低频事件**（无法绕过）：首次 `<script>` 注入 / CSP meta 改动 / VSCode 更新覆盖 workbench.html。这些是月更级频率。

重启根因（已确证，doc/10 RK13 + doc/01）：Reload Window = `webContents.reload()` 走 Chromium 磁盘 HTTP 缓存不重读 workbench.html；只有 Cmd+Q/`app.relaunch` 完全重启重读盘。

## Spike 9 闸门（GO/NO-GO）⚠️ 唯一未闸门点

`import(blobUrl)` / `eval()` 的 **Trusted Types 通过性**未真机确认。理论 spec 放行（import() 非 TT sink，仅 CSP 管）+ loadLibBlob 旁证，但非本项目真机铁证。

**关键捷径**：Wave1 serveLib 修复后，PDF/3D 的 `loadLibBlob`（overlay.template.js:365 `import(blobUrl)`）首次真机运行 = **天然的 Spike 9**。
- **用户 hover `.pdf` 或 `.glb` 能渲染**（非 TT TypeError）→ import() 路径通 → **Wave 4 GO**
- 抛 `TrustedScript/TrustedHTML TypeError` → import() 被 TT 拦 → Wave 4 **搁置**，回退"每次 bump INJECT_VERSION + Cmd+Q"

手动复核（VSCode DevTools Console，TOKEN 从 `window.__MP_CONFIG__.token`）：
```js
fetch("http://127.0.0.1:17741/lib/pdf.min.mjs?token=<TOKEN>")
  .then(r=>r.text()).then(c=>import(URL.createObjectURL(new Blob([c]))))
```

## 实施蓝图（Spike 9 通过后机械化执行）

### 1. 文件拆分
- `resources/overlay.bootstrap.js`（~70 行，**冻结**，随 mp-overlay.js 静态注入）：cfg 守卫 + enabled 守卫 + waitForExplorer + loadImpl + 轮询版本 + swap。
- `resources/overlay-impl.template.js`（现有 overlay.template.js :14-397 全部逻辑重构为 `export function createOverlay(cfg)`，补全 dispose）。

### 2. overlay-impl 模块签名
```js
export const OVERLAY_IMPL_REV = "__IMPL_HASH__";  // bake 时填 sha256 前 8
export function createOverlay(cfg) {
    // 现有全部逻辑搬进此函数体；module-scope var 变 createOverlay 局部 var
    var hoverTimer=null, hideTimer=null, currentHovered=null, lastRenderedItem=null,
        renderEpoch=0, threeReady=null, activeFontFace=null, activePdf=null,
        activeRendererType=null, isPinned=false, _curPin=null;
    var explorerRoot=null, onMove=null, onLeave=null;  // ★ 命名引用（dispose 要 removeEventListener）
    // ... cache 模块 / detectMediaType / ensurePopup / renderXxx / handleHover / schedulePrefetch ...
    function attach() {  // ★ 命名监听器（非匿名），记 explorerRoot
        explorerRoot = document.querySelector(".explorer-viewlet") || ...;
        onMove = function(e){...}; onLeave = function(){...};
        explorerRoot.addEventListener("mousemove", onMove, true);
        explorerRoot.addEventListener("mouseleave", onLeave);
    }
    function dispose() {  // ★ 完整 teardown（热替换前调）
        if (hoverTimer) clearTimeout(hoverTimer);
        if (hideTimer) clearTimeout(hideTimer);
        disposeContent(); if (typeof dispose3D==="function") dispose3D();
        unpinCurrent();
        if (explorerRoot && onMove) { explorerRoot.removeEventListener("mousemove", onMove, true);
                                      explorerRoot.removeEventListener("mouseleave", onLeave); }
        var p=document.getElementById("mp-popup"); if(p) p.remove();
        var css=document.getElementById("mp-popup-css"); if(css) css.remove();
    }
    attach();
    return { dispose: dispose, rev: OVERLAY_IMPL_REV };
}
```

### 3. bootstrap（冻结，静态注入）
```js
;(function(){
  "use strict";
  var cfg = window.__MP_CONFIG__ || {};
  if (!cfg.port || !cfg.token) { console.warn("[mp] cfg missing"); return; }
  if (cfg.enabled === false) { console.log("[mp] disabled"); return; }
  var BASE = "http://127.0.0.1:" + cfg.port, TOK = cfg.token;
  var INSTANCE=null, poll=null, swapLock=false;
  async function loadImpl() {
    var r = await fetch(BASE + "/overlay-impl.js?token=" + encodeURIComponent(TOK));
    if (!r.ok) throw new Error("impl " + r.status);
    var code = await r.text();
    var blobUrl = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    var mod; try { mod = await import(blobUrl); } finally { URL.revokeObjectURL(blobUrl); }
    return mod;
  }
  async function maybeSwap() {
    if (swapLock) return; swapLock = true;
    try {
      var mod = await loadImpl();
      if (INSTANCE && mod.OVERLAY_IMPL_REV === INSTANCE.rev) return;  // 幂等
      var next = mod.createOverlay(cfg);  // 先 init 新（throw 则旧仍在）
      var old = INSTANCE; INSTANCE = next;
      if (old) { try { old.dispose(); } catch(e){ console.warn("[mp] old dispose", e); } }
      console.log("[mp] hot-swapped impl →", next.rev);
    } catch(e) { console.warn("[mp] swap failed (keep old)", e.message); }
    finally { swapLock = false; }
  }
  function startPoll() {
    poll = setInterval(function(){  // 10s 轮询 /config 取 overlayImplRev
      fetch(BASE + "/config?token=" + encodeURIComponent(TOK)).then(r=>r.json())
        .then(c=>{ if (c.overlayImplRev && (!INSTANCE || c.overlayImplRev !== INSTANCE.rev)) maybeSwap(); })
        .catch(()=>{});
    }, 10000);
    document.addEventListener("visibilitychange", function(){ if (document.visibilityState==="visible") maybeSwap(); });
  }
  function waitForExplorer(cb){ /* 复用 overlay.template.js:386-394 */ }
  waitForExplorer(function(){ maybeSwap().then(function(){ if(!INSTANCE) console.warn("[mp] impl not loaded,retry @poll"); startPoll(); }); });
})();
```

### 4. 配套改动
- `src/overlay-bake.ts`：新增 `buildBootstrapJs`（banner hash）；`buildImplJs`（impl 单独算 IMPL_HASH）；detectAndPatch bake 两文件到 workbench 目录。
- `src/patcher.ts`：installRuntimeFiles 复制 overlay-impl.js 到 INSTALL_DIR；detectAndPatch fresh 分支也校验 overlay-impl.js 存在。
- `companion/src/server.ts`：新增 `/overlay-impl.js` 端点（复用 serveLib 正则净化，从 INSTALL_DIR/resources 或 workbench 目录读）；`/config` 恢复但极简 `{ overlayImplRev, port }`（仅 bootstrap 轮询消费）。
- `hooks/test-contract-sync.mjs`：加 overlay-impl ↔ bootstrap 的 dispose/attach 契约断言（impl 必须 export createOverlay + OVERLAY_IMPL_REV）。

### 5. 激活后的效果
- **首次**：patcher 注入 bootstrap（静态 `<script src>`，TT 安全）+ 复制 impl 到 workbench 目录 → **Cmd+Q 一次**。
- **之后每次迭代**（改 overlay-impl + rebuild + 重装）：bootstrap 轮询发现 impl rev 变 → fetch → import → dispose 旧 → init 新 → **≤10s 自动生效，无需 Cmd+Q**。
- Reload-cache 盲区：复用 doc/01 已设计的 `globalThis.__mpPatchRev` 哨兵。

## 风险
1. **Spike 9 失败**（import/eval 被 TT 拦）→ 整条路线搁置。
2. **dispose 不全** → 监听器/RAF/worker/blobUrl 泄漏 → 每 10s 轮询累积。缓解：dispose 必须覆盖 hover listeners(命名引用)、timers、popup+CSS、3D renderer/font/pdf worker、cache unpin；上线前用"连续 swap 10 次后查 listener 计数 + 内存"验证。
3. **blobUrl 泄漏**：loadImpl 每次造 blobUrl，import 后 revoke（finally）。impl 内部缓存的 blobUrl 由 cachePut LRU 单点 revoke（已就绪）。

## 不做（YAGNI）
- service worker 拦截 / DevTools Protocol / location reload 绕缓存——研究结论均为更侵入或不可靠，不采。
