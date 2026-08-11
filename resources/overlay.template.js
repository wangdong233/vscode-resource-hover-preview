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
    var pinBtnEl = null;  // 0.4.9 供 startRename 改 is-pinned（直接持引用,免按 class 查——pin 按钮由 .mp-rail button 泛化样式,无独立 CSS 规则）
    var currentHovered = null;
    var lastRenderedItem = null;  // 已渲染项（防同项 re-hover 重 fetch 闪烁，审查 3.1）
    var renderEpoch = 0;  // 渲染代际（防异步竞态 A 的 promise 覆盖 B，审查 3.6）
    var hasFfmpeg = false;  // 档3:/ping 缓存——非原生格式(avi/aiff)仅在 ffmpeg 在时弹浮窗,不在则不弹(用户要求不做提醒)
    var NATIVE_VIDEO = ["mp4", "webm", "ogg", "mov", "m4v", "mkv"];  // Chromium 原生解复用/解码
    var NATIVE_AUDIO = ["mp3", "wav", "ogg", "flac", "aac", "m4a", "opus"];
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
    // activePdf 移除（0.4.5：PDF 预览删除，用户判定无必要）

    // v0.1 图片 + v0.2 视频 + v0.3 音频/字体（overlay *_EXTS ↔ server TYPE_TABLE 一致性由 test-contract-sync per-type 闸门钉）
    var IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"];
    var VIDEO_EXTS = ["mp4", "webm", "mov", "mkv", "avi", "m4v", "flv"];  // 0.5: +flv(ffmpeg transcode)
    var AUDIO_EXTS = ["mp3", "wav", "ogg", "flac", "aac", "m4a", "opus", "aiff"];  // 0.5: +aiff(ffmpeg 转码)
    var FONT_EXTS = ["ttf", "otf", "woff", "woff2"];
    var MODEL3D_EXTS = ["glb", "gltf", "stl", "obj", "fbx"];  // 0.4.3：恢复 stl/obj/fbx（entry-three 加 STLLoader/OBJLoader/FBXLoader，render3D 按格式分发）

    function detectMediaType(filename) {
        var ext = (filename.split(".").pop() || "").toLowerCase();
        if (IMAGE_EXTS.indexOf(ext) >= 0) return "image";
        if (VIDEO_EXTS.indexOf(ext) >= 0) {
            if (NATIVE_VIDEO.indexOf(ext) >= 0 || hasFfmpeg) return "video";  // 原生或 ffmpeg 可转码 → 弹浮窗
            return null;  // 非原生(avi/flv) + 无 ffmpeg → 不弹(用户要求不做提醒)
        }
        if (AUDIO_EXTS.indexOf(ext) >= 0) {
            if (NATIVE_AUDIO.indexOf(ext) >= 0 || hasFfmpeg) return "audio";
            return null;
        }
        if (FONT_EXTS.indexOf(ext) >= 0) return "font";
        if (MODEL3D_EXTS.indexOf(ext) >= 0) return "3d";
        return null;
    }

    // ===== 预加载缓存 API（Wave3 b：单写者——唯一 revoke 点 = cachePut 内 LRU 驱逐；hidePopup/disposeContent 绝不碰 _cache）=====
    function cacheKey(p, t) { return p + "|" + t; }
    var _pinnedKeys = new Set();  // 当前渲染项 key（防 prefetch 邻项 LRU 驱逐正在显示的项，审查 §1.6 项6 多写者协调）
    function cachePin(p, t) { var k = cacheKey(p, t); _pinnedKeys.add(k); var e = _cache.get(k); if (e) e.pinned = true; }
    function cacheUnpin(p, t) { var k = cacheKey(p, t); _pinnedKeys.delete(k); var e = _cache.get(k); if (e) e.pinned = false; }
    function cacheGet(p, t) { var e = _cache.get(cacheKey(p, t)); if (e) { e.ts = Date.now(); return e.data; } return null; }
    function cachePut(p, t, data, bytes) {
        var key = cacheKey(p, t);
        if (_cache.has(key)) return;
        _cache.set(key, { data: data, bytes: bytes, ts: Date.now(), pinned: _pinnedKeys.has(key) });
        _cacheBytes += bytes;
        while ((_cache.size > CACHE_MAX || _cacheBytes > CACHE_BYTES_MAX) && _cache.size > 1) {  // 单驱逐点
            var oldestKey = null, oldest = null;
            for (var entry of _cache) { if (!entry[1].pinned && (!oldest || entry[1].ts < oldest.ts)) { oldest = entry[1]; oldestKey = entry[0]; } }
            if (!oldestKey) break;
            _cache.delete(oldestKey); _cacheBytes -= oldest.bytes;
            // GC handles arrayBuffer/data-URL (no createObjectURL in codebase)
        }
    }
    // fetchCached：命中返缓存 data；未命中跑 fetcher（_inflight dedup 并发）→ cachePut → 返 data
    function fetchCached(p, t, fetcher) {
        var key = cacheKey(p, t), existing = _cache.get(key);
        if (existing) { existing.ts = Date.now(); return Promise.resolve(existing.data); }
        if (_inflight.has(key)) return _inflight.get(key);
        var prom = fetcher().then(function (r) { cachePut(p, t, r.data, r.bytes); _inflight.delete(key); return r.data; })
            .catch(function (e) { _inflight.delete(key); throw e; });
        _inflight.set(key, prom);
        return prom;
    }
    // previewUrl：单一 URL 构造（审查 R-INT-04 散布收敛：原 fetcherFor/renderVideo/renderAudio 三处独立拼）
    function previewUrl(p, type) { return SERVER_BASE + "/preview?file=" + encodeURIComponent(p) + "&type=" + type + "&token=" + encodeURIComponent(TOKEN); }
    // 档3:非原生格式走 /transcode(ffmpeg 转码);原生走 /preview
    function mediaUrl(p, type) {
        var ext = (p.split(".").pop() || "").toLowerCase();
        var isNative = (type === "video" && NATIVE_VIDEO.indexOf(ext) >= 0) || (type === "audio" && NATIVE_AUDIO.indexOf(ext) >= 0);
        return isNative ? previewUrl(p, type) : (SERVER_BASE + "/transcode?file=" + encodeURIComponent(p) + "&type=" + type + "&token=" + encodeURIComponent(TOKEN));
    }
    // fetcherFor：类型分派取数据 → {data, bytes}。
    // ★ 0.4.7 根因修：font/pdf/3d 直接存 arrayBuffer（不再造 blob URL）。原 blob round-trip（ab→Blob→blobUrl→fetch→ab）
    //   毫无意义且引入 connect-src blob: 依赖（workbench connect-src 无 blob: → fetch(blobUrl) 被拦 "Failed to fetch"）。
    //   image 存 data URL 串（img.src 用）；font/3d 存 arrayBuffer（loader 直接吃，免 fetch）。
    function fetcherFor(p, type) {
        var url = previewUrl(p, type);
        if (type === "image") {
            return function () { return fetch(url).then(function (r) { if (!r.ok) throw new Error("server " + r.status); return r.json(); })
                .then(function (d) { return { data: "data:" + d.mime + ";base64," + d.base64, bytes: d.base64.length }; }); };  // bytes=data URL 实际驻留字节（base64 串长）
        }
        return function () { return fetch(url).then(function (r) { if (!r.ok) throw new Error("server " + r.status); return r.arrayBuffer(); })
            .then(function (ab) { return { data: ab, bytes: ab.byteLength }; }); };  // 直接存 arrayBuffer（loader 吃 ab，免 blob/fetch）
    }
    // schedulePrefetch（Wave3 a）：hover 某项时预取 ±2 兄弟行填缓存（流式 video/audio 不预取）
    function schedulePrefetch(item) {
        var rows = [item], sib = item;
        for (var i = 0; i < 2; i++) { sib = sib.previousElementSibling; if (sib && sib.matches && sib.matches(".monaco-list-row")) rows.push(sib); else break; }
        sib = item;
        for (var i = 0; i < 2; i++) { sib = sib.nextElementSibling; if (sib && sib.matches && sib.matches(".monaco-list-row")) rows.push(sib); else break; }
        rows.forEach(function (r) {
            var fn = getLabelName(r); if (!fn) return;
            var type = detectMediaType(fn); if (!type || type === "video" || type === "audio" || type === "3d") return;  // 流式 + 大 3D 二进制(数十 MB FBX/STL 常见)不预取(复审 revArch：预取大 3D 填爆缓存驱逐有用项)
            var p = getFullPath(r); if (!p || cacheGet(p, type)) return;
            fetchCached(p, type, fetcherFor(p, type)).catch(function () {});  // 填缓存，结果忽略
        });
    }
    // pinCurrent/unpinCurrent：当前显示项缓存 pin（防 prefetch 邻项 LRU 驱逐正在显示的项）
    var _curPin = null;
    function pinCurrent(p, t) { if (_curPin) cacheUnpin(_curPin.p, _curPin.t); cachePin(p, t); _curPin = { p: p, t: t }; }
    function unpinCurrent() { if (_curPin) { cacheUnpin(_curPin.p, _curPin.t); _curPin = null; } }

    // ===== SVG 矢量图标（createElementNS，TT 合规；currentColor 随按钮色）=====
    function mkIcon(d) {
        var ns = "http://www.w3.org/2000/svg";
        var svg = document.createElementNS(ns, "svg");
        svg.setAttribute("viewBox", "0 0 16 16");
        svg.setAttribute("width", "15"); svg.setAttribute("height", "15");
        svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor");
        svg.setAttribute("stroke-width", "1.6"); svg.setAttribute("stroke-linecap", "round"); svg.setAttribute("stroke-linejoin", "round");
        var p = document.createElementNS(ns, "path"); p.setAttribute("d", d); svg.appendChild(p);
        return svg;
    }
    // 图标 path（16×16）：pin=圆圈(.is-pinned 时 CSS 填充)、reset=四角展开、close=X
    var ICON_PIN = "M11.5 8a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0z";
    var ICON_RESET = "M3 6.5V3.5A.5.5 0 0 1 3.5 3H6.5 M9.5 3h3a.5.5 0 0 1 .5.5V6.5 M13 9.5v3a.5.5 0 0 1-.5.5H9.5 M6.5 13h-3a.5.5 0 0 1-.5-.5V9.5";
    var ICON_CLOSE = "M4 4l8 8M12 4l-8 8";

    // ===== popup 骨架（createElement，doc03）=====
    function ensurePopup() {
        var popup = document.getElementById("mp-popup");
        if (popup) return popup;
        popup = document.createElement("div");
        popup.id = "mp-popup";
        var fname = document.createElement("span"); fname.className = "mp-fname"; fname.title = "点击重命名";  // 文件名悬浮左上（0.4.9 毛玻璃胶囊 + 点击改名）
        fname.addEventListener("click", startRename);
        // 工具盘（右下角右侧边外部吸附；pin/reset/close SVG 图标 + divider 分组；popup DOM 子元素保 :hover/mouseleave 协同）
        var rail = document.createElement("div"); rail.className = "mp-rail";
        var pinBtn = document.createElement("button"); pinBtn.className = "mp-pin"; pinBtn.title = "固定（锁定当前内容，忽略新 hover）"; pinBtn.appendChild(mkIcon(ICON_PIN));
        var resetBtn = document.createElement("button"); resetBtn.className = "mp-reset"; resetBtn.title = "恢复默认大小"; resetBtn.appendChild(mkIcon(ICON_RESET));
        var closeBtn = document.createElement("button"); closeBtn.className = "mp-close"; closeBtn.title = "关闭"; closeBtn.appendChild(mkIcon(ICON_CLOSE));
        var divider = document.createElement("div"); divider.className = "mp-divider";  // 分组分割（锁定 | 窗口操作）
        rail.append(pinBtn, divider, resetBtn, closeBtn);
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
        pinBtnEl = pinBtn;  // 0.4.9 供 startRename（非 querySelector）
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
            ".mp-fname{position:absolute;top:-24px;left:0;z-index:2;font:500 11px/1.4 var(--vscode-font-family,sans-serif);color:rgba(255,255,255,.92);padding:3px 8px;border-radius:4px;max-width:calc(100% - 12px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:rgba(28,28,32,.55);backdrop-filter:blur(8px) saturate(1.4);-webkit-backdrop-filter:blur(8px) saturate(1.4);border:1px solid rgba(255,255,255,.08);box-shadow:0 2px 8px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.06);text-shadow:0 1px 2px rgba(0,0,0,.6);cursor:text}",  // 0.4.11 文件名常驻可见（原 opacity:0 hover 才显 → 用户看不到）；吸附左上角横边（top:6 left:6 毛玻璃胶囊）
            ".mp-rail{position:absolute;top:6px;right:0;transform:translate(112%,0) scale(.92);display:flex;flex-direction:column;align-items:center;gap:3px;padding:5px;border-radius:9px;background:rgba(28,28,32,.62);backdrop-filter:blur(12px) saturate(1.4);-webkit-backdrop-filter:blur(12px) saturate(1.4);border:1px solid rgba(255,255,255,.1);box-shadow:0 6px 20px rgba(0,0,0,.45),0 2px 6px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.07);opacity:0;transition:opacity 120ms ease-out,transform 120ms ease-out}",  // 0.4.12 右上角右侧边外部吸附（用户修正：右上非右下；与左上文件名对称）
            "#mp-popup:hover .mp-rail{opacity:1;transform:translate(100%,0) scale(1);transition:opacity 180ms cubic-bezier(.22,1,.36,1),transform 220ms cubic-bezier(.34,1.56,.64,1)}",  // snap spring 入场
            "#mp-popup.rail-left .mp-rail{top:6px;right:auto;left:0;transform:translate(-12%,0) scale(.92)}",
            "#mp-popup.rail-left:hover .mp-rail{transform:translate(-100%,0) scale(1)}",
            ".mp-rail button{width:28px;height:28px;display:flex;align-items:center;justify-content:center;background:transparent;border:none;color:rgba(255,255,255,.8);cursor:pointer;padding:0;border-radius:6px;transition:background-color 100ms ease-out,color 100ms ease-out,transform 100ms cubic-bezier(.34,1.56,.64,1)}",  // 28×28 等比例触控区，SVG 矢量图标（currentColor）
            ".mp-rail button:hover{background:rgba(255,255,255,.13);color:#fff;transform:scale(1.1)}",
            ".mp-rail button:active{transform:scale(.92)}",
            ".mp-rail button.is-pinned{color:#4ec9b0}",  // pin 高亮
            ".mp-rail button.is-pinned svg{fill:currentColor}",  // pin 圆圈填充（锁定态视觉反馈）
            ".mp-rail .mp-divider{width:18px;height:1px;background:rgba(255,255,255,.13);margin:2px 0;border:none}",  // 分组短横线
            "@media (prefers-reduced-motion:reduce){.mp-rail,.mp-rail button{transition-duration:.01ms!important}.mp-rail{transform:translate(100%,0) scale(1)!important}#mp-popup.rail-left .mp-rail{transform:translate(-100%,0) scale(1)!important}}",  // reduced-motion 兜底（0.01ms 非 0 保 transitionend + transform 覆盖终态）
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
        x = Math.max(8, Math.min(x, vw - w - 8)); y = Math.max(28, Math.min(y, vh - h - 8));
        popup.style.left = x + "px"; popup.style.top = y + "px";
        // rail 朝向：popup 在文件项右侧 → rail 朝右（远离项）；popup 在项左侧 → rail 朝左（防压文件行）
        popup.classList.toggle("rail-left", x < itemRect.left || (x + popup.offsetWidth) > window.innerWidth - 50);
    }

    // ===== 四角缩放（对角固定）+ pin + close =====
    function bindInteractions(popup, pinBtn, closeBtn, resetBtn) {
        popup.querySelectorAll(".mp-resize").forEach(function (handle) {
            handle.addEventListener("pointerdown", function (e) {  // 0.4.9：pointer 事件 + setPointerCapture 修"快拖出浮窗/窗口卡住"（原 mousedown+document.mouseup 鼠标出 window 时 mouseup 丢失致 drag 残留）
                e.preventDefault(); e.stopPropagation();
                try { handle.setPointerCapture(e.pointerId); } catch (err) {}  // 捕获 → 指针出 window 也收 pointermove/up
                var corner = handle.dataset.corner;
                var startX = e.clientX, startY = e.clientY, r = popup.getBoundingClientRect();
                // rAF 节流：每帧最多设一次 style（60fps），避免高频 pointermove reflow 卡顿
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
                var onUp = function (ev) {
                    handle.removeEventListener("pointermove", onMove); handle.removeEventListener("pointerup", onUp); handle.removeEventListener("pointercancel", onUp);
                    try { handle.releasePointerCapture(e.pointerId); } catch (err) {}
                    if (rafId) cancelAnimationFrame(rafId);
                    applyResize();  // 最终精确
                    savePopupSize(popup.offsetWidth, popup.offsetHeight);
                };
                handle.addEventListener("pointermove", onMove); handle.addEventListener("pointerup", onUp); handle.addEventListener("pointercancel", onUp);  // 🟡 复审：pointercancel（cmd+tab/睡眠/触摸打断）也走 onUp 清理，免监听泄漏
            });
        });
        pinBtn.addEventListener("click", function (e) { e.stopPropagation(); isPinned = !isPinned; pinBtn.classList.toggle("is-pinned", isPinned); });  // Wave2：class 高亮替代文本（窄 rail 不撑宽）
        resetBtn.addEventListener("click", function (e) { e.stopPropagation(); popup.style.width = "400px"; popup.style.height = "300px"; savePopupSize(400, 300); });
        closeBtn.addEventListener("click", function (e) { e.stopPropagation(); if (activeRenameDone) activeRenameDone(false); isPinned = false; pinBtn.classList.remove("is-pinned"); currentHovered = null; lastRenderedItem = null; hidePopup(); });  // 🔵 复审：改名中途关闭先 done(false) 取消（恢复 fname）再关，免下次 show 崩
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
    // 0.4.9 图片/视频尺寸适配：popup 贴合内容 intrinsic 尺寸（无 letterbox 黑边），上限 70vw/70vh，地板 200×150。
    // 保留 object-fit:contain（popup 贴合比例时 no-op 无黑边；手动 resize 变比例时保图不变形）。
    function fitPopupToContent(nw, nh, rect) {
        var vw = window.innerWidth, vh = window.innerHeight;
        var w = nw || 400, h = nh || 300;  // SVG 无 natural → 兜底 400×300
        var MAX_W = Math.min(vw * 0.35, 450), MAX_H = Math.min(vh * 0.35, 340);  // 0.4.11：按 VSCode 窗口 40% + 硬上限 560×420（原 70% 太大占满屏；保比例按窗口大小非全分辨率）
        var scale = Math.min(MAX_W / w, MAX_H / h, 1);  // 保图片比例，不放大超 natural
        w = Math.round(w * scale); h = Math.round(h * scale);
        var popup = document.getElementById("mp-popup"); if (!popup) return;
        popup.style.width = Math.max(200, w) + "px";
        popup.style.height = Math.max(150, h) + "px";
        popup.style.minHeight = "";  // 清 audio 折叠的 minHeight（切类型复位）
        if (rect) placePopup(rect);  // 尺寸变后重定位防越界（用 handleHover 快照 rect）
    }

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

    // 0.4.9 文件名点击改名：fname → input → Enter/blur 提交 → fetch /rename（server fs.rename + containment）→ 刷新 Explorer
    var editing = false, activeRenameDone = null;  // activeRenameDone: closeBtn 改名中途关闭时调 done(false) 取消（🔵 复审：否则 input 被 hidePopup 清除但 fname 未恢复 → 下次 show querySelector(".mp-fname") null 崩）
    function startRename() {
        if (editing) return;
        var item = currentHovered; if (!item) return;
        var oldFull = getFullPath(item), oldName = getLabelName(item);
        if (!oldFull || !oldName) return;
        var popup = document.getElementById("mp-popup"); if (!popup) return;
        var fname = popup.querySelector(".mp-fname"); if (!fname) return;
        // 0.4.11：不再 isPinned 锁（用户要求：鼠标离开浮窗应直接关闭）。编辑期间鼠标在 popup 内无 mouseleave → 不关；
        //   鼠标离开 popup → input blur(done 提交) + mouseleave(hideTimer 关) = 提交并关闭，符合"鼠标离开输入框生效 + 离开浮窗关闭"。
        editing = true;
        var input = document.createElement("input");
        input.type = "text"; input.value = oldName;
        input.style.cssText = "position:absolute;top:-24px;left:0;font:500 11px/1.4 var(--vscode-font-family,sans-serif);color:#fff;padding:3px 8px;border-radius:4px;max-width:calc(100% - 12px);border:1px solid #0e639c;background:#3c3c3c;outline:none;box-shadow:0 2px 8px rgba(0,0,0,.35)";  // 0.5.3: 加 position:absolute;top:-24px;left:0 与 .mp-fname 同位(否则 replaceWith 后 input 回 static 流 → 左下角 + 鼠标不在 popup → mouseleave 关)  // 🔵 复审：font 与 .mp-fname 对齐（var 字体，编辑/显示态不跳变）
        fname.replaceWith(input); input.focus(); input.select();
        var done = function (commit) {
            if (!editing) return; editing = false; activeRenameDone = null;  // 🔵 复审：清 closeBtn 取消钩
            var nn = input.value.trim();
            input.replaceWith(fname);
            if (commit && nn && nn !== oldName) {
                fetch(SERVER_BASE + "/rename?token=" + encodeURIComponent(TOKEN) + "&oldPath=" + encodeURIComponent(oldFull) + "&newName=" + encodeURIComponent(nn))
                    .then(function (r) { return r.json().catch(function () { return { ok: false, error: "server " + r.status }; }); })
                    .then(function (d) { if (d && d.ok) fname.textContent = nn; else showPopupError((d && d.error) || "改名失败"); })
                    .catch(function () { showPopupError("改名网络错误"); });
            }
        };
        activeRenameDone = done;  // 🔵 供 closeBtn 中途取消
        input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); done(true); } else if (e.key === "Escape") { done(false); } });
        input.addEventListener("blur", function () { done(true); });
    }

    // ===== 渲染（doc03 图片，createElement）=====
    function showPopupError(msg) {
        var popup = ensurePopup(); popup.style.display = "flex";
        var content = popup.querySelector(".mp-content"); content.replaceChildren();
        var span = document.createElement("div"); span.textContent = msg; span.style.color = "#f88"; content.appendChild(span);
    }
    function renderImage(filePath, ep, rect) {
        return fetchCached(filePath, "image", fetcherFor(filePath, "image")).then(function (dataUrl) {
            if (ep !== renderEpoch) return;  // stale（已被新 hover 取代，审查 3.6）
            var img = document.createElement("img");
            img.src = dataUrl; img.alt = filePath;
            return img.decode().then(function () {
                if (ep !== renderEpoch) return;
                fitPopupToContent(img.naturalWidth, img.naturalHeight, rect);  // 0.4.9：贴合图片 natural 尺寸无黑边
                document.querySelector(".mp-content").replaceChildren(img);
            });
        });
    }

    // v0.2 视频：直 HTTP src（浏览器原生 Range seek，非 blob；doc08 §1）
    function renderVideo(filePath, ep, rect) {
        var content = document.querySelector(".mp-content");
        var video = document.createElement("video");
        video.src = mediaUrl(filePath, "video");
        video.controls = true; video.autoplay = true; video.muted = true; video.playsInline = true;  // muted+autoplay 配对 + playsInline（doc08 §1，v0.2-v0.5审查🔵）
        video.style.maxWidth = "100%"; video.style.maxHeight = "100%";
        content.replaceChildren(video);
        video.addEventListener("loadedmetadata", function () { if (ep === renderEpoch) fitPopupToContent(video.videoWidth, video.videoHeight, rect); });  // 0.4.9：贴合视频尺寸
        video.addEventListener("error", function () {
            if (ep !== renderEpoch) return;
            var vext = (filePath.split(".").pop() || "").toLowerCase();
            if (NATIVE_VIDEO.indexOf(vext) < 0) showPopupError("." + vext + " 格式不支持浏览器预览（Chromium 仅原生解码 MP4/WebM，" + vext.toUpperCase() + " 需转码或外部播放器）");
            else showPopupError("video 加载失败");
        });
        video.play().catch(function () {  // autoplay 被拦 → showPlayButton（doc08 §1，v0.2-v0.5审查🔵）
            if (ep !== renderEpoch) return;  // 复审：content 已被新 hover 替换则不叠杂散按钮
            var btn = document.createElement("button"); btn.textContent = "▶ 点击播放"; btn.style.cssText = "font-size:24px;padding:12px;cursor:pointer";
            btn.addEventListener("click", function () { video.play(); btn.remove(); });
            content.appendChild(btn);
        });
    }

    // v0.3 音频：<audio> 直 HTTP src（复用 video/serveStream 路径，波形砍 [11 F2]）
    function renderAudio(filePath, ep, rect) {
        var content = document.querySelector(".mp-content");
        var audio = document.createElement("audio");
        audio.src = mediaUrl(filePath, "audio");
        audio.controls = true; audio.style.width = "100%";
        content.replaceChildren(audio);
        audio.addEventListener("canplay", function () { audio.play().catch(function () {}); });  // 0.5.3: autoplay 被拦→静默(native controls 已有播放键,不需 fallback btn)
        // 0.4.9：音频无视觉内容 → popup 折叠成细横条（破 min-height:150 地板需设 minHeight）
        var popup = document.getElementById("mp-popup");
        if (popup) { popup.style.height = "56px"; popup.style.minHeight = "56px"; popup.style.width = "320px"; if (rect) placePopup(rect); }
        audio.addEventListener("error", function () { if (ep === renderEpoch) showPopupError("audio 加载失败"); });
    }

    // v0.3 字体：FontFace ArrayBuffer 源（免 font-src CSP）+ canvas glyph grid（doc08 §3）。走缓存（arrayBuffer 直存）。
    async function renderFont(filePath, ep) {
        var buf = await fetchCached(filePath, "font", fetcherFor(filePath, "font"));  // buf=arrayBuffer（0.4.7：缓存直存 ab，免 blob/fetch）
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

    // three.js 加载：由 workbench.html 的 <script defer src="mp-three.js"> 静态注入（0.4.6）。
    // ★ 唯一 TT-safe 加载法：workbench require-trusted-types-for 'script' 实测拦了 import(blob:)【Failed to fetch】
    //   AND eval/Function【Evaluating a string violates Trusted Type】。static <script src> 在解析期注入不经 TT（mp-overlay.js 同款 proven）。
    //   defer=后台下载+解析（2MB），不阻塞 workbench 启动；render3D 调 waitForThree 等 globalThis.MP_THREE 就绪。
    function waitForThree() {
        if (window.MP_THREE) return Promise.resolve(window.MP_THREE);
        return new Promise(function (resolve, reject) {
            var start = Date.now();
            var iv = setInterval(function () {
                if (window.MP_THREE) { clearInterval(iv); resolve(window.MP_THREE); }
                else if (Date.now() - start > 8000) { clearInterval(iv); reject(new Error("three.js 加载超时（mp-three.js 未就绪）")); }
            }, 50);
        });
    }

    // v0.5 3D：three.js esbuild bundle（doc08 §5）。
    var threeReady = null;
    // 0.4.8 大文件性能：阈值降级 + 元信息优先（防大 3D 文件 auto-parse 冻结 UI）。/preview 已支持 Range（206）。
    var TIER_AUTO = 5 * 1024 * 1024;  // <5MB 自动渲染；≥5MB 走元信息卡 + 加载完整按钮（不 auto-parse）
    function probeSize(filePath) {  // Range bytes=0-0 → Content-Range total（不发 HEAD，零 server 改动）
        return fetch(previewUrl(filePath, "3d"), { headers: { Range: "bytes=0-0" } })
            .then(function (r) {
                if (r.status !== 206) return null;  // 未支持 Range → fail-open（返 null 走全量自动渲染）
                var cr = r.headers.get("Content-Range") || "";  // "bytes 0-0/12345"
                var m = /\/(\d+)$/.exec(cr); return m ? parseInt(m[1], 10) : null;
            }).catch(function () { return null; });  // 网络错 → fail-open
    }
    function rangeFetch(filePath, start, end) {  // 单次 Range 取 [start,end] → arrayBuffer
        return fetch(previewUrl(filePath, "3d"), { headers: { Range: "bytes=" + start + "-" + end } })
            .then(function (r) { if (r.status !== 206 && r.status !== 200) throw new Error("range " + r.status); return r.arrayBuffer(); });
    }
    // 元信息免 parse 提取（v1：STL 头拿面数/顶点；其他格式仅大小。GLB bbox 留 v2）
    async function extractMeta(filePath, ext, total) {
        var meta = { format: ext.toUpperCase(), size: total, faces: null, vertices: null };
        if (ext === "stl") {
            try {
                var hdr = await rangeFetch(filePath, 0, 83);  // 84B header
                if (hdr.byteLength >= 84) {
                    var dv = new DataView(hdr), n = dv.getUint32(80, true);  // 三角面数 LE @80
                    if (84 + n * 50 === total) { meta.format = "STL (binary)"; meta.faces = n; meta.vertices = n * 3; }
                    else meta.format = "STL (ASCII)";  // 非 binary 长度公式 → ASCII
                }
            } catch (e) {}
        }
        return meta;
    }
    function formatBytes(b) { return b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : (b / 1024).toFixed(0) + " KB"; }
    // 大文件元信息卡 + "加载完整"按钮（不 auto-parse 防 UI 冻结；用户主动点才完整渲染）
    function showBigModelCard(filePath, ext, meta, total, T) {
        var content = document.querySelector(".mp-content"); content.replaceChildren();
        var card = document.createElement("div"); card.style.cssText = "padding:18px;color:var(--vscode-descriptionForeground,#aaa);font-size:12px;line-height:2;text-align:left;width:100%";
        function row(label, val) { var d = document.createElement("div"); d.textContent = label + val; card.appendChild(d); }
        row("格式：", meta.format || ext.toUpperCase());
        row("大小：", formatBytes(total));
        if (meta.faces) row("三角面数：", meta.faces.toLocaleString());
        if (meta.vertices) row("顶点数：", meta.vertices.toLocaleString());
        var note = document.createElement("div"); note.style.cssText = "margin-top:8px;color:#888;font-size:11px"; note.textContent = "大模型，完整解析会短暂占用主线程"; card.appendChild(note);
        var btn = document.createElement("button"); btn.textContent = "加载完整 3D 预览";
        btn.style.cssText = "display:block;margin-top:12px;padding:6px 14px;cursor:pointer;background:var(--vscode-button-background,#0e639c);color:#fff;border:none;border-radius:3px;font-size:12px";
        btn.addEventListener("click", function () {
            var ep2 = ++renderEpoch; pinCurrent(filePath, "3d");
            render3DFull(filePath, ep2, ext, T).catch(function (e) { if (ep2 === renderEpoch) showPopupError(e.message); });
        });
        card.appendChild(btn);
        content.appendChild(card);
    }
    async function render3D(filePath, ep, rect) {
        var T = await waitForThree();
        if (ep !== renderEpoch) return;
        var p3d = document.getElementById("mp-popup"); if (p3d) { p3d.style.width = "600px"; p3d.style.height = "450px"; p3d.style.minHeight = ""; if (rect) placePopup(rect); }
        var ext = (filePath.split(".").pop() || "").toLowerCase();
        // 0.4.8 大文件分档：probe size → ≥5MB 走元信息卡（不 auto-parse 防 UI 冻结），<5MB 自动渲染
        var total = await probeSize(filePath); if (ep !== renderEpoch) return;
        if (total && total > TIER_AUTO) {
            var meta = null;
            try { meta = await extractMeta(filePath, ext, total); } catch (e) { meta = { format: ext.toUpperCase(), size: total }; }
            if (ep !== renderEpoch) return;
            showBigModelCard(filePath, ext, meta, total, T);
            return;
        }
        await render3DFull(filePath, ep, ext, T, rect);
    }
    async function render3DFull(filePath, ep, ext, T, rect) {
        var ab = await fetchCached(filePath, "3d", fetcherFor(filePath, "3d"));  // ab=arrayBuffer（0.4.7：缓存直存 ab，免 blob/fetch(blobUrl) 被 connect-src 拦）
        if (ep !== renderEpoch) return;
        // 按格式分发：glb/gltf=GLTFLoader(场景)；stl=STLLoader(纯几何,套材质)；obj=OBJLoader(文本,Group)；fbx=FBXLoader(二进制,Group)
        var object;
        if (ext === "glb" || ext === "gltf") {
            var gltf = await new T.GLTFLoader().parseAsync(ab, ""); if (ep !== renderEpoch) return;  // parseAsync 纯 CPU（同步 parse 包 Promise），大模型阻塞主线程
            object = gltf.scene;
        } else if (ext === "stl") {
            var geo = new T.STLLoader().parse(ab); if (ep !== renderEpoch) return;
            if (!geo.attributes.normal) geo.computeVertexNormals();  // STL 无法线则算（MeshStandardMaterial 需法线着色）
            object = new T.Mesh(geo, new T.MeshStandardMaterial({ color: 0x88aacc, metalness: 0.1, roughness: 0.75 }));
        } else if (ext === "obj") {
            var text = new TextDecoder().decode(ab); if (ep !== renderEpoch) return;  // OBJ=ASCII 文本，ab→text（TextDecoder 同步，不经 fetch）
            object = new T.OBJLoader().parse(text); if (ep !== renderEpoch) return;
        } else if (ext === "fbx") {
            object = new T.FBXLoader().parse(ab, ""); if (ep !== renderEpoch) return;
        } else { if (ep === renderEpoch) showPopupError("不支持的 3D 格式：" + ext); return; }
        if (ep !== renderEpoch) return;
        // 归一化：stl/obj/fbx 原始几何常不在原点/尺寸悬殊 → 居中 + 缩放到 ~3 单位，相机 z=5 看全
        var box = new T.Box3().setFromObject(object);
        if (!box.isEmpty()) {  // 复审 revArch：退化/空几何(0 三角形 STL/空 GLB)→ box 空 → center=NaN → position/scale 灾难；空则跳过归一化原样显示
            var center = box.getCenter(new T.Vector3());
            var size = box.getSize(new T.Vector3());
            var maxDim = Math.max(size.x, size.y, size.z, 0.001);
            var scl = 3 / maxDim;
            object.position.copy(center).multiplyScalar(-scl);  // p = -scl*center → 缩放后 box 中心落原点
            object.scale.setScalar(scl);
        }
        if (ep !== renderEpoch) return;
        var content = document.querySelector(".mp-content");
        var canvas = document.createElement("canvas");
        canvas.style.width = "100%"; canvas.style.height = "100%";
        content.replaceChildren(canvas);
        var cw = canvas.clientWidth || 400, ch = canvas.clientHeight || 300;  // v0.2-v0.5审查🔵：首帧 clientWidth=0 fallback
        var scene = new T.Scene();
        scene.add(new T.HemisphereLight(0xffffff, 0x444444, 1.2));  // 光照（stl 默认材质 + glb/fbx 标准 PBR 材质需光）
        var dir = new T.DirectionalLight(0xffffff, 1.0); dir.position.set(2, 3, 2); scene.add(dir);
        var camera = new T.PerspectiveCamera(45, cw / ch, 0.1, 1000);
        camera.position.set(2.2, 1.8, 4.2);  // 0.4.8：3/4 hero 视角（零几何空间升级；原 (0,0,5) 正交直视像 2D 贴图）
        camera.lookAt(0, 0, 0);
        var renderer = new T.WebGLRenderer({ canvas: canvas, antialias: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));  // 封顶 2x（popup 小，控 GPU）
        renderer.setClearColor(0x2d2d30, 1);  // 0.4.8：中深灰底（★修黑底；≈VSCode dark/three.js editor 0x333333，浅/深模型剪影都清晰）
        renderer.setSize(cw, ch, false);
        var controls = new T.OrbitControls(camera, canvas);
        controls.target.set(0, 0, 0);
        controls.update();  // 必调，否则首帧用旧 target
        scene.add(object);
        // 0.4.8：STL/OBJ（CAD 件）加淡网格地面（用户诉求 + three.js editor/Blender 范式；glb/fbx 资产/角色不加免"穿网格"违和）。traverse 会收集 grid 的 geometry/material 进 disposables。
        if (ext === "stl" || ext === "obj") {
            var floorBox = new T.Box3().setFromObject(object);
            var grid = new T.GridHelper(8, 8, 0x666666, 0x3a3a3a);
            grid.material.transparent = true; grid.material.opacity = 0.5;
            grid.position.y = floorBox.min.y;  // 贴模型底部（归一化后）
            scene.add(grid);
        }
        var disposables = [];
        scene.traverse(function (o) {  // 遍历收集 geometry/material/texture 防 GPU 泄漏（glb/stl/obj/fbx 通用）
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
        if (type === "image") renderImage(fullPath, ep, rect).catch(function (e) { if (ep === renderEpoch) showPopupError(e.message); });
        else if (type === "video") renderVideo(fullPath, ep, rect);
        else if (type === "audio") renderAudio(fullPath, ep, rect);
        else if (type === "font") renderFont(fullPath, ep).catch(function (e) { if (ep === renderEpoch) showPopupError(e.message); });
        else if (type === "3d") render3D(fullPath, ep, rect).catch(function (e) { if (ep === renderEpoch) showPopupError(e.message); });
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
    waitForExplorer(function () {
        setupHoverListeners();
        console.log("[mp-overlay] hover listeners attached");
        // 0.5.3: 探测 ffmpeg——重试 3 次(首次可能 server 还没起,HAS_FFMPEG 阻塞 EH activate ~2s)
        function probeFfmpeg(retries) {
            fetch(SERVER_BASE + "/ping?token=" + encodeURIComponent(TOKEN))
                .then(function (r) { return r.json(); })
                .then(function (d) { hasFfmpeg = !!d.hasFfmpeg; if (hasFfmpeg) console.log("[mp-overlay] ffmpeg detected → AVI/AIFF/FLV 等走转码"); })
                .catch(function () { if (retries > 0) setTimeout(function () { probeFfmpeg(retries - 1); }, 3000); });
        }
        probeFfmpeg(3);
    });
})();
