#!/usr/bin/env node
// CLI 入口 + detectAndPatch 编排。详见 doc/01_自愈patch机制设计.md + doc/parse/pares1.md
// 架构：cc-status-dot 方案 C（companion spawn 本文件 --patch-only）。INSTALL_DIR = companion 扩展目录。
// ⚠️ 编排顺序关键：checksum 必须在 workbench.html 写盘【后】算。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";  // 审查 2.6：spawn 未用，删（noUnusedLocals 闸门）
import { randomBytes } from "node:crypto";
import { INJECT_VERSION, readWorkbenchState, clearExistingPatches } from "./patcher-state.js";
import { recomputeChecksum, patchProductChecksums, deriveChecksumKey } from "./checksum.js";
import { writeAtomicSync, atomicCopyFileSync, backupIfAbsent, rollbackFromBak } from "./atomic.js";
import { patchCsp, injectScriptTag } from "./csp.js";
import { discoverVscodeInstalls, type Install } from "./discover.js";
import { withLock } from "./lock.js";
import { buildOverlayJs, buildConfigJs } from "./overlay-bake.js";  // buildConfigJs：统一 mp-config bake（消除双 bake，v0.1审查🟡）
import { cmpVerStr } from "./semver.js";  // v0.1审查🟡：locateInstallDir semver 排序（消除死代码）

const HERE = path.dirname(fileURLToPath(import.meta.url)); // dist/（npx）或 INSTALL_DIR（--patch-only）
const COMPANION_ID = "wangdong.vscode-resource-hover-preview-companion"; // publisher.name

// ===== mp-overlay.js 定位（install 时 bake 到 INSTALL_DIR；--patch-only 从 INSTALL_DIR 复制）=====
function findBakedOverlay(): string | null {
    const installDir = locateInstallDir();
    if (!installDir) return null;
    const p = path.join(installDir, "mp-overlay.js");
    return fs.existsSync(p) ? p : null;
}
function findOverlayTemplate(): string | null {
    const candidates = [
        path.join(HERE, "..", "resources", "overlay.template.js"), // 项目 dist/ → ../resources
        path.join(HERE, "resources", "overlay.template.js"),       // INSTALL_DIR/resources
    ];
    return candidates.find(p => fs.existsSync(p)) ?? null;
}

// ===== INSTALL_DIR = companion 扩展安装目录 =====
function locateInstallDir(): string | null {
    if (process.env.MP_TEST_INSTALL_DIR) return process.env.MP_TEST_INSTALL_DIR;  // 测试 seam（test-patcher-io）
    const extRoot = path.join(os.homedir(), ".vscode", "extensions");
    if (!fs.existsSync(extRoot)) return null;
    // 版本前缀匹配 wangdong.vscode-resource-hover-preview-companion-*
    const match = fs.readdirSync(extRoot)
        .filter(d => d.startsWith(COMPANION_ID + "-"))
        .sort((a, b) => cmpVerStr(a.slice(COMPANION_ID.length + 1), b.slice(COMPANION_ID.length + 1)))  // semver 正确排序（v0.1审查🟡：字典序会让 0.10.0<0.2.0）
        .pop();
    return match ? path.join(extRoot, match) : null;
}

