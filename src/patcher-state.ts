// patch 状态机 + 注入标记常量。详见 doc/01_自愈patch机制设计.md
export const INJECT_VERSION = "v0.29.2"; // bump:0.5.31 全项目双审(三路 0🔴19🟡)全修——F2 hide 裁决工厂/Y3 grace 复位/zoom sim 同步挂链/patcher Y3-Y7+B8-B10/server F3+evict+负缓存确定性+预热 disable 旗标

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
