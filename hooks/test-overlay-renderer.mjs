// test-overlay-renderer：renderer 执行闸门(0.5.24,第 8 道,npm test 链尾)。
// 📕 起源(0.5.24 全项目双审 BLOCK 项 R1):stopPan 声明落在 pointerdown 回调作用域,closeBtn 层引用即
//   ReferenceError——关闭按钮整体失效。**七闸门全绿放行**(全部静态 scrape/node --check,renderer 零执行)。
//   本闸门用最小 DOM stub 真跑 overlay IIFE:image hover 全链 → closeBtn click → 断言不抛且浮窗隐藏;
//   audio→image 切换 → disposeContent 断言 pause 被调(R2 锚)。R1 类作用域/运行时回归从此有闸。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const base = fileURLToPath(new URL("../", import.meta.url));
const src = readFileSync(base + "resources/overlay.template.js", "utf8");
let fails = 0;
const fail = (m) => { console.error("  FAIL:", m); fails++; };

// ---------- 最小 DOM stub ----------
class El {
    constructor(tag) { this.tagName = (tag || "div").toUpperCase(); this.children = []; this.parent = null;
        this.style = {}; this.dataset = {}; this._cls = new Set(); this._listeners = new Map(); this._attrs = {};
        this.textContent = ""; this.className = ""; this.title = ""; this.id = "";
        this.naturalWidth = 800; this.naturalHeight = 600; this.videoWidth = 640; this.videoHeight = 360;
        this.paused = true; this.muted = false; this.controls = false; this.autoplay = false; this.playsInline = false;
        this._calls = []; this.value = ""; this.readyState = 4; this.body = null;
        Object.defineProperty(this, "offsetWidth", { get: () => parseFloat(this.style.width) || 400 });
        Object.defineProperty(this, "offsetHeight", { get: () => parseFloat(this.style.height) || 300 });
    }
    get classList() { const self = this; return { add: (...c) => c.forEach(x => self._cls.add(x)), remove: (...c) => c.forEach(x => self._cls.delete(x)),
        toggle: (c, f) => { const on = f === undefined ? !self._cls.has(c) : !!f; on ? self._cls.add(c) : self._cls.delete(c); return on; },
        contains: c => self._cls.has(c) }; }
    setAttribute(k, v) { this._attrs[k] = String(v); if (k === "id") this.id = String(v); }
    getAttribute(k) { return this._attrs[k] ?? null; }
    removeAttribute(k) { this._calls.push("removeAttribute:" + k); delete this._attrs[k]; }
    appendChild(c) { c.parent = this; this.children.push(c); return c; }
    append(...cs) { cs.forEach(c => this.appendChild(c)); }
    removeChild(c) { this.children = this.children.filter(x => x !== c); }
    replaceChildren(...cs) { this.children.forEach(c => { c.parent = null; }); this.children = []; cs.forEach(c => this.appendChild(c)); }
    replaceWith(n) { if (this.parent) { const i = this.parent.children.indexOf(this); this.parent.children[i] = n; n.parent = this.parent; } }
    remove() { if (this.parent) this.parent.removeChild(this); }
    addEventListener(t, fn) { if (!this._listeners.has(t)) this._listeners.set(t, []); this._listeners.get(t).push(fn); }
    removeEventListener(t, fn) { const l = this._listeners.get(t); if (l) this._listeners.set(t, l.filter(f => f !== fn)); }
    dispatch(t, ev) { (this._listeners.get(t) || []).slice().forEach(fn => fn(ev || {})); }
    getBoundingClientRect() { return { left: 100, top: 100, width: this.offsetWidth, height: this.offsetHeight, right: 100 + this.offsetWidth, bottom: 100 + this.offsetHeight }; }
    matches() { return false; } closest() { return null; }
    querySelector(sel) { return this._qs(this, sel); } querySelectorAll(sel) { return this._qsa(this, sel); }
    focus() {} select() {} load() { this._calls.push("load"); }
    play() { this._calls.push("play"); this.paused = false; return Promise.resolve(); }
    pause() { this._calls.push("pause"); this.paused = true; return Promise.resolve(); }
    decode() { return Promise.resolve(); }
    setPointerCapture() {} releasePointerCapture() {}
    _tok(el, t) { if (t.startsWith("#")) return el.id === t.slice(1); if (t.startsWith(".")) return el._cls.has(t.slice(1)) || el.className.split(/\s+/).includes(t.slice(1)); return el.tagName === t.toUpperCase(); }
    _matchPart(el, part) { const toks = part.trim().split(/\s+/).filter(x => !x.includes("[")); if (!toks.length) return false;
        if (!this._tok(el, toks[toks.length - 1])) return false; let p = el.parent;
        for (let i = toks.length - 2; i >= 0; i--) { while (p && !this._tok(p, toks[i])) p = p.parent; if (!p) return false; p = p.parent; }
        return true; }
    _qsa(root, sel) { const parts = sel.split(",").map(s => s.trim()).filter(Boolean); const out = [];
        const walk = el => { for (const c of el.children) { if (parts.some(p => { try { return this._matchPart(c, p); } catch { return false; } })) out.push(c); walk(c); } };
        walk(root); return out; }
    _qs(root, sel) { return this._qsa(root, sel)[0] || null; }
}
const byId = new Map();
const docLs = new Map();  // 0.5.26:document 级监听(全局 mousemove 跟踪器挂这里)
const body = new El("body");
const mkDoc = () => ({
    getElementById: id => byId.get(id) || body._qs(body, "#" + id),  // overlay 直接属性赋 id(不经 setAttribute)→ 须 DOM 树查找兜底
    createElement: t => new El(t),
    createElementNS: (ns, t) => new El(t),
    addEventListener: (t, fn) => { if (!docLs.has(t)) docLs.set(t, []); docLs.get(t).push(fn); },
    removeEventListener: (t, fn) => { const l = docLs.get(t); if (l) docLs.set(t, l.filter(f => f !== fn)); },
    querySelector: sel => { if (sel === ".explorer-viewlet") return explorerRoot; return body._qs(body, sel); },
    querySelectorAll: sel => body._qsa(body, sel),
    body, head: new El("head"),
    fonts: { add() {}, delete() {} },
});
let explorerRoot = null;

