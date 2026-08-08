// 多窗口/多实例文件锁。详见 doc/01 自愈完整流程。custom-ui-style utils.ts 范式。
import fs from "node:fs";
import path from "node:path";

const LOCK_TIMEOUT_MS = 10 * 60 * 1000; // 10min stale-break
const LOCK_WAIT_MS = 5000; // 最多等 5s

// 同装目录并发 patch 防护（多窗口/CLI+扩展竞态）。扩展内 ran Set 仅防同 EH，跨进程靠此锁。
export async function withLock<T>(appDir: string, fn: () => Promise<T>): Promise<T> {
    const lockPath = path.join(appDir, "__mp-patcher.lock");
    const start = Date.now();
    while (fs.existsSync(lockPath) && Date.now() - start < LOCK_WAIT_MS) {
        const ts = Number(fs.readFileSync(lockPath, "utf8"));
        if (Date.now() - ts > LOCK_TIMEOUT_MS) { fs.rmSync(lockPath); break; } // stale 清
        await sleep(1000);
    }
    if (fs.existsSync(lockPath)) throw new Error("patcher locked by another process, skip");
    fs.writeFileSync(lockPath, String(Date.now()));
    try {
        return await fn();
    } finally {
        try { fs.rmSync(lockPath); } catch { /* ignore */ }
    }
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }
