/*mp-overlay:__VERSION__:__HASH__*/
// resource-hover-preview overlay —— 注入 VSCode workbench Renderer（Chromium）。
// 详见 doc/03_浮动预览弹窗设计.md + doc/06_DOM选择器容错策略.md + doc/parse/pares1.md。
// ⚠️ 全程 createElement（Trusted Types 禁 innerHTML，Spike1 实证 TypeError TrustedHTML）。
// window.__MP_CONFIG__ 由 mp-config.js（companion bake）先注入，本文件只读取。
;(function () {
    "use strict";
    var cfg = window.__MP_CONFIG__ || {};
    if (!cfg.port || !cfg.token) { console.warn("[mp-overlay] config missing（mp-config.js 未加载/port/token 缺失），abort"); return; }  // v1.0审查🔵：降等保护
    var SERVER_BASE = "http://127.0.0.1:" + cfg.port;
    var TOKEN = cfg.token;
    var HOVER_DELAY = 300, HIDE_DELAY = 200;
    var SIZE_KEY = "mp.popupSize";
    var isPinned = false;
    var currentHovered = null;
    var hoverTimer = null;
    var hideTimer = null;

    // v0.1 图片 + v0.2 视频 + v0.3 音频/字体（v0.4+ 升 /config 单源 type→mime，R-INT-02）
    var IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"];
    var VIDEO_EXTS = ["mp4", "webm", "mov", "mkv", "avi", "m4v"];
    var AUDIO_EXTS = ["mp3", "wav", "ogg", "flac", "aac", "m4a", "opus"];
    var FONT_EXTS = ["ttf", "otf", "woff", "woff2"];
    var PDF_EXTS = ["pdf"];
    var MODEL3D_EXTS = ["glb", "gltf", "obj", "stl", "fbx"];

    function detectMediaType(filename) {
        var ext = (filename.split(".").pop() || "").toLowerCase();
        if (IMAGE_EXTS.indexOf(ext) >= 0) return "image";
        if (VIDEO_EXTS.indexOf(ext) >= 0) return "video";
        if (AUDIO_EXTS.indexOf(ext) >= 0) return "audio";
        if (FONT_EXTS.indexOf(ext) >= 0) return "font";
        if (PDF_EXTS.indexOf(ext) >= 0) return "pdf";
        if (MODEL3D_EXTS.indexOf(ext) >= 0) return "3d";
        return null;
    }

    // ===== popup 骨架（createElement，doc03）=====
    function ensurePopup() {
        var popup = document.getElementById("mp-popup");
        if (popup) return popup;
        popup = document.createElement("div");
        popup.id = "mp-popup";
        var toolbar = document.createElement("div"); toolbar.className = "mp-toolbar";
        var fname = document.createElement("span"); fname.className = "mp-fname";
        var pinBtn = document.createElement("button"); pinBtn.className = "mp-pin"; pinBtn.textContent = "📌";
        var closeBtn = document.createElement("button"); closeBtn.className = "mp-close"; closeBtn.textContent = "✕";
        toolbar.append(fname, pinBtn, closeBtn);
        var content = document.createElement("div"); content.className = "mp-content";
        var corners = ["nw", "ne", "sw", "se"];
        var handles = corners.map(function (c) {
            var h = document.createElement("div"); h.className = "mp-resize mp-resize-" + c; h.dataset.corner = c; return h;
        });
        popup.append(toolbar, content);
        handles.forEach(function (h) { popup.appendChild(h); });
        injectPopupCss();
        document.body.appendChild(popup);
        bindInteractions(popup, pinBtn, closeBtn);
        loadPopupSize(popup);
        return popup;
    }

    function injectPopupCss() {
        if (document.getElementById("mp-popup-css")) return;
        var style = document.createElement("style");
        style.id = "mp-popup-css";
        style.textContent = [
            "#mp-popup{position:fixed;z-index:999999;background:var(--vscode-editor-background,#1e1e1e);border:1px solid var(--vscode-editorWidget-border,#454545);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.5);overflow:hidden;display:flex;flex-direction:column;min-width:200px;min-height:150px;width:400px;height:300px}",
            ".mp-toolbar{display:flex;align-items:center;gap:8px;padding:4px 8px;background:var(--vscode-editorWidget-background,#252526);border-bottom:1px solid var(--vscode-editorWidget-border,#454545);font-size:12px;user-select:none}",
            ".mp-toolbar .mp-fname{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
            ".mp-toolbar button{background:none;border:none;color:inherit;cursor:pointer;padding:2px 4px}",
            ".mp-content{flex:1;overflow:auto;display:flex;align-items:center;justify-content:center}",
            ".mp-content img,.mp-content video,.mp-content canvas{max-width:100%;max-height:100%;object-fit:contain}",
            ".mp-resize{position:absolute;width:14px;height:14px;z-index:2}",
            ".mp-resize-nw{top:-1px;left:-1px;cursor:nwse-resize}",
            ".mp-resize-ne{top:-1px;right:-1px;cursor:nesw-resize}",
            ".mp-resize-sw{bottom:-1px;left:-1px;cursor:nesw-resize}",
            ".mp-resize-se{bottom:-1px;right:-1px;cursor:nwse-resize}",
        ].join("\n");
        document.head.appendChild(style);
    }

    // ===== 四象限智能定位（doc03，位置固定不跟随鼠标）=====
    function placePopup(itemRect) {
        var popup = ensurePopup();
        var vw = window.innerWidth, vh = window.innerHeight, GAP = 12;
        var w = popup.offsetWidth, h = popup.offsetHeight;
        var cx = itemRect.left + itemRect.width / 2, cy = itemRect.top + itemRect.height / 2;
        var x, y;
        if (cx < vw / 2 && cy < vh / 2) { x = itemRect.right + GAP; y = itemRect.bottom + GAP; }       // 文件项左上 → popup 右下
        else if (cx >= vw / 2 && cy < vh / 2) { x = itemRect.left - GAP - w; y = itemRect.bottom + GAP; } // 右上 → 左下
        else if (cx < vw / 2 && cy >= vh / 2) { x = itemRect.right + GAP; y = itemRect.top - GAP - h; }   // 左下 → 右上
        else { x = itemRect.left - GAP - w; y = itemRect.top - GAP - h; }                                  // 右下 → 左上
        x = Math.max(8, Math.min(x, vw - w - 8)); y = Math.max(8, Math.min(y, vh - h - 8));
        popup.style.left = x + "px"; popup.style.top = y + "px";
    }

    // ===== 四角缩放（对角固定）+ pin + close =====
    function bindInteractions(popup, pinBtn, closeBtn) {
        popup.querySelectorAll(".mp-resize").forEach(function (handle) {
            handle.addEventListener("mousedown", function (e) {
                e.preventDefault(); e.stopPropagation();
                var corner = handle.dataset.corner;
                var startX = e.clientX, startY = e.clientY, r = popup.getBoundingClientRect();
                var onMove = function (ev) {
                    var w = r.width, h = r.height, left = r.left, top = r.top;
                    if (corner.indexOf("e") >= 0) w = Math.max(200, r.width + (ev.clientX - startX));
                    if (corner.indexOf("s") >= 0) h = Math.max(150, r.height + (ev.clientY - startY));
                    if (corner.indexOf("w") >= 0) { w = Math.max(200, r.width - (ev.clientX - startX)); left = r.left + (r.width - w); }
                    if (corner.indexOf("n") >= 0) { h = Math.max(150, r.height - (ev.clientY - startY)); top = r.top + (r.height - h); }
                    popup.style.width = w + "px"; popup.style.height = h + "px";
                    popup.style.left = left + "px"; popup.style.top = top + "px";
                };
                var onUp = function () {
                    document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp);
                    savePopupSize(popup.offsetWidth, popup.offsetHeight);
                };
                document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp);
            });
        });
        pinBtn.addEventListener("click", function (e) { e.stopPropagation(); isPinned = !isPinned; pinBtn.textContent = isPinned ? "📌(固定)" : "📌"; });
        closeBtn.addEventListener("click", function (e) { e.stopPropagation(); isPinned = false; hidePopup(); });
    }

    function savePopupSize(w, h) { try { localStorage.setItem(SIZE_KEY, JSON.stringify({ w: w, h: h })); } catch (e) {} }
    function loadPopupSize(popup) { try { var s = JSON.parse(localStorage.getItem(SIZE_KEY) || "{}"); if (s.w && s.h) { popup.style.width = s.w + "px"; popup.style.height = s.h + "px"; } } catch (e) {} }

    function hidePopup() {
        var popup = document.getElementById("mp-popup"); if (!popup) return;
        disposeContent(); popup.style.display = "none";
        var content = popup.querySelector(".mp-content"); if (content) content.replaceChildren();
    }
    function disposeContent() { if (typeof dispose3D === "function") dispose3D(); }

    // ===== hover 监听（event delegation，doc06）=====
    function isExplorerActive() { var v = document.getElementById("workbench.view.explorer"); return !!v && v.offsetParent !== null; }
    function setupHoverListeners() {
        var root = document.querySelector(".explorer-viewlet") || document.querySelector(".explorer-folders-view") || document.querySelector(".part.sidebar");
        if (!root) return;
        root.addEventListener("mouseover", function (e) {
            if (!isExplorerActive()) return;
            var item = e.target.closest(".monaco-list-row[role='treeitem']") || e.target.closest("[role='treeitem']");
            if (!item || item === currentHovered) return;
            currentHovered = item;
            if (hoverTimer) clearTimeout(hoverTimer);
            var rect = item.getBoundingClientRect();
            hoverTimer = setTimeout(function () { if (currentHovered === item) handleHover(item, rect); }, HOVER_DELAY);
        });
        root.addEventListener("mouseout", function (e) {
            var item = e.target.closest("[role='treeitem']");
            if (item === currentHovered) {
                if (hoverTimer) clearTimeout(hoverTimer);
                if (hideTimer) clearTimeout(hideTimer);
                hideTimer = setTimeout(function () { if (!isMouseInPopup() && !isPinned) hidePopup(); }, HIDE_DELAY);
            }
        });
    }
    function isMouseInPopup() { var p = document.getElementById("mp-popup"); return p && p.matches(":hover"); }

    // ===== 文件名/路径（doc06 方案0：.monaco-icon-label aria-label = 完整路径）=====
    function getLabelName(rowEl) {
        var ln = rowEl.querySelector(".monaco-icon-label a.label-name");
        return ln && ln.textContent ? ln.textContent.trim() : null;
    }
    function getFullPath(rowEl) {
        // Spike8 白盒确证：.monaco-icon-label aria-label = 完整绝对路径（按首个 ' • ' 切分取前段去 decoration）
        var iconLabel = rowEl.querySelector(".monaco-icon-label");
        var al = iconLabel && iconLabel.getAttribute("aria-label");
        if (al) { var idx = al.indexOf(" • "); return (idx >= 0 ? al.slice(0, idx) : al).trim(); }
        return null; // fallback：方案B EH 索引（remote/compressed，v0.1 暂不实现）
    }

    // ===== 渲染（doc03 图片，createElement）=====
    function showPopupError(msg) {
        var popup = ensurePopup(); popup.style.display = "flex";
        var content = popup.querySelector(".mp-content"); content.replaceChildren();
        var span = document.createElement("div"); span.textContent = msg; span.style.color = "#f88"; content.appendChild(span);
    }
    function renderImage(filePath) {
        return fetch(SERVER_BASE + "/preview?file=" + encodeURIComponent(filePath) + "&type=image&token=" + encodeURIComponent(TOKEN))
            .then(function (r) { if (!r.ok) throw new Error("server " + r.status); return r.json(); })
            .then(function (data) {
                var content = document.querySelector(".mp-content");
                var img = document.createElement("img");
                img.src = "data:" + data.mime + ";base64," + data.base64; img.alt = filePath;
                content.replaceChildren(img);
            });
    }

    // v0.2 视频：直 HTTP src（浏览器原生 Range seek，非 blob；doc08 §1）
    function renderVideo(filePath) {
        var content = document.querySelector(".mp-content");
        var video = document.createElement("video");
        video.src = SERVER_BASE + "/preview?file=" + encodeURIComponent(filePath) + "&type=video&token=" + encodeURIComponent(TOKEN);
        video.controls = true; video.autoplay = true; video.muted = true;  // muted+autoplay 配对（doc08）
        video.style.maxWidth = "100%"; video.style.maxHeight = "100%";
        content.replaceChildren(video);
        video.addEventListener("error", function () { showPopupError("video 加载失败"); });
    }

    // v0.3 音频：<audio> 直 HTTP src（复用 video/serveStream 路径，波形砍 [11 F2]）
    function renderAudio(filePath) {
        var content = document.querySelector(".mp-content");
        var audio = document.createElement("audio");
        audio.src = SERVER_BASE + "/preview?file=" + encodeURIComponent(filePath) + "&type=audio&token=" + encodeURIComponent(TOKEN);
        audio.controls = true; audio.style.width = "100%";
        content.replaceChildren(audio);
        audio.addEventListener("error", function () { showPopupError("audio 加载失败"); });
    }

    // v0.3 字体：FontFace ArrayBuffer 源（免 font-src CSP）+ canvas glyph grid（doc08 §3）
    async function renderFont(filePath) {
        var resp = await fetch(SERVER_BASE + "/preview?file=" + encodeURIComponent(filePath) + "&type=font&token=" + encodeURIComponent(TOKEN));
        if (!resp.ok) throw new Error("font server " + resp.status);
        var buf = await resp.arrayBuffer();
        var face = new FontFace("MpPreviewFont", buf);  // ArrayBuffer 源 → 不经 font-src
        await face.load();
        document.fonts.add(face);
        var content = document.querySelector(".mp-content");
        var canvas = document.createElement("canvas");
        canvas.width = 480; canvas.height = 360;
        var ctx = canvas.getContext("2d");
        var samples = [{ size: 48, text: "The quick brown fox" }, { size: 24, text: "ABCDEFGabcdefg 0123456789" }, { size: 14, text: "!@#$%^&*()_+-=" }];
        var y = 0;
        for (var i = 0; i < samples.length; i++) {
            ctx.font = samples[i].size + "px MpPreviewFont";
            ctx.fillText(samples[i].text, 20, y += samples[i].size + 8);
        }
        content.replaceChildren(canvas);
    }

    // v0.4 PDF：pdf.js v6 ESM blob 加载（doc08 §4+§6）。Spike7 真机验证前置（test-pending）。
    var _libCache = {};
    async function loadLibBlob(name, libPath) {
        if (_libCache[name]) return _libCache[name];
        var resp = await fetch(SERVER_BASE + "/lib/" + libPath + "?token=" + encodeURIComponent(TOKEN));
        if (!resp.ok) throw new Error("load " + name + " failed: " + resp.status);
        var code = await resp.text();
        var blobUrl = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
        var mod = await import(blobUrl);  // blob 同源 + script-src blob: 允许
        URL.revokeObjectURL(blobUrl);
        _libCache[name] = mod;
        return mod;
    }
    async function ensurePdfjs() {
        if (_libCache.pdfjs) return _libCache.pdfjs;
        var wresp = await fetch(SERVER_BASE + "/lib/pdf.worker.min.mjs?token=" + encodeURIComponent(TOKEN));
        var wcode = await wresp.text();
        var workerUrl = URL.createObjectURL(new Blob([wcode], { type: "text/javascript" }));  // blob worker（不 revoke）
        var pdfjsLib = await loadLibBlob("pdfjs", "pdf.min.mjs");
        pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
        return pdfjsLib;
    }
    async function renderPdf(filePath) {
        var lib = await ensurePdfjs();
        var resp = await fetch(SERVER_BASE + "/preview?file=" + encodeURIComponent(filePath) + "&type=pdf&token=" + encodeURIComponent(TOKEN));
        var ab = await resp.arrayBuffer();
        var pdf = await lib.getDocument({ data: ab }).promise;
        var page = await pdf.getPage(1);
        var content = document.querySelector(".mp-content");
        var canvas = document.createElement("canvas");
        var viewport = page.getViewport({ scale: 1.0 });
        canvas.width = viewport.width; canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext("2d"), viewport: viewport }).promise;
        content.replaceChildren(canvas);
    }

    // v0.5 3D：three.js esbuild bundle（doc08 §5）。Spike7 真机验证前置（test-pending）。
    var threeReady = null;
    async function render3D(filePath) {
        await loadLibBlob("three", "mp-three.bundle.js");
        var T = window.MP_THREE;
        var content = document.querySelector(".mp-content");
        var canvas = document.createElement("canvas");
        canvas.style.width = "100%"; canvas.style.height = "100%";
        content.replaceChildren(canvas);
        var scene = new T.Scene();
        var camera = new T.PerspectiveCamera(45, canvas.clientWidth / canvas.clientHeight, 0.1, 1000);
        var renderer = new T.WebGLRenderer({ canvas: canvas, antialias: true });
        renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
        var controls = new T.OrbitControls(camera, canvas);
        var resp = await fetch(SERVER_BASE + "/preview?file=" + encodeURIComponent(filePath) + "&type=3d&token=" + encodeURIComponent(TOKEN));
        var ab = await resp.arrayBuffer();
        var gltf = await new T.GLTFLoader().parseAsync(ab, "");
        scene.add(gltf.scene);
        var rafId;
        (function animate() { rafId = requestAnimationFrame(animate); controls.update(); renderer.render(scene, camera); })();
        threeReady = { renderer: renderer, controls: controls, rafId: rafId };
    }
    function dispose3D() {
        if (!threeReady) return;
        cancelAnimationFrame(threeReady.rafId);
        threeReady.controls.dispose();
        threeReady.renderer.dispose();
        threeReady.renderer.forceContextLoss();  // ★ 真正释放 WebGL context，否则 >16 context 必崩
        threeReady = null;
    }

    function handleHover(rowEl, rect) {
        var filename = getLabelName(rowEl);
        if (!filename) return;
        var type = detectMediaType(filename);
        if (!type) return; // 非媒体
        var fullPath = getFullPath(rowEl);
        if (!fullPath) return; // 路径取不到（remote 等 fallback 待 v0.2+）
        var popup = ensurePopup();
        var fn = popup.querySelector(".mp-fname"); fn.textContent = filename;
        popup.style.display = "flex";
        placePopup(rect);
        // loading 占位
        var content = popup.querySelector(".mp-content"); content.replaceChildren();
        var loading = document.createElement("div"); loading.textContent = "loading…"; loading.style.color = "#888"; content.appendChild(loading);
        if (type === "image") renderImage(fullPath).catch(function (e) { showPopupError(e.message); });
        else if (type === "video") renderVideo(fullPath);
        else if (type === "audio") renderAudio(fullPath);
        else if (type === "font") renderFont(fullPath).catch(function (e) { showPopupError(e.message); });
        else if (type === "pdf") renderPdf(fullPath).catch(function (e) { showPopupError(e.message); });
        else if (type === "3d") render3D(fullPath).catch(function (e) { showPopupError(e.message); });
    }

    // ===== 启动 =====
    function waitForExplorer(cb) {
        var start = Date.now();
        (function check() {
            var root = document.querySelector(".explorer-viewlet") || document.querySelector(".part.sidebar .monaco-list");
            if (root) { cb(); return; }
            if (Date.now() - start > 10000) { console.warn("[mp] explorer not found within 10s"); return; }
            setTimeout(check, 300);
        })();
    }

    console.log("[mp-overlay] loaded", cfg.version);
    waitForExplorer(function () { setupHoverListeners(); console.log("[mp-overlay] hover listeners attached"); });
})();
