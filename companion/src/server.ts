// EH localhost HTTP server。详见 doc/04_EH与Renderer通信协议.md（安全硬化真相源）。
// 六道闸门（每请求按序）：OPTIONS → Host → Origin → CORS ACAO → 会话 token → 路径 containment。
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const BASE_PORT = 17741;
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const ALLOWED_HOST = /^(127\.0\.0\.1|localhost|\[::1\]):(\d+)$/;
const ALLOWED_ORIGIN = /^vscode-file:|^file:/;

// 媒体类型→mime（serveStream/serveImage 消费；overlay 用本地 *_EXTS 双轨，per-type sync 由 test-contract-sync 闸门保证一致）
export const TYPE_TABLE: Record<string, { exts: string[]; mime: string }> = {
    image: { exts: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"], mime: "image/*" },
    video: { exts: ["mp4", "webm", "mov", "mkv", "avi", "m4v"], mime: "video/mp4" },
    audio: { exts: ["mp3", "wav", "ogg", "flac", "aac", "m4a", "opus"], mime: "audio/mpeg" },
    font: { exts: ["ttf", "otf", "woff", "woff2"], mime: "font/*" },
    "3d": { exts: ["glb", "gltf", "stl", "obj", "fbx"], mime: "model/gltf-binary" },  // 0.4.3：恢复 stl/obj/fbx；0.4.5：pdf 删除
};

export interface PreviewServer { server: http.Server; port: number; token: string; }

export function startPreviewServer(token: string, roots: string[] = [], onRenamed?: (newPath: string) => void): PreviewServer {
    const port = findPort(BASE_PORT);
    const server = http.createServer((req, res) => handle(req, res, token, roots, onRenamed));
    server.on("error", (e: NodeJS.ErrnoException) => {  // v0.1审查🟡修：防 EADDRINUSE 崩 EH
        if (e.code === "EADDRINUSE") console.error(`[mp] port ${port} occupied`);
        else throw e;
    });
    server.listen(port, "127.0.0.1"); // ⚠️ 绝不 0.0.0.0
    return { server, port, token };
}

function findPort(base: number): number {
    // port 固定 17741（与 patcher bake mp-config 契约锁定，overlay fetch 该端口；不可漂移）。
    // 冲突时由 server.on("error") EADDRINUSE 报错，用户手改 BASE_PORT（双源同步 test-contract-sync 闸门）。
    return base;
}

function handle(req: http.IncomingMessage, res: http.ServerResponse, token: string, roots: string[], onRenamed?: (newPath: string) => void) {
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

    // 审查 3.3：/config 端点已删（overlay 用硬编码 EXTS + detectMediaType，从不 fetch /config；
    //   version/mime/types 字段运行时全死）。TYPE_TABLE 保留（serveStream/serveImage 消费 + test-contract-sync 闸门）。
    if (url.pathname === "/preview") return servePreview(url, req, res, roots);
    if (url.pathname.startsWith("/lib/")) return serveLib(url, res);  // v0.4: lazy 库（pdf.js/three）
    if (url.pathname === "/rename") return serveRename(url, res, roots, onRenamed);  // 0.4.9 文件改名（overlay 文件名点击触发）
    res.writeHead(404); res.end("not found");
}

// 0.4.9 /rename：同目录改名（fs.rename）。闸门：token(已过) + newName 净化 + realpath + 双路径 containment + 同名碰撞检查。
// 0.4.10 复审加固：错误统一 JSON {ok:false,error}(原纯文本致 overlay 解析塌缩) + roots=[] fail-closed(mutation 端点) + existsSync 碰撞 409(fs.rename 普通文件原子覆盖不报 EEXIST) + 净化补纯空格/Win 保留名。
function serveRename(url: URL, res: http.ServerResponse, roots: string[], onRenamed?: (newPath: string) => void) {
    const jsonErr = (code: number, error: string) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error })); };
    const oldPath = url.searchParams.get("oldPath");
    const newName = url.searchParams.get("newName");
    if (!oldPath || !newName) return jsonErr(400, "missing params");
    if (newName.trim() === "" || /[\\/]/.test(newName) || newName === "." || newName === ".." || newName.includes("\0") || newName.length > 255 || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(newName)) {
        return jsonErr(400, "invalid name");  // 净化：纯空格/路径分隔符/./../null/超长/Windows 保留名
    }
    if (roots.length === 0) return jsonErr(403, "no workspace");  // 🟡 fail-closed：mutation 端点无 workspace 默认拒（防本机进程借 token 改任意文件）
    let oldReal = oldPath.startsWith("~") ? oldPath.replace(/^~/, os.homedir()) : oldPath;
    try { oldReal = fs.realpathSync(path.resolve(oldReal)); } catch { return jsonErr(404, "not found"); }
    const newPath = path.join(path.dirname(oldReal), newName);  // 同目录 + 纯文件名（newName 已净化）
    const realRoots = roots.map(r => { try { return fs.realpathSync(r); } catch { return r; } });
    const inside = (p: string) => realRoots.some(r => p === r || p.startsWith(r + path.sep));
    if (!inside(oldReal) || !inside(newPath)) return jsonErr(403, "outside workspace");  // 双路径 containment
    if (fs.existsSync(newPath) && newPath !== oldReal) return jsonErr(409, "exists");  // 🟡 同名碰撞 → 409（防 fs.rename 原子覆盖静默丢数据）
    fs.rename(oldReal, newPath, err => {
        if (err) { const code = err.code || ""; return jsonErr(code === "ENOENT" ? 404 : 500, code || "rename error"); }
        if (typeof onRenamed === "function") { try { onRenamed(newPath); } catch (e) { /* ignore */ } }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, newPath }));
    });
}