// ===== installRuntimeFiles（npx 默认模式）：bake overlay + 复制 dist/resources 到 INSTALL_DIR =====
function installRuntimeFiles(): void {
    const installDir = locateInstallDir();
    if (!installDir) { console.error(`[mp] 未找到 companion 扩展 ${COMPANION_ID}，请先 installCompanion`); return; }
    // bake mp-overlay.js（内容固定 per INJECT_VERSION，不含 port/token；配置由 companion bake 进 mp-config.js）→ INSTALL_DIR
    const template = findOverlayTemplate();
    if (!template) { console.error("[mp] overlay.template.js 未找到"); return; }
    const { js, hash } = buildOverlayJs(readFileSafe(template), INJECT_VERSION);
    writeAtomicSync(path.join(installDir, "mp-overlay.js"), js);
    readOrGenToken(installDir);  // 首次生成固定 token（INSTALL_DIR/mp-token.json），server + mp-config 共用
    // 复制 patcher.js + dist/*.js（ESM 模块）→ INSTALL_DIR（companion spawn 用）
    copyDirFiles(HERE, installDir, ".js");
    // 审查 2.1 serveLib：resources/lib（pdf.min.mjs/worker + three bundle）须随 INSTALL_DIR，
    //   否则 server.ts serveLib path.join(__dirname,"..","resources","lib") = INSTALL_DIR/resources/lib 404 → PDF/3D 全断。
    //   copyDirFiles 单层仅 .js 漏 .mjs → 递归复制 lib 全件（vsix 打包 + npx 双通道）。
    const libSrc = path.join(HERE, "..", "resources", "lib");
    if (fs.existsSync(libSrc)) {
        const libDest = path.join(installDir, "resources", "lib");
        fs.mkdirSync(libDest, { recursive: true });
        for (const f of fs.readdirSync(libSrc)) {
            const sp = path.join(libSrc, f);
            if (fs.statSync(sp).isFile()) atomicCopyFileSync(sp, path.join(libDest, f));
        }
    }
    console.log(`[mp] installRuntimeFiles → ${installDir}（mp-overlay.js hash=${hash}）`);
}

// ===== installCompanion：code --install-extension vsix（同步等，确保 INSTALL_DIR 建好）=====
function installCompanion(): void {
    const vsix = findVsix();
    if (!vsix) { console.error("[mp] 未找到 .vsix，请先 npm run companion:package"); return; }
    const codeBin = (process.env.PATH?.split(path.delimiter).some(p => fs.existsSync(path.join(p, "code")))) ? "code" : "/usr/local/bin/code";  // v0.1审查🟡：Win 分隔符 ';'
    console.log(`[mp] code --install-extension ${vsix}`);
    const r = spawnSync(codeBin, ["--install-extension", vsix], { stdio: "inherit" });
    console.log(`[mp] install-extension exit ${r.status}`);
}

