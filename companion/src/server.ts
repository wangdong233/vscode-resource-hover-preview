// EH localhost HTTP server。详见 doc/04_EH与Renderer通信协议.md（安全硬化真相源）。
// 六道闸门（每请求按序）：OPTIONS → Host → Origin → CORS ACAO → 会话 token → 路径 containment。
import * as http from "http";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

const BASE_PORT = 17741;
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const ALLOWED_HOST = /^(127\.0\.0\.1|localhost|\[::1\]):(\d+)$/;
const ALLOWED_ORIGIN = /^vscode-file:|^file:/;

// 媒体类型→mime 单一真相源（/config 端点，overlay 消费，不硬编码 MEDIA_TYPES）
export const TYPE_TABLE: Record<string, { exts: string[]; mime: string }> = {
    image: { exts: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"], mime: "image/*" },
    video: { exts: ["mp4", "webm", "mov", "mkv", "avi", "m4v"], mime: "video/mp4" },
    audio: { exts: ["mp3", "wav", "ogg", "flac", "aac", "m4a", "opus"], mime: "audio/mpeg" },
    font: { exts: ["ttf", "otf", "woff", "woff2"], mime: "font/*" },
    pdf: { exts: ["pdf"], mime: "application/pdf" },
    "3d": { exts: ["glb", "gltf", "obj", "stl", "fbx"], mime: "model/gltf-binary" },
};

export interface PreviewServer { server: http.Server; port: number; token: string; }

export function startPreviewServer(token: string): PreviewServer {
    const port = findPort(BASE_PORT);
    const server = http.createServer((req, res) => handle(req, res, token));
    server.listen(port, "127.0.0.1"); // ⚠️ 绝不 0.0.0.0
    return { server, port, token };
}

function findPort(base: number, max = base + 20): number {
    // TODO: net 试 listen EADDRINUSE 递增（v0.1 简化用 base，冲突时编码者补）
    return base;
}

function handle(req: http.IncomingMessage, res: http.ServerResponse, token: string) {
    // 闸门1：Host header（防 DNS rebinding）
    const host = req.headers.host || "";
    if (!ALLOWED_HOST.test(host)) { res.writeHead(403); res.end("forbidden host"); return; }
    // 闸门2：Origin（若带）
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGIN.test(origin)) { res.writeHead(403); res.end("forbidden origin"); return; }
    if (origin) { res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin"); }

    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/ping") { res.writeHead(200); res.end("ok"); return; }
    // 闸门3：token（除 /ping）
    if (url.searchParams.get("token") !== token) { res.writeHead(403); res.end("forbidden token"); return; }

    if (url.pathname === "/config") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ port: BASE_PORT, version: "v0.1.0", maxFileSize: MAX_FILE_SIZE, types: TYPE_TABLE }));
        return;
    }
    if (url.pathname === "/preview") return servePreview(url, res);
    res.writeHead(404); res.end("not found");
}

function servePreview(url: URL, res: http.ServerResponse) {
    const file = url.searchParams.get("file");
    const type = url.searchParams.get("type");
    if (!file || !type) { res.writeHead(400); res.end("missing file or type"); return; }
    // 闸门4：路径 containment（防穿越 + 符号链接；v0.1 简化：须存在 + 大小限；编码者补 isWithin workspace + realpath）
    const resolved = path.resolve(file);
    if (!fs.existsSync(resolved)) { res.writeHead(404); res.end("not found"); return; }
    const stat = fs.statSync(resolved);
    if (stat.size > MAX_FILE_SIZE) { res.writeHead(413); res.end("too large"); return; }
    // TODO: isWithin(workspaceRoots) + fs.realpathSync 防符号链接逃逸（doc04 三层防御）
    if (type === "image") return serveImage(resolved, res);
    // v0.2+: video/audio/pdf/3d range stream / font
    res.writeHead(400); res.end("unsupported type (v0.1 image only)");
}

// 图片：异步读 + base64（v0.1 原图；大图缩放推迟）
function serveImage(file: string, res: http.ServerResponse) {
    fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(500); res.end("read error"); return; }
        const ext = path.extname(file).slice(1);
        const mime = "image/" + (ext === "jpg" ? "jpeg" : ext);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: "image", mime, base64: data.toString("base64"), sizeBytes: data.length }));
    });
}
