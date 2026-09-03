// patch 状态机 + 注入标记常量。详见 doc/01_自愈patch机制设计.md
export const INJECT_VERSION = "v0.28.16"; // bump:0.5.24 全项目双审 BLOCK 修复——R1 stopPan 作用域(关闭钮失效)/R2 媒体摘除 pause+断src/Y1 URL try/Y2 isFile+stream error/Y8 reset 复夹紧/Y9 3D 入口置 type/Y13 drag 重入门/B4 spawnPatcher 三件套 + 第8闸门 renderer 执行 harness

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
