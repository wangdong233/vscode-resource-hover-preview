// 多窗口/多实例文件锁。详见 doc/01 自愈完整流程。custom-ui-style utils.ts 范式。
// v0.1审查🟡修：O_EXCL 原子创建（wx），消除 existsSync→writeFileSync 的 TOCTOU 竞态。
import fs from "node:fs";
import path from "node:path";

const LOCK_TIMEOUT_MS = 10 * 60 * 1000; // 10min stale-break
const LOCK_WAIT_MS = 5000; // 最多等 5s

// 同装目录并发 patch 防护（多窗口/CLI+扩展竞态）。O_EXCL 原子创建防 TOCTOU。
export async function withLock<T>(appDir: string, fn: () => Promise<T>): Promise<T> {
    const lockPath = path.join(appDir, "__mp-patcher.lock");
    const start = Date.now();
    let fd: number | null = null;
    while (Date.now() - start < LOCK_WAIT_MS) {
        try {
            fd = fs.openSync(lockPath, "wx");  // 原子：已存在抛 EEXIST
            fs.writeSync(fd, String(Date.now()));
            break;
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "EEXIST") {
                try {
                    const stat = fs.statSync(lockPath);
                    if (Date.now() - stat.mtimeMs > LOCK_TIMEOUT_MS) { fs.rmSync(lockPath); continue; } // stale 清
                } catch { /* ignore */ }
                await sleep(1000);
            } else throw e;
        }
    }
    if (fd === null) throw new Error("patcher locked by another process, skip");
    try {
        return await fn();
    } finally {
        try { fs.closeSync(fd); } catch { /* ignore */ }
        try { fs.rmSync(lockPath); } catch { /* ignore */ }
    }
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }
