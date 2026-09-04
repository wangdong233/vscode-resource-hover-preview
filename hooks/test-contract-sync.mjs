// test-contract-sync：跨边界同步闸门（03 §1.7 项7 可机械化对）。
// ① overlay *_EXTS ↔ server TYPE_TABLE per-type deep-equal（审查 3.5：原并集等价放过 mp4 挪组错位）
// ② patcher bake port ↔ server BASE_PORT 字面量相等（审查 3.7/6.2）
// ③ patcher 结果 marker ↔ extension 匹配串 同源（审查 3.4/6.3：原 includes("VSCode: patched") flavor 耦合）
// ④ MODEL3D_EXTS ↔ entry-three.js Loader import 能力（审查 6.4：防声称格式无 loader 抛晦涩错）
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const base = fileURLToPath(new URL("../", import.meta.url));
const overlay = readFileSync(base + "resources/overlay.template.js", "utf8");
const server = readFileSync(base + "companion/src/server.ts", "utf8");
const patcher = readFileSync(base + "src/patcher.ts", "utf8");
const extension = readFileSync(base + "companion/src/extension.ts", "utf8");
const entryThree = existsSync(base + "entry-three.js") ? readFileSync(base + "entry-three.js", "utf8") : "";

function extractArr(src, re) { const m = src.match(re); return m ? (m[1].match(/"([^"]+)"/g) || []).map(x => x.replace(/"/g, "")) : null; }

// overlay var 名 → server type key
const VAR2TYPE = { IMAGE: "image", VIDEO: "video", AUDIO: "audio", FONT: "font", MODEL3D: "3d" };  // 0.4.5：PDF 删除
let fails = 0;
const fail = (m) => { console.error("  FAIL:", m); fails++; };

// ① per-type deep-equal
console.log("[1/5] overlay *_EXTS ↔ server TYPE_TABLE per-type ...");
const ttBlock = server.match(/TYPE_TABLE[^=]*=\s*\{([\s\S]*?)\n\};/)[1];
for (const [vname, type] of Object.entries(VAR2TYPE)) {
    const ov = extractArr(overlay, new RegExp(`var ${vname}_EXTS\\s*=\\s*\\[([^\\]]+)\\]`));
    // server key 可带引号（"3d"）也可不带（image）→ "? 匹配两侧
    const sv = extractArr(ttBlock, new RegExp(`"?${type}"?:\\s*\\{[^}]*exts:\\s*\\[([^\\]]+)\\]`));
    if (!ov) { fail(`${vname}_EXTS overlay 未找到`); continue; }
    if (!sv) { fail(`TYPE_TABLE.${type} server 未找到`); continue; }
    if (ov.join(",") !== sv.join(",")) fail(`${type}: overlay=[${ov}] ≠ server=[${sv}]（per-type 分组错位）`);
}

// ② port 字面量同步
console.log("[2/5] patcher bake port ↔ server BASE_PORT ...");
const bakePort = patcher.match(/port:\s*(\d+)/);
const serverPort = server.match(/BASE_PORT\s*=\s*(\d+)/);
if (!bakePort || !serverPort) fail("port 字面量未抽到");
else if (bakePort[1] !== serverPort[1]) fail(`port 不同步：patcher bake=${bakePort[1]} ≠ server BASE_PORT=${serverPort[1]}`);

// ③ 结果 marker 同源（patcher emit ↔ extension match）
console.log("[3/5] 结果 marker 同源（patcher emit ↔ extension match）...");
const MARKER = "[mp-result] patched=";
if (!patcher.includes("`" + MARKER + "${")) fail(`patcher 未 emit marker "${MARKER}"`);
if (!extension.includes('"' + MARKER + 'true"')) fail(`extension 未 match marker "${MARKER}true"`);

// ④ 3D loader 能力 ↔ MODEL3D_EXTS
console.log("[4/5] MODEL3D_EXTS ↔ entry-three.js Loader 能力 ...");
const EXT2LOADER = { glb: "GLTFLoader", gltf: "GLTFLoader", obj: "OBJLoader", stl: "STLLoader", fbx: "FBXLoader" };
const modelExts = extractArr(overlay, /var MODEL3D_EXTS\s*=\s*\[([^\]]+)\]/) || [];
for (const ext of modelExts) {
    const loader = EXT2LOADER[ext];
    if (!loader) { fail(`MODEL3D_EXTS 含 "${ext}" 无 loader 映射（补 EXT2LOADER）`); continue; }
    if (entryThree && !new RegExp(`\\b${loader}\\b`).test(entryThree)) fail(`MODEL3D_EXTS 含 "${ext}" 需 ${loader}，但 entry-three.js 未 import`);
}

