// patch 状态机 + 注入标记常量。详见 doc/01_自愈patch机制设计.md
export const INJECT_VERSION = "v0.29.5"; // bump:0.5.33 移出不关终修——走廊时间维(静止>500ms 必关,真机 rig8 定案)+链死端消灭(暂态改短周期复查,含 hold 尊重)+隐形 rail pointer-events:none+!item 清 hoverTimer(H3 幽灵重渲染)

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
