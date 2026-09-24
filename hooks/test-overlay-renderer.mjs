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
    matches(sel) { return String(sel).includes(":hover") ? !!this._hover : false; } closest() { return null; }  // 0.5.31 Y5::hover 可注入
    querySelector(sel) { return this._qs(this, sel); } querySelectorAll(sel) { return this._qsa(this, sel); }
    focus() {} select() {} load() { this._calls.push("load"); }
    requestVideoFrameCallback(cb) { (this.__rvfcCbs = this.__rvfcCbs || []).push(cb); this.__rvfcCb = cb; }  // 0.5.38 终审🟡-1:rVFC 桩(真机主揭示信号的行为锚前提);0.5.39:队列化——reveal 与 noblur 双注册,单槽覆盖会吞 4e(真浏览器允许多并发回调)
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
    activeElement: null,  // 0.5.37:可注入焦点(场景4b 复现"拖后焦点恒留"真机失败模式;原桩缺此属性→旧 activeElement 守卫在桩里恒过=空转绿)
});
let explorerRoot = null;

// ---------- 场景驱动 ----------
async function scenario() {
    const popupLogs = [];
    const storage = new Map();
    const fetchLog = [];
    const vmDoc = mkDoc();  // 0.5.37:保留引用供场景 4b 注入 activeElement(复现拖后焦点恒留)
    const sandbox = {
        console: { log: () => {}, warn: (...a) => popupLogs.push(a.join(" ")), error: () => {} },
        setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame: cb => setTimeout(cb, 0), cancelAnimationFrame: id => clearTimeout(id),
        Date, Math, JSON, Promise, Error, RegExp, parseInt, parseFloat, isNaN, Map, Set, ArrayBuffer, TextDecoder: { prototype: TextDecoder.prototype },
        fetch: (url) => { fetchLog.push(String(url));
            return Promise.resolve({ ok: true, status: 200, headers: { get: () => '"1-1"' },
                json: () => Promise.resolve({ type: "image", mime: "image/png", base64: "aGk=", sizeBytes: 2 }),
                arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)), body: { cancel() {} } }); },
        localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
        document: vmDoc,
        window: { innerWidth: 1920, innerHeight: 1080 },
        navigator: {},  // 0.5.28:探测已删,AAC 家族恒路由——无需桩
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

    const pump = async (x, y, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { (docLs.get("mousemove") || []).slice().forEach(fn => fn({ clientX: x, clientY: y + (Date.now() % 2 ? 1 : -1) })); await new Promise(r => setTimeout(r, 150)); } };  // 0.5.33:移动中指针模拟(每 150ms 泵一次,坐标微动=真在移动)——静止长等=按新语义应关,通过场景必须泵动
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

    // --- 场景3b(0.5.36 adv-verify M2 行为锚):宽限到期"动过"须复检真实 :hover 定去留(保活方向) ---
    //    M2 突变(删 currentHovered.matches(":hover") 复检)曾全绿——到期动过+源行仍悬停→误关而闸门无察。
    //    隔离设计:全程不派发任何 mouseleave(裁决点=唯一到期 handler);先证保活(行 _hover 注入),
    //    再证负向(全无 :hover 到期必关)——双向锚防"到期 handler 根本没跑"的空转绿。
    await hover(rowPng);
    await new Promise(r => setTimeout(r, 450));
    const popup3b = byId.get("mp-popup") || body._qs(body, "#mp-popup");
    const img3b = popup3b && popup3b._qs(popup3b, ".mp-content img");
    if (!img3b) fail("场景3b: img 缺失(前置渲染未留)");
    else {
        popup3b.dispatch("wheel", { deltaY: -120, deltaMode: 0, ctrlKey: false, clientX: 150, clientY: 150, target: img3b, preventDefault() {} });
        const zb3b = popup3b._qsa(popup3b, "button").find(b => b.className.includes("mp-zoomreset"));
        if (!zb3b) fail("场景3b: zoomreset 按钮未建");
        else {
            zb3b.dispatch("click", { stopPropagation() {} });   // 武装宽限(arm 坐标=此刻 lastM)
            popup3b._hover = false; rowPng._hover = true;       // 不在窗内;源行仍悬停(复检保活依据)
            (docLs.get("mousemove") || []).slice().forEach(fn => fn({ clientX: 150, clientY: 150 }));  // 动过(≠arm→复检路)
            await new Promise(r => setTimeout(r, 780));         // 过到期(660)
            if (popup3b.style.display === "none") fail("3b 保活:到期复检忽略源行 :hover——动过+仍悬停被误关(verify M2 突变曾存活)");
            rowPng._hover = false;                              // 反向:全无 :hover →到期必关(证 handler 真跑,非空转)
            zb3b.dispatch("click", { stopPropagation() {} });   // 再武装
            (docLs.get("mousemove") || []).slice().forEach(fn => fn({ clientX: 151, clientY: 151 }));
            await new Promise(r => setTimeout(r, 780));
            if (popup3b.style.display !== "none") fail("3b 关闭:全无 :hover 到期未关(复检负向失效)");
        }
    }
    console.log("    场景: image hover→close 不抛且隐藏 ✓ / audio→image dispose pause+断src ✓ / fetch " + fetchLog.length + " 次 / 复原宽限+停驻保持→移动才关 ✓");

    // --- 场景4(0.5.29 核心):原生基底 + mixer 双元素同步 + 走廊守卫 ---
    await hover(rowMp4);
    await new Promise(r => setTimeout(r, 900));  // settle 600ms 兜底
    const popup4 = byId.get("mp-popup") || body._qs(body, "#mp-popup");
    const vid4 = popup4 && popup4._qs(popup4, ".mp-content video");
    if (!vid4) fail("场景4: video 未落(settle 未跑通)");
    else {
        if (String(vid4.src).indexOf("/preview") < 0) fail("0.5.29 核心:mp4 须原文件 /preview 直读(完整时长/秒拖;实得 " + vid4.src + ")");
        const twin4 = popup4._qs(popup4, ".mp-content audio");
        if (!twin4) fail("twin 音频旁路未建(TWIN_NEEDED 家族)");
        else {
            if (String(twin4.src).indexOf("/audio") < 0) fail("twin 须接 /audio 提取端点(实得 " + twin4.src + ")");
            if (twin4.muted !== true) fail("twin 须 muted 起播(autoplay 政策)");
            const bar = popup4._qs(popup4, ".mp-content .mp-mb");
            const bPlay = bar && bar._qs(bar, ".mp-mb-play"), bMute = bar && bar._qs(bar, ".mp-mb-mute"), bSeek = bar && bar._qs(bar, ".mp-mb-seek");
            if (!bPlay || !bMute || !bSeek) fail("mp-mb 三要件缺");
            else {
                vid4._calls.length = 0; twin4._calls.length = 0;
                bPlay.dispatch("click", {});  // settle 已 play(paused=false)→ 此点击=暂停(mixer 须双停)
                if (!vid4._calls.includes("pause") || !twin4._calls.includes("pause")) fail("mixer pause 未双停(video:" + vid4._calls.join(",") + " twin:" + twin4._calls.join(",") + ")");
                vid4._calls.length = 0; twin4._calls.length = 0;
                bPlay.dispatch("click", {});  // 再点=播放(双起)
                if (!vid4._calls.includes("play") || !twin4._calls.includes("play")) fail("mixer play 未双起");
                bMute.dispatch("click", {});  // 手势解静音 → twin 翻 false,master 恒 true
                if (twin4.muted !== false) fail("mute 点击未解静音(twin.muted 应 false)");
                if (vid4.muted !== true) fail("twin 场景 master 须恒 muted(其 AAC 轨宿主零解码)");
                vid4.duration = 100; twin4.duration = 100;
                bSeek.value = "250"; bSeek.dispatch("input", {});  // seek → 双 currentTime
                if (vid4.currentTime !== 25 || twin4.currentTime !== 25) fail("mixer seek 未双写(vid=" + vid4.currentTime + " twin=" + twin4.currentTime + ")");
                twin4.currentTime = 1; vid4.dispatch("timeupdate", {});  // 漂移 24s → 主时钟校正
                if (Math.abs(twin4.currentTime - 25) > 0.01) fail("mixer 漂移校正失效(twin=" + twin4.currentTime + " 应回 25)");
                twin4.dispatch("error", {});  // 旁路死 → _mpDead 降级
                if (twin4._mpDead !== true) fail("twin error 未 _mpDead 降级");
                // --- 场景4b(0.5.37 🔴用户实测锚):拖进度条后 timeupdate 必须继续跟随 ---
                // 真机根因:原守卫 document.activeElement!==seek——拖拽使 range 得焦且松手不 blur(Playwright 实证:
                // 拖后 activeElement 恒=seek,模拟时间推进而 seekValue 冻结)→ timeupdate 永不覆写="拖到最开头后进度条不动"。
                // 桩曾无 activeElement 属性→旧守卫恒过=空转绿,本锚补真机失败模式+多通道复位语义。
                bSeek.value = "0"; bSeek.dispatch("input", {});  // 用户拖到最开头(scrubbing 置位)
                if (vid4.currentTime !== 0) fail("4b 前置:拖到最开头未落 currentTime(实得 " + vid4.currentTime + ")");
                vid4.currentTime = 5; vid4.dispatch("timeupdate", {});
                if (bSeek.value !== "0") fail("4b 拖中保护:input 后未松手,seek 不得被 timeupdate 覆写(实得 " + bSeek.value + ")");
                await new Promise(r => setTimeout(r, 170));  // 过去抖窗:仍拖中(未发 change)——闩锁是唯一防线(对抗终审🟡-1:杀"删 input 内置位"突变,该突变曾同 tick 逃过两闸)
                vid4.currentTime = 8; vid4.dispatch("timeupdate", {});
                if (bSeek.value !== "0") fail("4b 闩锁独立防线:拖中静止超过去抖窗,seek 仍不得被覆写(实得 " + bSeek.value + "——闩锁置位缺席)");
                bSeek.dispatch("input", {});  // 新一轮拖拽周期(commit 语义锚用干净 ts)
                vid4.currentTime = 10; vid4.dispatch("timeupdate", {});
                if (bSeek.value !== "0") fail("4b 拖中保护2:新周期 input 后 seek 被覆写(实得 " + bSeek.value + ")");
                vmDoc.activeElement = bSeek;  // 真机失败模式:松手后焦点恒留 range(旧代码在此之后永久冻结)
                bSeek.dispatch("change", {});  // 松手提交(seekEnd:解除+立即重同步)
                vid4.currentTime = 20; vid4.dispatch("timeupdate", {});
                if (bSeek.value !== "0") fail("4b 去抖窗:change 后 150ms 输入去抖窗内仍不覆写(键盘修磨保护,实得 " + bSeek.value + ")");
                await new Promise(r => setTimeout(r, 170));  // 过去抖窗(真机松手后首个 timeupdate≥250ms 本就窗外)
                vid4.currentTime = 40; vid4.dispatch("timeupdate", {});
                if (bSeek.value !== "400") fail("4b 🔴冻结回归:change(松手)+去抖窗外,timeupdate 须恢复覆写(实得 " + bSeek.value + "——焦点遗留下旧 activeElement 推断=永久冻结)");
                vid4.currentTime = 60; vid4.dispatch("timeupdate", {});
                if (bSeek.value !== "600") fail("4b 持续跟随:后续 timeupdate 未继续推进(实得 " + bSeek.value + ")");
                // 4c:change 丢失路径(HTML spec:拖回原值松手不发 change)→ pointerup 兜底通道
                bSeek.value = "100"; bSeek.dispatch("input", {});  // 再拖
                vid4.currentTime = 70; vid4.dispatch("timeupdate", {});
                if (bSeek.value !== "100") fail("4c 拖中保护:再拖中 seek 被覆写(实得 " + bSeek.value + ")");
                bSeek.dispatch("pointerup", {});  // change 不发(spec 级丢失路径)→ 元素级 pointerup 兜底(原生 range 隐式捕获)
                await new Promise(r => setTimeout(r, 170));
                vid4.currentTime = 80; vid4.dispatch("timeupdate", {});
                if (bSeek.value !== "800") fail("4c pointerup 兜底:change 丢失路径后未恢复跟随(实得 " + bSeek.value + ")");
                bSeek.dispatch("blur", {}); bSeek.dispatch("pointercancel", {});  // 其余兜底通道不抛
                vmDoc.activeElement = null;
                // --- 场景4d(0.5.38 首帧白闪):opacity 揭示闸——两周期确定性锚 ---
                // 机制:loadedmetadata(rs=1,零帧)即插入,首帧前 video 规范级完全透明→透弹窗底(用户实测起播白闪根因之一)。
                // 修=创建即 opacity:0;揭示三信号(rVFC 主[桩无该方法,归 gate7 文本钉+复刻实验]/loadeddata+双 rAF/500ms 兜底)幂等。
                // 周期A:悬停后 700ms(settle 经 600ms 兜底已跑,揭示兜底窗 500ms 只走了 100ms)→ 必仍 0;dispatch loadeddata→双 rAF(桩=setTimeout 0)→ 120ms 内(<500ms,排除兜底路径)必 1。
                // 周期B:再切走再悬 → 700ms 时必 0 → +600ms(过 500ms 兜底)必 1(兜底路径)。
                await hover(rowPng); await new Promise(r => setTimeout(r, 250));  // 切走关窗(渲染 image)
                await hover(rowMp4); await new Promise(r => setTimeout(r, 700));
                let vid4d = body._qs(body, "#mp-popup .mp-content video");
                if (!vid4d) fail("4d: 新周期 video 未落(settle 未跑通)");
                else {
                    if (vid4d.style.opacity !== "0") fail("4d 揭示闸:settle 后揭示前 opacity 须 0(实得 " + vid4d.style.opacity + "——无帧透明窗透底=起播白闪回归)");
                    vid4d.dispatch("loadeddata", {});
                    await new Promise(r => setTimeout(r, 120));
                    if (vid4d.style.opacity !== "1") fail("4d loadeddata 揭示:loadeddata+双 rAF 须置 1 且早于 500ms 兜底(实得 " + vid4d.style.opacity + ")");
                    await hover(rowPng); await new Promise(r => setTimeout(r, 250));
                    await hover(rowMp4); await new Promise(r => setTimeout(r, 700));
                    vid4d = body._qs(body, "#mp-popup .mp-content video");
                    if (!vid4d) fail("4d: 周期B video 未落");
                    else {
                        if (vid4d.style.opacity !== "0") fail("4d 周期B 揭示闸:兜底窗内仍须 0(实得 " + vid4d.style.opacity + ")");
                        await new Promise(r => setTimeout(r, 600));
                        if (vid4d.style.opacity !== "1") fail("4d 兜底揭示:rVFC 不触发(chromium#40239565 离屏坑)时 500ms 兜底须置 1(实得 " + vid4d.style.opacity + "——永久透明=永久空白弹窗)");
                    }
                }
                // --- 场景4e(0.5.38 终审🟡-1):rVFC 主揭示信号行为锚(桩补 requestVideoFrameCallback;此前该钉零行为兜底=注释包裹突变实测双绿存活) ---
                await hover(rowPng); await new Promise(r => setTimeout(r, 250));
                await hover(rowMp4); await new Promise(r => setTimeout(r, 700));
                let vid4e = body._qs(body, "#mp-popup .mp-content video");
                if (!vid4e) fail("4e: video 未落");
                else {
                    if (vid4e.style.opacity !== "0") fail("4e 揭示闸:rVFC 回调前须 0(实得 " + vid4e.style.opacity + ")");
                    if (!vid4e.__rvfcCbs || !vid4e.__rvfcCbs.length) fail("4e 注册缺失:settle 须在 play 前注册 rVFC(真机主揭示信号——注释包裹突变在此被行为杀)");
                    vid4e.__rvfcCbs.slice().forEach(function (cb) { cb({}); });  // 首帧回调(队列全发——reveal+noblur 双注册)
                    await new Promise(r => setTimeout(r, 30));
                    if (vid4e.style.opacity !== "1") fail("4e rVFC 揭示:首回调须置 1(实得 " + vid4e.style.opacity + ")");
                }
                // --- 场景4f(0.5.39 起播窗 no-blur):playing+首 rVFC 双确认挂 .mp-noblur,480ms 后摘 ---
                // 否定重查修锚:单确认(reveal 可在 paused t=0 触发)会把窗打在起播前=保护空拍;须干净新周期测。
                await hover(rowPng); await new Promise(r => setTimeout(r, 250));
                await hover(rowMp4); await new Promise(r => setTimeout(r, 700));
                {
                    const pop4f = byId.get("mp-popup") || body._qs(body, "#mp-popup");
                    const vid4f = body._qs(body, "#mp-popup .mp-content video");
                    if (!pop4f || !vid4f) fail("4f: popup/video 缺");
                    else {
                        if (!vid4f.__rvfcCbs || vid4f.__rvfcCbs.length < 2) fail("4f 双注册:settle 须注册 reveal+noblur 两个 rVFC 回调(实得 " + (vid4f.__rvfcCbs || []).length + ")");
                        vid4f.dispatch("playing", {});   // 先 playing(单确认)
                        if (pop4f._cls.has("mp-noblur")) fail("4f 单确认防护:仅 playing 不得挂 no-blur(窗会打在起播前=保护空拍)");
                        vid4f.__rvfcCbs.slice().forEach(function (cb) { cb({}); });  // 再首 rVFC → 双确认
                        if (!pop4f._cls.has("mp-noblur")) fail("4f 双确认挂窗:playing+首 rVFC 后须挂 .mp-noblur(起播合成风暴窗玻璃暂关)");
                        await new Promise(r => setTimeout(r, 560));  // 过 480ms 窗
                        if (pop4f._cls.has("mp-noblur")) fail("4f 摘窗:480ms 后须摘 .mp-noblur(玻璃经 background-color 300ms 渐回)");
                    }
                }
                // --- 场景4g(0.5.39 终审🔴-1 死锁逃逸口):480ms 窗内早退(hidePopup 换代)→类不得会话级滞留 ---
                await hover(rowPng); await new Promise(r => setTimeout(r, 250));
                await hover(rowMp4); await new Promise(r => setTimeout(r, 700));
                {
                    const pop4g = byId.get("mp-popup") || body._qs(body, "#mp-popup");
                    const vid4g = body._qs(body, "#mp-popup .mp-content video");
                    if (!pop4g || !vid4g) fail("4g: popup/video 缺");
                    else {
                        vid4g.dispatch("playing", {});
                        (vid4g.__rvfcCbs || []).slice().forEach(function (cb) { cb({}); });
                        if (!pop4g._cls.has("mp-noblur")) fail("4g 前置:双确认后须挂类");
                        const close4g = pop4g._qsa(pop4g, "button").find(b => b.className.includes("mp-close"));
                        if (!close4g) fail("4g: close 按钮缺");
                        else {
                            close4g.dispatch("click", { stopPropagation() {} });   // 480ms 窗内关闭(hidePopup+epoch 换代)
                            if (pop4g.style.display !== "none") fail("4g 前置:closeBtn 未隐藏 popup");
                            if (pop4g._cls.has("mp-noblur")) fail("4g 🔴死锁:hidePopup 须即清 mp-noblur(关闭漏斗双保险;off 模式除外)");
                            await new Promise(r => setTimeout(r, 600));  // 过 480ms timer(终审:原 ep 守卫在换代后拒摘=滞留)
                            if (pop4g._cls.has("mp-noblur")) fail("4g 🔴死锁:摘类 timer 不得带 ep 守卫(换代拒摘+重布防见类跳过=会话级永久滞留,殃及图片/音频全类型)");
                            await hover(rowPng); await new Promise(r => setTimeout(r, 450));  // 再悬图片:后续渲染不得被污染
                            const pop4g2 = byId.get("mp-popup") || body._qs(body, "#mp-popup");
                            if (pop4g2 && pop4g2._cls.has("mp-noblur")) fail("4g:再悬停后类残留(后续渲染被污染)");
                        }
                    }
                }
            }
        }
    }

    // --- 场景5(0.5.29):走廊守卫——指针在 popup↔源行缓冲走廊内不关浮窗;离开后正常关 ---
    await hover(rowPng);
    const popup5 = byId.get("mp-popup") || body._qs(body, "#mp-popup");
    if (popup5 && popup5.style.display !== "none") {
        (docLs.get("mousemove") || []).slice().forEach(fn => fn({ clientX: 200, clientY: 200 }));  // 指针进走廊(stub popup rect 100..500/100..400,+24 缓冲含 200,200)
        const mm5 = explorerRoot._listeners.get("mousemove");
        if (mm5 && mm5.length) mm5[mm5.length - 1]({ target: explorerRoot, clientX: 200, clientY: 200 });  // 非行区 mousemove → 计划关闭
        await pump(200, 200, 900);  // 0.5.33:通过中=移动指针(走廊点;>400ms 媒体延时+250ms 重查)
        if (popup5.style.display === "none") fail("走廊守卫失效:指针在走廊内浮窗被关(慢速移向控件条闪烁回归)");
        (docLs.get("mousemove") || []).slice().forEach(fn => fn({ clientX: 1500, clientY: 1500 }));  // 离开走廊
        if (mm5 && mm5.length) mm5[mm5.length - 1]({ target: explorerRoot, clientX: 1500, clientY: 1500 });
        await pump(1500, 1500, 700);  // 0.5.33:离开后(远点,移动也不保活)
        if (popup5.style.display !== "none") fail("离开走廊后未正常关闭(死悬窗)");
    }

    // --- 场景6(0.5.31):走廊缓冲带几何 + grace 阳性不关 + 音频隐藏分型 ---
    await hover(rowPng);
    const popup6 = byId.get("mp-popup") || body._qs(body, "#mp-popup");
    const img6 = popup6 && popup6._qs(popup6, ".mp-content img");
    if (img6 && popup6 && popup6.style.display !== "none") {
        // 6a 带内 popup 外点 (108,80) vs 带外 (60,60):用同构几何复算(overlay 内部判定不可直达)
        const band = (x, y) => x >= 76 && x <= 524 && y >= 76 && y <= 424;  // stub popup rect 100..500/100..400 ±24
        if (!band(108, 80) || band(60, 60)) fail("6a:走廊带几何复算自洽性破(改 stub rect 须同步)");
        // 6b grace 阳性:武装→指针回 popup(_hover=true)→过 650ms 不得关
        popup6.dispatch("wheel", { deltaY: -120, deltaMode: 0, ctrlKey: false, clientX: 200, clientY: 200, target: img6, preventDefault() {} });
        const zb6 = popup6._qsa(popup6, "button").find(b => b.className.includes("mp-zoomreset"));
        if (zb6 && img6._mpZoom) { (docLs.get("mousemove") || []).slice().forEach(fn => fn({ clientX: 200, clientY: 200 })); zb6.dispatch("click", { stopPropagation() {} }); }
        popup6._hover = true;
        await new Promise(r => setTimeout(r, 800));
        if (popup6.style.display === "none") fail("6b:grace 到期指针在 popup 内被误关(isMouseInPopup 阳性分支失效——Y5 盲区回归)");
        popup6._hover = false;
        (docLs.get("mousemove") || []).slice().forEach(fn => fn({ clientX: 60, clientY: 60 }));
        await new Promise(r => setTimeout(r, 800));  // hold 裁决→带外→关
    }
    // 6c(0.5.34 统一 200ms):移开→350ms 内必关(灵敏度行为锚;旧裙带+媒体 400 曾 650ms+)
    await hover(rowMp3);
    const popup6c = byId.get("mp-popup") || body._qs(body, "#mp-popup");
    (docLs.get("mousemove") || []).slice().forEach(fn => fn({ clientX: 1500, clientY: 1500 }));
    const mm6 = explorerRoot._listeners.get("mousemove");
    if (mm6 && mm6.length) mm6[mm6.length - 1]({ target: explorerRoot, clientX: 1500, clientY: 1500 });
    await new Promise(r => setTimeout(r, 350));
    if (popup6c.style.display !== "none") fail("6c:音频弹窗 350ms 未关(0.5.34 统一 200ms 灵敏度——裙带重挂或媒体 400 回流)");
    await new Promise(r => setTimeout(r, 450));
    if (popup6c.style.display !== "none") fail("6c:音频弹窗 750ms 仍未关(死悬窗)");

    // --- 场景7(0.5.32 🔴 用户实测回归):走廊外接包络巨舱——行下方包络内点必须关 ---
    // 0.5.29-0.5.31 走廊=两矩形外接包络(行0..300,0..22+popup312..712,34..334→760×382 巨舱),指针停舱内→250ms 链无限
    // 重挂→移出不关(rig6 复现+0.5.30 对照二分)。0.5.32 改三区并集(各扩24+间隙连接带)。双 rect 覆写复刻真实几何。
    await hover(rowPng);
    const popup7 = byId.get("mp-popup") || body._qs(body, "#mp-popup");
    if (popup7 && popup7.style.display !== "none") {
        rowPng.getBoundingClientRect = () => ({ left: 0, top: 0, right: 300, bottom: 22, width: 300, height: 22 });
        popup7.getBoundingClientRect = () => ({ left: 312, top: 34, right: 712, bottom: 334, width: 400, height: 300 });
        (docLs.get("mousemove") || []).slice().forEach(fn => fn({ clientX: 150, clientY: 320 }));
        const mm7 = explorerRoot._listeners.get("mousemove");
        if (mm7 && mm7.length) mm7[mm7.length - 1]({ target: explorerRoot, clientX: 150, clientY: 320 });
        await new Promise(r => setTimeout(r, 800));
        if (popup7.style.display !== "none") fail("7a:走廊包络回归——行下方包络内点未关(0.5.32 三区几何失效,用户'移出不关'重演)");
        await hover(rowPng); await new Promise(r => setTimeout(r, 500));
        const popup7b = byId.get("mp-popup") || body._qs(body, "#mp-popup");
        popup7b.getBoundingClientRect = () => ({ left: 312, top: 34, right: 712, bottom: 334, width: 400, height: 300 });
        rowPng.getBoundingClientRect = () => ({ left: 0, top: 0, right: 300, bottom: 22, width: 300, height: 22 });  // 0.5.36:显式行 rect(消 7a 泄漏耦合)
        (docLs.get("mousemove") || []).slice().forEach(fn => fn({ clientX: 310, clientY: 28 }));
        const mm7b = explorerRoot._listeners.get("mousemove");
        if (mm7b && mm7b.length) mm7b[mm7b.length - 1]({ target: explorerRoot, clientX: 310, clientY: 28 });
        await pump(310, 28, 800);  // 0.5.33:通过中=移动指针(连接带)
        if (popup7b.style.display === "none") fail("7b:连接带通过点被误关(走廊保活语义破坏)");
        // 7c(0.5.33 时间维):带内【静止】指针必关(真机 rig8 定案的用户 bug——移动中通过≠停驻)
        await hover(rowPng); await new Promise(r => setTimeout(r, 500));
        const popup7c = byId.get("mp-popup") || body._qs(body, "#mp-popup");
        popup7c.getBoundingClientRect = () => ({ left: 312, top: 34, right: 712, bottom: 334, width: 400, height: 300 });
        (docLs.get("mousemove") || []).slice().forEach(fn => fn({ clientX: 290, clientY: 50 }));  // 垂直连接带内点(290,50:行带 y>46 外/横连带 y>46 外/竖连带 xOv[288,324]×yGap[-2,58] 内)
        const mm7c = explorerRoot._listeners.get("mousemove");
        if (mm7c && mm7c.length) mm7c[mm7c.length - 1]({ target: explorerRoot, clientX: 290, clientY: 50 });
        await new Promise(r => setTimeout(r, 1100));  // 静止 >500ms
        if (popup7c.style.display !== "none") fail("7c:带内静止指针未关(时间维缺失——用户'移出后一直保持'重演)");
        // 7d(0.5.36 裙带行为锚):浮窗裙带区持续移动必关——(730,300) 在 popup±24 裙内(712+24=736)但行带/连接带皆外;
        //   裙带或 hull 回归(0.5.32/0.5.34 头条语义)会在此点保活。改名回流(var skirt=r)同样被此行为锚捕获。
        await hover(rowPng); await new Promise(r => setTimeout(r, 500));
        const popup7d = byId.get("mp-popup") || body._qs(body, "#mp-popup");
        rowPng.getBoundingClientRect = () => ({ left: 0, top: 0, right: 300, bottom: 22, width: 300, height: 22 });
        popup7d.getBoundingClientRect = () => ({ left: 312, top: 34, right: 712, bottom: 334, width: 400, height: 300 });
        (docLs.get("mousemove") || []).slice().forEach(fn => fn({ clientX: 730, clientY: 300 }));
        const mm7d = explorerRoot._listeners.get("mousemove");
        if (mm7d && mm7d.length) mm7d[mm7d.length - 1]({ target: explorerRoot, clientX: 730, clientY: 300 });
        await pump(730, 300, 800);  // 持续移动(排除时间维干扰,专测空间几何)
        if (popup7d.style.display !== "none") fail("7d:裙带/hull 回归——裙带区持续移动仍保活(0.5.34 灵敏度语义被破坏)");
        // 7e(0.5.36 连接带行为锚):(330,30) 是纯连接带点(x>行带右 324,y<46;横连带[276,336]×[10,46] 内)——移动中必活;
        //   删除连接带代码(verify M8 幸存者)会在此点误关。
        await hover(rowPng); await new Promise(r => setTimeout(r, 500));
        const popup7e = byId.get("mp-popup") || body._qs(body, "#mp-popup");
        rowPng.getBoundingClientRect = () => ({ left: 0, top: 0, right: 300, bottom: 22, width: 300, height: 22 });
        popup7e.getBoundingClientRect = () => ({ left: 312, top: 34, right: 712, bottom: 334, width: 400, height: 300 });
        (docLs.get("mousemove") || []).slice().forEach(fn => fn({ clientX: 330, clientY: 30 }));
        const mm7e = explorerRoot._listeners.get("mousemove");
        if (mm7e && mm7e.length) mm7e[mm7e.length - 1]({ target: explorerRoot, clientX: 330, clientY: 30 });
        await pump(330, 30, 800);
        if (popup7e.style.display === "none") fail("7e:连接带失效——纯间隙点移动中被误关(行↔浮窗通过保护破坏=闪烁回归)");
        // 7f(0.5.36 hull 行为锚):(600,350) 在 hull 包络内(x≤736,y≤358)但三区皆外——持续移动必关;
        //   hull 回退(verify M5 幸存者)会在此点保活。
        await hover(rowPng); await new Promise(r => setTimeout(r, 500));
        const popup7f = byId.get("mp-popup") || body._qs(body, "#mp-popup");
        rowPng.getBoundingClientRect = () => ({ left: 0, top: 0, right: 300, bottom: 22, width: 300, height: 22 });
        popup7f.getBoundingClientRect = () => ({ left: 312, top: 34, right: 712, bottom: 334, width: 400, height: 300 });
        (docLs.get("mousemove") || []).slice().forEach(fn => fn({ clientX: 600, clientY: 350 }));
        const mm7f = explorerRoot._listeners.get("mousemove");
        if (mm7f && mm7f.length) mm7f[mm7f.length - 1]({ target: explorerRoot, clientX: 600, clientY: 350 });
        await pump(600, 350, 800);
        if (popup7f.style.display !== "none") fail("7f:hull 包络回归——包络空白区持续移动仍保活(0.5.32 移出不关重演)");
    }
    // --- 场景8(0.5.35):持续移动中必关——防抖重置行为锚 ---
    await hover(rowPng);
    const popup8 = byId.get("mp-popup") || body._qs(body, "#mp-popup");
    const mm8 = explorerRoot._listeners.get("mousemove");
    const t8 = Date.now();
    while (Date.now() - t8 < 600 && popup8.style.display !== "none") {
        (docLs.get("mousemove") || []).slice().forEach(fn => fn({ clientX: 1500, clientY: 800 + (Date.now() % 2 ? 1 : -1) }));
        if (mm8 && mm8.length) mm8[mm8.length - 1]({ target: explorerRoot, clientX: 1500, clientY: 800 + (Date.now() % 2 ? 1 : -1) });
        await new Promise(r => setTimeout(r, 80));
    }
    if (popup8.style.display !== "none") fail("8:持续移动中未关(防抖重置回归——关闭被推迟到停手后)");
    if (Date.now() - t8 > 500) fail("8:关闭过慢(" + (Date.now() - t8) + "ms,应≈200+泵周期;防抖残留在拖)");
console.log("    场景: mp-mb play/pause 驱动 + mute 手势解静音 + seek 写入 ✓");
}

await scenario();
if (fails) { console.error(`\nFAIL: test-overlay-renderer（${fails} 处——renderer 执行层回归）`); process.exit(1); }
console.log("OK: test-overlay-renderer（IIFE 真跑:closeBtn 无 R1 类作用域崩溃 + 媒体 dispose pause+断src + hover 全链）");
process.exit(0);
