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
const VAR2TYPE = { IMAGE: "image", VIDEO: "video", AUDIO: "audio", FONT: "font", PDF: "pdf", MODEL3D: "3d" };
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
const OUR_STATE = new Set(["is-pinned", "rail-left"]);  // 非 mp- 前缀的自定义状态类
for (const c of jsRefClasses) {
    if (!c.startsWith("mp-") && !OUR_STATE.has(c)) continue;  // 跳过外部 VSCode class（explorer-viewlet/monaco-*/part.sidebar）
    if (!cssClasses.has(c)) fail(`JS 行为引用 class ".${c}" 在 CSS 块无对应规则（typo 或漏 CSS）`);
}

if (fails) { console.error(`\nFAIL: test-contract-sync（${fails} 处跨边界同步失配）`); process.exit(1); }
console.log("OK: test-contract-sync（per-type exts + port + marker + 3D-loader + CSS-class 全同步）");
