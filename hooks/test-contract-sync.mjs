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
console.log("[1/4] overlay *_EXTS ↔ server TYPE_TABLE per-type ...");
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
console.log("[2/4] patcher bake port ↔ server BASE_PORT ...");
const bakePort = patcher.match(/port:\s*(\d+)/);
const serverPort = server.match(/BASE_PORT\s*=\s*(\d+)/);
if (!bakePort || !serverPort) fail("port 字面量未抽到");
else if (bakePort[1] !== serverPort[1]) fail(`port 不同步：patcher bake=${bakePort[1]} ≠ server BASE_PORT=${serverPort[1]}`);

// ③ 结果 marker 同源（patcher emit ↔ extension match）
console.log("[3/4] 结果 marker 同源（patcher emit ↔ extension match）...");
const MARKER = "[mp-result] patched=";
if (!patcher.includes("`" + MARKER + "${")) fail(`patcher 未 emit marker "${MARKER}"`);
if (!extension.includes('"' + MARKER + 'true"')) fail(`extension 未 match marker "${MARKER}true"`);

// ④ 3D loader 能力 ↔ MODEL3D_EXTS
console.log("[4/4] MODEL3D_EXTS ↔ entry-three.js Loader 能力 ...");
const EXT2LOADER = { glb: "GLTFLoader", gltf: "GLTFLoader", obj: "OBJLoader", stl: "STLLoader", fbx: "FBXLoader" };
const modelExts = extractArr(overlay, /var MODEL3D_EXTS\s*=\s*\[([^\]]+)\]/) || [];
for (const ext of modelExts) {
    const loader = EXT2LOADER[ext];
    if (!loader) { fail(`MODEL3D_EXTS 含 "${ext}" 无 loader 映射（补 EXT2LOADER）`); continue; }
    if (entryThree && !new RegExp(`\\b${loader}\\b`).test(entryThree)) fail(`MODEL3D_EXTS 含 "${ext}" 需 ${loader}，但 entry-three.js 未 import`);
}

if (fails) { console.error(`\nFAIL: test-contract-sync（${fails} 处跨边界同步失配）`); process.exit(1); }
console.log("OK: test-contract-sync（per-type exts + port + marker + 3D-loader 全同步）");
