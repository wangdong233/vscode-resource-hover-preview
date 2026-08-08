// VSCode 伴随扩展 activate。详见 doc/07 v0.1 模块级任务 #7。
// onStartupFinished 触发：自愈 detectAndPatch + 起 server + 建索引。
import * as vscode from "vscode";
import { startPreviewServer } from "./server";
import { buildFileIndex } from "./fileIndex";

export async function activate(context: vscode.ExtensionContext) {
    const output = vscode.window.createOutputChannel("Resource Hover Preview");
    context.subscriptions.push(output);

    // 1. 自愈 detectAndPatch（版本化 bak 缺失 → 重 patch）。同 CLI patcher 逻辑。
    //    ⚠️ 自愈触发点 = onStartupFinished（VSCode 更新走 quitAndInstall→app.relaunch 完全重启 → 新进程 activate → 检测新版本无 bak → 重 patch）
    //    setImmediate(() => detectAndPatch().then(r => { if (r === "patched") promptRelaunch(); }));
    // TODO: import detectAndPatch from 根 src/patcher（CLI 与 companion 共用 patch 逻辑）

    // 2. 起 localhost server（:17741，绑 127.0.0.1 + 会话 token，doc04 六道闸门）
    const { server, port, token } = startPreviewServer();
    output.appendLine(`[mp] server on 127.0.0.1:${port}`);

    // 3. 建文件索引（doc06 方案0：aria-label 含全路径 → 多数免索引；方案B 降 fallback）
    const index = await buildFileIndex();
    context.subscriptions.push({ dispose: () => server.close() });

    // 4. commands
    context.subscriptions.push(
        vscode.commands.registerCommand("resourceHoverPreview.patch", () => {
            // TODO: 调 detectAndPatch + 提示 Cmd+Q 完全重启
            vscode.window.showInformationMessage("Resource Hover Preview: TODO patch（见 doc/01）");
        }),
        vscode.commands.registerCommand("resourceHoverPreview.revert", () => {
            // TODO: 清标记 + 还原 CSP/checksums + 删 overlay.js + 提示 Cmd+Q
            vscode.window.showInformationMessage("Resource Hover Preview: TODO revert");
        }),
        vscode.commands.registerCommand("resourceHoverPreview.status", () => {
            // TODO: 只读三态报告
            vscode.window.showInformationMessage("Resource Hover Preview: TODO status");
        }),
    );
}

export function deactivate() {
    // server 由 context.subscriptions 自动 dispose
}
