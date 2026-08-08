// 三平台 shell relaunch（⚠️ 非 nativeHostService.relaunch——扩展 API 无此服务；非 reloadWindow——用缓存不重读）。
// 详见 doc/01 自愈完整流程#重启。custom-ui-style restart.ts:17-149 范式，直接抄。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export class ManualRestartRequiredError extends Error {}

// macOS: osascript quit + 等退出 + relaunch。Windows/Linux TODO（填 01 自愈节代码）。
export function relaunchApp(productJsonPath: string): void {
    const product = JSON.parse(fs.readFileSync(productJsonPath, "utf8"));
    let p;
    if (process.platform === "darwin") {
        const nameLong = product.nameLong;
        const m = /(.*\.app)\/Contents\/Frameworks\//.exec(process.execPath);
        const appPath = m ? m[1] : `/Applications/${nameLong}.app`;
        const bin = locateBin(path.join(appPath, "Contents", "Resources", "app", "bin"));
        p = spawn("osascript", [
            "-e", `quit app "${nameLong}"`,
            "-e", "repeat 100",
            "-e", `if not (application "${nameLong}" is running) then exit repeat`,
            "-e", "delay 0.1",
            "-e", "end repeat",
            "-e", `do shell script quoted form of "${bin}"`,
        ], { detached: true, stdio: "ignore" });
    } else if (process.platform === "win32") {
        // TODO: taskkill /F /IM + powershell 等退出 + relaunch bin（doc01 自愈节）
        throw new ManualRestartRequiredError("Windows relaunch 待实现，请手动完全退出再开 VSCode");
    } else {
        const pid = Number(process.env.VSCODE_PID);
        if (!Number.isInteger(pid) || pid <= 0)
            throw new ManualRestartRequiredError("无法确定 VSCode PID，请手动完全退出再开 VSCode");
        // TODO: kill $pid + 等退出 + relaunch bin（doc01 自愈节）
        throw new ManualRestartRequiredError("Linux relaunch 待实现，请手动完全退出再开 VSCode");
    }
    p.unref();
}

// 扫 bin/ 排除 -tunnel，fallback which code（restart.ts:32-63）
function locateBin(binDir: string): string {
    if (fs.existsSync(binDir)) {
        const entries = fs.readdirSync(binDir).filter(n => !n.includes("-tunnel"));
        if (entries.length) return path.join(binDir, entries[0]);
    }
    return "code"; // fallback PATH
}
