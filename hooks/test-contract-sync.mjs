// test-contract-sync：overlay EXTS === server TYPE_TABLE exts（R-INT-02 单源闸门，v0.2-v0.5审查🟡）
// 防止新增扩展名只改一边（overlay 硬编码 vs server TYPE_TABLE 双真相源分叉）
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const overlay = readFileSync(fileURLToPath(new URL("../resources/overlay.template.js", import.meta.url)), "utf8");
const server = readFileSync(fileURLToPath(new URL("../companion/src/server.ts", import.meta.url)), "utf8");

// 提取 overlay 所有 *_EXTS 数组
const overlayExts = new Set();
const extRe = /var (\w+)_EXTS\s*=\s*\[([^\]]+)\]/g;
let m;
while ((m = extRe.exec(overlay))) {
    m[2].match(/"([^"]+)"/g)?.forEach(x => overlayExts.add(x.replace(/"/g, "")));
}

// 提取 server TYPE_TABLE 所有 exts 数组
const serverExts = new Set();
const ttMatches = server.match(/exts:\s*\[([^\]]+)\]/g);
ttMatches?.forEach(s => {
    s.match(/"([^"]+)"/g)?.forEach(x => serverExts.add(x.replace(/"/g, "")));
});

const missingInOverlay = [...serverExts].filter(x => !overlayExts.has(x));
const missingInServer = [...overlayExts].filter(x => !serverExts.has(x));
if (missingInOverlay.length || missingInServer.length) {
    console.error("FAIL: overlay EXTS vs server TYPE_TABLE 不一致（R-INT-02 双真相源分叉）");
    if (missingInOverlay.length) console.error("  server 有 overlay 无:", missingInOverlay.join(","));
    if (missingInServer.length) console.error("  overlay 有 server 无:", missingInServer.join(","));
    process.exit(1);
}
console.log("OK: test-contract-sync（overlay EXTS === server TYPE_TABLE，" + overlayExts.size + " exts 同步）");
