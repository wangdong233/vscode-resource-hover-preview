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
    var HOVER_DELAY = 300, HIDE_DELAY = 200, MEDIA_HIDE_DELAY = 400;  // 0.5.20(S2/S5):视频/音频弹窗隐藏延时加长——用户从 explorer 移向底部音量控件需跨 popup 主体,200ms 窗太紧
function hideDelayMs() { return (activeRendererType === "video" || activeRendererType === "audio") ? MEDIA_HIDE_DELAY : HIDE_DELAY; }
    var isPinned = false;
    var isDragging = false;  // 0.5.13: pin 态浮窗拖动中标志(root mousemove 早退防 currentHovered 漂移 + pinBtn unpin 强制终止用)
    var isPanning = false;   // 0.5.22: 缩放图平移中标志(三处 hideTimer fire-time 守卫防 pan 中弹窗被销毁 + root mousemove/wheel 让出)
    var zoomBtnEl = null;    // 0.5.22: rail 缩放复原按钮(仅 s>1 显示)
    var zoomGeomGrace = 0;   // 0.5.25:复原按钮点击的几何宽限截止时间戳——见 armZoomGeomGrace
    var zoomGeomHold = false;  // 0.5.26:停驻保持——宽限到期时鼠标未动则无限期保持浮窗,由下一次移动裁决(用户语义:点复原后停在原地=不关;"那个位置还有东西"的完整语义)
    var lastMX = -1, lastMY = -1;  // 0.5.26:全局鼠标坐标(document mousemove 记录;hold 裁决"动过没有"的唯一依据)
    var ZOOM_MAX = 1000, ZOOM_K = 0.0022, ZOOM_K_PINCH = 0.01, ZOOM_STEP_PINCH = 0.336, ZOOM_DY_MAX = 200;  // 0.5.22:ZOOM_MAX 8→1000(用户决策解除放大上限;千倍=浮点安全护栏,约 35 格到顶,实际无限制)。滚轮一格×1.30;0.5.25:PINCH 0.0015→0.01(用户实测捏合不跟手——mac 捏合合成 wheel 事件 dy 极小(±1~8/次)高频,低增益=迟滞;Excalidraw 同手势 /100=0.01 同量级)+STEP_PINCH 封顶 0.336(=ln1.4≈1.4×/event,防真鼠标 ctrl+滚轮一格 dy~120 跳 2.7×;触控板 dy 小恒不触顶=全增益);单事件 dy 封顶±200
    var currentHovered = null;
    var lastRenderedItem = null;  // 已渲染项（防同项 re-hover 重 fetch 闪烁，审查 3.1）
    var lastRenderedPath = null;  // 0.5.4: 已渲染项路径（startRename 取此,不取 currentHovered——后者可能因 hoverTimer 延迟与显示不同步）
    var renderEpoch = 0;  // 渲染代际（防异步竞态 A 的 promise 覆盖 B，审查 3.6）
    var NATIVE_VIDEO = ["mp4", "webm", "mov", "m4v"];  // 0.5.20 删 mkv:Chromium 无 matroska demuxer(webm 例外),原生路径必死→移出走 /transcode 真正可放(VIDEO_EXTS 不动)
    var NATIVE_AUDIO = ["mp3", "wav", "ogg", "flac", "aac", "m4a", "opus"];
    // ===== 预加载缓存（0.5.18 复审 G2 纠注:LRU 缓存现仅 font/3d——image 0.5.18 退出(无版本键=同名覆盖供旧根因,改走 fetchImageFresh),pdf 0.4.5 已删,0.4.7 起存 data-URL/arrayBuffer 非 blob）=====
    var _cache = new Map();       // key=path|type → {data, bytes, ts, pinned}
    var _inflight = new Map();    // key → Promise（dedup 并发预取）
    var _imgMemo = new Map();     // 0.5.19(G4): path → {etag, dataUrl} —— image 按【server 宣新的 etag】版本化 memo,未变 re-hover 免全量 JSON.parse(大图 200-450ms 阻塞缓解);etag 来自每次 live 响应头,不可能供旧(旧字节键在旧 etag 下)
    var _prefetched = new Map();  // 0.5.18: image 预取节流(key→ts,TTL 60s)——image 退出版本化缓存后防每 hover 重复条件请求
    var PREFETCH_TTL = 60000;
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
            return "video";  // 0.5.4: 始终返 video(非原生走 /transcode,失败则 hidePopup 静默)
        }
        if (AUDIO_EXTS.indexOf(ext) >= 0) {
            return "audio";  // 0.5.4: 始终返 audio
        }
        if (FONT_EXTS.indexOf(ext) >= 0) return "font";
        if (MODEL3D_EXTS.indexOf(ext) >= 0) return "3d";
        return null;
    }

    // ===== 预加载缓存 API（单写者——唯一驱逐点 = cachePut 内 LRU;hidePopup/disposeContent 绝不碰 _cache;0.4.7 起无 createObjectURL,纯 data-URL/ArrayBuffer 驻留,驱逐即 GC）=====
    function cacheKey(p, t) { return p + "|" + t; }
    var _pinnedKeys = new Set();  // 当前渲染项 key（防 prefetch 邻项 LRU 驱逐正在显示的项，审查 §1.6 项6 多写者协调）
    function cachePin(p, t) { var k = cacheKey(p, t); _pinnedKeys.add(k); var e = _cache.get(k); if (e) e.pinned = true; }  // 0.5.19 注:image 调用点为有意 no-op(image 已不入 _cache,此调用仅保 _pinnedKeys 有界性,勿删)
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
    // 0.5.18 fetchImageFresh:image 不再进 _cache(cacheKey=path|type 无版本信号=同名覆盖供旧根因 L1)——新鲜度交 HTTP 层
    // ETag 协商(server no-cache,Chromium 自动 If-None-Match;304 时 fetch 用缓存副本重组完整 200,此处透明),
    // 仅保留 _inflight 并发去重。font/3d 仍走 fetchCached(稳定资产,会话级缓存=文档化取舍)。
    // 0.5.19(G4 代码方案①):_imgMemo 按【响应头 etag】版本化 memo——每次 hover 仍发条件请求(server 保有真相权),
    // 但 etag 未变时免全量 JSON.parse(最坏 50MB→67MB base64 串 200-450ms 主线程阻塞);etag 变=新键,memo 不可能供旧。
    function fetchImageFresh(p) {
        var key = cacheKey(p, "image");
        if (_inflight.has(key)) return _inflight.get(key);
        var prom = fetch(previewUrl(p, "image")).then(function (r) {
            if (!r.ok) throw new Error("server " + r.status);
            var etag = r.headers.get("etag"), m = _imgMemo.get(p);
            if (etag && m && m.etag === etag) {  // server 宣新=同一版本 → 复用已解析 dataUrl,弃 body(304 重组体免读免 parse)
                try { if (r.body && r.body.cancel) r.body.cancel(); } catch (e) { /* ignore */ }
                return m.dataUrl;
            }
            return r.json().then(function (d) {
                var dataUrl = "data:" + d.mime + ";base64," + d.base64;
                if (etag) { if (_imgMemo.size > 24) _imgMemo.clear(); _imgMemo.set(p, { etag: etag, dataUrl: dataUrl }); }  // 与 CACHE_MAX 同量级粗防膨胀
                return dataUrl;
            });
        })
        _inflight.set(key, prom);
        var cleanup = function (v) { _inflight.delete(key); return v; };
        prom.then(cleanup, cleanup);  // 双路删键(成功/失败),不吞错(外层 catch 链继续抛)
        return prom;
    }
    // previewUrl：单一 URL 构造（审查 R-INT-04 散布收敛：原 fetcherFor/renderVideo/renderAudio 三处独立拼）
    function previewUrl(p, type) { return SERVER_BASE + "/preview?file=" + encodeURIComponent(p) + "&type=" + type + "&token=" + encodeURIComponent(TOKEN); }
    // 档3:非原生格式走 /transcode(ffmpeg 转码);原生走 /preview
    // 0.5.29 🔴架构回归(用户裁决:回到最初方案基底):视频【原文件直读】(/preview Range——完整时长/秒拖/零流式闪烁),
    //   声音走 MP3 旁路(VSCode 出厂 libffmpeg 无 AAC 解码器,nm 二进制定案;MP3 解码器必有且纯 .mp3 零容器变量):
    //   AAC 家族视频(mp4/mov/m4v)视频元素恒 muted + 独立 <audio>(/audio 提取缓存)经 makeMixer 主从同步;
    //   webm 家族音轨(vorbis/opus)宿主可解 → 单元素原生;非 web 容器(mkv/avi/flv)仍 /transcode 流(最初方案亦不能播)。
    //   0.5.27/28 的转码路由/自愈梯整体废弃(流式=进度条渐进+缓冲闪烁,用户实测否决)。
    function mediaUrl(p, type) {
        var ext = (p.split(".").pop() || "").toLowerCase();
        var isNative = (type === "video" && NATIVE_VIDEO.indexOf(ext) >= 0) || (type === "audio" && NATIVE_AUDIO.indexOf(ext) >= 0);
        return isNative ? previewUrl(p, type) : (SERVER_BASE + "/transcode?file=" + encodeURIComponent(p) + "&type=" + type + "&token=" + encodeURIComponent(TOKEN));
    }
    // 0.5.29 audioUrl:/audio 音轨提取 MP3 缓存端点(单一构造点;server 端完整 Content-Length+Range → <audio> 全量时长)
    function audioUrl(p) { return SERVER_BASE + "/audio?file=" + encodeURIComponent(p) + "&token=" + encodeURIComponent(TOKEN); }
    var TWIN_NEEDED = ["mp4", "mov", "m4v"];  // AAC 家族视频需要旁路;webm(可解音轨)不需要
    // 0.5.29 makeMixer:双元素音画同步控制器(主时钟=视频元素,音频旁路从动)。接口与单 media 元素同形(buildMediaBar 零改动):
    //   漂移>0.2s 以主时钟校正 / seek·play·pause 即时对齐 / ratechange 跟随 / muted·volume 落在 twin(无 twin 落 master)。
    function makeMixer(master, twinEl) {
        var ax = function () { return (twinEl && !twinEl._mpDead) ? twinEl : null; };
        var L = {};
        var fire = function (t) { (L[t] || []).slice().forEach(function (f) { try { f({}); } catch (e) {} }); };
        ["play", "pause", "ended", "timeupdate", "durationchange", "seeking"].forEach(function (t) { master.addEventListener(t, function () { fire(t); }); });
        master.addEventListener("volumechange", function () { fire("volumechange"); });
        if (twinEl) twinEl.addEventListener("volumechange", function () { fire("volumechange"); });
        var syncTwin = function () {
            var a = ax(); if (!a) return;
            if (!master.paused && a.paused && master.currentTime < a.duration - 0.05) { try { a.currentTime = master.currentTime; } catch (e) {} var p = a.play(); if (p && p.catch) p.catch(function () {}); }  // 0.5.29c 🟡-2:音短于视频的源,尾部不再重启 twin(否则 ended→play 从 0 重播→漂移拽回=4Hz 循环)
            else if (master.paused && !a.paused) a.pause();
            if (!a.paused && Math.abs(a.currentTime - master.currentTime) > 0.2) { try { a.currentTime = master.currentTime; } catch (e) {} }  // 漂移校正(主时钟=视频)
        };
        master.addEventListener("timeupdate", syncTwin);
        master.addEventListener("seeking", function () { var a = ax(); if (a) { try { a.currentTime = master.currentTime; } catch (e) {} } });
        master.addEventListener("play", syncTwin);
        master.addEventListener("pause", syncTwin);
        master.addEventListener("ratechange", function () { var a = ax(); if (a) { try { a.playbackRate = master.playbackRate; } catch (e) {} } });
        master.addEventListener("ended", function () { var a = ax(); if (a && !a.paused) a.pause(); });
        return {
            get paused() { return master.paused; },
            get duration() { return master.duration; },
            get currentTime() { return master.currentTime; },
            set currentTime(t) { master.currentTime = t; var a = ax(); if (a) { try { a.currentTime = t; } catch (e) {} } },
            get muted() { var a = ax(); return a ? a.muted : master.muted; },
            set muted(m) { var a = ax(); if (a) { a.muted = m; if (!m && !master.paused && a.paused) { try { a.currentTime = master.currentTime; } catch (e) {} var p1 = a.play(); if (p1 && p1.catch) p1.catch(function () {}); } master.muted = true; } else master.muted = m; },  // twin 场景 master 恒 muted;0.5.29b:解静音手势内若 twin 未随主起播则即刻补起(rig 实证 headless 下 timeupdate 补起不可靠,手势内是最强保障)
            get volume() { var a = ax(); return a ? a.volume : master.volume; },
            set volume(v) { var a = ax(); if (a) a.volume = v; else master.volume = v; },
            play: function () { var a = ax(); if (a) { try { a.currentTime = master.currentTime; } catch (e) {} var p1 = a.play(); if (p1 && p1.catch) p1.catch(function () {}); } return master.play(); },
            pause: function () { var a = ax(); if (a) a.pause(); master.pause(); },
            addEventListener: function (t, f) { (L[t] = L[t] || []).push(f); },
            removeEventListener: function () { },
        };
    }
    // fetcherFor：类型分派取数据 → {data, bytes}。
    // ★ 0.4.7 根因修：font/3d 直接存 arrayBuffer（不再造 blob URL）。原 blob round-trip（ab→Blob→blobUrl→fetch→ab）
    //   毫无意义且引入 connect-src blob: 依赖（workbench connect-src 无 blob: → fetch(blobUrl) 被拦 "Failed to fetch"）。
    //   image 存 data URL 串（img.src 用）；font/3d 存 arrayBuffer（loader 直接吃，免 fetch）。
    function fetcherFor(p, type) {  // 0.5.19:image 分支已删(image 走 fetchImageFresh 内联,含 etag memo);本函数仅服务 font/3d(arrayBuffer 直存)
        var url = previewUrl(p, type);
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
            var p = getFullPath(r); if (!p) return;
            if (type === "image") {  // 0.5.18:image 退出版本化缓存→预取改预热 HTTP 缓存(no-cache 存储体,后续 hover 付 304)+ _prefetched 节流(否则 cacheGet 恒 miss 致每 hover 重复条件请求)
                var pk = cacheKey(p, "image"), pt = _prefetched.get(pk);
                if (pt && Date.now() - pt < PREFETCH_TTL) return;
                if (_prefetched.size > 128) _prefetched.clear();
                _prefetched.set(pk, Date.now());
                fetchImageFresh(p).catch(function () {});
                return;
            }
            if (cacheGet(p, type)) return;  // font 原路径(仍走版本化缓存)
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
        svg.setAttribute("viewBox", "0 0 24 24");  // 0.5.11: Lucide 24×24 图标集(原 16×16 自绘辨识度低)
        svg.setAttribute("width", "16"); svg.setAttribute("height", "16");
        svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor");
        svg.setAttribute("stroke-width", "2"); svg.setAttribute("stroke-linecap", "round"); svg.setAttribute("stroke-linejoin", "round");
        var p = document.createElementNS(ns, "path"); p.setAttribute("d", d); svg.appendChild(p);
        return svg;
    }
    // 图标 path（Lucide 24×24 语义化）：pin=图钉(固定)、reset=逆时针弧(恢复默认)、close=X(关闭)
    var ICON_PIN = "M12 17v5 M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z";  // thumbtack(.is-pinned 时 CSS 填充头部)
    var ICON_RESET = "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8 M3 3v5h5";  // rotate-ccw(恢复/重置)
    var ICON_CLOSE = "M18 6 6 18 M6 6l12 12";  // x
    var ICON_ZOOMRESET = "M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M16 21h3a2 2 0 0 0 2-2v-3M8 21H5a2 2 0 0 1-2-2v-3M7.5 12a4.5 4.5 0 1 0 4.5-4.5 4.88 4.88 0 0 0-3.37 1.37L7.5 10M7.5 7.5v2.5h2.5";  // 0.5.26 结合式(用户定案v2):最大化四角框(lucide maximize,复原到适配框)+框内 0.5 尺度 rotate-ccw 复原箭头(与 ICON_RESET 同语义)。四角框 3~21 全幅,内箭头圆 r4.5 中心(12,12)——两图形零交叠
    var ICON_PLAY = "M7 5v14l12-7z";  // 0.5.27 lucide play(自研控件条)
    var ICON_PAUSE = "M7 5h3v14H7zM14 5h3v14h-3z";  // lucide pause
    var ICON_VOL = "M11 5 6 9H3v6h3l5 4V5z M15.5 8.5a5 5 0 0 1 0 7";  // lucide volume-2
    var ICON_VOLX = "M11 5 6 9H3v6h3l5 4V5z M22 9l-6 6 M16 9l6 6";  // lucide volume-x

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
        var resetBtn = document.createElement("button"); resetBtn.className = "mp-reset"; resetBtn.title = "恢复默认大小与缩放"; resetBtn.appendChild(mkIcon(ICON_RESET));
        var closeBtn = document.createElement("button"); closeBtn.className = "mp-close"; closeBtn.title = "关闭"; closeBtn.appendChild(mkIcon(ICON_CLOSE));
        var divider = document.createElement("div"); divider.className = "mp-divider";  // 分组分割（锁定 | 窗口操作）
        rail.append(pinBtn, divider, resetBtn, closeBtn);
        // 0.5.22:缩放复原按钮(仅 s>1 显示;独立分组,与原三键以更宽 gap 隔开——用户指定"间隔要和原来的三个远离一些")
        var gap2 = document.createElement("div"); gap2.className = "mp-gap2";
        var zoomBtn = document.createElement("button"); zoomBtn.className = "mp-zoomreset"; zoomBtn.title = "复原缩放(回到 100%)"; zoomBtn.style.display = "none"; zoomBtn.appendChild(mkIcon(ICON_ZOOMRESET));
        zoomBtn.addEventListener("click", function (e) { e.stopPropagation(); armZoomGeomGrace(); resetImageZoom(popup); });  // 0.5.25:+几何宽限(本按钮+gap2 在光标下隐藏→rail 缩走→mouseleave 误关,见 armZoomGeomGrace)
        rail.append(gap2, zoomBtn);
        zoomBtnEl = zoomBtn;
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
        // 0.5.4: loadPopupSize 改 per-type,在各 renderer 内调用
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
            ".mp-rail .mp-gap2{height:12px;border:none;display:none}",  // 0.5.22:独立分组间距(0.5.23🟡-4:默认隐藏,随 img-zoomed 类显隐,与复原按钮同条件——s=1 无悬空段)
            "#mp-popup.img-zoomed .mp-rail .mp-gap2{display:block}",
            "#mp-popup.img-zoomed .mp-content img{cursor:grab}",  // 0.5.22:已缩放图片可拖 affordance
            "#mp-popup.is-panning .mp-content img{cursor:grabbing}",  // 平移中
            "@media (prefers-reduced-motion:reduce){.mp-rail,.mp-rail button{transition-duration:.01ms!important}.mp-rail{transform:translate(100%,0) scale(1)!important}#mp-popup.rail-left .mp-rail{transform:translate(-100%,0) scale(1)!important}}",  // reduced-motion 兜底（0.01ms 非 0 保 transitionend + transform 覆盖终态）
            ".mp-resize{position:absolute;width:14px;height:14px;z-index:3;opacity:0;transition:opacity .15s}",
            "#mp-popup:hover .mp-resize{opacity:.4}",
            ".mp-resize:hover{opacity:1}",
            ".mp-resize-nw{top:0;left:0;cursor:nwse-resize}",
            ".mp-resize-ne{top:0;right:0;cursor:nesw-resize}",
            ".mp-resize-sw{bottom:0;left:0;cursor:nesw-resize}",
            ".mp-resize-se{bottom:0;right:0;cursor:nwse-resize}",
            "#mp-popup.is-pinned{cursor:grab}",  // 0.5.13:pin 态背景显 grab(子元素 cursor 各自声明恒胜继承:按钮 pointer/handle nwse/fname text)
            "#mp-popup.is-pinned .mp-content video,#mp-popup.is-pinned .mp-content audio{cursor:default}",  // 视频/音频画面区非按钮处常规光标(交互面=mp-mb,0.5.27 起 controls 已弃)
            "#mp-popup.is-dragging,#mp-popup.is-dragging *{cursor:grabbing!important}",  // 拖动中统一锁定(模态捕获态,!important 唯一合法用)
            // 0.5.27 自研媒体控件条(替代原生 UA controls:闭影 DOM 在 VSCode 环境交互死 + 自动化不可测)
            ".mp-mb{position:absolute;left:10px;right:10px;bottom:8px;z-index:2;display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;background:rgba(15,15,18,.62);backdrop-filter:blur(10px) saturate(1.3);-webkit-backdrop-filter:blur(10px) saturate(1.3);box-shadow:0 2px 10px rgba(0,0,0,.4)}",  // 0.5.27b:内缩悬浮胶囊(白盒审计:四角把手 14×14 opacity:0 恒命中,贴边条会吃 play 键左缘——离边 10px 避让四角把手;仅角部 4×6px 残余重叠,handle z-3 恒胜,不挡 play 键本体)
            ".mp-mb button{width:26px;height:26px;flex:none;display:flex;align-items:center;justify-content:center;background:transparent;border:none;color:rgba(255,255,255,.9);cursor:pointer;padding:0;border-radius:6px;transition:background-color 100ms ease-out,color 100ms ease-out}",
            ".mp-mb button:hover{background:rgba(255,255,255,.14);color:#fff}",
            ".mp-mb-time{flex:none;font:500 11px/1 var(--vscode-font-family,sans-serif);color:rgba(255,255,255,.88);font-variant-numeric:tabular-nums;white-space:nowrap}",
            ".mp-mb input[type=range]{-webkit-appearance:none;appearance:none;height:14px;background:transparent;cursor:pointer;border:none;padding:0}",
            ".mp-mb input[type=range]:disabled{opacity:.3;cursor:default}",
            ".mp-mb input[type=range]::-webkit-slider-runnable-track{height:3px;border-radius:2px;background:rgba(255,255,255,.28)}",
            ".mp-mb input[type=range]:hover::-webkit-slider-runnable-track{background:rgba(255,255,255,.45)}",
            ".mp-mb input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:10px;height:10px;border-radius:50%;background:#fff;margin-top:-3.5px}",
            ".mp-mb .mp-mb-seek{flex:1;min-width:40px}",  // 进度条吃满中段;音量条定宽(inline style)
            ".mp-mb.mp-mb-narrow .mp-mb-time{display:none}",  // 0.5.27d 🟡-4:窄窗(<300px)藏时间条
            ".mp-mb.mp-mb-tiny .mp-mb-time,.mp-mb.mp-mb-tiny .mp-mb-vol{display:none}",  // <250px 再藏音量条(bar 定宽≈250>200-20 会溢出)
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
        // 0.5.13: pin 态浮窗拖动(复用 resize 的 pointer+setPointerCapture+pointercancel+rAF 已验证范式)
        // DRAG_SKIP:拖动时让出的交互子元素。★ H-3 决策(0.5.14 方案 C):video/audio 整体让出(保留原生控件)+ 3D canvas 特判(下行 OrbitControls)
        //   → video/audio/3D pin 态【无可拖区】(媒体填满浮窗),仅 pin 锁定内容不随 hover 变;image/font 可拖。维持现状不追加 drag handle(产品决策,非 bug)。
        var DRAG_SKIP = ".mp-resize,.mp-rail,.mp-fname,.mp-mb,video,audio,button,input,a,[contenteditable]";  // 0.5.27:+.mp-mb(控件条背景让出按钮/滑条自有交互)
        var dragPointerId = null, onDragMove = null, onDragUp = null;
        var stopPan = function () { isPanning = false; popup.classList.remove("is-panning"); };  // 0.5.24🔴R1修:提升到 bindInteractions 作用域(原声明在 pointerdown 回调内,closeBtn 层引用即 ReferenceError——关闭按钮整体失效,0.5.23 自身回归;与 stopDrag 对称的 pan 强制清理)
        function stopDrag() {  // unpin/close 强制终止可能进行中的拖动(capture 路由下 click 可能不触发,须主动清)
            if (!isDragging) return;
            if (onDragMove) { popup.removeEventListener("pointermove", onDragMove); popup.removeEventListener("pointerup", onDragUp); popup.removeEventListener("pointercancel", onDragUp); }
            try { if (dragPointerId != null) popup.releasePointerCapture(dragPointerId); } catch (e2) {}
            isDragging = false; dragPointerId = null; onDragMove = null; onDragUp = null;
            popup.classList.remove("is-dragging");
        }
        popup.querySelectorAll(".mp-resize").forEach(function (handle) {
            handle.addEventListener("pointerdown", function (e) {  // 0.4.9：pointer 事件 + setPointerCapture 修"快拖出浮窗/窗口卡住"（原 mousedown+document.mouseup 鼠标出 window 时 mouseup 丢失致 drag 残留）
                e.preventDefault(); e.stopPropagation();
                resetImageZoom(popup);  // 0.5.16:tx/ty 是 px 态锚点,布局盒一变即失真;resize=重适配手势,清掉最简最正确
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
                    resetImageZoom(popup);  // 0.5.16复审🔵-3:一指拖角+另指滚动的并发竞态(触控板物理可同发),终态补清防缩放残留过 resize
                };
                handle.addEventListener("pointermove", onMove); handle.addEventListener("pointerup", onUp); handle.addEventListener("pointercancel", onUp);  // 🟡 复审：pointercancel（cmd+tab/睡眠/触摸打断）也走 onUp 清理，免监听泄漏
            });
        });
        // 0.5.13: pin 态拖动——pointerdown 落在背景(非 DRAG_SKIP 交互子元素 / 非 3D canvas)才启动
        popup.addEventListener("pointerdown", function (e) {
            if (e.button !== 0) return;  // 仅左键
            if (isDragging || isPanning) return;  // 0.5.24 Y13:重入门(第二指针触屏可达——无条件覆盖共享句柄致监听器残留"跟鼠假死")
            // 0.5.22 pan:图片已缩放(s>1)且按在 img 上 → 平移图片内容(优先于 pin 拖浮窗;未 pin 也可;背景/letterbox 仍走下方 pin 拖浮窗)
            if (activeRendererType === "image" && e.target.tagName === "IMG" && e.target._mpZoom && e.target._mpZoom.s > 1) {
                var pimg = e.target;
                e.preventDefault();
                try { pimg.setPointerCapture(e.pointerId); } catch (err) {}  // 捕获→指针出 popup/window 也收 move/up
                isPanning = true; popup.classList.add("is-panning");
                var psx = e.clientX, psy = e.clientY, ptx0 = pimg._mpZoom.tx, pty0 = pimg._mpZoom.ty;
                var plast = e, praf = null;
                var pApply = function () { praf = null; var ev = plast; if (!pimg._mpZoom) return; pimg._mpZoom.tx = ptx0 + (ev.clientX - psx); pimg._mpZoom.ty = pty0 + (ev.clientY - psy); applyImgZoom(pimg); };  // 0.5.23🟡-1守卫:复位置 null 后裸读 .tx 抛 TypeError→清理全跳,断链
                var pMove = function (ev) { plast = ev; if (!praf) praf = requestAnimationFrame(pApply); };  // rAF 节流同 drag
                var pUp = function () {
                    if (praf) cancelAnimationFrame(praf); pApply();
                    try { pimg.releasePointerCapture(e.pointerId); } catch (err) {}
                    pimg.removeEventListener("pointermove", pMove); pimg.removeEventListener("pointerup", pUp); pimg.removeEventListener("pointercancel", pUp);
                    stopPan();
                };
                pimg.addEventListener("pointermove", pMove); pimg.addEventListener("pointerup", pUp); pimg.addEventListener("pointercancel", pUp);
                return;
            }
            if (!isPinned) return;  // 仅 pin 态可拖浮窗
            if (e.target.closest(DRAG_SKIP)) return;  // 命中按钮/handle/文件名/控件 → 让出各元素自有交互
            if (e.target.tagName === "CANVAS" && activeRendererType === "3d") return;  // 3D canvas 让 OrbitControls 接管旋转
            e.preventDefault();
            try { popup.setPointerCapture(e.pointerId); } catch (err) {}  // 捕获→指针出 window 也收 move/up(复用 resize 范式)
            dragPointerId = e.pointerId; isDragging = true; popup.classList.add("is-dragging");
            var sx = e.clientX, sy = e.clientY, r = popup.getBoundingClientRect(), ox = r.left, oy = r.top;
            var lastEv = e, rafId = null;
            var apply = function () {
                rafId = null; var ev = lastEv, vw = window.innerWidth, vh = window.innerHeight, w = popup.offsetWidth, h = popup.offsetHeight;
                popup.style.left = Math.max(8, Math.min(ox + (ev.clientX - sx), vw - w - 8)) + "px";  // 越界夹紧(对齐 placePopup:水平 8 / 顶 28 给 .mp-fname top:-24 留净空)
                popup.style.top = Math.max(28, Math.min(oy + (ev.clientY - sy), vh - h - 8)) + "px";
            };
            onDragMove = function (ev) { lastEv = ev; if (!rafId) rafId = requestAnimationFrame(apply); };  // rAF 节流 60fps
            onDragUp = function () { if (rafId) cancelAnimationFrame(rafId); apply(); stopDrag(); };  // 终帧精确 + 清理
            popup.addEventListener("pointermove", onDragMove); popup.addEventListener("pointerup", onDragUp); popup.addEventListener("pointercancel", onDragUp);  // pointercancel:cmd+tab/睡眠/触摸打断兜底
        });
        // 0.5.16 图片滚轮/双指捏合缩放(仅 image):单 wheel 监听覆盖两手势(Mac 捏合=Chromium 合成 wheel+ctrlKey,deltaY<0=放大,
        //   与滚轮上滚同号同向;gesture* 是 WebKit 私有事件,Chromium 永不触发,禁写)。
        //   ★门序关键:preventDefault 必须过完全部门才调——它挡的是 Chromium 默认动作(explorer 滚动/ctrl+wheel 整窗缩放);
        //   3D/video 由门1 先 return 保原生 wheel(preventDefault≠stopPropagation,OrbitControls 挂 canvas 先收事件本不受影响)。
        // ZOOM_SKIP 与 DRAG_SKIP【有意不同,禁朴素合并】(0.5.16复审🔵-5):并集会给 DRAG_SKIP 加 canvas,先于 3D 特判被 closest 命中→弄坏字体画布拖动;
        //   未来新增交互子元素须同步审视两列表。
        var ZOOM_SKIP = ".mp-rail,.mp-resize,.mp-fname,button,input,a,canvas,video,audio";
        popup.addEventListener("wheel", function (e) {
            if (activeRendererType !== "image") return;                    // 门1:类型(renderImage 早设;3d/video/audio/font 全挡)
            if (isDragging || isPanning || editing) return;                 // 门2:pin 拖动/pan 平移中/改名输入期让出
            if (e.target.closest && e.target.closest(ZOOM_SKIP)) return;   // 门3:工具盘/把手/文件名胶囊让出(保各自原生行为)
            var content = popup.querySelector(".mp-content");
            var img = content && content.querySelector("img");
            if (!img || !img.naturalWidth) return;                         // 门4:img 存在(挡 loading 占位/错误卡两个无 img 窗口)
            e.preventDefault();                                            // 挡页面滚动 + Chromium ctrl+wheel/pinch 整窗缩放默认动作
            var dy = e.deltaY; if (e.deltaMode === 1) dy *= 33;            // 规范合规性归一 line→pixel(宿主 mac Chromium 恒 pixel,不可达;留作跨环境正确性)
            if (dy > ZOOM_DY_MAX) dy = ZOOM_DY_MAX; else if (dy < -ZOOM_DY_MAX) dy = -ZOOM_DY_MAX;  // 0.5.20:单事件封顶(惯性大 delta/line-mode 无上限跳变)
            var zoomK = e.ctrlKey ? ZOOM_K_PINCH : ZOOM_K;        // 0.5.20:捏合(ctrlKey)独立 K;0.5.25:0.0015→0.01(用户实测捏合不跟手而滚轮已完美——mac 捏合合成 wheel 事件 dy 极小(±1~8/次),0.0015 下全手势仅 ~1.2×;Excalidraw 同手势 /100=0.01 量级)
            var step = -dy * zoomK;
            if (e.ctrlKey && step > ZOOM_STEP_PINCH) step = ZOOM_STEP_PINCH; else if (e.ctrlKey && step < -ZOOM_STEP_PINCH) step = -ZOOM_STEP_PINCH;  // 0.5.25:捏合支路单事件步长封顶(K 升 0.01 后真鼠标 ctrl+滚轮一格 dy~120 会跳 2.7×;封 ln1.4≈1.4×/event。触控板捏合 dy 小恒不触顶=全增益,顺滑不受影响)
            var z = img._mpZoom || { s: 1, tx: 0, ty: 0 };
            var sNext = Math.min(ZOOM_MAX, Math.max(1, z.s * Math.exp(step)));  // clamp [1,ZOOM_MAX];下界触底→下行复位(非 no-op)
            if (sNext === z.s) return;
            if (sNext === 1) { resetImageZoom(popup); return; }  // 0.5.16复审🟡-1修:触底态≡干净态——不复位则 tx 残留→s=1 图却偏移被 overflow:hidden 裁掉,且此后 sNext===z.s 永久 no-op(无 pan 无法自愈)
            var cr = content.getBoundingClientRect();                      // content 永不被 transform,视觉盒==layout 盒
            var iw = img.offsetWidth, ih = img.offsetHeight;               // offset* 是 layout 盒,transform 免疫
            var ix = cr.left + (cr.width - iw) / 2, iy = cr.top + (cr.height - ih) / 2;  // flex 居中反推 img layout 盒左上
            var px = (e.clientX - ix - z.tx) / z.s, py = (e.clientY - iy - z.ty) / z.s;  // 光标处 local 坐标(由当前视觉态反解)
            z.tx = e.clientX - ix - sNext * px; z.ty = e.clientY - iy - sNext * py;      // 光标锚定:新 scale 下该点仍留在光标处
            z.s = sNext; img._mpZoom = z;
            applyImgZoom(img);  // 0.5.22:transform 单写者(与 pan 共用;含 img-zoomed 类+复原按钮可见性)
        }, { passive: false });
        // 0.5.16 双击重置缩放("缩飞了回 100%"最高频诉求。双击的两次 pointerdown 各启停一次 pin-drag,无位移则 apply 原位,无害)
        popup.addEventListener("dblclick", function (e) {
            if (activeRendererType !== "image") return;
            var content = popup.querySelector(".mp-content");
            var img = content && content.querySelector("img");
            if (!img || (e.target !== img && e.target !== content)) return;  // 0.5.16复审🔵-4修:图被平移腾空的 content 空白区也接受复位(原精确判 img 致最需复位时落空,仅 rail reset 兜底)
            resetImageZoom(popup);
        });
        pinBtn.addEventListener("click", function (e) {
            e.stopPropagation();
            if (isPinned) stopDrag();  // unpin 强制终止拖动(capture 路由下 click 可能异常,主动清)
            isPinned = !isPinned;
            pinBtn.classList.toggle("is-pinned", isPinned);
            popup.classList.toggle("is-pinned", isPinned);  // 0.5.13复审 H-4 纠注:同步根仅影响 #mp-popup.is-pinned{cursor:grab} 选择器(原 latent bug=grab 光标不显);拖动门控读 isPinned 模块 var 不依赖此 class
        });
        resetBtn.addEventListener("click", function (e) { e.stopPropagation(); armZoomGeomGrace(); try { localStorage.removeItem("mp.popupSize." + (activeRendererType || "default")); } catch (e2) {} resetToDefaultSize(); });  // 0.5.11:清保存尺寸 + 按内容 natural 恢复(原固定 400×300 不匹配图比例→上下留白);0.5.25:+几何宽限(窗被手动放大过时,回 natural 使 rail 随右缘左移出光标→同族误关)
        closeBtn.addEventListener("click", function (e) { e.stopPropagation(); if (activeRenameDone) activeRenameDone(false); stopDrag(); stopPan(); isPinned = false; pinBtn.classList.remove("is-pinned"); popup.classList.remove("is-pinned"); currentHovered = null; lastRenderedItem = null; hidePopup(); });  // 0.5.13复审 H-2:走 stopDrag() 单一清理点(R-INT-07,原手动逐字段清是唯一例外,未来加 Esc/auto-hide 路径会放大);🔵 改名中途关闭先 done(false) 取消
        // popup 在 document.body（不在 .explorer-viewlet 子树），root 事件收不到 popup 上的进出 → popup 自管
        popup.addEventListener("mouseenter", function () { if (hideTimer) clearTimeout(hideTimer); if (hoverTimer) clearTimeout(hoverTimer); });  // 0.5.12🟡修:进 popup 也清 hoverTimer(否则 300ms 内首次 hover 的 hoverTimer 仍触发 handleHover 重渲染,刷掉用户正要点的按钮)
        popup.addEventListener("mouseleave", function () {  // 离开 popup → 计划关闭
            if (!isPinned) {
                if (hideTimer) clearTimeout(hideTimer);
                var leaveHide = function () { if (!isPinned && !isPanning && Date.now() >= zoomGeomGrace) { if (inTransitCorridor()) { hideTimer = setTimeout(leaveHide, 250); return; } hidePopup(); currentHovered = null; } };  // 0.5.29:+走廊守卫(慢速移向控件条 400ms 窗击穿→闪烁)
                hideTimer = setTimeout(leaveHide, hideDelayMs());  // 0.5.22:+!isPanning;0.5.25:+几何宽限让位
            }
        });
    }

    function savePopupSize(w, h) { try { localStorage.setItem("mp.popupSize." + (activeRendererType || "default"), JSON.stringify({ w: w, h: h })); } catch (e) {} }  // 0.5.4: per-type 保存
    function loadPopupSize(popup, type) { try { var s = JSON.parse(localStorage.getItem("mp.popupSize." + (type || "default")) || "{}"); if (s.w && s.h) { popup.style.width = s.w + "px"; popup.style.height = s.h + "px"; return true; } } catch (e) {} return false; }  // 0.5.4: per-type 加载
    // 0.4.9 图片/视频尺寸适配：popup 贴合内容 intrinsic 尺寸（无 letterbox 黑边），上限 70vw/70vh，地板 200×150。
    // 保留 object-fit:contain（popup 贴合比例时 no-op 无黑边；手动 resize 变比例时保图不变形）。
    function fitPopupToContent(nw, nh, rect) {
        var vw = window.innerWidth, vh = window.innerHeight;
        var w = nw || 400, h = nh || 300;  // SVG 无 natural → 兜底 400×300
        var MAX_W = Math.min(vw * 0.35, 450), MAX_H = Math.min(vh * 0.35, 340);  // 按窗口 35% + 硬上限 450×340（0.5.12 复审:原注释 40%/560×420 与代码不符,已纠正）
        var scale = Math.min(MAX_W / w, MAX_H / h, 1);  // 保图片比例，不放大超 natural
        w = Math.round(w * scale); h = Math.round(h * scale);
        var popup = document.getElementById("mp-popup"); if (!popup) return;
        popup.style.width = Math.max(200, w) + "px";
        popup.style.height = Math.max(150, h) + "px";
        popup.style.minHeight = "";  // 清 audio 折叠的 minHeight（切类型复位）
        if (rect) placePopup(rect);  // 尺寸变后重定位防越界（用 handleHover 快照 rect）
    }

    // 0.5.11: 恢复默认尺寸——按 type 回 natural(图/视频无 letterbox 上下留白)/固定栏(音频 56px)/600×450(3d)。resetBtn 调用。
    // 0.5.16 图片缩放重置:expando img._mpZoom 状态随元素生灭(renderImage 新建 img / hidePopup replaceChildren = 天然重置,零代码),
    // 仅两处须显式清(img 元素不重建而布局变的场景):resetToDefaultSize(窗复位)与四角 resize(重适配)。
    function resetImageZoom(popup) {
        var img = popup.querySelector(".mp-content img");
        if (img) { img.style.transform = ""; img.style.transformOrigin = ""; img.style.willChange = ""; img._mpZoom = null; }
        popup.classList.remove("img-zoomed");  // 0.5.22:光标 affordance 与 rail 复原按钮可见性随复位
        if (zoomBtnEl) zoomBtnEl.style.display = "none";
    }
    // 0.5.22 applyImgZoom:transform 单写者(wheel 锚定与 pan 平移共用,防双写漂移);顺带驱动 img-zoomed 类与 rail 复原按钮可见性(s>1)
    function applyImgZoom(img) {
        var z = img._mpZoom; if (!z) return;
        img.style.transformOrigin = "0 0";  // 固定 0 0(百分比 origin 按 layout 盒解析,光标移动时漂移)
        img.style.transform = "translate(" + z.tx + "px," + z.ty + "px) scale(" + z.s + ")";  // ★translate 必须在 scale 前
        img.style.willChange = "transform";
        var pop = document.getElementById("mp-popup");
        if (pop) pop.classList.toggle("img-zoomed", z.s > 1);
        if (zoomBtnEl) zoomBtnEl.style.display = z.s > 1 ? "flex" : "none";
    }
    function resetToDefaultSize() {
        var popup = document.getElementById("mp-popup"); if (!popup) return;
        resetImageZoom(popup);  // 0.5.16:img 不重建,inline transform 残留;不清则"窗复位而图仍放大"状态分裂
        var content = popup.querySelector(".mp-content");
        if (activeRendererType === "audio") { popup.style.height = "56px"; popup.style.minHeight = "56px"; popup.style.width = "360px"; }  // 0.5.27d 🔵-5:与 renderAudio 对齐(原 320 不一致)
        else if (activeRendererType === "3d") { popup.style.width = "600px"; popup.style.height = "450px"; popup.style.minHeight = ""; }
        else {
            var img = content && content.querySelector("img"), vid = content && content.querySelector("video");
            popup.style.minHeight = "";
            if (img && img.naturalWidth) fitPopupToContent(img.naturalWidth, img.naturalHeight);  // 贴回图比例(无上下留白)
            else if (vid && vid.videoWidth) fitPopupToContent(vid.videoWidth, vid.videoHeight);
            else { popup.style.width = "400px"; popup.style.height = "300px"; }
        }
        // 0.5.24 Y8:复位后视口夹紧(原直设尺寸无重定位——右下角小窗 reset 放大即溢出不可达;刻度对齐 placePopup 8/28/8)
        var vw2 = window.innerWidth, vh2 = window.innerHeight, w2 = popup.offsetWidth, h2 = popup.offsetHeight;
        var cl = parseFloat(popup.style.left), ct = parseFloat(popup.style.top);
        if (!isNaN(cl)) popup.style.left = Math.max(8, Math.min(cl, vw2 - w2 - 8)) + "px";
        if (!isNaN(ct)) popup.style.top = Math.max(28, Math.min(ct, vh2 - h2 - 8)) + "px";
    }
    function hidePopup() {
        renderEpoch++;  // 0.5.12🟡修:bump 代际→in-flight render3DFull 的 ep 守卫作废,防 popup 已隐藏但其 rAF 动画循环继续空转耗 GPU(3D 资源隐性泄漏)
        var popup = document.getElementById("mp-popup"); if (!popup) return;
        disposeContent(); popup.style.display = "none"; popup.style.width = ""; popup.style.height = ""; popup.style.minHeight = "";  // 0.5.20(A6)+0.5.21🔵-1:含 minHeight(audio 56 残留陷阱):清残留几何,下次 placePopup 不用上一项旧尺寸定位
        var content = popup.querySelector(".mp-content"); if (content) content.replaceChildren();
        lastRenderedItem = null;  // 清已渲染项（审查 3.1）
        unpinCurrent();  // 解除当前项缓存 pin（允许 LRU 回收;0.4.7 起无 blobUrl,纯数据驻留 GC 自理）
    }
    function disposeContent() {
        // 0.5.23复审🔴-1修:zoom 可见性载体(img-zoomed 类+复原按钮)在此重置——disposeContent 是 hidePopup 与 handleHover 图→图直切(disposeActiveRenderer)的共同汇聚点,一行覆盖全部拆除路径(原"expando 随 img 生灭"不变式对新载体不成立→换图后假按钮+假 grab 光标)
        var dPop = document.getElementById("mp-popup"); if (dPop) resetImageZoom(dPop);
        // v0.2-v0.5审查🟡：按 type 路由 dispose（防 FontFace/PDF worker/geometry 累积）
        if (activeRendererType === "3d" && typeof dispose3D === "function") dispose3D();
        else if (activeRendererType === "font" && activeFontFace) { try { document.fonts.delete(activeFontFace); activeFontFace.unload(); } catch (e) {} activeFontFace = null; }
        else if (activeRendererType === "video" || activeRendererType === "audio") {  // 0.5.24🔴R2修+0.5.29:全部媒体元素(视频+旁路 twin+音频条)逐一 pause+断 src+load(twin 入 DOM,单一清理路径)
            var dMeds = document.querySelectorAll("#mp-popup .mp-content video, #mp-popup .mp-content audio");
            for (var di = 0; di < dMeds.length; di++) { try { var p = dMeds[di].pause(); if (p && p.catch) p.catch(function () {}); dMeds[di].removeAttribute("src"); dMeds[di].load(); } catch (e) { /* ignore */ } }
        }
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
            if (isDragging || isPanning) return;  // 0.5.13/0.5.22:拖动/平移中忽略 explorer hover,防 currentHovered 漂移(handleHover 已 isPinned 主守,此为双保险)
            var item = e.target.closest(".monaco-list-row[role='treeitem']") || e.target.closest("[role='treeitem']");
            if (!item) {
                // 鼠标离开文件项区域 → 计划隐藏
                if (currentHovered && !isPinned) {
                    if (hideTimer) clearTimeout(hideTimer);
                    var awayHide2 = function () { if (!isMouseInPopup() && !isPinned && !isPanning && Date.now() >= zoomGeomGrace) { if (!inTransitCorridor()) { hidePopup(); currentHovered = null; return; } hideTimer = setTimeout(awayHide2, 250); } };  // 0.5.29:+走廊守卫;currentHovered 仅真关时清(走廊保活期回行 dedup 防重渲染闪烁)
                    hideTimer = setTimeout(awayHide2, hideDelayMs());
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
                var awayHide3 = function () { if (!isMouseInPopup() && !isPinned && !isPanning && Date.now() >= zoomGeomGrace) { if (!inTransitCorridor()) { hidePopup(); currentHovered = null; return; } hideTimer = setTimeout(awayHide3, 250); } };
                hideTimer = setTimeout(awayHide3, hideDelayMs());
            }
        });
    }
    function isMouseInPopup() { var p = document.getElementById("mp-popup"); return p && p.matches(":hover"); }
    // 0.5.29 走廊守卫:指针在 popup 与源文件行之间的缓冲走廊(各向外扩 24px 的包围盒)→ 不关浮窗,250ms 后再查。
    // 根因:hideTimer 400ms 窗口只覆盖"快速移动",慢速移向底部控件条时窗口击穿 → hide→re-hover→重渲染 = 用户实测的闪烁抖动。
    // 指针停走廊=意图不明,保活是安全默认(回到行/popup 即恢复常规语义)。
    function inTransitCorridor() {
        if (lastMX < 0) return false;
        var p = document.getElementById("mp-popup");
        if (!p || p.style.display === "none") return false;
        var r = p.getBoundingClientRect();
        var l = r.left - 24, t = r.top - 24, rr = r.right + 24, b = r.bottom + 24;
        if (currentHovered && currentHovered.getBoundingClientRect) {
            try { var c = currentHovered.getBoundingClientRect(); l = Math.min(l, c.left - 24); t = Math.min(t, c.top - 24); rr = Math.max(rr, c.right + 24); b = Math.max(b, c.bottom + 24); } catch (e) {}
        }
        return lastMX >= l && lastMX <= rr && lastMY >= t && lastMY <= b;
    }
    // 0.5.25 复位几何宽限:🔴点复原按钮=浮窗瞬间消失(用户实测)。根因≠窗缩——是 rail 在光标下缩走:
    //   点击 zoomBtn → gap2(12px)+按钮(28px)同时隐藏 → rail 自底缩 ~40px → 光标正落在原按钮位=rail 新盒之外
    //   → Chromium 对"元素自光标下移走"补发 popup mouseleave → 200ms 后误关。resetBtn(尺寸复原)在窗被手动
    //   放大过时同族(窗回 natural,rail 随右缘左移出光标)。
    //   宽限=复检制(用户语义"默认认为复原按钮原位置还有东西,虽然看不见"):窗口期内三处 hideTimer fire-time
    //   让位;到期复检——0.5.26:鼠标未动→hold 无限期保持(下一次移动裁决);动过→按真实 :hover(popup 或源行)定去留。
    function armZoomGeomGrace() {
        zoomGeomHold = false;
        var armX = lastMX, armY = lastMY;
        zoomGeomGrace = Date.now() + 650;
        setTimeout(function () {
            if (Date.now() < zoomGeomGrace) return;  // 宽限期内被再次 arm 顺延,本轮回让(多 timer 自收敛,免句柄簿记)
            zoomGeomGrace = 0;
            if (lastMX === armX && lastMY === armY) { zoomGeomHold = true; return; }  // 0.5.26:停驻原地→保持不关。死区内此后无任何既有监听会触发(popup mouseleave 已发过/root 只盖 explorer)→裁决点=下一次 document mousemove(见 boot 处跟踪器)
            if (!isMouseInPopup() && !isPinned && !isPanning && !(currentHovered && currentHovered.matches(":hover"))) { hidePopup(); currentHovered = null; }
        }, 660);
    }

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
        var popup = document.getElementById("mp-popup"); if (!popup) return;
        var fname = popup.querySelector(".mp-fname"); if (!fname) return;  // 0.5.9 修:原 oldName 行先读 fname.textContent 但 var fname 在下一行才声明——var 提升致 fname=undefined→undefined.textContent TypeError→点击无反应(潜伏自 0.5.4)。先取元素再读
        var oldFull = lastRenderedPath, oldName = fname.textContent.trim();  // 0.5.4: 从显示元素取(不取 currentHovered——可能因 hoverTimer 与显示不同步)
        if (!oldFull || !oldName) return;
        // 0.4.11：不再 isPinned 锁（用户要求：鼠标离开浮窗应直接关闭）。编辑期间鼠标在 popup 内无 mouseleave → 不关；
        //   鼠标离开 popup → input blur(done 提交) + mouseleave(hideTimer 关) = 提交并关闭，符合"鼠标离开输入框生效 + 离开浮窗关闭"。
        editing = true;
        var input = document.createElement("input");
        input.type = "text"; input.value = oldName;
        input.style.cssText = "position:absolute;top:-24px;left:0;font:500 11px/1.4 var(--vscode-font-family,sans-serif);color:#fff;padding:3px 8px;border-radius:4px;max-width:calc(100% - 12px);border:1px solid #0e639c;background:#3c3c3c;outline:none;box-shadow:0 2px 8px rgba(0,0,0,.35)";  // 0.5.3: 加 position:absolute;top:-24px;left:0 与 .mp-fname 同位(否则 replaceWith 后 input 回 static 流 → 左下角 + 鼠标不在 popup → mouseleave 关)  // 🔵 复审：font 与 .mp-fname 对齐（var 字体，编辑/显示态不跳变）
        fname.replaceWith(input); input.focus();
        var dot = oldName.lastIndexOf(".");  // 0.5.11:只选中文件名本体,不选中后缀(photo.jpg→选 "photo",留 ".jpg")
        if (dot > 0) input.setSelectionRange(0, dot); else input.select();  // dot>0 防隐藏文件(.bashrc dot=0→全选)
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
        activeRendererType = "image";  // 0.5.9: savePopupSize 按 type 存(原漏设→resize 存 "default" key→loadPopupSize 读 "image" 取不到→resize 不持久)
        return fetchImageFresh(filePath).then(function (dataUrl) {
            if (ep !== renderEpoch) return;  // stale（已被新 hover 取代，审查 3.6）
            var img = document.createElement("img");
            img.src = dataUrl; img.alt = filePath;
            return img.decode().then(function () {
                if (ep !== renderEpoch) return;
                var popup = document.getElementById("mp-popup");
                if (!loadPopupSize(popup, "image")) fitPopupToContent(img.naturalWidth, img.naturalHeight, rect);  // 0.5.9:无保存尺寸才贴合 natural;有用户上次 resize 则用之(原 fit 总覆盖→resize 永不生效)
                else if (rect) placePopup(rect);
                document.querySelector(".mp-content").replaceChildren(img);
            });
        });
    }

    // ===== 0.5.27 自研媒体控件条(mp-mb)=====
    // 根因链:原生 UA 控件=闭影 DOM——(a)用户实测 VSCode 环境中点击死(mute/play 无响应);(b)自动化不可测
    // (CDP 合成输入驱动不了它,rig c1 裸 video 对照已证);(c)S1/样式/布局屡次与之缠斗。
    // 属性写路径(play/pause/muted/volume/currentTime)rig 已证活跃 + 我们自有 DOM 按钮(rail 四键)在用户环境天天可用
    // → 弃 controls,自建可测控件面。unmute 只发生在按钮/滑条手势内(autoplay 政策安全:手势内解静音是标准路径)。
    function fmtT(s) { if (!isFinite(s) || s < 0) s = 0; s = Math.floor(s); var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60; return (h ? h + ":" + (m < 10 ? "0" : "") : "") + m + ":" + (sec < 10 ? "0" : "") + sec; }  // 0.5.27d 🔵-5:≥1h 显示 1:15:00
    function buildMediaBar(media) {
        var bar = document.createElement("div"); bar.className = "mp-mb";
        var play = document.createElement("button"); play.className = "mp-mb-play"; play.title = "播放/暂停";
        var setPlayIcon = function () { play.replaceChildren(mkIcon(media.paused ? ICON_PLAY : ICON_PAUSE)); };
        setPlayIcon();
        play.addEventListener("click", function () { if (media.paused) { var p = media.play(); if (p && p.catch) p.catch(function () {}); } else media.pause(); });
        var time = document.createElement("span"); time.className = "mp-mb-time"; time.textContent = "0:00 / 0:00";
        var seek = document.createElement("input"); seek.type = "range"; seek.min = "0"; seek.max = "1000"; seek.step = "1"; seek.value = "0"; seek.className = "mp-mb-seek"; seek.title = "进度"; seek.disabled = true;
        var mute = document.createElement("button"); mute.className = "mp-mb-mute"; mute.title = "静音";
        var setMuteIcon = function () { mute.replaceChildren(mkIcon(media.muted || media.volume === 0 ? ICON_VOLX : ICON_VOL)); mute.title = media.muted ? "取消静音" : "静音"; };
        setMuteIcon();
        mute.addEventListener("click", function () { media.muted = !media.muted; if (!media.muted && media.volume === 0) media.volume = 0.5; setMuteIcon(); });  // 手势内解静音(Chromium:手势外程序解静音会被 autoplay 政策暂停)
        var vol = document.createElement("input"); vol.type = "range"; vol.min = "0"; vol.max = "100"; vol.step = "1"; vol.value = String(Math.round((media.muted ? 0 : media.volume) * 100)); vol.title = "音量"; vol.className = "mp-mb-vol"; vol.style.width = "56px";
        vol.addEventListener("input", function () { media.volume = parseInt(vol.value, 10) / 100; media.muted = media.volume === 0; setMuteIcon(); });
        seek.addEventListener("input", function () { if (isFinite(media.duration) && media.duration > 0) media.currentTime = parseInt(seek.value, 10) / 1000 * media.duration; });
        var sync = function () {
            time.textContent = fmtT(media.currentTime) + " / " + fmtT(media.duration);
            if (isFinite(media.duration) && media.duration > 0) {
                seek.disabled = false;
                if (document.activeElement !== seek) seek.value = String(Math.round(media.currentTime / media.duration * 1000));  // 0.5.27d 🟡-1:拖动中不被 timeupdate 覆写(与 vol 同守卫;原缺→拖进度与播放"打架")
            } else seek.disabled = true;  // /transcode fMP4 空_moov 期 duration=Infinity → 禁拖待 durationchange 解锁
            var popN = document.getElementById("mp-popup"), w = popN ? popN.offsetWidth : 400;  // 0.5.27d 🟡-4:窄窗自适应(bar 定宽≈250>min-width 200-20 → 溢出)。<300 藏 time,<250 再藏 vol
            bar.classList.toggle("mp-mb-narrow", w < 300);
            bar.classList.toggle("mp-mb-tiny", w < 250);
        };
        media.addEventListener("timeupdate", sync);
        media.addEventListener("durationchange", sync);
        media.addEventListener("play", setPlayIcon);
        media.addEventListener("pause", setPlayIcon);
        media.addEventListener("volumechange", function () { setMuteIcon(); if (document.activeElement !== vol) vol.value = String(Math.round((media.muted ? 0 : media.volume) * 100)); });
        media.addEventListener("ended", setPlayIcon);
        bar.append(play, time, seek, mute, vol);
        sync();  // 0.5.27d 🔵-2:构造即同步一次(settle 时 metadata 已知,免"禁用态 seek+0:00"闪到首个 timeupdate)
        return bar;
    }

    // v0.2 视频:直 HTTP src(浏览器原生 Range seek,非 blob;doc08 §1)。
    // 0.5.20 settle-before-show(S1):离屏建 video 等 metadata→定尺寸定位→一次性插 DOM→play(可见后几何不变)。
    // 0.5.27:controls=false + 自研 mp-mb 控件条(原生 UA 控件在 VSCode 环境交互死+不可测,见 buildMediaBar 注);
    //   muted=true 起播(autoplay 政策恒过),用户点 mp-mb-mute 在手势内解静音——取代旧 S4 ▶fallback(被 play 按钮子集覆盖,删)。
    function renderVideo(filePath, ep, rect) {
        activeRendererType = "video";
        var popup = document.getElementById("mp-popup");
        var content = popup.querySelector(".mp-content");
        var ext = (filePath.split(".").pop() || "").toLowerCase();
        var video = document.createElement("video");
        video.preload = "metadata";  // 离屏先取 metadata(本地/流式均早到)
        video.src = mediaUrl(filePath, "video");  // 0.5.29 原生基底:mp4/mov/m4v/webm = 原文件 /preview(完整时长/秒拖);mkv/avi/flv = /transcode 流
        video.muted = true; video.playsInline = true;  // muted 起播(autoplay 恒过);AAC 家族永久 muted(makeMixer 保证 unmute 落 twin),webm 家族 unmute 直接落本元素
        video.style.maxWidth = "100%"; video.style.maxHeight = "100%";
        video.addEventListener("click", function () { if (video.paused) { var p = video.play(); if (p && p.catch) p.catch(function () {}); } else video.pause(); });  // 点击画面切播放(媒体播放器惯例;与 pan/drag 无冲突——video 在 DRAG_SKIP)
        // 0.5.29 音频旁路:AAC 家族(mp4/mov/m4v)建 twin(detached <audio>,离 DOM 可播);提取失败/无音轨 → _mpDead 降级单元素
        var twin = null;
        if (TWIN_NEEDED.indexOf(ext) >= 0) {
            twin = document.createElement("audio");
            twin.preload = "auto"; twin.muted = true; twin.style.display = "none";
            twin.src = audioUrl(filePath);
            twin.addEventListener("error", function () {
                if (ep !== renderEpoch) return;
                twin._mpDead = true;  // mixer 即刻降级(mute/volume 落回 master);不 retry(无 ffmpeg/无音轨皆终局)
                try { twin.removeAttribute("src"); twin.load(); } catch (e2) {}
                try { console.warn("[mp] 音频旁路不可用(无 ffmpeg/无音轨):", filePath.slice(-64)); } catch (e3) {}
            });
        }
        var mixer = makeMixer(video, twin);  // twin=null(webm/非原生)时 mixer 退化为单元素直通
        var settled = false;
        var settle = function () {  // 唯一"定尺寸→定位→插 DOM→play"入口,latch 保证只跑一次
            if (settled || ep !== renderEpoch) return; settled = true;
            if (!loadPopupSize(popup, "video")) fitPopupToContent(video.videoWidth, video.videoHeight, rect);
            else if (rect) placePopup(rect);
            var kids = [video]; if (twin) kids.push(twin); kids.push(buildMediaBar(mixer));
            content.replaceChildren.apply(content, kids);  // loading 占位此刻一次换掉(video+twin+bar 同刻插入,S1;twin display:none 入 DOM——dispose 单一 DOM 清理路径覆盖)
            var pp = video.play(); if (pp && pp.catch) pp.catch(function () {});  // muted 起播(策略恒过);mixer.timeupdate 会拉起 twin 对齐加入
        };
        video.addEventListener("loadedmetadata", settle);
        setTimeout(settle, 600);  // 兜底:metadata 迟到也出画面(默认 400×300);迟到后不二次改尺寸(防跳)
        video.addEventListener("error", function () {
            if (ep !== renderEpoch) return; settled = true;  // latch:错误后不再 settle
            var vext = (filePath.split(".").pop() || "").toLowerCase();
            if (NATIVE_VIDEO.indexOf(vext) < 0) { hidePopup(); return; }  // 非原生(avi/flv/mkv)失败 → 静默关(用户要求不做提醒)
            else { disposeContent(); showPopupError("video 加载失败"); }  // 0.5.29c 🟡-3:先 dispose(pause+断src 双媒体)——否则已解静音的 twin 在错误卡下继续出声(幽灵音频)
        });
    }

    // v0.3 音频:直 HTTP src。0.5.27:controls=false + mp-mb(与视频同组件;原生 UA 控件同族死按钮风险)。
    //   不 autoplay 不静音——用户点 mp-mb-play(手势)即播,mp-mb-mute/vol 控音量。
    function renderAudio(filePath, ep, rect) {
        activeRendererType = "audio";
        var content = document.querySelector(".mp-content");
        var ext = (filePath.split(".").pop() || "").toLowerCase();
        var audio = document.createElement("audio");
        // 0.5.29:m4a/aac(宿主无解码)→ /audio 提取 MP3 缓存主源(失败回退原生);mp3/wav/ogg/flac/opus 原生直读;aiff 走 /transcode WAV
        audio.src = (ext === "m4a" || ext === "aac") ? audioUrl(filePath) : mediaUrl(filePath, "audio");
        audio.preload = "auto"; audio.style.display = "none";  // 无 controls 视觉;交互面全部走 mp-mb
        content.replaceChildren(audio, buildMediaBar(audio));
        var popup = document.getElementById("mp-popup");  // 音频无视觉内容 → popup 折叠成细横条(mp-mb 即全部内容)
        if (popup) { popup.style.height = "56px"; popup.style.minHeight = "56px"; popup.style.width = "360px"; if (rect) placePopup(rect); }
        var nativeAudioTried = false;
        audio.addEventListener("error", function () {
            if (ep !== renderEpoch) return;
            if (!nativeAudioTried && audio.src.indexOf("/audio") >= 0) { nativeAudioTried = true; audio.src = mediaUrl(filePath, "audio"); audio.load(); return; }  // 提取失败(无 ffmpeg)→ 原生回退(无 AAC 宿主会再 error→错误卡;有解码宿主可正常)
            showPopupError("audio 加载失败");
        });
    }

    // v0.3 字体：FontFace ArrayBuffer 源（免 font-src CSP）+ canvas glyph grid（doc08 §3）。走缓存（arrayBuffer 直存）。
    async function renderFont(filePath, ep, rect) {  // 0.5.21复审🟡-2修:加 rect(renderFont 原无任何尺寸恢复——A6 前靠残留 inline 几何意外保留用户 resize,A6 后存了永读不回)
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
        var popupF = document.getElementById("mp-popup");  // 0.5.21🟡-2:尺寸恢复(无保存则 480×360 匹配 canvas 1:1,原 400×300 会压扁 canvas)+对称重定位
        if (popupF) { if (!loadPopupSize(popupF, "font")) { popupF.style.width = "480px"; popupF.style.height = "360px"; popupF.style.minHeight = ""; } if (rect) placePopup(rect); }
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
    function probeSize(filePath) {  // Range bytes=0-0 → Content-Range total（不发 HEAD，零 server 改动）。0.5.19 注:探测不带 If-Range→恒拿当前 total(恒新);而 render3DFull 走 _cache 会话级——3d 同名覆盖后"新 meta 配旧 body"为预存取舍(稳定资产假设,终裁文档化)
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
        activeRendererType = "3d";  // 0.5.24 Y9:入口前置(大卡/加载窗口期 resize 曾落死键 default、resetBtn 走错分支、hideDelayMs 非 media 档)
        var T = await waitForThree();
        if (ep !== renderEpoch) return;
        var p3d = document.getElementById("mp-popup");
        if (p3d && !loadPopupSize(p3d, "3d")) { p3d.style.width = "600px"; p3d.style.height = "450px"; p3d.style.minHeight = ""; if (rect) placePopup(rect); }
        else if (rect) placePopup(rect);  // 0.5.21复审🟡-1修:保存尺寸命中分支也须重定位(A6 清几何后,否则定位按 CSS 默认 400×300 钳制而渲染用保存尺寸→视口右/下缘溢出;与 image/video 对称)
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
        await render3DFull(filePath, ep, ext, T);
    }
    async function render3DFull(filePath, ep, ext, T) {
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
        if (editing) { if (activeRenameDone) activeRenameDone(false); }  // 0.5.12🔴修:改名编辑中 .mp-fname 被 input 替换→下方 querySelector(".mp-fname")=null→TypeError 崩。先取消改名恢复 fname 再继续(transit<200ms 常触发)
        var filename = getLabelName(rowEl);
        if (!filename) return;
        var type = detectMediaType(filename);
        if (!type) { hidePopup(); currentHovered = null; lastRenderedItem = null; return; }  // 0.5.4: 非媒体文件 → 关闭当前浮窗(否则旧内容残留)
        var fullPath = getFullPath(rowEl);
        if (!fullPath) { hidePopup(); currentHovered = null; lastRenderedItem = null; return; }  // 0.5.12🟡修:路径取不到也关浮窗(原仅 return 致旧 popup 残留,与非媒体分支不对称)
        if (rowEl === lastRenderedItem) {  // 同项已渲染且仍可见 → 不重复 fetch（审查 3.1：防 hideTimer 清 currentHovered 后 re-hover 闪烁）
            var existing = document.getElementById("mp-popup");
            if (existing && existing.style.display !== "none") return;
        }
        lastRenderedItem = rowEl;
        lastRenderedPath = fullPath;
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
        else if (type === "font") renderFont(fullPath, ep, rect).catch(function (e) { if (ep === renderEpoch) showPopupError(e.message); });
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

    // 0.5.26 全局鼠标坐标 + hold 裁决:hold 期(点复原后停驻原地)死区内无任何既有监听触发
    //   (popup mouseleave 已发过 / root mousemove 只盖 explorer / popup 自身无 mousemove 监听)→ 必须 document 级。
    //   首帧移动即结束 hold:光标在 popup 内=常规驻留不动;在死区=恢复常规离开语义(200ms 后关)。
    //   capture 保证先于 explorer root 处理器跑(移动到源行场景:先排 hideTimer,root 行处理器随即清之,零竞态)。
    document.addEventListener("mousemove", function (e) {
        lastMX = e.clientX; lastMY = e.clientY;
        if (!zoomGeomHold) return;
        zoomGeomHold = false;
        if (!isMouseInPopup() && !isPinned && !isPanning) {
            if (hideTimer) clearTimeout(hideTimer);
            var holdHide = function () { if (!isMouseInPopup() && !isPinned && !isPanning && Date.now() >= zoomGeomGrace) { if (!inTransitCorridor()) { hidePopup(); currentHovered = null; return; } hideTimer = setTimeout(holdHide, 250); } };
            hideTimer = setTimeout(holdHide, hideDelayMs());
        }
    }, true);

    console.log("[mp-overlay] loaded", cfg.version);
    waitForExplorer(function () {
        setupHoverListeners();
        console.log("[mp-overlay] hover listeners attached");
    });
})();
