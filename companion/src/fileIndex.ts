// 文件路径推导。详见 doc/06_DOM选择器容错策略.md。
// Spike8 白盒确证（2026-08-08）：.monaco-icon-label 的 aria-label = labelService.getUriLabel(resource) = 完整绝对路径
//   → overlay 直接读 aria-label（按首个 ' • ' 切分取前段）即得路径，**免整个 EH 文件索引**（方案0）。
// 方案B（EH findFiles 索引 + 重名消歧）降为 fallback，仅 aria-label 失败时启用：
//   remote workspace（aria-label=远程 URI label 非 fsPath）/ compressed folder / path 含 ' • '。
import * as vscode from "vscode";

export interface FileIndex {
    // 返回候选路径数组（同名消歧），null = 无索引（指示 overlay 走 aria-label 方案0）
    get(name: string, hint?: string): string[] | null;
}

export async function buildFileIndex(): Promise<FileIndex> {
    // Spike8 方案0 成立（本机 1.129.1）：默认不建索引，overlay 读 aria-label。
    // 仅 remote workspace 等场景需要索引时，用 vscode.workspace.findFiles 建 Map<basename, string[]>。
    // TODO: 检测 remote workspace → 触发 findFiles 建 index + FileSystemWatcher 增量
    return {
        get: () => null, // 默认 null：overlay 用 aria-label 方案0
    };
}
