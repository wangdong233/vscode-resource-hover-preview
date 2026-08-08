// 版本字符串比较（从 cc-status-dot 复制，pure function）
export function cmpVerStr(a: string, b: string): number {
    const pa = a.replace(/^v/, "").split(".").map(Number);
    const pb = b.replace(/^v/, "").split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const da = pa[i] || 0;
        const pb2 = pb[i] || 0;
        if (da !== pb2) return da - pb2;
    }
    return 0;
}
