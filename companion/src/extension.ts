// VSCode 伴随扩展 activate。详见 doc/07 + doc/parse/pares1.md。
// 顺序：readToken(INSTALL_DIR) → 起 server(token) → spawn patcher --patch-only（patcher 自己 bake mp-config 用同 token）。
// cc-status-dot 方案 C：spawn + ELECTRON_RUN_AS_NODE，非阻塞。token 固定（workbench 加载早于 activate，必须稳定）。
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as cp from "child_process";
import { startPreviewServer } from "./server";

const PATCH_JS = path.join(__dirname, "..", "patcher.js"); // INSTALL_DIR/patcher.js（installRuntimeFiles 复制）

export async function activate(context: vscode.ExtensionContext) {
    const output = vscode.window.createOutputChannel("Resource Hover Preview");
    context.subscriptions.push(output);

    // 1. token 固定 from INSTALL_DIR/mp-token.json（patcher installRuntimeFiles 首次生成）
    const token = readTokenFromInstallDir();
    // 2. workspace roots（path containment，v0.1审查🔴修）
    const roots = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
    // 3. 起 server（绑 127.0.0.1，用固定 token + roots containment；port 17741 固定）
    const { server, port } = startPreviewServer(token, roots);
    context.subscriptions.push({ dispose: () => server.close() });
    output.appendLine(`[mp] server 127.0.0.1:${port} token=${token ? "ok" : "MISSING(请 npx resource-hover-preview 安装)"}`);

    // 3. spawn patcher --patch-only（patcher 读 INSTALL_DIR token + port 17741 bake mp-config；不传 env）
    setImmediate(() => runPatcher(output));

    context.subscriptions.push(
        vscode.commands.registerCommand("resourceHoverPreview.patch", () => runPatcher(output)),
        vscode.commands.registerCommand("resourceHoverPreview.revert", () => spawnPatcher(["--revert"], output)),
        vscode.commands.registerCommand("resourceHoverPreview.status", () => spawnPatcher(["--status"], output)),
    );
}

// 读 INSTALL_DIR/mp-token.json（patcher 生成）。companion 装了但 npx 没跑时 token 缺失 → server 起但 overlay fetch 403。
function readTokenFromInstallDir(): string {
    const tokenPath = path.join(__dirname, "..", "mp-token.json");
    try { if (fs.existsSync(tokenPath)) return JSON.parse(fs.readFileSync(tokenPath, "utf8")).token; } catch { /* fall through */ }
    return "";
}

// spawn INSTALL_DIR/patcher.js --patch-only（非阻塞 cp.spawn + Promise，30s 超时；cc-status-dot runPatcher 范式）
function runPatcher(output: vscode.OutputChannel) {
    if (!fs.existsSync(PATCH_JS)) {
        vscode.window.showWarningMessage(`Resource Hover Preview: patcher not found at ${PATCH_JS}. Re-run \`npx resource-hover-preview\`.`);
        return;
    }
    const child = cp.spawn(findNodeBin(), [PATCH_JS, "--patch-only"], {
        stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    const out: string[] = [], err: string[] = [];
    child.stdout?.on("data", d => out.push(d.toString()));
    child.stderr?.on("data", d => err.push(d.toString()));
    const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* ignore */ } }, 30000);
    child.on("close", () => {
        clearTimeout(timer);
        const msg = out.join("").trim();
        output.appendLine(msg);
        if (err.length) output.appendLine("[stderr] " + err.join("").trim());
        if (msg.includes("patched")) {
            vscode.window.showInformationMessage("Resource Hover Preview: 已 patch。请 Cmd+Q 完全退出重启 VSCode（Reload Window 不生效）。");
        }
    });
    child.on("error", e => { clearTimeout(timer); output.appendLine("[spawn error] " + e.message); });
}

function spawnPatcher(args: string[], output: vscode.OutputChannel) {
    if (!fs.existsSync(PATCH_JS)) { vscode.window.showWarningMessage(`patcher not found: ${PATCH_JS}`); return; }
    const child = cp.spawn(findNodeBin(), [PATCH_JS, ...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    const out: string[] = []; child.stdout?.on("data", d => out.push(d.toString()));
    child.on("close", () => output.appendLine(out.join("").trim()));
}

// ELECTRON_RUN_AS_NODE 让 Electron execPath 退化为 Node（VSCode spawn EH 的同款 trick）
function findNodeBin(): string {
    try { if (process.execPath && fs.existsSync(process.execPath)) return process.execPath; } catch { /* ignore */ }
    return "node";
}

export function deactivate() { /* server 由 context.subscriptions dispose */ }