// ===== detectAndPatch（--patch-only / 默认 都用）：编排，顺序关键 =====
async function detectAndPatch(install: Install, fixedToken: string): Promise<"fresh" | "patched" | "failed"> {
    const { workbenchHtmlPath, productJsonPath, outDir, appDir } = install;
    return withLock(appDir, async () => {
        const html = fs.readFileSync(workbenchHtmlPath, "utf8");
        const { state } = readWorkbenchState(html);
        // bake mp-config.js：token 固定（main 调一次 readOrGenToken 传入，复审 rev2：多 install 并发 Promise.all 不各自 gen 致 token 分叉 403）。
        // ⚠️ 必须固定：workbench renderer 加载早于 companion activate，每次 activate 随机 token
        //   → mp-config(workbench 读) vs server(activate 新 token) 永久不匹配 → fetch 永远 403。
        if (fixedToken) {
            writeAtomicSync(path.join(path.dirname(workbenchHtmlPath), "mp-config.js"),
                buildConfigJs({ port: 17741, token: fixedToken, version: INJECT_VERSION, enabled: process.env.MP_ENABLED !== "false" }));
        }
        if (state === "fresh") {
            // v0.1审查🔵：fresh 也校验 mp-overlay.js 存在（被删则补拷，否则 script 404 静默死）
            const overlayDest = path.join(path.dirname(workbenchHtmlPath), "mp-overlay.js");
            const overlaySrc = findBakedOverlay();
            if (overlaySrc && !fs.existsSync(overlayDest)) atomicCopyFileSync(overlaySrc, overlayDest);
            return "fresh";
        }

        try { fs.accessSync(workbenchHtmlPath, fs.constants.W_OK); }
        catch { console.error(`[mp] 无写权限: ${workbenchHtmlPath}。请: sudo chown -R $(whoami) '<appRoot>'`); return "failed"; }

        const ver = JSON.parse(fs.readFileSync(productJsonPath, "utf8")).version;  // hoist 到 try 外（catch 要用，v0.1审查🔴修）
        try {
            backupIfAbsent(workbenchHtmlPath, `${workbenchHtmlPath}.mp.bak.${ver}`);
            backupIfAbsent(productJsonPath, `${productJsonPath}.mp.bak.${ver}`);

            // overlay.js（baked）：--patch-only 从 INSTALL_DIR；默认从 installRuntimeFiles 产物
            const overlaySrc = findBakedOverlay();
            if (!overlaySrc) { console.error("[mp] mp-overlay.js 未找到（先 installRuntimeFiles）"); return "failed"; }
            const overlayJs = fs.readFileSync(overlaySrc, "utf8");
            const overlayHash = overlayJs.match(/mp-overlay:v[\d.]+:([0-9a-f]+)/)?.[1] ?? "00000000";

            // 组装 + 原子写 workbench.html
            const injected = injectScriptTag(patchCsp(clearExistingPatches(html)), INJECT_VERSION, overlayHash);
            writeAtomicSync(workbenchHtmlPath, injected);
            // 复制 mp-overlay.js 到 workbench 同目录
            atomicCopyFileSync(overlaySrc, path.join(path.dirname(workbenchHtmlPath), "mp-overlay.js"));
            // （mp-config.js 已在函数开头 bake，fresh/absent 统一）
            // ★ 重算 checksum（workbench 写盘后）
            patchProductChecksums(productJsonPath, outDir);
            // post-verify
            const verifyHtml = fs.readFileSync(workbenchHtmlPath, "utf8");
            const product2 = JSON.parse(fs.readFileSync(productJsonPath, "utf8"));
            const wbKey = deriveChecksumKey(workbenchHtmlPath, outDir);
            if (!verifyHtml.includes(`<!--mp-injected:${INJECT_VERSION}:`)) throw new Error("marker missing");
            if (product2.checksums[wbKey] !== recomputeChecksum(workbenchHtmlPath)) throw new Error("checksum mismatch");
            return "patched";
        } catch (e) {
            rollbackFromBak(`${workbenchHtmlPath}.mp.bak.${ver}`, workbenchHtmlPath);  // 版本化名（v0.1审查🔴修：与 backup 一致）
            rollbackFromBak(`${productJsonPath}.mp.bak.${ver}`, productJsonPath);
            console.error(`[mp] patch failed: ${(e as Error).message}`);
            return "failed";
        }
    });
}

// ===== --revert =====
function runRevert(installs: Install[]): void {
    for (const inst of installs) {
        const { workbenchHtmlPath, productJsonPath } = inst;  // 仅用此二者（审查 2.6 noUnusedLocals）
        try {
            rollbackVersionedBak(workbenchHtmlPath);  // glob .mp.bak.* 还原（v0.1审查🔴修：revert 版本化名）
            rollbackVersionedBak(productJsonPath);
            const overlayDest = path.join(path.dirname(workbenchHtmlPath), "mp-overlay.js");
            if (fs.existsSync(overlayDest)) fs.rmSync(overlayDest);
            const cfgDest = path.join(path.dirname(workbenchHtmlPath), "mp-config.js");
            if (fs.existsSync(cfgDest)) fs.rmSync(cfgDest);
            console.log(`[mp] reverted ${inst.flavor}`);
        } catch (e) { console.error(`[mp] revert failed ${inst.flavor}: ${(e as Error).message}`); }
    }
    console.log("[mp] revert done. 请 Cmd+Q 完全退出重启 VSCode");
}