function servePreview(url: URL, req: http.IncomingMessage, res: http.ServerResponse, roots: string[]) {
    let file = url.searchParams.get("file");
    const type = url.searchParams.get("type");
    if (!file || !type) { res.writeHead(400); res.end("missing file or type"); return; }
    // aria-label 路径来自 labelService.getUriLabel，desktop 默认 tildify（~/Documents/...）
    // Node path.resolve 不展开 ~ → 当相对 cwd 解析 → realpathSync ENOENT → 404。须先映射 homedir。
    if (file.startsWith("~")) file = file.replace(/^~/, os.homedir());
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
    if (type === "video" || type === "audio" || type === "3d" || type === "font") return serveStream(realPath, type, req, res);
    res.writeHead(400); res.end("unsupported type");
}

// range stream（video/audio/3d/font，原生 Range seek，doc04 硬化）
function serveStream(file: string, type: string, req: http.IncomingMessage, res: http.ServerResponse) {
    const stat = fs.statSync(file);
    const mimeMap: Record<string, string> = { video: "video/mp4", audio: "audio/mpeg", "3d": "model/gltf-binary", font: "font/ttf" };
    const mime = mimeMap[type] || "application/octet-stream";
    const range = req.headers.range;
    if (range) {
        const m = /^bytes=(\d+)-(\d*)$/.exec(range);
        if (!m) { res.writeHead(416); res.end("invalid range"); return; }
        const start = parseInt(m[1], 10);
        const end = Math.min(m[2] ? parseInt(m[2], 10) : stat.size - 1, stat.size - 1);
        if (start > end || start >= stat.size) { res.writeHead(416); res.end("unsatisfiable"); return; }
        res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1, "Content-Type": mime, "Cache-Control": "private, max-age=300" });
        fs.createReadStream(file, { start, end }).pipe(res);
    } else {
        res.writeHead(200, { "Content-Length": stat.size, "Content-Type": mime, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=300" });  // Wave3 c：HTTP 缓存（video/audio 流式，不经 overlay blob 缓存）
        fs.createReadStream(file).pipe(res);
    }
}

// v0.4 /lib/:name —— lazy 库（pdf.min.mjs/three bundle，从 INSTALL_DIR/resources/lib/）。正则净化文件名（防穿越）
function serveLib(url: URL, res: http.ServerResponse) {
    const name = url.pathname.slice("/lib/".length);
    if (!/^[\w.\-]+$/.test(name)) { res.writeHead(400); res.end("invalid lib name"); return; }
    const libPath = path.join(__dirname, "..", "resources", "lib", name);
    if (!fs.existsSync(libPath) || !fs.statSync(libPath).isFile()) { res.writeHead(404); res.end("lib not found"); return; }
    res.writeHead(200, { "Content-Type": name.endsWith(".mjs") ? "text/javascript" : "application/octet-stream" });
    fs.createReadStream(libPath).pipe(res);
}

// 图片：异步读 + base64（v0.1 原图；大图缩放推迟）
function serveImage(file: string, res: http.ServerResponse) {
    fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(500); res.end("read error"); return; }
        const ext = path.extname(file).slice(1);
        const mime = "image/" + (ext === "jpg" ? "jpeg" : ext === "svg" ? "svg+xml" : ext === "ico" ? "x-icon" : ext);  // 复审：svg→svg+xml / ico→x-icon（非标直拼 Chromium 靠嗅探,显式映射确定性）
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "private, max-age=300" });
        res.end(JSON.stringify({ type: "image", mime, base64: data.toString("base64"), sizeBytes: data.length }));
    });
}
