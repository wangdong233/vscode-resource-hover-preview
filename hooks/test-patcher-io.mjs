// test-patcher-io：patcher 三态 IO + checksum 顺序回归闸门（审查 2.3，原 vacuous 空壳已补真断言）。
// 真 fixture（/tmp 仿 app 目录：workbench.html + product.json checksums + out/）+ spawn dist/patcher.js
//   （MP_TEST_APPDIR / MP_TEST_INSTALL_DIR 两 seam，discover/locateInstallDir 跳过真实 VSCode）。
// 断言：absent→patch / fresh→no-op byte-identical / stale→re-patch / checksums[wbKey]===recompute / revert 还原 pristine。
// mutation：对调 writeAtomicSync(workbench) 与 patchProductChecksums 顺序 → checksum 断言必红（顺序关键 bug 守门）。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PATCHER = join(ROOT, "dist", "patcher.js");
if (!existsSync(PATCHER)) { console.warn("[test-patcher-io] SKIP: dist/patcher.js 不存在（先 npm run build）"); process.exit(0); }

const INJECT_VER = readFileSync(join(ROOT, "src", "patcher-state.ts"), "utf8").match(/INJECT_VERSION = "(v[\d.]+)"/)[1];
const WB_REL = "vs/code/electron-browser/workbench/workbench.html";  // discover seam 首位候选（discover.ts WORKBENCH_CANDIDATES[0]）
const WB_SEGS = WB_REL.split("/");
const recompute = (p) => createHash("sha256").update(readFileSync(p)).digest("base64").replace(/=+$/, "");
let fails = 0;
const fail = (m) => { console.error("  FAIL:", m); fails++; };

