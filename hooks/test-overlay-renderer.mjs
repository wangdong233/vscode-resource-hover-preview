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
const body = new El("body");
const mkDoc = () => ({
    getElementById: id => byId.get(id) || body._qs(body, "#" + id),  // overlay 直接属性赋 id(不经 setAttribute)→ 须 DOM 树查找兜底
    createElement: t => new El(t),
    createElementNS: (ns, t) => new El(t),
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
        navigator: {},
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
    console.log("    场景: image hover→close 不抛且隐藏 ✓ / audio→image dispose pause+断src ✓ / fetch " + fetchLog.length + " 次");
}

await scenario();
if (fails) { console.error(`\nFAIL: test-overlay-renderer（${fails} 处——renderer 执行层回归）`); process.exit(1); }
console.log("OK: test-overlay-renderer（IIFE 真跑:closeBtn 无 R1 类作用域崩溃 + 媒体 dispose pause+断src + hover 全链）");
process.exit(0);
