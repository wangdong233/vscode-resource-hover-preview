#!/usr/bin/env node
// CLI 入口 + detectAndPatch 编排。详见 doc/01_自愈patch机制设计.md
// ⚠️ 编排顺序关键：checksum 必须在 workbench.html 写盘【后】算（Spike2 实证 + custom-ui-style "MUST be the end"）。
import fs from "node:fs";
import { INJECT_VERSION, readWorkbenchState, clearExistingPatches } from "./patcher-state.js";
import { recomputeChecksum, patchProductChecksums, deriveChecksumKey } from "./checksum.js";
import { writeAtomicSync, atomicCopyFileSync, backupIfAbsent, rollbackFromBak } from "./atomic.js";
import { patchCsp, injectScriptTag } from "./csp.js";
import { discoverVscodeInstalls, type Install } from "./discover.js";
import { withLock } from "./lock.js";

// detectAndPatch 编排。⚠️ 顺序见 doc01 伪代码。
async function detectAndPatch(install: Install): Promise<"fresh" | "patched" | "failed"> {
    const { workbenchHtmlPath, productJsonPath, outDir, appDir } = install;
    return withLock(appDir, async () => {
        const html = fs.readFileSync(workbenchHtmlPath, "utf8");
        const { state } = readWorkbenchState(html);
        if (state === "fresh") return "fresh";

        // 权限检测（扩展进程无法 sudo 提权）
        try { fs.accessSync(workbenchHtmlPath, fs.constants.W_OK); }
        catch {
            console.error(`[mp] 无写权限: ${workbenchHtmlPath}。请: sudo chown -R $(whoami) '<appRoot>'`);
            return "failed";
        }

        try {
            const product = JSON.parse(fs.readFileSync(productJsonPath, "utf8"));
            const ver = product.version; // 版本化备份名（承担版本比对，custom-ui-style 范式）
            // 1. 版本化备份（同目录，VSCode 更新整体替换 app 会擦除 → 下次重备 pristine）
            backupIfAbsent(workbenchHtmlPath, `${workbenchHtmlPath}.mp.bak.${ver}`);
            backupIfAbsent(productJsonPath, `${productJsonPath}.mp.bak.${ver}`);

            // TODO: bake overlay.js + mp-config.js（buildOverlayJs/buildConfigJs，需先起 server 拿 actualPort + 生成 token）
            // const { js: overlayJs, hash: overlayHash } = buildOverlayJs({port, token, version: INJECT_VERSION});
            const overlayHash = "TODO_baked"; // 占位，实现时替换

            // 2. 组装新 workbench.html（清旧标记 + CSP patch + 注入静态 script）
            const injected = injectScriptTag(patchCsp(clearExistingPatches(html)), INJECT_VERSION, overlayHash);
            // 3. ★ 原子写 workbench.html（先落盘最终字节）
            writeAtomicSync(workbenchHtmlPath, injected);
            // 4. 复制 mp-overlay.js + mp-config.js 到 workbench 同目录
            // TODO: atomicCopyFileSync(bakedOverlayJs, path.join(path.dirname(workbenchHtmlPath), "mp-overlay.js"));
            // TODO: atomicCopyFileSync(bakedConfigJs, path.join(path.dirname(workbenchHtmlPath), "mp-config.js"));
            // 5. ★ 重算 checksum 填回（读回【已写盘】的 workbench.html 最终字节）
            patchProductChecksums(productJsonPath, outDir);
            // 6. post-verify（Cmd+Q 不弹损坏的唯一可靠闸门）
            const verifyHtml = fs.readFileSync(workbenchHtmlPath, "utf8");
            const product2 = JSON.parse(fs.readFileSync(productJsonPath, "utf8"));
            const wbKey = deriveChecksumKey(workbenchHtmlPath, outDir);
            if (!verifyHtml.includes(`<!--mp-injected:${INJECT_VERSION}:`)) throw new Error("marker missing after write");
            if (product2.checksums[wbKey] !== recomputeChecksum(workbenchHtmlPath)) throw new Error("checksum mismatch");
            return "patched";
        } catch (e) {
            rollbackFromBak(`${workbenchHtmlPath}.mp.bak`, workbenchHtmlPath);
            rollbackFromBak(`${productJsonPath}.mp.bak`, productJsonPath);
            console.error(`[mp] patch failed: ${(e as Error).message}`);
            return "failed";
        }
    });
}

// CLI 入口
async function main() {
    const argv = process.argv.slice(2);
    const cmd = argv[0] ?? "--patch";
    const installs = discoverVscodeInstalls();
    if (installs.length === 0) { console.error("[mp] 未发现 VSCode 安装"); process.exit(1); }

    if (cmd === "--status") {
        for (const inst of installs) {
            const html = fs.readFileSync(inst.workbenchHtmlPath, "utf8");
            console.log(`${inst.flavor}: ${readWorkbenchState(html).state}`);
        }
    } else if (cmd === "--revert") {
        // TODO: 清标记 + 还原 CSP + 还原 checksums + 删 mp-overlay.js/mp-config.js（从 .bak）
        console.log("[mp] TODO revert. 请 Cmd+Q 完全退出重启 VSCode");
    } else {
        for (const inst of installs) console.log(`[mp] ${inst.flavor}: ${await detectAndPatch(inst)}`);
        console.log("[mp] done. 请 Cmd+Q 完全退出重启 VSCode（Reload Window 用缓存不重读 workbench.html，patch 不生效）");
    }
}

main();
