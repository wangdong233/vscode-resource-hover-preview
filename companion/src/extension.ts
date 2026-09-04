// VSCode 伴随扩展 activate。详见 doc/07 + doc/parse/pares1.md。
// 顺序：readToken(INSTALL_DIR) → 起 server(token) → spawn patcher --patch-only（patcher 自己 bake mp-config 用同 token）。
// cc-status-dot 方案 C：spawn + ELECTRON_RUN_AS_NODE，非阻塞。token 固定（workbench 加载早于 activate，必须稳定）。
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as cp from "child_process";
import { startPreviewServer, ensureAudioCacheByPath } from "./server";

const PATCH_JS = path.join(__dirname, "..", "patcher.js"); // INSTALL_DIR/patcher.js（installRuntimeFiles 复制）

export async function activate(context: vscode.ExtensionContext) {
    const output = vscode.window.createOutputChannel("Resource Hover Preview");
    context.subscriptions.push(output);

    // 1. token 固定 from INSTALL_DIR/mp-token.json（patcher installRuntimeFiles 首次生成）
    const token = readTokenFromInstallDir();
    // 2. workspace roots（path containment，v0.1审查🔴修）
    const roots = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
    // 3. 起 server（绑 127.0.0.1，用固定 token + roots containment；port 17741 固定）。onRenamed: 改名后刷新 Explorer（0.4.9）
    const { server, port } = startPreviewServer(token, roots, () => {
        try { vscode.commands.executeCommand("workbench.files.action.refreshFilesExplorer"); } catch (e) { /* ignore */ }
    });
    context.subscriptions.push({ dispose: () => server.close() });
    output.appendLine(`[mp] server 127.0.0.1:${port} token=${token ? "ok" : "MISSING(请 npx vscode-resource-hover-preview 安装)"}`);

    // 3. spawn patcher --patch-only（patcher 读 INSTALL_DIR token + port 17741 bake mp-config；不传 env）
    setImmediate(() => runPatcher(output));

    // 0.5.30 音频旁路预热:启动 12s 后(避宿主启动抢 IO/CPU)后台串行预提取 AAC 家族音轨 → 消除首次悬停 ~1.4s。
    // 护栏:nice -n 10 低优先级(server 内) + 串行+250ms 间隔 + 预算(80 文件/8min)+ mtime 降序(最近动的更可能被预览)
    //     + 50MB 单文件上限 + node_modules 排除;预热与用户实时请求同键合流(server _audioJobs)。可配置 prewarmAudio 关闭。
    const prewarmEnabled = vscode.workspace.getConfiguration("resource-hover-preview").get<boolean>("prewarmAudio", true);
    if (prewarmEnabled) setTimeout(() => { prewarmAudioCache(output).catch(() => { /* ignore */ }); }, 12000);

    // 审查 2.4：enabled 配置变更 → 重新 bake mp-config（需 Cmd+Q 生效，因 mp-config.js 走磁盘缓存）
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration("resource-hover-preview.enabled")) setImmediate(() => runPatcher(output));
    }));

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
        vscode.window.showWarningMessage(`Resource Hover Preview: patcher not found at ${PATCH_JS}. Re-run \`npx vscode-resource-hover-preview\`.`);
        return;
    }
    // 审查 2.4：读 workspace enabled 配置 → 传 patcher bake 进 mp-config（=== false 时 overlay 自禁）
    const enabled = vscode.workspace.getConfiguration("resource-hover-preview").get<boolean>("enabled", true);
    const child = cp.spawn(findNodeBin(), [PATCH_JS, "--patch-only"], {
        stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", MP_ENABLED: String(enabled) },
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
        if (msg.includes("[mp-result] patched=true")) {  // 结构化 marker（审查 3.4：固定串，不再 flavor 耦合 "VSCode: patched"）
            vscode.window.showInformationMessage("Resource Hover Preview: 已 patch。请 Cmd+Q 完全退出重启 VSCode（Reload Window 不生效）。");
        }
    });
    child.on("error", e => { clearTimeout(timer); output.appendLine("[spawn error] " + e.message); });
}

function spawnPatcher(args: string[], output: vscode.OutputChannel) {
    if (!fs.existsSync(PATCH_JS)) { vscode.window.showWarningMessage(`patcher not found: ${PATCH_JS}`); return; }
    const child = cp.spawn(findNodeBin(), [PATCH_JS, ...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    const out: string[] = []; child.stdout?.on("data", d => out.push(d.toString()));
    const err: string[] = []; child.stderr?.on("data", d => err.push(d.toString()));  // 0.5.24 B4:对齐 runPatcher 三件套(原无 error handler→ENOENT unhandled 崩;无超时;无 stderr)
    const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* ignore */ } }, 30000);
    child.on("error", er => { clearTimeout(timer); output.appendLine("[spawn error] " + er.message); });
    child.on("close", () => { clearTimeout(timer); output.appendLine(out.join("").trim()); if (err.length) output.appendLine("[stderr] " + err.join("").trim()); });
}

// ELECTRON_RUN_AS_NODE 让 Electron execPath 退化为 Node（VSCode spawn EH 的同款 trick）
function findNodeBin(): string {
    try { if (process.execPath && fs.existsSync(process.execPath)) return process.execPath; } catch { /* ignore */ }
    return "node";
}

export function deactivate() { /* server 由 context.subscriptions dispose */ }

// 0.5.30 音频旁路预热(一次性/会话内;预算耗尽即止——不循环不常驻,file 变更由缓存键 mtime 自动失效重提)
const PREWARM_MAX_FILES = 80, PREWARM_BUDGET_MS = 8 * 60 * 1000, PREWARM_GAP_MS = 250, PREWARM_MAX_BYTES = 50 * 1024 * 1024;
async function prewarmAudioCache(output: vscode.OutputChannel): Promise<void> {
    if (!vscode.workspace.workspaceFolders?.length) return;
    const t0 = Date.now();
    let uris: vscode.Uri[];
    try { uris = await vscode.workspace.findFiles("**/*.{mp4,mov,m4v,m4a,aac}", "**/{node_modules,dist,out,build,.git}/**", 1000); } catch { return; }  // 0.5.30b:findFiles 只套 files.exclude(不含 node_modules!VSCode 源码语义),显式排除必须全列
    const cands = (await Promise.all(uris.map(u => new Promise<{ p: string; m: number } | null>(res =>
        fs.stat(u.fsPath, (e, st) => res(e || !st || !st.isFile() || st.size > PREWARM_MAX_BYTES ? null : { p: u.fsPath, m: st.mtimeMs }))))))
        .filter((x): x is { p: string; m: number } => !!x).sort((a, b) => b.m - a.m).slice(0, PREWARM_MAX_FILES);
    let extracted = 0, noaudio = 0;
    for (const c of cands) {
        if (Date.now() - t0 > PREWARM_BUDGET_MS) break;
        try {
            const r = await ensureAudioCacheByPath(c.p, true);  // lowPriority: nice + 用户实时请求同键合流
            if (r) extracted++; else noaudio++;  // r=缓存路径(新提取或已缓存皆已就绪);null=无音轨/跳过(区分度交由 server 日志)
        } catch { noaudio++; }
        await new Promise(r => setTimeout(r, PREWARM_GAP_MS));
    }
    output.appendLine(`[mp] 音频旁路预热完成: 就绪 ${extracted} / 无音轨或跳过 ${noaudio}(候选 ${cands.length},耗时 ${Math.round((Date.now() - t0) / 1000)}s,nice 低优先级串行)`);
}
