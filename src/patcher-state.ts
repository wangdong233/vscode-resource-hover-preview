// patch 状态机 + 注入标记常量。详见 doc/01_自愈patch机制设计.md
export const INJECT_VERSION = "v0.29.1"; // bump:0.5.29c 对抗审查 1🔴6🟡 全修——🔴-1 /audio ETag 字面量笔误(304 永失效)改 etagOf/🟡-1 超时不落负缓存/🟡-2 音短于视频尾部重启环守卫/🟡-3 error 先 dispose 防幽灵音频/🟡-4 companion 版本对齐+闸门

// 注入标记块格式：<!--mp-injected:VERSION:HASH--> ... <!--/mp-injected-->
export const MARKER_RE = /<!--mp-injected:(v[\d.]+):(\w+)-->([\s\S]*?)<!--\/mp-injected-->/;
export const MARKER_BLOCK_CLOSE = "<!--/mp-injected-->";

export type WorkbenchState = "fresh" | "stale" | "absent";

// 读 workbench.html 判断 patch 状态
export function readWorkbenchState(html: string): { state: WorkbenchState; version?: string } {
    const m = html.match(MARKER_RE);
    if (!m) return { state: "absent" }; // 标记不在 = VSCode 更新覆盖
    if (m[1] === INJECT_VERSION) return { state: "fresh", version: m[1] }; // 标记在 + 版本匹配
    return { state: "stale", version: m[1] }; // 标记在但版本旧
}

// 清除已存在的标记块（幂等：重 patch 前清旧，vscode-custom-css clearExistingPatches 范式）
export function clearExistingPatches(html: string): string {
    return html.replace(MARKER_RE, "");
}
