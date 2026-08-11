// 三平台 VSCode 安装发现 + workbench 多候选路径。详见 doc/05_三平台路径与权限.md
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface Install {
    appDir: string;          // .../Resources/app
    workbenchHtmlPath: string;
    productJsonPath: string;
    mainJsPath: string;      // 0.5.10: Electron 主进程入口(package.json main 字段,注入 autoplay switch)
    outDir: string;          // .../app/out（checksum baseOutDir）
    flavor: string;
}

// workbench 多候选（顺序据 1.129.1 实证：electron-browser/workbench.html 首位）
const WORKBENCH_CANDIDATES = [
    "out/vs/code/electron-browser/workbench/workbench.html",       // ✅ 实证命中(1.129.1 stable)
    "out/vs/code/electron-sandbox/workbench/workbench.esm.html",   // 官方博客称现行(与实证矛盾,并列保留)
    "out/vs/code/electron-sandbox/workbench/workbench.html",
    "out/vs/code/electron-browser/workbench/workbench.esm.html",
    "out/vs/code/electron-sandbox/workbench/workbench-apc-extension.html", // Cursor fork
];

export function discoverVscodeInstalls(): Install[] {
    // 测试 seam（test-patcher-io）：MP_TEST_APPDIR 指向 /tmp 仿 app 目录，跳过真实 VSCode 扫描
    if (process.env.MP_TEST_APPDIR) {
        const appDir = process.env.MP_TEST_APPDIR;
        const productJsonPath = path.join(appDir, "product.json");
        const workbenchHtmlPath = path.join(appDir, "out", "vs", "code", "electron-browser", "workbench", "workbench.html");
        return [{ appDir, workbenchHtmlPath, productJsonPath, mainJsPath: resolveMainJs(appDir), outDir: path.join(appDir, "out"), flavor: "test" }];
    }
    const found: Install[] = [];
    for (const appDir of candidateAppDirs()) {
        const productJsonPath = path.join(appDir, "product.json");
        if (!fs.existsSync(productJsonPath)) continue;
        const workbenchHtmlPath = findWorkbench(appDir);
        if (!workbenchHtmlPath) continue;
        found.push({
            appDir, workbenchHtmlPath, productJsonPath,
            mainJsPath: resolveMainJs(appDir),
            outDir: path.join(appDir, "out"),
            flavor: inferFlavor(appDir),
        });
    }
    return found;
}

// Electron 主进程入口：package.json main 字段是源真相（VSCode 约定 out/main.js,但读字段防漂移）
function resolveMainJs(appDir: string): string {
    try { const pkg = JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf8")); if (pkg.main) return path.join(appDir, pkg.main); } catch { /* fall through */ }
    return path.join(appDir, "out", "main.js");
}

function candidateAppDirs(): string[] {
    const home = os.homedir();
    switch (process.platform) {
        case "darwin":
            return [
                "/Applications/Visual Studio Code.app/Contents/Resources/app",
                "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app",
                "/Applications/VSCodium.app/Contents/Resources/app",
                "/Applications/Cursor.app/Contents/Resources/app",
                `${home}/Applications/Visual Studio Code.app/Contents/Resources/app`,
            ];
        case "win32": {
            const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
            return [
                path.join(local, "Programs", "Microsoft VS Code", "resources", "app"),
                path.join("C:", "Program Files", "Microsoft VS Code", "resources", "app"),
                path.join(local, "Programs", "VSCodium", "resources", "app"),
            ];
        }
        case "linux":
            return [
                "/usr/share/code/resources/app",
                "/usr/share/vscode/resources/app",
                "/opt/VSCode/resources/app",
                "/usr/share/vscodium/resources/app",
                "/opt/vscodium/resources/app",
            ];
        default:
            return [];
    }
}

function findWorkbench(appDir: string): string | null {
    for (const rel of WORKBENCH_CANDIDATES) {
        const p = path.join(appDir, rel);
        if (fs.existsSync(p)) return p;
    }
    return null; // TODO: glob 兜底 out/vs/code/**/workbench*.html
}

function inferFlavor(appDir: string): string {
    if (/Insiders/i.test(appDir)) return "Insiders";
    if (/VSCodium/i.test(appDir)) return "VSCodium";
    if (/Cursor/i.test(appDir)) return "Cursor";
    return "VSCode";
}
