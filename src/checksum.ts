// checksum 重算填回。详见 doc/01_自愈patch机制设计.md#checksum-重算填回
// ⚠️ 算法锁定 SHA256（勿用 md5，勿抄 lehni 原版，抄 RimuruChan fork 或本算法）。Spike4 实测确证。
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeAtomicSync } from "./atomic.js";  // 0.5.12🟡:product.json 原子写(原 writeFileSync 半写→VSCode 启动 JSON parse 失败→整 app 不启)

// SHA256 → base64 → 去结尾 = （VSCode checksumService.ts:21,26 算法）
export function recomputeChecksum(absPath: string): string {
    return createHash("sha256").update(fs.readFileSync(absPath)).digest("base64").replace(/=+$/, "");
}

// 全量遍历 product.checksums（object map），重算填回。custom-ui-style json.ts 范式。
// ⚠️【顺序关键】必须在 workbench.html 写盘【后】调（读回最终字节，custom-ui-style index.ts:35 "MUST be the end"）。
// 全量遍历自然覆盖所有 workbench*.html / workbench*.js key，无需正则匹配（取代旧"删 key"方案，Spike4 实测删 key 弃用）。
export function patchProductChecksums(productJsonPath: string, baseOutDir: string): void {
    const product = JSON.parse(fs.readFileSync(productJsonPath, "utf8"));
    if (!product.checksums || typeof product.checksums !== "object") return;
    for (const relKey of Object.keys(product.checksums)) {
        const abs = path.join(baseOutDir, ...relKey.split("/")); // relKey 不含 out/ 前缀，前置 baseOutDir
        if (!fs.existsSync(abs)) continue; // 文件不存在（新版本删除）→ 跳过不报错
        product.checksums[relKey] = recomputeChecksum(abs);
    }
    writeAtomicSync(productJsonPath, JSON.stringify(product, null, "\t")); // 0.5.12🟡:原子写(.tmp+rename,与全代码库范式一致)。tab 缩进对齐 VSCode product.json 原格式
}

// 由 workbench.html 绝对路径推 checksum key（去 out/ 前缀，如 vs/code/electron-browser/workbench/workbench.html）
export function deriveChecksumKey(workbenchHtmlPath: string, baseOutDir: string): string {
    return path.relative(baseOutDir, workbenchHtmlPath).split(path.sep).join("/");
}
