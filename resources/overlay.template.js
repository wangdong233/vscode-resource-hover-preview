/*mp-overlay:__VERSION__:__HASH__*/
// resource-hover-preview overlay —— 注入 VSCode workbench Renderer（Chromium）。
// 详见 doc/03_浮动预览弹窗设计.md + doc/06_DOM选择器容错策略.md + doc/08_富媒体渲染器矩阵.md。
// ⚠️ 全程 createElement（Trusted Types 禁 innerHTML，Spike1 实证 TypeError TrustedHTML）。
// __MP_CONFIG__ 在 bake 时被替换为 {port,token,version}（或由 mp-config.js 先赋 window.__MP_CONFIG__）。
;(function () {
    "use strict";
    var cfg = window.__MP_CONFIG__ || {};
    var SERVER_BASE = "http://127.0.0.1:" + cfg.port;
    var TOKEN = cfg.token;
    var HOVER_DELAY = 300, HIDE_DELAY = 200;
    var SIZE_KEY = "mp.popupSize";
    var isPinned = false;

    // ===== popup 骨架（createElement，doc03）=====
    function ensurePopup() { /* TODO doc03: createElement toolbar/content/4角handle, loadPopupSize */ }
    function placePopup(itemRect) { /* TODO doc03 四象限智能定位：itemRect 中心相对视口选展开方向 */ }
    function bindResize() { /* TODO doc03 四角缩放：对角固定 */ }
    function savePopupSize(w, h) { localStorage.setItem(SIZE_KEY, JSON.stringify({ w: w, h: h })); }
    function loadPopupSize() { /* TODO */ }
    function hidePopup() { /* TODO: disposeActiveRenderer + replaceChildren */ }

    // ===== hover 监听（event delegation，doc06）=====
    function isExplorerActive() { /* TODO doc06: #workbench.view.explorer 可见 */ }
    function setupHoverListeners() { /* TODO doc06: mouseover/mouseout 委托 .explorer-viewlet，closest [role=treeitem] */ }

    // ===== 文件名/路径（doc06 方案0：.monaco-icon-label aria-label = 完整路径）=====
    function getLabelName(rowEl) { /* TODO doc06: rowEl.querySelector('.monaco-icon-label a.label-name').textContent */ }
    function getFullPath(rowEl) {
        // TODO doc06 Spike8 白盒确证：.monaco-icon-label aria-label = 完整绝对路径（按首个 ' • ' 切分取前段）
        // 免 EH 文件索引（方案B 降为 fallback：remote/compressed/path含' • '）
    }
    function detectMediaType(filename) { /* TODO: 从 /config 端点取 type→mime 映射（04 单源），不硬编码 */ }

    // ===== 渲染（doc03 图片 / doc08 富媒体，全程 createElement）=====
    function renderImage(filePath) { /* TODO doc03: fetch /preview type=image → createElement('img') src=data:base64 */ }
    function renderByType(type, filePath) { /* TODO doc08 dispatch + disposeActiveRenderer */ }

    // ===== 启动 =====
    function waitForExplorer(cb) { /* TODO doc06: MutationObserver 等 .explorer-viewlet */ }
    console.log("[mp-overlay] loaded", cfg.version);
    // TODO: waitForExplorer → setupHoverListeners → reportEnvironment
})();
