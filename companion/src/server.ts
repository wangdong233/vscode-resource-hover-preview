// EH localhost HTTP server。详见 doc/04_EH与Renderer通信协议.md（安全硬化真相源）。
// 六道闸门（每请求按序）：OPTIONS → Host header → Origin → CORS ACAO → 会话 token → 路径 containment。
import * as http from "http";
import * as crypto from "crypto";
import * as path from "path";

const BASE_PORT = 17741;
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const ALLOWED_HOST = /^(127\.0\.0\.1|localhost|\[::1\]):(\d+)$/;
const ALLOWED_ORIGIN = /^vscode-file:|^file:/;

// 媒体类型→mime 单一真相源（04 /config 端点，overlay 启动 fetch 消费，不硬编码 MEDIA_TYPES）
export const TYPE_TABLE: Record<string, { exts: string[]; mime: string }> = {
    image: { exts: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"], mime: "image/*" },
    video: { exts: ["mp4", "webm", "mov", "mkv", "avi", "m4v"], mime: "video/mp4" },
    audio: { exts: ["mp3", "wav", "ogg", "flac", "aac", "m4a", "opus"], mime: "audio/mpeg" },
    font: { exts: ["ttf", "otf", "woff", "woff2"], mime: "font/*" },
    pdf: { exts: ["pdf"], mime: "application/pdf" },
    "3d": { exts: ["glb", "gltf", "obj", "stl", "fbx"], mime: "model/gltf-binary" },
};

export function startPreviewServer(): { server: http.Server; port: number; token: string } {
    const token = crypto.randomBytes(32).toString("hex"); // 会话 token（非一次性，per-instance）
    const port = findPort(BASE_PORT);
    const server = http.createServer((req, res) => handle(req, res, token));
    server.listen(port, "127.0.0.1"); // ⚠️ 绝不 0.0.0.0（暴露 LAN）
    return { server, port, token };
}

function findPort(base: number, max = base + 20): number {
    // TODO: net.createServer().listen 试，EADDRINUSE → base+1，上限 max
    return base;
}

function handle(req: http.IncomingMessage, res: http.ServerResponse, token: string) {
    // TODO doc04 六道闸门：
    // 1. Host header 校验（防 DNS rebinding）：req.headers.host 须匹配 ALLOWED_HOST
    // 2. Origin 校验：若带，须匹配 ALLOWED_ORIGIN
    // 3. CORS ACAO：同源回显 + Vary: Origin，绝不用 *
    // 4. 会话 token（除 /ping）：query.token === token，否则 403
    // 5. 路径 containment：new URL + path.resolve + fs.realpathSync（解符号链接）+ isWithin(workspaceRoots)
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/ping") { res.writeHead(200); res.end("ok"); return; }
    if (url.pathname === "/config") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ port: BASE_PORT, version: "v0.1.0", maxFileSize: MAX_FILE_SIZE, types: TYPE_TABLE }));
        return;
    }
    // TODO: /preview（image→base64 JSON / video|audio|pdf|3d→range stream / font→JSON）
    // TODO: /resolve（aria-label 先验免索引，fallback 查 index）
    // TODO: /lib/:name（lazy 库 pdf.js/three.js，正则净化文件名）
    res.writeHead(404); res.end("not found");
}
