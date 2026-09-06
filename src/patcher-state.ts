// patch 状态机 + 注入标记常量。详见 doc/01_自愈patch机制设计.md
export const INJECT_VERSION = "v0.29.6"; // bump:0.5.34 关闭灵敏度回归修复——走廊去浮窗裙带(离开必穿裙带=250ms×N 迟钝关)+统一 200ms(媒体 400 是前走廊时代补丁)

// 注入标记块格式：<!--mp-injected:VERSION:HASH--> ... <!--/mp-injected-->
export const MARKER_BLOCK_CLOSE = "<!--/mp-injected-->";  // 0.5.31 B8:唯一常量(csp.ts 模板+本 RE 均由此构造,原三处字面量分叉)
export const MARKER_RE = new RegExp("<!--mp-injected:(v[\\d.]+):(\\w+)-->([\\s\\S]*?)" + MARKER_BLOCK_CLOSE.replace(/\//g, "\\/"));

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
