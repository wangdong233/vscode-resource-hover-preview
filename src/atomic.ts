// 原子写 + 版本化备份。详见 doc/01_自愈patch机制设计.md。复用 cc-status-dot atomic 范式。
import fs from "node:fs";

// 原子写（写 .tmp + rename，防 VSCode 启动期读到半写文件）
export function writeAtomicSync(filePath: string, content: string): void {
    const tmp = filePath + ".mp.tmp";
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, filePath);
}

// 原子复制（overlay.js/mp-config.js 落盘）
export function atomicCopyFileSync(src: string, dest: string): void {
    const tmp = dest + ".mp.tmp";
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dest);
}

// 版本化备份（已存在不覆盖）。
// 【同目录】放 .bak：VSCode 自动更新整体替换 app bundle 会擦除同目录 .bak → 下次 detectAndPatch 见 !hasBak → 备份新 pristine → patch。
// 版本化名（.{vscodeVersion}）天然承担版本比对：VSCode 月更后 version 变 → 新版本 bak 不存在 → 触发重 patch。
export function backupIfAbsent(src: string, bak: string): void {
    if (!fs.existsSync(bak)) fs.copyFileSync(src, bak);
}

// 从 .bak 还原（revert / patch 失败回滚）
export function rollbackFromBak(bak: string, dest: string): boolean {
    if (!fs.existsSync(bak)) return false;
    fs.copyFileSync(bak, dest);
    return true;
}