// ---------- 场景驱动 ----------
async function scenario() {
    const popupLogs = [];
    const storage = new Map();
    const fetchLog = [];
    const sandbox = {
        console: { log: () => {}, warn: (...a) => popupLogs.push(a.join(" ")), error: () => {} },
        setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame: cb => setTimeout(cb, 0), cancelAnimationFrame: id => clearTimeout(id),
        Date, Math, JSON, Promise, Error, RegExp, parseInt, parseFloat, isNaN, Map, Set, ArrayBuffer, TextDecoder: { prototype: TextDecoder.prototype },
        fetch: (url) => { fetchLog.push(String(url));
            return Promise.resolve({ ok: true, status: 200, headers: { get: () => '"1-1"' },
                json: () => Promise.resolve({ type: "image", mime: "image/png", base64: "aGk=", sizeBytes: 2 }),
                arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)), body: { cancel() {} } }); },
        localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
        document: mkDoc(),
        window: { innerWidth: 1920, innerHeight: 1080 },
        navigator: { mediaCapabilities: { decodingInfo: function () { return Promise.resolve({ supported: false }); } } },  // 0.5.27e:AAC 探测桩(不支持)→ mp4 路由 /transcode,供场景4 回退断言
    };
    sandbox.window.__MP_CONFIG__ = { port: 17741, token: "gate-token", version: "test", enabled: true };  // 缺此 IIFE 早退(降等保护)
    sandbox.window.MP_THREE = undefined;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    try { vm.runInContext(src, sandbox, { timeout: 5000 }); } catch (e) { fail("overlay IIFE 加载即抛:" + e.message); return; }

    // explorer root + 文件行
    explorerRoot = new El("div"); explorerRoot._cls.add("explorer-viewlet");
    const mkRow = (name, path) => { const row = new El("div"); row._cls.add("monaco-list-row");
        row.closest = () => row; // [role] 选择器由 stub 直通
        const label = new El("a"); label._cls.add("label-name"); label.textContent = name;
        const icon = new El("div"); icon._cls.add("monaco-icon-label"); icon.setAttribute("aria-label", path + " • Git");
        const wrap = new El("div"); wrap._cls.add("monaco-icon-label");
        wrap.appendChild(label); icon.appendChild(label); row.appendChild(icon);
        row.querySelector = sel => sel.includes("label-name") ? label : (sel.includes("monaco-icon-label") ? icon : null);
        return row; };
    const rowPng = mkRow("test.png", "/tmp/x/test.png");
    const rowMp3 = mkRow("test.mp3", "/tmp/x/test.mp3");
    const rowMp4 = mkRow("test.mp4", "/tmp/x/test.mp4");

    // 等 waitForExplorer 轮询到 root + listeners attached
    await new Promise(r => setTimeout(r, 500));
    const mm = explorerRoot._listeners.get("mousemove");
    if (!mm || !mm.length) { fail("explorer mousemove 监听未挂(waitForExplorer/setupHoverListeners 未跑通)"); return; }
    byId.set("workbench.view.explorer", { offsetParent: {} }); // isExplorerActive

    const hover = async (row) => { mm[mm.length - 1]({ target: row, clientX: 200, clientY: 200 }); await new Promise(r => setTimeout(r, 420)); };

    // --- 场景1: image hover 全链 → closeBtn click 不抛且隐藏(R1 锚) ---
    await hover(rowPng);
    const popup = byId.get("mp-popup") || body._qs(body, "#mp-popup");
    if (!popup) { fail("hover 后 #mp-popup 未建(handleHover 链断:" + popupLogs.join("|") + ")"); return; }
    if (popup.style.display !== "flex") fail("popup 未显示(display=" + popup.style.display + ")");
    let img = popup._qs(popup, ".mp-content img");
    if (!img) fail("renderImage 未落 img(fetch/decode 链断)");
    const closeBtn = popup._qsa(popup, "button").find(b => b.className.includes("mp-close"));
    if (!closeBtn) { fail("closeBtn 未找到"); return; }
    let threw = null;
    try { closeBtn.dispatch("click", { stopPropagation() {} }); } catch (e) { threw = e; }
    if (threw) fail("closeBtn click 抛异常(R1 类 renderer 运行时回归):" + threw.message);
    else if (popup.style.display !== "none") fail("closeBtn 点击后 popup 未隐藏(hidePopup 链断)");
    if (fetchLog.length === 0) fail("零 fetch(renderImage 未发起请求)");

    // --- 场景2: audio 播放 → hover image → disposeContent 应 pause+断src(R2 锚) ---
    await hover(rowMp3);
    const popup2 = byId.get("mp-popup") || body._qs(body, "#mp-popup");
    const aud = popup2._qs(popup2, ".mp-content audio");
    if (!aud) { fail("renderAudio 未落 audio 元素"); return; }
    aud._calls.length = 0;
    await hover(rowPng);
    if (!aud._calls.includes("pause")) fail("audio→image 切换未 pause(disposeContent R2 分支未生效:脱离 DOM 媒体继续出声)");
    if (!aud._calls.includes("removeAttribute:src")) fail("audio 未断 src(转码流继续拉取)");

    // --- 场景3(0.5.25🔴锚+0.5.26 hold 语义):wheel 放大→点复原→mouseleave 不误关→停驻=不关→移动才关 ---
    //    真机根因:点击后 gap2+按钮在光标下隐藏→rail 缩走→Chromium 补发 mouseleave→200ms 误关(用户实测"点复原=浮窗消失")
    //    0.5.26 用户语义:点复原后停在原地=浮窗保持不关闭;动了才按常规离开语义关
    const popup3 = byId.get("mp-popup") || body._qs(body, "#mp-popup");
    const img3 = popup3 && popup3._qs(popup3, ".mp-content img");
    if (!img3) fail("场景3: img 缺失(前置场景未留 image 渲染)");
    else {
        popup3.dispatch("wheel", { deltaY: -120, deltaMode: 0, ctrlKey: false, clientX: 200, clientY: 200, target: img3, preventDefault() {} });
        if (!(img3._mpZoom && img3._mpZoom.s > 1)) fail("wheel 缩放未生效(_mpZoom.s>1 缺失)");
        const zb = popup3._qsa(popup3, "button").find(b => b.className.includes("mp-zoomreset"));
        if (!zb) fail("zoomreset 按钮未建");
        else {
            if (zb.style.display !== "flex") fail("zoomBtn 须随 s>1 显示(display=flex),实得 " + zb.style.display);
            const dmm = docLs.get("mousemove");
            if (!dmm || !dmm.length) fail("document mousemove 跟踪器未挂(hold 裁决唯一入口)");
            zb.dispatch("click", { stopPropagation() {} });   // 点复原(真机此刻 rail 在光标下缩走)
            popup3.dispatch("mouseleave", {});                // 模拟 Chromium 对"元素自光标下移走"补发的 mouseleave
            await new Promise(r => setTimeout(r, 350));       // > hideDelay(200) 但 < 宽限(650):不得关
            if (popup3.style.display === "none") fail("grace 失效:点复原按钮后被 mouseleave 误关(0.5.25 用户实测🔴回归)");
            await new Promise(r => setTimeout(r, 600));       // 过宽限到期(650):鼠标未动(stub 无 doc mousemove)→hold 停驻保持
            if (popup3.style.display === "none") fail("hold 失效:停驻原地仍被关(0.5.26 用户语义:点复原停在原地=不关)");
            (docLs.get("mousemove") || []).slice().forEach(fn => fn({ clientX: 900, clientY: 900 }));  // 鼠标动了(死区)
            await new Promise(r => setTimeout(r, 400));       // > hideDelay(200):恢复常规离开语义→应关
            if (popup3.style.display !== "none") fail("hold 后移动到死区未关(移动裁决失效:死悬窗)");
        }
    }
    console.log("    场景: image hover→close 不抛且隐藏 ✓ / audio→image dispose pause+断src ✓ / fetch " + fetchLog.length + " 次 / 复原宽限+停驻保持→移动才关 ✓");

    // --- 场景4(0.5.27 核心):自研 mp-mb 控件条行为——原生 UA 控件(闭影 DOM)被弃后,交互面全部落在此 ---
    //    点 play → video.play 被调;点 mute → muted 翻 false(手势内解静音);seek input → currentTime 写入。
    //    这正是用户实测死的交互(原生 mute 死按钮),从此有闸。
    await hover(rowMp4);
    await new Promise(r => setTimeout(r, 900));  // settle 600ms 兜底(settle 走 setTimeout 兜底路径)
    const popup4 = byId.get("mp-popup") || body._qs(body, "#mp-popup");
    const vid4 = popup4 && popup4._qs(popup4, ".mp-content video");
    if (!vid4) fail("场景4: video 未落(settle 未跑通)");
    else {
        if (vid4.controls) fail("video 不得带 controls(原生 UA 控件已弃;属性式/setAttribute 式皆抓)");
        const bar = popup4._qs(popup4, ".mp-content .mp-mb");
        if (!bar) fail("mp-mb 控件条未建(buildMediaBar 未跑)");
        else {
            const bPlay = bar._qs(bar, ".mp-mb-play"), bMute = bar._qs(bar, ".mp-mb-mute"), bSeek = bar._qs(bar, ".mp-mb-seek");
            if (!bPlay || !bMute || !bSeek) fail("mp-mb 三要件缺(play/mute/seek)");
            else {
                bPlay.dispatch("click", {});  // 初始:renderVideo settle 已 play(paused=false)→ 此点击=暂停
                if (!vid4._calls.includes("pause")) fail("mp-mb play 点击未驱动媒体(点按→pause 未调)");
                bPlay.dispatch("click", {});  // 再点=播放
                if (!vid4._calls.includes("play")) fail("mp-mb play 点击未驱动媒体(再点→play 未调)");
                bMute.dispatch("click", {});  // muted=true → false(手势内解静音,用户核心诉求)
                if (vid4.muted !== false) fail("mp-mb mute 点击未解静音(muted 应翻 false)——用户实测死按钮的替代路径失效");
                vid4.duration = 100; bSeek.value = "250"; bSeek.dispatch("input", {});  // duration 由媒体栈供;stub 手设后 seek
                if (vid4.currentTime !== 25) fail("mp-mb seek 未写入 currentTime(实得 " + vid4.currentTime + ")");
                if (!String(vid4.src).includes("/transcode")) fail("场景4: AAC 桩不支持时 mp4 须路由 /transcode(实得 " + vid4.src + ")");
                vid4.dispatch("error", {});  // 0.5.27e 🔴-1 行为断言:转码路死(无 ffmpeg 404)→ 回退原生一次
                if (!String(vid4.src).includes("/preview")) fail("🔴-1 回退失效:转码 error 后 src 未回退 /preview(无 ffmpeg 宿主 mp4 将报错卡——0.5.27d 对抗审)");
                if (!vid4._calls.includes("play")) fail("回退后须重试 play");
            }
        }
    }
    console.log("    场景: mp-mb play/pause 驱动 + mute 手势解静音 + seek 写入 ✓");
}

await scenario();
if (fails) { console.error(`\nFAIL: test-overlay-renderer（${fails} 处——renderer 执行层回归）`); process.exit(1); }
console.log("OK: test-overlay-renderer（IIFE 真跑:closeBtn 无 R1 类作用域崩溃 + 媒体 dispose pause+断src + hover 全链）");
process.exit(0);