function setup() {
    const app = mkdtempSync(join(tmpdir(), "mp-app-"));
    const install = mkdtempSync(join(tmpdir(), "mp-install-"));
    const outDir = join(app, "out");
    mkdirSync(join(outDir, ...WB_SEGS.slice(0, -1)), { recursive: true });
    const wb = join(outDir, ...WB_SEGS);
    writeFileSync(wb, `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data: blob:; media-src https:; script-src 'self' blob:; style-src 'self' 'unsafe-inline';"></head><body></body></html>`);
    writeFileSync(join(app, "product.json"), JSON.stringify({ version: "1.129.1-test", checksums: { [WB_REL]: "STALE" } }));
    // 0.5.10: 主进程 autoplay 补丁 fixture（package.json main 字段 = 源真相 + pristine main.js）
    writeFileSync(join(app, "package.json"), JSON.stringify({ main: "./out/main.js" }));
    const mainJs = join(outDir, "main.js");
    writeFileSync(mainJs, `"use strict";\n// VSCode main bootstrap (fixture)\nconsole.log("main");\n`);
    const pristineMain = readFileSync(mainJs);  // 字节级还原基准
    writeFileSync(join(install, "mp-overlay.js"), `/*mp-overlay:${INJECT_VER}:abcdef12*/\nconsole.log("test");`);  // 合法 banner（detectAndPatch 提取 8hex hash）
    writeFileSync(join(install, "mp-token.json"), JSON.stringify({ token: "testtoken" }));
    return { app, install, wb, mainJs, pristineMain };
}
function runPatcher(app, install, args = ["--patch-only"]) {
    const r = spawnSync(process.execPath, [PATCHER, ...args], {
        env: { ...process.env, MP_TEST_APPDIR: app, MP_TEST_INSTALL_DIR: install, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8",
    });
    return (r.stdout || "") + (r.stderr || "");
}

// [1] absent → patched + checksum 顺序
console.log("[1/3] absent → patched + checksums[wbKey]===recompute ...");
const { app, install, wb, mainJs, pristineMain } = setup();
runPatcher(app, install);
let wbContent = readFileSync(wb, "utf8");
if (!wbContent.includes(`<!--mp-injected:${INJECT_VER}:`)) fail("absent→patch 后 marker 缺失");
// 0.5.11: main.js 不再注入 autoplay(特性废弃)→ 应保持 pristine 无 marker
const mainContent = readFileSync(mainJs, "utf8");
if (mainContent.includes("mp-main-injected")) fail("main.js 不应含 autoplay marker（0.5.11 废弃注入,应 pristine）");
// 清理 strip 守门:伪造 0.5.10 残留 marker → 重跑 patcher → 应被 strip 字节还原(迁移已 patch 机器)
writeFileSync(mainJs, `/*!mp-main-injected:v0.28.3*/\ntry{require("electron").app.commandLine.appendSwitch("autoplay-policy","no-user-gesture-required");}catch(e){}\n/*!/mp-main-injected*/\n` + mainContent);
runPatcher(app, install);
if (readFileSync(mainJs, "utf8").includes("mp-main-injected")) fail("main.js 残留 autoplay marker 未被 strip 清理");
if (!pristineMain.equals(readFileSync(mainJs))) fail("main.js 清理后非 byte-identical 于 pristine（strip 应字节级还原）");
const product = JSON.parse(readFileSync(join(app, "product.json"), "utf8"));
if (product.checksums[WB_REL] !== recompute(wb)) fail(`checksum 不匹配：product=${product.checksums[WB_REL]} ≠ recompute=${recompute(wb)}（★ 顺序 bug：checksum 必须在 workbench 写盘后算）`);
// ★ token 一致性守门（2026-08-09 真机 403 回归根因）：mp-config.js（overlay 读）的 token 必须等于
//   mp-token.json（server 读）——否则全类型 preview fetch 403。detectAndPatch 必须用 locateInstallDir 的同源 token bake。
const tokenJson = JSON.parse(readFileSync(join(install, "mp-token.json"), "utf8")).token;
const mpConfig = readFileSync(join(app, "out", "vs", "code", "electron-browser", "workbench", "mp-config.js"), "utf8");
if (!mpConfig.includes(`"token":"${tokenJson}"`)) fail(`mp-config token ≠ mp-token.json token（overlay/server token 分叉 → 403）：mp-config 未含 token ${tokenJson.slice(0, 8)}…`);

// [2] fresh → no-op byte-identical
console.log("[2/3] fresh → no-op byte-identical（marker 版本匹配则不重写）...");
const before = readFileSync(wb);
const mainBefore = readFileSync(mainJs);
runPatcher(app, install);
const after = readFileSync(wb);
if (!before.equals(after)) fail("fresh 重跑 workbench.html 非 byte-identical（fresh 应 no-op，仅 bake mp-config 不碰 workbench）");
if (!mainBefore.equals(readFileSync(mainJs))) fail("fresh 重跑 main.js 非 byte-identical（stripMainAutoplay 干净后应 no-op）");

// [3] stale → re-patch + revert 还原 pristine
console.log("[3/3] stale → re-patch + revert 还原 pristine ...");
wbContent = readFileSync(wb, "utf8").replace(`<!--mp-injected:${INJECT_VER}:`, "<!--mp-injected:v0.0.0:");
writeFileSync(wb, wbContent);  // 伪造旧版本 marker → stale
runPatcher(app, install);
if (!readFileSync(wb, "utf8").includes(`<!--mp-injected:${INJECT_VER}:`)) fail("stale 未 re-patch（marker 仍旧版本）");
runPatcher(app, install, ["--revert"]);
if (readFileSync(wb, "utf8").includes("<!--mp-injected:")) fail("revert 后 workbench 仍含 marker（未还原 pristine 备份）");
if (readFileSync(mainJs).includes("mp-main-injected")) fail("revert 后 main.js 仍含 autoplay marker（未 strip）");
if (!pristineMain.equals(readFileSync(mainJs))) fail("revert 后 main.js 非 byte-identical 于 pristine（strip 应字节级还原,只 prepend 故可逆）");

try { rmSync(app, { recursive: true, force: true }); rmSync(install, { recursive: true, force: true }); } catch { /* ignore */ }
if (fails) { console.error(`\nFAIL: test-patcher-io（${fails} 处）`); process.exit(1); }
console.log("OK: test-patcher-io（absent/fresh/stale 三态 + checksum 顺序守门 + revert 还原 全过）");
