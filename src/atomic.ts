// 原子写 + 版本化备份。详见 doc/01_自愈patch机制设计.md。复用 cc-status-dot atomic 范式。
import fs from "node:fs";

// 原子写（写 .tmp + rename，防 VSCode 启动期读到半写文件）
export function writeAtomicSync(filePath: string, content: string): void {
    const tmp = filePath + ".mp.tmp";
    try { fs.writeFileSync(tmp, content, "utf8"); fs.renameSync(tmp, filePath); }
    finally { try { if (fs.existsSync(tmp)) fs.rmSync(tmp); } catch { /* ignore */ } }  // 0.5.12🔵:失败/成功后清 .tmp(原 rename 失败残留污染目录)
}

// 原子复制（overlay.js/mp-config.js 落盘）
export function atomicCopyFileSync(src: string, dest: string): void {
    const tmp = dest + ".mp.tmp";
    try { fs.copyFileSync(src, tmp); fs.renameSync(tmp, dest); }
    finally { try { if (fs.existsSync(tmp)) fs.rmSync(tmp); } catch { /* ignore */ } }
}

// 版本化备份（已存在不覆盖）。
// 【同目录】放 .bak：VSCode 自动更新整体替换 app bundle 会擦除同目录 .bak → 下次 detectAndPatch 见 !hasBak → 备份新 pristine → patch。
// 版本化名（.{vscodeVersion}）天然承担版本比对：VSCode 月更后 version 变 → 新版本 bak 不存在 → 触发重 patch。
export function backupIfAbsent(src: string, bak: string): void {
    if (!fs.existsSync(bak)) atomicCopyFileSync(src, bak);  // 0.5.31 Y6:原裸 copy——崩溃窗内留截断 bak,rollback 会把截断品还原进 app
}

// 从 .bak 还原（revert / patch 失败回滚）
export function rollbackFromBak(bak: string, dest: string): boolean {
    if (!fs.existsSync(bak)) return false;
    atomicCopyFileSync(bak, dest);  // 0.5.31 Y6:回滚亦须原子(半还原 workbench=启动即死)
    return true;
}
