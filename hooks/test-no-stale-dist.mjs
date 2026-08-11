// test-no-stale-dist：构建产物清洁闸门(03 §1.7 项3 artifact hygiene)。
// 每个 dist/*.js 须有对应 src/*.ts——防 stale 产物随 npm publish / vsce package 发布。
// 📕 起源:0.5.12 审查发现 dist/restart.js + companion/dist/fileIndex.js 的源 .ts 早已删除,但 .js 仍残留且被 package.json files 数组随包发布,下游困惑 + 膨胀。
import { readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const base = fileURLToPath(new URL("../", import.meta.url));
let fails = 0;
const fail = (m) => { console.error("  FAIL:", m); fails++; };

function checkDir(distDir, srcDir, label) {
    if (!existsSync(distDir)) return;  // 未 build(无 dist)→ 跳过(无 stale 可查)
    for (const f of readdirSync(distDir)) {
        if (!f.endsWith(".js")) continue;
        const ts = join(srcDir, f.replace(/\.js$/, ".ts"));
        if (!existsSync(ts)) fail(`${label}/${f} 无对应源 ${ts.replace(base, "")}(stale 构建产物,源 .ts 已删但 .js 残留)`);
    }
}
checkDir(join(base, "dist"), join(base, "src"), "dist");
checkDir(join(base, "companion", "dist"), join(base, "companion", "src"), "companion/dist");

if (fails) { console.error(`\nFAIL: test-no-stale-dist（${fails} 处 stale 构建产物——rm 之或恢复源 .ts）`); process.exit(1); }
console.log("OK: test-no-stale-dist（dist/*.js 均有 src/*.ts 对应,无 stale 构建产物）");
