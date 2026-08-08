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

export function startPreviewServer(token: string, roots: string[] = []): PreviewServer {
    const port = findPort(BASE_PORT);
    const server = http.createServer((req, res) => handle(req, res, token, roots));
    server.on("error", (e: NodeJS.ErrnoException) => {  // v0.1审查🟡修：防 EADDRINUSE 崩 EH
        if (e.code === "EADDRINUSE") console.error(`[mp] port ${port} occupied`);
        else throw e;
    });
    server.listen(port, "127.0.0.1"); // ⚠️ 绝不 0.0.0.0
    return { server, port, token };
}

function findPort(base: number, max = base + 20): number {
    // TODO: net 试 listen EADDRINUSE 递增（v0.1 简化用 base，冲突时编码者补）
    return base;
}

function handle(req: http.IncomingMessage, res: http.ServerResponse, token: string, roots: string[]) {
    // 闸门1：Host header（防 DNS rebinding）
    const host = req.headers.host || "";
    if (!ALLOWED_HOST.test(host)) { res.writeHead(403); res.end("forbidden host"); return; }
    // 闸门2：Origin（若带）
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGIN.test(origin)) { res.writeHead(403); res.end("forbidden origin"); return; }
    if (origin) { res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin"); }

    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/ping") { res.writeHead(200); res.end("ok"); return; }
    // 闸门3：token（除 /ping）。空 token deny-all（v0.1审查🟡修：token='' 时 ''!=='' 为 false 会放行）
    if (!token || url.searchParams.get("token") !== token) { res.writeHead(403); res.end("forbidden token"); return; }

    if (url.pathname === "/config") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ port: BASE_PORT, version: "v0.1.0", maxFileSize: MAX_FILE_SIZE, types: TYPE_TABLE }));
        return;
    }
    if (url.pathname === "/preview") return servePreview(url, req, res, roots);
    res.writeHead(404); res.end("not found");
}

function servePreview(url: URL, req: http.IncomingMessage, res: http.ServerResponse, roots: string[]) {
    const file = url.searchParams.get("file");
    const type = url.searchParams.get("type");
    if (!file || !type) { res.writeHead(400); res.end("missing file or type"); return; }
    const resolved = path.resolve(file);
    // 闸门4 containment（v0.1审查🔴修）：realpath 防符号链接逃逸 + workspace 归属校验
    let realPath: string;
    try { realPath = fs.realpathSync(resolved); } catch { res.writeHead(404); res.end("not found"); return; }
    if (roots.length > 0) {
        const realRoots = roots.map(r => { try { return fs.realpathSync(r); } catch { return r; } });
        if (!realRoots.some(r => realPath === r || realPath.startsWith(r + path.sep))) {
            res.writeHead(403); res.end("outside workspace"); return;
        }
    }
    const stat = fs.statSync(realPath);
    if (stat.size > MAX_FILE_SIZE) { res.writeHead(413); res.end("too large"); return; }
    if (type === "image") return serveImage(realPath, res);
    if (type === "video" || type === "audio" || type === "pdf" || type === "3d" || type === "font") return serveStream(realPath, type, req, res);
    res.writeHead(400); res.end("unsupported type");
}

// range stream（video/audio/pdf/3d，原生 Range seek，doc04 硬化）
function serveStream(file: string, type: string, req: http.IncomingMessage, res: http.ServerResponse) {
    const stat = fs.statSync(file);
    const mimeMap: Record<string, string> = { video: "video/mp4", audio: "audio/mpeg", pdf: "application/pdf", "3d": "model/gltf-binary", font: "font/ttf" };
    const mime = mimeMap[type] || "application/octet-stream";
    const range = req.headers.range;
    if (range) {
        const m = /^bytes=(\d+)-(\d*)$/.exec(range);
        if (!m) { res.writeHead(416); res.end("invalid range"); return; }
        const start = parseInt(m[1], 10);
        const end = Math.min(m[2] ? parseInt(m[2], 10) : stat.size - 1, stat.size - 1);
        if (start > end || start >= stat.size) { res.writeHead(416); res.end("unsatisfiable"); return; }
        res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1, "Content-Type": mime });
        fs.createReadStream(file, { start, end }).pipe(res);
    } else {
        res.writeHead(200, { "Content-Length": stat.size, "Content-Type": mime, "Accept-Ranges": "bytes" });
        fs.createReadStream(file).pipe(res);
    }
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