// ⑤ CSS class ↔ JS 引用同步（复审 rev3：Wave2 样式重构新引入 .mp-rail/.mp-fname/.is-pinned/.rail-left，
//   classList.toggle/querySelector 行为引用的类必须在 CSS 块有对应规则，防 typo 致样式静默失效）
console.log("[5/5] CSS class ↔ JS 行为引用同步 ...");
const cssBlock = overlay.match(/style\.textContent\s*=\s*\[([\s\S]*?)\]\.join/)?.[1] || "";
const cssClasses = new Set([...cssBlock.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]));
const jsRefClasses = new Set();
for (const m of overlay.matchAll(/classList\.(?:toggle|add|remove|contains)\(["']([^"']+)["']\)/g)) jsRefClasses.add(m[1]);
for (const m of overlay.matchAll(/querySelector(?:All)?\(["']\.([^.#[\s"']+)["']\)/g)) jsRefClasses.add(m[1]);
const OUR_STATE = new Set(["is-pinned", "is-dragging", "is-panning", "img-zoomed", "rail-left"]);  // 0.5.23复审🟡-3:补 is-panning/img-zoomed(0.5.13 H-1 陷阱重演:闸门⑤对白名单外 continue 跳过)  // 非 mp- 前缀的自定义状态类(0.5.13 复审 H-1:补 is-dragging,否则 CSS-class 闸门⑤对其 continue 跳过→失效)
for (const c of jsRefClasses) {
    if (!c.startsWith("mp-") && !OUR_STATE.has(c)) continue;  // 跳过外部 VSCode class（explorer-viewlet/monaco-*/part.sidebar）
    if (!cssClasses.has(c)) fail(`JS 行为引用 class ".${c}" 在 CSS 块无对应规则（typo 或漏 CSS）`);
}

// ⑥ await fetch().X() 优先级 bug 守门（复审 revTest 🔴：`await fetch(url).arrayBuffer()` 中 .arrayBuffer 调在 Promise 上非 Response → TypeError；
//   正确写法 `await (await fetch(url)).arrayBuffer()` 或 `.then(r=>r.X())`。此静态闸门防 font/pdf/3d 全坏类回归）
console.log("[6/6] await fetch().X() 优先级 bug 守门 ...");
const badFetch = overlay.match(/await\s+fetch\([^)]*\)\.(arrayBuffer|text|json|blob)\s*\(/g);
if (badFetch) for (const b of badFetch) fail(`await fetch().X() 优先级 bug（应 await (await fetch()).X() 或 .then）：${b}`);

// ⑦ NATIVE_VIDEO/NATIVE_AUDIO ⊆ *_EXTS（0.5.12:防死分支——原 NATIVE_VIDEO 含 ogg,但 detectMediaType 路由 .ogg→audio,AUDIO 优先 → NATIVE_VIDEO 的 ogg 永不生效=死分支）
console.log("[7/7] NATIVE_VIDEO/AUDIO ⊆ *_EXTS(防死分支) ...");
const nativeVideo = extractArr(overlay, /var NATIVE_VIDEO\s*=\s*\[([^\]]+)\]/) || [];
const nativeAudio = extractArr(overlay, /var NATIVE_AUDIO\s*=\s*\[([^\]]+)\]/) || [];
const videoExts7 = extractArr(overlay, /var VIDEO_EXTS\s*=\s*\[([^\]]+)\]/) || [];
const audioExts7 = extractArr(overlay, /var AUDIO_EXTS\s*=\s*\[([^\]]+)\]/) || [];
for (const e of nativeVideo) if (!videoExts7.includes(e)) fail(`NATIVE_VIDEO 含 "${e}" ∉ VIDEO_EXTS → 死分支(detectMediaType 不路由 .${e}→video)`);
for (const e of nativeAudio) if (!audioExts7.includes(e)) fail(`NATIVE_AUDIO 含 "${e}" ∉ AUDIO_EXTS → 死分支`);

