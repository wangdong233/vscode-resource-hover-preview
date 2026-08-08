// overlay.js + mp-config.js 编译/打包。详见 doc/01 overlay.js 编译/打包。
// 复用 cc-status-dot buildIIFE bake 范式（适配为文件级：注入 <script src> 而非 splice 进 extension.js）。
import fs from "node:fs";
import { createHash } from "node:crypto";

const OVERLAY_TEMPLATE_PATH = "resources/overlay.template.js"; // 相对项目根（运行时 cwd）

export interface OverlayConfig {
    port: number;       // server actualPort（递增后烘焙实际值）
    token: string;      // 会话 token（crypto.randomBytes(32)）
    version: string;    // INJECT_VERSION
}

// bake mp-overlay.js：模板占位符替换 → 返回 {js, hash}
// ⚠️ port/token/version 单源真相（只在 patcher 定义），bake 进字节（同 cc-status-dot cfgLiteral）。
export function buildOverlayJs(config: OverlayConfig): { js: string; hash: string } {
    let js = fs.readFileSync(OVERLAY_TEMPLATE_PATH, "utf8");
    js = js.replace("__MP_CONFIG__", JSON.stringify(config)); // 烘焙配置（config 也可单独 mp-config.js，见 buildConfigJs）
    // banner 替换：先算 hash（基于已替换内容的 sha256 前 8），再填 banner
    const hash = createHash("sha256").update(js).digest("hex").slice(0, 8);
    js = js.replace("/*mp-overlay:__VERSION__:__HASH__*/", `/*mp-overlay:${config.version}:${hash}*/`);
    return { js, hash };
}

// bake mp-config.js（静态外链，烘焙 port/token）。
// 纯 window 属性赋值（非 inline script、非 TT sink），script-src 'self' 放行 + TT 不管（spike6 实证）。
export function buildConfigJs(config: OverlayConfig): string {
    return `/*mp-config:baked*/\nwindow.__MP_CONFIG__ = ${JSON.stringify(config)};\n`;
}