// ===== main =====
async function main() {
    const argv = process.argv.slice(2);
    const cmd = argv[0] ?? "--patch";
    const installs = discoverVscodeInstalls();
    if (installs.length === 0) { console.error("[mp] 未发现 VSCode 安装"); process.exit(1); }

    if (cmd === "--status") {
        for (const inst of installs) console.log(`${inst.flavor}: ${readWorkbenchState(fs.readFileSync(inst.workbenchHtmlPath, "utf8")).state}`);
        return;
    }
    if (cmd === "--revert") { runRevert(installs); return; }
    // 复审 rev2：token 在 main 调一次（locateInstallDir 多 install 共享同一 INSTALL_DIR；Promise.all 并发各自 readOrGenToken 会 gen 不同 token → 一边 mp-config 写旧 → 403）
    const installDir = locateInstallDir();
    const fixedToken = installDir ? readOrGenToken(installDir) : "";
    if (cmd === "--patch-only") {
        const states = await Promise.all(installs.map(inst => detectAndPatch(inst, fixedToken).then(s => { console.log(`[mp] ${inst.flavor}: ${s}`); return s; })));
        console.log("[mp] --patch-only done. 若 patched 请 Cmd+Q 完全退出重启（Reload Window 不生效）");
        console.log(`[mp-result] patched=${states.includes("patched")}`);  // 结构化 marker（审查 3.4：extension 匹配固定串，不再 flavor 耦合 "VSCode: patched"）
        return;
    }
    // 默认 --patch（npx）：install companion → installRuntimeFiles（要 INSTALL_DIR）→ patch
    installCompanion();
    installRuntimeFiles();
    const fixedToken2 = installDir ? readOrGenToken(installDir) : fixedToken;  // installRuntimeFiles 后 token 已生成，重读同值
    const states = await Promise.all(installs.map(inst => detectAndPatch(inst, fixedToken2).then(s => { console.log(`[mp] ${inst.flavor}: ${s}`); return s; })));
    console.log("[mp] done. 请 Cmd+Q 完全退出重启 VSCode（Reload Window 用缓存不重读 workbench.html，patch 不生效）");
    console.log(`[mp-result] patched=${states.includes("patched")}`);
}

// ===== helpers =====
// readOrGenToken：固定 token（INSTALL_DIR/mp-token.json）。首次生成，后续读同值。
// 固定原因：workbench renderer 加载早于 companion activate，token 必须跨 activate 稳定才不失配。
// rollbackVersionedBak：glob 目录下 <basename>.mp.bak.* 取最新还原（不依赖 version 字符串，v0.1审查🔴修）
function rollbackVersionedBak(targetPath: string): void {
    const dir = path.dirname(targetPath);
    const base = path.basename(targetPath);
    try {
        const baks = fs.readdirSync(dir).filter(f => f.startsWith(base + ".mp.bak.")).sort();
        if (baks.length) fs.copyFileSync(path.join(dir, baks[baks.length - 1]), targetPath);
    } catch { /* 无 bak 静默（首次 revert 无备份） */ }
}
function readOrGenToken(installDir: string): string {
    const tokenPath = path.join(installDir, "mp-token.json");
    try { if (fs.existsSync(tokenPath)) return JSON.parse(fs.readFileSync(tokenPath, "utf8")).token; } catch { /* fall through gen */ }
    const token = randomBytes(32).toString("hex");
    try { writeAtomicSync(tokenPath, JSON.stringify({ token })); } catch { /* ignore */ }
    return token;
}
function readFileSafe(p: string): string { return fs.readFileSync(p, "utf8"); }
function findVsix(): string | null {
    // 找最新 vsix（mtime 排序，防 companion/ 残留旧名 vsix 被选——真机 bug：旧 resource-hover-preview-companion-0.1.0.vsix 字母序在新名前）
    const dirs = [path.join(HERE, "..", "companion"), HERE];
    const all: { file: string; mtime: number }[] = [];
    for (const d of dirs) {
        if (!fs.existsSync(d)) continue;
        for (const f of fs.readdirSync(d)) {
            if (f.endsWith(".vsix")) {
                const fp = path.join(d, f);
                try { all.push({ file: fp, mtime: fs.statSync(fp).mtimeMs }); } catch { /* ignore */ }
            }
        }
    }
    if (!all.length) return null;
    all.sort((a, b) => b.mtime - a.mtime);  // 最新 mtime 优先
    return all[0].file;
}
function copyDirFiles(srcDir: string, destDir: string, ext: string): void {
    if (!fs.existsSync(srcDir)) return;
    for (const f of fs.readdirSync(srcDir)) {
        if (f.endsWith(ext)) { const s = path.join(srcDir, f); if (fs.statSync(s).isFile()) atomicCopyFileSync(s, path.join(destDir, f)); }
    }
}

main();