// ⑧ 图片滚轮缩放契约(0.5.16复审🟡-2:本特性此前仅 node --check 语法覆盖;passive/门序/transform 序/复位配对/触底复位 全零断言——
//   最现实高危 mutation 是 passive:false→true(DevTools"顺手优化"即中招,现象=缩放仍发生但 explorer 同步滚动+整窗缩放并发))
console.log("[8/8] 图片滚轮缩放契约(passive:false + 门序 + transform 序 + 复位配对 + 触底复位)...");
const wheelBlockM = overlay.match(/popup\.addEventListener\("wheel", function \(e\) \{[\s\S]*?\}, \{ passive: false \}\);/);
if (!wheelBlockM) fail('wheel 监听块未找到或非 {passive:false}(passive:true → preventDefault 静默失效)');
else {
    const wb = wheelBlockM[0];
    const pdIdx = wb.indexOf("e.preventDefault()");
    if (pdIdx < 0) fail("wheel 块内 preventDefault 缺失");
    for (const gate of ['activeRendererType !== "image"', "isDragging || isPanning || editing", "closest(ZOOM_SKIP)", "img.naturalWidth"]) {
        const gi = wb.indexOf(gate);
        if (gi < 0 || gi > pdIdx) fail(`wheel 门「${gate}」缺失或位于 preventDefault 之后(门序=保 3D/video 原生 wheel)`);
    }
    if (!/applyImgZoom\(img\);/.test(wb)) fail("wheel 未走 applyImgZoom(0.5.22 transform 单写者,与 pan 共用)");
    const azM = overlay.match(/function applyImgZoom\(img\) \{[\s\S]*?\n    \}/);
    if (!azM || !/transform = "translate\(" \+ z\.tx[\s\S]{0,80}scale\(" \+ z\.s/.test(azM[0])) fail("applyImgZoom 内 transform 序错(须 translate 在 scale 前——光标锚定数学依赖)");
    if (!/sNext === 1\)[\s\S]{0,120}resetImageZoom\(/.test(wb)) fail("触底复位缺失(缩回 s=1 时 tx 残留→100% 图偏移且此后 wheel 永久 no-op)");
}
// 复位配对:dblclick / resetToDefaultSize / resize pointerdown / resize onUp 四处须调 resetImageZoom
if (!/addEventListener\("dblclick"[\s\S]{0,400}resetImageZoom\(/.test(overlay)) fail("dblclick 未调 resetImageZoom");
if (!/function resetToDefaultSize\(\)[\s\S]{0,200}resetImageZoom\(popup\)/.test(overlay)) fail("resetToDefaultSize 未调 resetImageZoom(窗复位图仍放大=状态分裂)");
if (!/e\.preventDefault\(\); e\.stopPropagation\(\);[\s\S]{0,150}resetImageZoom\(popup\)/.test(overlay)) fail("resize pointerdown 未调 resetImageZoom(tx/ty px 锚点随布局变即失真)");
if (!/savePopupSize\(popup\.offsetWidth, popup\.offsetHeight\);[\s\S]{0,150}resetImageZoom\(popup\)/.test(overlay)) fail("resize onUp 未调 resetImageZoom(拖角+滚动并发竞态残留)");

if (fails) { console.error(`\nFAIL: test-contract-sync（${fails} 处跨边界同步失配）`); process.exit(1); }
// 0.5.31 Y2:overlay↔zoom-sim 常量同步对(0.5.25 曾漂移:PINCH 0.0015→0.01 改了 overlay 忘 sim,03 §1.7 项7 实锤)
const ovSrc2 = readFileSync(base + "resources/overlay.template.js", "utf8");
// 0.5.31 F4:AAC 家族事实互检(overlay TWIN_NEEDED+renderAudio 分支 ↔ extension prewarm glob——三源曾无互检,扩家族静默漂移)
const twinM = ovSrc2.match(/var TWIN_NEEDED = \[([^\]]+)\];/);
const globM = readFileSync(base + "companion/src/extension.ts", "utf8").match(/findFiles\("\*\*\/\*\.{([^}]+)}"/);
const twinSet = new Set((twinM ? twinM[1] : "").split(",").map(x => x.trim().replace(/"/g, "")).filter(Boolean));
const globSet = new Set((globM ? globM[1] : "").split(",").map(x => x.trim()).filter(Boolean));
for (const ext of twinSet) if (!globSet.has(ext)) fail("F4: TWIN_NEEDED 含 " + ext + " 而 prewarm glob 不含(旁路家族漂移)");
for (const ext of globSet) if (!twinSet.has(ext) && ext !== "m4a" && ext !== "aac") fail("F4: prewarm glob 含 " + ext + " 而 TWIN_NEEDED 不含(m4a/aac 例外=音频文件主源)");
const simSrc2 = readFileSync(base + "hooks/zoom-invariant-sim.reference.js", "utf8");
for (const cnst of ["ZOOM_MAX", "ZOOM_K", "ZOOM_K_PINCH", "ZOOM_STEP_PINCH", "ZOOM_DY_MAX"]) {
    const rx = new RegExp(cnst + " = ([0-9.]+)");
    const a = ovSrc2.match(rx), b2 = simSrc2.match(rx);
    if (!a || !b2 || a[1] !== b2[1]) fail(cnst + " overlay(" + (a && a[1]) + ") ↔ sim(" + (b2 && b2[1]) + ") 漂移——§1.7 项7 同步对");
}
// 0.5.29c 🟡-4:root↔companion 版本等值(曾漂移 5 版——重装 vsix 即回退)
const rootV = JSON.parse(readFileSync(base + "package.json", "utf8")).version;
const compV = JSON.parse(readFileSync(base + "companion/package.json", "utf8")).version;
if (rootV !== compV) fail("root(" + rootV + ") ↔ companion(" + compV + ") 版本漂移——升级路径会整目录替换回旧版");
console.log("OK: test-contract-sync（per-type exts + port + marker + 3D-loader + CSS-class + fetch优先级 + NATIVE⊆EXTS 全同步）");