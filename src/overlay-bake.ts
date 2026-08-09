// overlay.js + mp-config.js 编译。详见 doc/01 overlay.js 编译/打包 + doc/parse/pares1.md#1.3。
// 分工（pares1 决策）：mp-overlay.js 内容固定 per version（patcher bake，不含 port/token）；
//   mp-config.js 运行时配置（companion bake，每次 activate port/token 变）。overlay 读 window.__MP_CONFIG__。
// 复用 cc-status-dot buildIIFE bake 范式（banner hash 迭代）。
import { createHash } from "node:crypto";

export interface OverlayConfig {
    port: number;
    token: string;
    version: string;
    enabled?: boolean;  // 运行时开关（审查 2.4）：=== false 时 overlay IIFE 直接 return
}

// bake mp-overlay.js：banner 替换（version + content-hash），不碰 __MP_CONFIG__（运行时由 mp-config.js 注入）。
// templateJs 顶部 banner `/*mp-overlay:__VERSION__:__HASH__*/`。
export function buildOverlayJs(templateJs: string, version: string): { js: string; hash: string } {
    let js = templateJs;
    // hash 基于 banner 占位未替换的内容（banner 本身不含语义，算 hash 时先去掉占位避免循环）
    const stripped = js.replace("/*mp-overlay:__VERSION__:__HASH__*/", "");
    const hash = createHash("sha256").update(stripped).digest("hex").slice(0, 8);
    js = js.replace("/*mp-overlay:__VERSION__:__HASH__*/", `/*mp-overlay:${version}:${hash}*/`);
    return { js, hash };
}

// bake mp-config.js（companion 用，每次 activate 写 workbench 目录）。
// 纯 window 属性赋值（非 inline script、非 TT sink），script-src 'self' 放行 + TT 不管（spike6 实证）。
// enabled 仅在 === false 时写入（默认不写 → overlay 视为 true，避免老 mp-config 误关，审查 2.4）。
export function buildConfigJs(config: OverlayConfig): string {
    const safe = { ...config };
    if (safe.enabled === undefined) delete safe.enabled;
    return `/*mp-config:baked*/\nwindow.__MP_CONFIG__ = ${JSON.stringify(safe)};\n`;
}
