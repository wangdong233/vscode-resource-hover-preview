/*mp-overlay:__VERSION__:__HASH__*/
// vscode-resource-hover-preview overlay —— 注入 VSCode workbench Renderer（Chromium）。
// 详见 doc/03_浮动预览弹窗设计.md + doc/06_DOM选择器容错策略.md + doc/parse/pares1.md。
// ⚠️ 全程 createElement（Trusted Types 禁 innerHTML，Spike1 实证 TypeError TrustedHTML）。
// window.__MP_CONFIG__ 由 mp-config.js（companion bake）先注入，本文件只读取。
;(function () {
    "use strict";
    var cfg = window.__MP_CONFIG__ || {};
    if (!cfg.port || !cfg.token) { console.warn("[mp-overlay] config missing（mp-config.js 未加载/port/token 缺失），abort"); return; }  // v1.0审查🔵：降等保护
    if (cfg.enabled === false) { console.log("[mp-overlay] disabled（resource-hover-preview.enabled=false）"); return; }  // 运行时开关(2.4)：=== false 避免未定义误关
    var SERVER_BASE = "http://127.0.0.1:" + cfg.port;
    var TOKEN = cfg.token;
    var HOVER_DELAY = 300, HIDE_DELAY = 200;
    var SIZE_KEY = "mp.popupSize";
    var isPinned = false;
    var currentHovered = null;
    var lastRenderedItem = null;  // 已渲染项（防同项 re-hover 重 fetch 闪烁，审查 3.1）
    var renderEpoch = 0;  // 渲染代际（防异步竞态 A 的 promise 覆盖 B，审查 3.6）
    // ===== 预加载缓存（Wave3 b：LRU blob 缓存，image/font/pdf/3d 命中跳 fetch）=====
    var _cache = new Map();       // key=path|type → {url, bytes, ts, pinned}
    var _inflight = new Map();    // key → Promise（dedup 并发预取）
    var _cacheBytes = 0;
    var CACHE_MAX = 24, CACHE_BYTES_MAX = 60 * 1024 * 1024;  // 24 项 / 60MB（单驱逐点协调，审查 §1.6 项6）
    var hoverTimer = null;
    var hideTimer = null;
    // v0.2-v0.5审查🟡：disposeActiveRenderer 按 type 路由（防 font/pdf/3d 资源累积）
    var activeRendererType = null;
    var activeFontFace = null;
    var activePdf = null;

    // v0.1 图片 + v0.2 视频 + v0.3 音频/字体（overlay *_EXTS ↔ server TYPE_TABLE 一致性由 test-contract-sync per-type 闸门钉）
    var IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"];
    var VIDEO_EXTS = ["mp4", "webm", "mov", "mkv", "avi", "m4v"];
    var AUDIO_EXTS = ["mp3", "wav", "ogg", "flac", "aac", "m4a", "opus"];
    var FONT_EXTS = ["ttf", "otf", "woff", "woff2"];
    var PDF_EXTS = ["pdf"];
    var MODEL3D_EXTS = ["glb", "gltf"];  // 仅 glb/gltf（GLTFLoader 支持）；obj/stl/fbx 需对应 Loader，entry-three 未含 → 诚实砍（审查 2.2，防晦涩 GLTF 解析错）

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

    // ===== 预加载缓存 API（Wave3 b：单写者——唯一 revoke 点 = cachePut 内 LRU 驱逐；hidePopup/disposeContent 绝不碰 _cache）=====
    function cacheKey(p, t) { return p + "|" + t; }
    var _pinnedKeys = new Set();  // 当前渲染项 key（防 prefetch 邻项 LRU 驱逐正在显示的项，审查 §1.6 项6 多写者协调）
    function cachePin(p, t) { var k = cacheKey(p, t); _pinnedKeys.add(k); var e = _cache.get(k); if (e) e.pinned = true; }
    function cacheUnpin(p, t) { var k = cacheKey(p, t); _pinnedKeys.delete(k); var e = _cache.get(k); if (e) e.pinned = false; }
    function cacheGet(p, t) { var e = _cache.get(cacheKey(p, t)); if (e) { e.ts = Date.now(); return e.url; } return null; }
    function cachePut(p, t, url, bytes) {
        var key = cacheKey(p, t);
        if (_cache.has(key)) return;
        _cache.set(key, { url: url, bytes: bytes, ts: Date.now(), pinned: _pinnedKeys.has(key) });
        _cacheBytes += bytes;
        while ((_cache.size > CACHE_MAX || _cacheBytes > CACHE_BYTES_MAX) && _cache.size > 1) {  // 单驱逐点
            var oldestKey = null, oldest = null;
            for (var entry of _cache) { if (!entry[1].pinned && (!oldest || entry[1].ts < oldest.ts)) { oldest = entry[1]; oldestKey = entry[0]; } }
            if (!oldestKey) break;
            _cache.delete(oldestKey); _cacheBytes -= oldest.bytes;
            try { URL.revokeObjectURL(oldest.url); } catch (e) {}  // 唯一 revoke 点（data URL revoke 无害）
        }
    }
    // fetchCached：命中返缓存 url；未命中跑 fetcher（_inflight dedup 并发）→ cachePut → 返 url
    function fetchCached(p, t, fetcher) {
        var key = cacheKey(p, t), existing = _cache.get(key);
        if (existing) { existing.ts = Date.now(); return Promise.resolve(existing.url); }
        if (_inflight.has(key)) return _inflight.get(key);
        var prom = fetcher().then(function (r) { cachePut(p, t, r.url, r.bytes); _inflight.delete(key); return r.url; })
            .catch(function (e) { _inflight.delete(key); throw e; });
        _inflight.set(key, prom);
        return prom;
    }
    // previewUrl：单一 URL 构造（审查 R-INT-04 散布收敛：原 fetcherFor/renderVideo/renderAudio 三处独立拼）
    function previewUrl(p, type) { return SERVER_BASE + "/preview?file=" + encodeURIComponent(p) + "&type=" + type + "&token=" + encodeURIComponent(TOKEN); }
    // fetcherFor：类型分派取数据 → {url, bytes}（image=data URL；font/pdf/3d=blob URL）
    function fetcherFor(p, type) {
        var url = previewUrl(p, type);
        if (type === "image") {
            return function () { return fetch(url).then(function (r) { if (!r.ok) throw new Error("server " + r.status); return r.json(); })
                .then(function (d) { return { url: "data:" + d.mime + ";base64," + d.base64, bytes: d.base64.length }; }); };  // bytes=data URL 实际驻留字节（base64 串长，复审：原 sizeBytes 是原始字节，低估 ~4/3）
        }
        return function () { return fetch(url).then(function (r) { if (!r.ok) throw new Error("server " + r.status); return r.arrayBuffer(); })
            .then(function (ab) { return { url: URL.createObjectURL(new Blob([ab])), bytes: ab.byteLength }; }); };
    }
    // schedulePrefetch（Wave3 a）：hover 某项时预取 ±2 兄弟行填缓存（流式 video/audio 不预取）
    function schedulePrefetch(item) {
        var rows = [item], sib = item;
        for (var i = 0; i < 2; i++) { sib = sib.previousElementSibling; if (sib && sib.matches && sib.matches(".monaco-list-row")) rows.push(sib); else break; }
        sib = item;
        for (var i = 0; i < 2; i++) { sib = sib.nextElementSibling; if (sib && sib.matches && sib.matches(".monaco-list-row")) rows.push(sib); else break; }
        rows.forEach(function (r) {
            var fn = getLabelName(r); if (!fn) return;
            var type = detectMediaType(fn); if (!type || type === "video" || type === "audio") return;
            var p = getFullPath(r); if (!p || cacheGet(p, type)) return;
            fetchCached(p, type, fetcherFor(p, type)).catch(function () {});  // 填缓存，结果忽略
        });
    }
    // pinCurrent/unpinCurrent：当前显示项缓存 pin（防 prefetch 邻项 LRU 驱逐正在显示的项）
    var _curPin = null;
    function pinCurrent(p, t) { if (_curPin) cacheUnpin(_curPin.p, _curPin.t); cachePin(p, t); _curPin = { p: p, t: t }; }
    function unpinCurrent() { if (_curPin) { cacheUnpin(_curPin.p, _curPin.t); _curPin = null; } }

    // ===== popup 骨架（createElement，doc03）=====
    function ensurePopup() {
        var popup = document.getElementById("mp-popup");
        if (popup) return popup;
        popup = document.createElement("div");
        popup.id = "mp-popup";
        var fname = document.createElement("span"); fname.className = "mp-fname";  // 文件名悬浮 content 左上（无 toolbar 占位）
        // 右侧竖向 rail（pin/reset/close；popup DOM 子元素 → 保 :hover/mouseleave 协同）
        var rail = document.createElement("div"); rail.className = "mp-rail";
        var pinBtn = document.createElement("button"); pinBtn.className = "mp-pin"; pinBtn.textContent = "📌"; pinBtn.title = "固定（锁定当前内容，忽略新 hover）";
        var resetBtn = document.createElement("button"); resetBtn.className = "mp-reset"; resetBtn.textContent = "⤢"; resetBtn.title = "恢复默认大小";
        var closeBtn = document.createElement("button"); closeBtn.className = "mp-close"; closeBtn.textContent = "✕"; closeBtn.title = "关闭";
        rail.append(pinBtn, resetBtn, closeBtn);
        var content = document.createElement("div"); content.className = "mp-content";
        var corners = ["nw", "ne", "sw", "se"];
        var handles = corners.map(function (c) {
            var h = document.createElement("div"); h.className = "mp-resize mp-resize-" + c; h.dataset.corner = c; return h;
        });
        popup.append(content, fname, rail);
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
            // Wave2 样式重构：无 border + 半透明毛玻璃 + overflow:visible（让 rail 溢出右侧可点）
            "#mp-popup{position:fixed;z-index:999999;background:color-mix(in srgb,var(--vscode-editorWidget-background,#252526) 72%,transparent);backdrop-filter:blur(12px) saturate(1.3);-webkit-backdrop-filter:blur(12px) saturate(1.3);border:none;border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,.5);overflow:visible;display:flex;flex-direction:column;min-width:200px;min-height:150px;width:400px;height:300px}",
            "@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){#mp-popup{background:var(--vscode-editorWidget-background,#252526)}}",  // 软件渲染兜底（无 backdrop-filter）
            ".mp-content{flex:1;overflow:hidden;display:flex;align-items:center;justify-content:center;border-radius:8px}",  // ★ clip 下推到 content（popup overflow:visible 让 rail/handle 溢出）
            ".mp-content img,.mp-content video,.mp-content canvas{max-width:100%;max-height:100%;object-fit:contain;border-radius:8px}",
            ".mp-fname{position:absolute;top:6px;left:8px;z-index:2;font-size:11px;color:var(--vscode-descriptionForeground,rgba(255,255,255,.75));background:rgba(0,0,0,.4);padding:1px 6px;border-radius:3px;pointer-events:none;max-width:calc(100% - 16px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:0;transition:opacity .15s}",
            "#mp-popup:hover .mp-fname{opacity:1}",
            ".mp-rail{position:absolute;top:50%;right:0;transform:translate(100%,-50%);display:flex;flex-direction:column;gap:3px;opacity:0;transition:opacity .15s}",  // 溢出右侧垂直居中
            "#mp-popup:hover .mp-rail{opacity:1}",
            "#mp-popup.rail-left .mp-rail{right:auto;left:0;transform:translate(-100%,-50%)}",  // 朝左（popup 在文件项左侧时，rail 朝左不压文件行）
            ".mp-rail button{background:var(--vscode-editorWidget-background,#252526);border:none;color:var(--vscode-foreground,#ccc);cursor:pointer;padding:5px 7px;font-size:14px;line-height:1;border-radius:5px;box-shadow:0 2px 8px rgba(0,0,0,.4)}",
            ".mp-rail button:hover{background:var(--vscode-toolbar-hoverBackground,rgba(127,127,127,.3))}",
            ".mp-rail button.is-pinned{color:#4ec9b0}",  // pin 高亮
            ".mp-resize{position:absolute;width:14px;height:14px;z-index:3;opacity:0;transition:opacity .15s}",
            "#mp-popup:hover .mp-resize{opacity:.4}",
            ".mp-resize:hover{opacity:1}",
            ".mp-resize-nw{top:0;left:0;cursor:nwse-resize}",
            ".mp-resize-ne{top:0;right:0;cursor:nesw-resize}",
            ".mp-resize-sw{bottom:0;left:0;cursor:nesw-resize}",
            ".mp-resize-se{bottom:0;right:0;cursor:nwse-resize}",
        ].join("\n");
        document.head.appendChild(style);
    }

    // ===== 四象限智能定位（doc03，位置固定不跟随鼠标）+ rail 朝向 =====
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
        // rail 朝向：popup 在文件项右侧 → rail 朝右（远离项）；popup 在项左侧 → rail 朝左（防压文件行）
        popup.classList.toggle("rail-left", x < itemRect.left);
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
        pinBtn.addEventListener("click", function (e) { e.stopPropagation(); isPinned = !isPinned; pinBtn.classList.toggle("is-pinned", isPinned); });  // Wave2：class 高亮替代文本（窄 rail 不撑宽）
        resetBtn.addEventListener("click", function (e) { e.stopPropagation(); popup.style.width = "400px"; popup.style.height = "300px"; savePopupSize(400, 300); });
        closeBtn.addEventListener("click", function (e) { e.stopPropagation(); isPinned = false; pinBtn.classList.remove("is-pinned"); currentHovered = null; lastRenderedItem = null; hidePopup(); });  // 清 currentHovered/lastRenderedItem + is-pinned class（复审 rev3：popup 单例复用后 pin 按钮视觉状态机说谎）
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
        lastRenderedItem = null;  // 清已渲染项（审查 3.1）
        unpinCurrent();  // 解除当前项缓存 pin（允许 LRU 回收，但不 revoke——blobUrl 仍在 _cache）
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
            if (item === currentHovered) { if (hideTimer) clearTimeout(hideTimer); return; }  // 同一行不重复（去重）+ 取消 popup-mouseleave 设的 hideTimer（防 round-trip 闪烁）
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
    function renderImage(filePath, ep) {
        return fetchCached(filePath, "image", fetcherFor(filePath, "image")).then(function (dataUrl) {
            if (ep !== renderEpoch) return;  // stale（已被新 hover 取代，审查 3.6）
            var content = document.querySelector(".mp-content");
            var img = document.createElement("img");
            img.src = dataUrl; img.alt = filePath;
            return img.decode().then(function () { if (ep !== renderEpoch) return; content.replaceChildren(img); });  // Wave3 b：decode 预热再 attach
        });
    }

    // v0.2 视频：直 HTTP src（浏览器原生 Range seek，非 blob；doc08 §1）
    function renderVideo(filePath, ep) {
        var content = document.querySelector(".mp-content");
        var video = document.createElement("video");
        video.src = previewUrl(filePath, "video");
        video.controls = true; video.autoplay = true; video.muted = true; video.playsInline = true;  // muted+autoplay 配对 + playsInline（doc08 §1，v0.2-v0.5审查🔵）
        video.style.maxWidth = "100%"; video.style.maxHeight = "100%";
        content.replaceChildren(video);
        video.addEventListener("error", function () { if (ep === renderEpoch) showPopupError("video 加载失败"); });
        video.play().catch(function () {  // autoplay 被拦 → showPlayButton（doc08 §1，v0.2-v0.5审查🔵）
            if (ep !== renderEpoch) return;  // 复审：content 已被新 hover 替换则不叠杂散按钮
            var btn = document.createElement("button"); btn.textContent = "▶ 点击播放"; btn.style.cssText = "font-size:24px;padding:12px;cursor:pointer";
            btn.addEventListener("click", function () { video.play(); btn.remove(); });
            content.appendChild(btn);
        });
    }

    // v0.3 音频：<audio> 直 HTTP src（复用 video/serveStream 路径，波形砍 [11 F2]）
    function renderAudio(filePath, ep) {
        var content = document.querySelector(".mp-content");
        var audio = document.createElement("audio");
        audio.src = previewUrl(filePath, "audio");
        audio.controls = true; audio.style.width = "100%";
        content.replaceChildren(audio);
        audio.addEventListener("error", function () { if (ep === renderEpoch) showPopupError("audio 加载失败"); });
    }

    // v0.3 字体：FontFace ArrayBuffer 源（免 font-src CSP）+ canvas glyph grid（doc08 §3）。Wave3：走缓存。
    async function renderFont(filePath, ep) {
        var url = await fetchCached(filePath, "font", fetcherFor(filePath, "font"));
        if (ep !== renderEpoch) return;
        var buf = await fetch(url).arrayBuffer();  // blob URL → ArrayBuffer（缓存命中为本地内存 fetch）
        if (ep !== renderEpoch) return;
        var face = new FontFace("MpPreviewFont", buf);  // ArrayBuffer 源 → 不经 font-src
        await face.load();
        if (ep !== renderEpoch) return;
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
        if (ep !== renderEpoch) return;
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
    async function renderPdf(filePath, ep) {
        var lib = await ensurePdfjs();
        if (ep !== renderEpoch) return;
        var url = await fetchCached(filePath, "pdf", fetcherFor(filePath, "pdf"));
        if (ep !== renderEpoch) return;
        var ab = await fetch(url).arrayBuffer();
        if (ep !== renderEpoch) return;
        var pdf = await lib.getDocument({ data: ab }).promise;
        if (ep !== renderEpoch) { try { pdf.destroy(); } catch (e) {} return; }  // stale → 销毁防 worker 泄漏
        activePdf = pdf; activeRendererType = "pdf";  // 登记 dispose（v0.2-v0.5审查🟡）
        var page = await pdf.getPage(1);
        if (ep !== renderEpoch) return;
        var content = document.querySelector(".mp-content");
        var canvas = document.createElement("canvas");
        var viewport = page.getViewport({ scale: 1.0 });
        canvas.width = viewport.width; canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext("2d"), viewport: viewport }).promise;
        if (ep !== renderEpoch) return;
        content.replaceChildren(canvas);
    }

    // v0.5 3D：three.js esbuild bundle（doc08 §5）。Spike7 真机验证前置（test-pending）。
    var threeReady = null;
    async function render3D(filePath, ep) {
        await loadLibBlob("three", "mp-three.bundle.js");
        if (ep !== renderEpoch) return;
        var T = window.MP_THREE;
        var url = await fetchCached(filePath, "3d", fetcherFor(filePath, "3d"));
        if (ep !== renderEpoch) return;
        var ab = await fetch(url).arrayBuffer();
        if (ep !== renderEpoch) return;
        var gltf = await new T.GLTFLoader().parseAsync(ab, "");  // 复审：parseAsync 纯 CPU 解析，提到 WebGLRenderer 之前——await 窗口零 GPU context，stale 时连 renderer 都未创建
        if (ep !== renderEpoch) return;
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
        if (isPinned) return;  // pin 锁定当前内容，忽略新 hover（审查 3.2）
        var filename = getLabelName(rowEl);
        if (!filename) return;
        var type = detectMediaType(filename);
        if (!type) return; // 非媒体
        var fullPath = getFullPath(rowEl);
        if (!fullPath) return; // 路径取不到（remote 等 fallback 待 v0.2+）
        if (rowEl === lastRenderedItem) {  // 同项已渲染且仍可见 → 不重复 fetch（审查 3.1：防 hideTimer 清 currentHovered 后 re-hover 闪烁）
            var existing = document.getElementById("mp-popup");
            if (existing && existing.style.display !== "none") return;
        }
        lastRenderedItem = rowEl;
        var popup = ensurePopup();
        var fn = popup.querySelector(".mp-fname"); fn.textContent = filename;
        popup.style.display = "flex";
        placePopup(rect);
        disposeActiveRenderer();  // v0.2-v0.5审查🟡：渲染前清上一类型资源（防累积）
        // loading 占位
        var content = popup.querySelector(".mp-content"); content.replaceChildren();
        var loading = document.createElement("div"); loading.textContent = "loading…"; loading.style.color = "#888"; content.appendChild(loading);
        var ep = ++renderEpoch;  // 渲染代际（审查 3.6：异步 render 完成前若已 hover 新项 → 旧 render 作废）
        pinCurrent(fullPath, type);  // Wave3：缓存 pin 当前项（防 prefetch 邻项 LRU 驱逐正在显示的项）
        // 复审：error 路径也守 ep（stale 渲染的 rejection 不覆盖当前 live popup；ep 在 catch 闭包内）
        if (type === "image") renderImage(fullPath, ep).catch(function (e) { if (ep === renderEpoch) showPopupError(e.message); });
        else if (type === "video") renderVideo(fullPath, ep);
        else if (type === "audio") renderAudio(fullPath, ep);
        else if (type === "font") renderFont(fullPath, ep).catch(function (e) { if (ep === renderEpoch) showPopupError(e.message); });
        else if (type === "pdf") renderPdf(fullPath, ep).catch(function (e) { if (ep === renderEpoch) showPopupError(e.message); });
        else if (type === "3d") render3D(fullPath, ep).catch(function (e) { if (ep === renderEpoch) showPopupError(e.message); });
        schedulePrefetch(rowEl);  // Wave3 a：预取 ±2 邻行填缓存（消除移动间隔）
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
