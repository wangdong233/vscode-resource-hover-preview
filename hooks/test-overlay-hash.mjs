// overlay bake hash 稳定性 + assertCompiles（v0.1审查🔴修：vacuous green → 能失败的断言）。
// 详见 doc/07 + cc-status-dot test-overlay-hash 范式。
import { buildOverlayJs } from "../dist/overlay-bake.js";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const template = readFileSync(fileURLToPath(new URL("../resources/overlay.template.js", import.meta.url)), "utf8");
const a = buildOverlayJs(template, "v0.1.0");
const b = buildOverlayJs(template, "v0.1.0");
let fail = 0;

// 断言1：bake 稳定（同输入同输出，CI 闸门）
if (a.js !== b.js) { console.error("FAIL: bake 不稳定（同输入不同输出）"); fail = 1; }
// 断言2：banner 含 version
if (!a.js.startsWith("/*mp-overlay:v0.1.0:")) { console.error("FAIL: banner 缺 version"); fail = 1; }
// 断言3：hash 8 位 hex
if (!/^[0-9a-f]{8}$/.test(a.hash)) { console.error("FAIL: hash 非 8 位 hex（实际 " + a.hash + "）"); fail = 1; }
// 断言4：assertCompiles（overlay.js 语法正确）
const tmp = fileURLToPath(new URL("../dist/.test-overlay.tmp.js", import.meta.url));
writeFileSync(tmp, a.js);
const r = spawnSync("node", ["--check", tmp]);
if (r.status !== 0) { console.error("FAIL: overlay.js 语法错\n" + r.stderr); fail = 1; }
try { unlinkSync(tmp); } catch { /* ignore */ }

if (fail) process.exit(1);
console.log("OK: test-overlay-hash（bake 稳定 + banner + hash 8hex + assertCompiles）");
