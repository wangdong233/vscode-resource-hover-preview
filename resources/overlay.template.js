/*mp-overlay:__VERSION__:__HASH__*/
// vscode-resource-hover-preview overlay —— 注入 VSCode workbench Renderer（Chromium）。
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
    // v0.2-v0.5审查🟡：disposeActiveRenderer 按 type 路由（防 font/pdf/3d 资源累积）
    var activeRendererType = null;
    var activeFontFace = null;
    var activePdf = null;

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
        var pinBtn = document.createElement("button"); pinBtn.className = "mp-pin"; pinBtn.textContent = "📌"; pinBtn.title = "固定（不随鼠标离开消失）";
        var resetBtn = document.createElement("button"); resetBtn.className = "mp-reset"; resetBtn.textContent = "⤢"; resetBtn.title = "恢复默认大小";
        var closeBtn = document.createElement("button"); closeBtn.className = "mp-close"; closeBtn.textContent = "✕"; closeBtn.title = "关闭";
        toolbar.append(fname, resetBtn, pinBtn, closeBtn);
        var content = document.createElement("div"); content.className = "mp-content";
        var corners = ["nw", "ne", "sw", "se"];
        var handles = corners.map(function (c) {
            var h = document.createElement("div"); h.className = "mp-resize mp-resize-" + c; h.dataset.corner = c; return h;
        });
        popup.append(toolbar, content);
        handles.forEach(function (h) { popup.appendChild(h); });
        injectPopupCss();
        document.body.appendChild(popup);
        bindInteractions(popup, pinBtn, closeBtn, resetBtn);
        loadPopupSize(popup);
        return popup;
    }

    function injectPopupCss() {
        if (document.getElementById("mp-popup-css")) return;
        var style = document.createElement("style");
        style.id = "mp-popup-css";
        style.textContent = [
            "#mp-popup{position:fixed;z-index:999999;background:var(--vscode-editorWidget-background,#252526);border:1px solid var(--vscode-widget-border,rgba(255,255,255,.08));border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.4);overflow:hidden;display:flex;flex-direction:column;min-width:200px;min-height:150px;width:400px;height:300px}",
            ".mp-toolbar{display:flex;align-items:center;gap:2px;padding:2px 6px;font-size:11px;user-select:none;color:var(--vscode-descriptionForeground,rgba(255,255,255,.5))}",
            ".mp-toolbar .mp-fname{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
            ".mp-toolbar button{background:none;border:none;color:var(--vscode-foreground,#ccc);cursor:pointer;padding:2px 6px;font-size:13px;border-radius:4px;opacity:.35;transition:opacity .12s,background .12s}",
            ".mp-toolbar button:hover{opacity:1;background:var(--vscode-toolbar-hoverBackground,rgba(255,255,255,.12))}",
            "#mp-popup:hover .mp-toolbar button{opacity:.7}",
            ".mp-content{flex:1;overflow:hidden;display:flex;align-items:center;justify-content:center}",
            ".mp-content img,.mp-content video,.mp-content canvas{max-width:100%;max-height:100%;object-fit:contain}",
            ".mp-resize{position:absolute;width:14px;height:14px;z-index:3;opacity:0;transition:opacity .15s}",
            "#mp-popup:hover .mp-resize{opacity:.5}",
            ".mp-resize:hover{opacity:1}",
            ".mp-resize-nw{top:0;left:0;cursor:nwse-resize}",
            ".mp-resize-ne{top:0;right:0;cursor:nesw-resize}",
            ".mp-resize-sw{bottom:0;left:0;cursor:nesw-resize}",
            ".mp-resize-se{bottom:0;right:0;cursor:nwse-resize}",
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
    function bindInteractions(popup, pinBtn, closeBtn, resetBtn) {
        popup.querySelectorAll(".mp-resize").forEach(function (handle) {
            handle.addEventListener("mousedown", function (e) {
                e.preventDefault(); e.stopPropagation();
                var corner = handle.dataset.corner;
                var startX = e.clientX, startY = e.clientY, r = popup.getBoundingClientRect();
                // rAF 节流：每帧最多设一次 style（60fps），避免高频 mousemove reflow 卡顿
                var lastEv = e, rafId = null;
                var applyResize = function () {
                    rafId = null;
                    var ev = lastEv;
                    var w = r.width, h = r.height, left = r.left, top = r.top;
                    if (corner.indexOf("e") >= 0) w = Math.max(200, r.width + (ev.clientX - startX));
                    if (corner.indexOf("s") >= 0) h = Math.max(150, r.height + (ev.clientY - startY));
                    if (corner.indexOf("w") >= 0) { w = Math.max(200, r.width - (ev.clientX - startX)); left = r.left + (r.width - w); }
                    if (corner.indexOf("n") >= 0) { h = Math.max(150, r.height - (ev.clientY - startY)); top = r.top + (r.height - h); }
                    popup.style.width = w + "px"; popup.style.height = h + "px";
                    popup.style.left = left + "px"; popup.style.top = top + "px";
                };
                var onMove = function (ev) { lastEv = ev; if (!rafId) rafId = requestAnimationFrame(applyResize); };
                var onUp = function () {
                    document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp);
                    if (rafId) cancelAnimationFrame(rafId);
                    applyResize();  // 最终精确
                    savePopupSize(popup.offsetWidth, popup.offsetHeight);
                };
                document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp);
            });
        });
        pinBtn.addEventListener("click", function (e) { e.stopPropagation(); isPinned = !isPinned; pinBtn.textContent = isPinned ? "📌(固定)" : "📌"; });
        resetBtn.addEventListener("click", function (e) { e.stopPropagation(); popup.style.width = "400px"; popup.style.height = "300px"; savePopupSize(400, 300); });
        closeBtn.addEventListener("click", function (e) { e.stopPropagation(); isPinned = false; hidePopup(); });
        // popup 在 document.body（不在 .explorer-viewlet 子树），root 事件收不到 popup 上的进出 → popup 自管
        popup.addEventListener("mouseenter", function () { if (hideTimer) clearTimeout(hideTimer); });  // 在 popup 上 → 取消关闭
        popup.addEventListener("mouseleave", function () {  // 离开 popup → 计划关闭
            if (!isPinned) {
                if (hideTimer) clearTimeout(hideTimer);
                hideTimer = setTimeout(function () { if (!isPinned) { hidePopup(); currentHovered = null; } }, HIDE_DELAY);
            }
        });
    }

    function savePopupSize(w, h) { try { localStorage.setItem(SIZE_KEY, JSON.stringify({ w: w, h: h })); } catch (e) {} }
    function loadPopupSize(popup) { try { var s = JSON.parse(localStorage.getItem(SIZE_KEY) || "{}"); if (s.w && s.h) { popup.style.width = s.w + "px"; popup.style.height = s.h + "px"; } } catch (e) {} }

    function hidePopup() {
        var popup = document.getElementById("mp-popup"); if (!popup) return;
        disposeContent(); popup.style.display = "none";
        var content = popup.querySelector(".mp-content"); if (content) content.replaceChildren();
    }
    function disposeContent() {
        // v0.2-v0.5审查🟡：按 type 路由 dispose（防 FontFace/PDF worker/geometry 累积）
        if (activeRendererType === "3d" && typeof dispose3D === "function") dispose3D();
        else if (activeRendererType === "font" && activeFontFace) { try { document.fonts.delete(activeFontFace); activeFontFace.unload(); } catch (e) {} activeFontFace = null; }
        else if (activeRendererType === "pdf" && activePdf) { try { activePdf.destroy(); } catch (e) {} activePdf = null; }
        activeRendererType = null;
    }
    function disposeActiveRenderer() { disposeContent(); }  // handleHover 前/切类型时调

    // ===== hover 监听（event delegation，doc06）=====
    function isExplorerActive() { var v = document.getElementById("workbench.view.explorer"); return !!v && v.offsetParent !== null; }
    function setupHoverListeners() {
        var root = document.querySelector(".explorer-viewlet") || document.querySelector(".explorer-folders-view") || document.querySelector(".part.sidebar");
        if (!root) return;
        // ⚠️ 真机 bug1 彻查：VSCode HoverController 在 a.label-name 上吞了 mouseover（capture 也到不了）。
        //   改用 mousemove——VSCode hover 不在 mousemove 上拦截，冒泡+capture 都可靠。
        //   mousemove 高频，currentHovered 去重（同一行不重复）+ setTimeout 防抖。
        root.addEventListener("mousemove", function (e) {
            if (!isExplorerActive()) return;
            var item = e.target.closest(".monaco-list-row[role='treeitem']") || e.target.closest("[role='treeitem']");
            if (!item) {
                // 鼠标离开文件项区域 → 计划隐藏
                if (currentHovered && !isPinned) {
                    if (hideTimer) clearTimeout(hideTimer);
                    hideTimer = setTimeout(function () { if (!isMouseInPopup() && !isPinned) hidePopup(); currentHovered = null; }, HIDE_DELAY);
                }
                return;
            }
            if (item === currentHovered) return;  // 同一行不重复（mousemove 高频去重）
            currentHovered = item;
            if (hoverTimer) clearTimeout(hoverTimer);
            if (hideTimer) clearTimeout(hideTimer);  // 进入新行取消隐藏计划
            var rect = item.getBoundingClientRect();
            hoverTimer = setTimeout(function () { if (currentHovered === item) handleHover(item, rect); }, HOVER_DELAY);
        }, true);
        // mouseleave 兜底：鼠标快速划出 root（最后 mousemove 可能漏）
        root.addEventListener("mouseleave", function () {
            if (currentHovered && !isPinned) {
                if (hoverTimer) clearTimeout(hoverTimer);
                if (hideTimer) clearTimeout(hideTimer);
                hideTimer = setTimeout(function () { if (!isMouseInPopup() && !isPinned) hidePopup(); currentHovered = null; }, HIDE_DELAY);
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
        video.controls = true; video.autoplay = true; video.muted = true; video.playsInline = true;  // muted+autoplay 配对 + playsInline（doc08 §1，v0.2-v0.5审查🔵）
        video.style.maxWidth = "100%"; video.style.maxHeight = "100%";
        content.replaceChildren(video);
        video.addEventListener("error", function () { showPopupError("video 加载失败"); });
        video.play().catch(function () {  // autoplay 被拦 → showPlayButton（doc08 §1，v0.2-v0.5审查🔵）
            var btn = document.createElement("button"); btn.textContent = "▶ 点击播放"; btn.style.cssText = "font-size:24px;padding:12px;cursor:pointer";
            btn.addEventListener("click", function () { video.play(); btn.remove(); });
            content.appendChild(btn);
        });
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
        activeFontFace = face; activeRendererType = "font";  // 登记 dispose（v0.2-v0.5审查🟡）
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
        activePdf = pdf; activeRendererType = "pdf";  // 登记 dispose（v0.2-v0.5审查🟡）
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
        var cw = canvas.clientWidth || 400, ch = canvas.clientHeight || 300;  // v0.2-v0.5审查🔵：首帧 clientWidth=0 fallback
        var scene = new T.Scene();
        var camera = new T.PerspectiveCamera(45, cw / ch, 0.1, 1000);
        var renderer = new T.WebGLRenderer({ canvas: canvas, antialias: true });
        renderer.setSize(cw, ch, false);
        var controls = new T.OrbitControls(camera, canvas);
        var resp = await fetch(SERVER_BASE + "/preview?file=" + encodeURIComponent(filePath) + "&type=3d&token=" + encodeURIComponent(TOKEN));
        var ab = await resp.arrayBuffer();
        var gltf = await new T.GLTFLoader().parseAsync(ab, "");
        scene.add(gltf.scene);
        var disposables = [];
        scene.traverse(function (o) {  // v0.2-v0.5审查🟡：makeDisposeGLTF 遍历收集（doc08 §5）
            if (o.geometry) disposables.push(o.geometry);
            if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) {
                for (var k in m) { if (m[k] && m[k].isTexture) disposables.push(m[k]); }
                disposables.push(m);
            });
        });
        var cleanup = function () { disposables.forEach(function (d) { try { d.dispose(); } catch (e) {} }); };
        var rafId;
        (function animate() { rafId = requestAnimationFrame(animate); controls.update(); renderer.render(scene, camera); })();
        threeReady = { renderer: renderer, controls: controls, rafId: rafId, cleanup: cleanup };
        activeRendererType = "3d";
    }
    function dispose3D() {
        if (!threeReady) return;
        cancelAnimationFrame(threeReady.rafId);
        threeReady.controls.dispose();
        if (threeReady.cleanup) threeReady.cleanup();  // GLTF geometry/material/texture 遍历 dispose（v0.2-v0.5审查🟡）
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
        disposeActiveRenderer();  // v0.2-v0.5审查🟡：渲染前清上一类型资源（防累积）
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
