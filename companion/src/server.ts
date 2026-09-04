// EH localhost HTTP server。详见 doc/04_EH与Renderer通信协议.md（安全硬化真相源）。
// 五道闸门（每请求按序）：Host → Origin → CORS ACAO → 会话 token → 路径 containment（OPTIONS 不需要：overlay 用 simple GET 无自定义 header，不触发 CORS preflight）。
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn, execFile } from "child_process";
import { createHash } from "crypto";  // 0.5.29:音频旁路缓存键

const BASE_PORT = 17741;
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const ALLOWED_HOST = /^(127\.0\.0\.1|localhost|\[::1\]):(\d+)$/;
const ALLOWED_ORIGIN = /^vscode-file:|^file:/;

// 媒体类型→exts(唯一运行时消费者=test-contract-sync 闸门钉一致性;实际 MIME 走下方 MIME_BY_EXT 按扩展名。0.5.19 纠注:原"serveStream/serveImage 消费"失实)
export const TYPE_TABLE: Record<string, { exts: string[]; mime: string }> = {
    image: { exts: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"], mime: "image/*" },
    video: { exts: ["mp4", "webm", "mov", "mkv", "avi", "m4v", "flv"], mime: "video/mp4" },  // 0.5: +flv
    audio: { exts: ["mp3", "wav", "ogg", "flac", "aac", "m4a", "opus", "aiff"], mime: "audio/mpeg" },  // 0.5: +aiff
    font: { exts: ["ttf", "otf", "woff", "woff2"], mime: "font/*" },
    "3d": { exts: ["glb", "gltf", "stl", "obj", "fbx"], mime: "model/gltf-binary" },  // 0.4.3：恢复 stl/obj/fbx；0.4.5：pdf 删除
};

// 档3:ffmpeg 按需 spawn(/transcode 端点收到请求时直接 spawn,不在启动时预检——预检可能误判 + 阻塞 EH activate)

export interface PreviewServer { server: http.Server; port: number; }  // 0.5.12🔵删 token(返回字段未被 consumer 读,extension 已持入参 token)

export function startPreviewServer(token: string, roots: string[] = [], onRenamed?: (newPath: string) => void, port: number = BASE_PORT): PreviewServer {
    // 0.5.18:第 4 可选参 port 仅供测试密闭端口(传 0=临时端口);extension 调用点零改动,bake 契约 17741 与 test-contract-sync 闸门②不动
    const actualPort = findPort(port);
    const server = http.createServer((req, res) => handle(req, res, token, roots, onRenamed));
    server.on("error", (e: NodeJS.ErrnoException) => {  // v0.1审查🟡修：防 EADDRINUSE 崩 EH
        if (e.code === "EADDRINUSE") console.error(`[mp] port ${actualPort} occupied`);
        else throw e;
    });
    server.listen(actualPort, "127.0.0.1"); // ⚠️ 绝不 0.0.0.0
    return { server, port: actualPort };  // 0.5.19 注:传 port=0 时此值是请求值 0 非实际绑定端口——须读 server.address().port(唯一临时端口消费方 test-preview-freshness 已如此)
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

    let url: URL;
    try { url = new URL(req.url || "/", "http://127.0.0.1"); }  // 0.5.24 Y1:畸形请求行曾抛 TypeError→uncaughtException 崩 EH(无 token 本地进程单次 TCP 写入即可)
    catch { res.writeHead(400); res.end("bad request"); return; }
    if (url.pathname === "/ping") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true })); return; }  // 档3:overlay 探活(/transcode 按需 spawn ffmpeg,不在 ping 报状态——预检在 EH 模块加载期不可靠)
    // 闸门3：token（除 /ping）。空 token deny-all（v0.1审查🟡修：token='' 时 ''!=='' 为 false 会放行）
    if (!token || url.searchParams.get("token") !== token) { res.writeHead(403); res.end("forbidden token"); return; }

    // 审查 3.3:/config 端点已删(overlay 用硬编码 EXTS + detectMediaType,从不 fetch /config)。
    if (url.pathname === "/preview") return servePreview(url, req, res, roots);
    if (url.pathname.startsWith("/lib/")) return serveLib(url, res);  // v0.4: lazy 库（pdf.js/three）
    if (url.pathname === "/rename") return serveRename(url, res, roots, onRenamed);  // 0.4.9 文件改名（overlay 文件名点击触发）
    if (url.pathname === "/transcode") return serveTranscode(url, req, res, roots);  // 档3:ffmpeg 实时转码（非 web 容器视频 → webm/opus 流）
    if (url.pathname === "/audio") return serveAudioExtract(url, req, res, roots);  // 0.5.29:音轨提取 MP3 磁盘缓存(视频旁路/m4a 主源)
    res.writeHead(404); res.end("not found");
}

// 0.4.9 /rename：同目录改名（fs.rename）。闸门：token(已过) + newName 净化 + realpath + 双路径 containment + 同名碰撞检查。
// 0.4.10 复审加固：错误统一 JSON {ok:false,error}(原纯文本致 overlay 解析塌缩) + roots=[] fail-closed(mutation 端点) + existsSync 碰撞 409(fs.rename 普通文件原子覆盖不报 EEXIST) + 净化补纯空格/Win 保留名。
function serveRename(url: URL, res: http.ServerResponse, roots: string[], onRenamed?: (newPath: string) => void) {
    const jsonErr = (code: number, error: string) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error })); };
    const oldPath = url.searchParams.get("oldPath");
    const newName = url.searchParams.get("newName");
    if (!oldPath || !newName) return jsonErr(400, "missing params");
    if (newName.trim() === "" || /[\\/]/.test(newName) || newName === "." || newName === ".." || /[\x00-\x1f\x7f]/.test(newName) || newName.includes("\0") || newName.length > 255 || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(newName)) {
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
    // 0.5.12🟡注:read 端点(/preview //transcode) fail-open(roots=[] 放行)与 /rename fail-closed 不对称是有意——token 是主闸门(bake 进 workbench,
    //   renderer 可见但属本地威胁模型),roots 仅 workspace 防御纵深;roots 在 activate 期快照、不随后开文件夹刷新(加强需加 onWorkspaceFoldersChanged listener,留后续)
    if (roots.length > 0) {
        const realRoots = roots.map(r => { try { return fs.realpathSync(r); } catch { return r; } });
        if (!realRoots.some(r => realPath === r || realPath.startsWith(r + path.sep))) {
            res.writeHead(403); res.end("outside workspace"); return;
        }
    }
    let stat: fs.Stats;
    try { stat = fs.statSync(realPath); } catch { res.writeHead(404); res.end("not found"); return; }  // 0.5.12🟡:TOCTOU(realpath→stat 间文件被删→抛 ENOENT→无状态码 socket hangup)
    if (!stat.isFile()) { res.writeHead(404); res.end("not a file"); return; }  // 0.5.24 Y2:目录名 *.mp4 曾 EISDIR 崩 EH(detectMediaType 纯按扩展名)
    if (stat.size > MAX_FILE_SIZE) { res.writeHead(413); res.end("too large"); return; }
    if (type === "image") return serveImage(realPath, req, res, stat);
    if (type === "video" || type === "audio" || type === "3d" || type === "font") return serveStream(realPath, type, req, res, stat);
    res.writeHead(400); res.end("unsupported type");
}

// 0.5.18 版本指纹:唯一真相源(五层里只有 server 能 stat 磁盘)。size+mtimeMs 强 ETag——不用 W/ 前缀:
// 强验证器才会被 Chromium 用于 If-Range(206 分片一致性);碰撞=同尺寸+同毫秒覆盖,webpack 同款公式业界多年无事故。
// 已知良性竞态:stat 与 readFile 间文件被换→该次响应 etag 旧/字节新,下一轮协商自愈(接受,勿加锁)。
function etagOf(stat: fs.Stats): string { return '"' + stat.size + "-" + stat.mtimeMs + '"'; }
// 0.5.19(G3)注:If-None-Match/If-Range 用全串 === 比对是【有意简化】——全库唯一 HTTP 客户端=Chromium(fetch+媒体栈,原样回放单一存储 etag),
// 逗号列表/W/ 弱比较/* 通配(RFC 9110 §13.1.2)实际不可达,失配失败方向安全(→200 全量)。接入第二客户端前须补完整比较。

// range stream（video/audio/3d/font，原生 Range seek，doc04 硬化）
// MIME 按扩展名（档1 P0：原按 type 一刀切 audio/mpeg→FLAC/OGG/WAV 全错，靠 sniff 偶然工作）
const MIME_BY_EXT: Record<string, string> = {
    "mp4": "video/mp4", "webm": "video/webm", "ogg": "video/ogg", "mov": "video/mp4", "m4v": "video/mp4", "mkv": "video/x-matroska",
    "mp3": "audio/mpeg", "wav": "audio/wav", "flac": "audio/flac", "aac": "audio/aac", "m4a": "audio/mp4", "opus": "audio/ogg",
    "glb": "model/gltf-binary", "gltf": "model/gltf+json", "stl": "model/stl", "obj": "text/plain", "fbx": "application/octet-stream",
    "ttf": "font/ttf", "otf": "font/otf", "woff": "font/woff", "woff2": "font/woff2", "flv": "video/x-flv",
};
function mimeForFile(filePath: string, type: string): string {
    const ext = path.extname(filePath).slice(1).toLowerCase();
    return MIME_BY_EXT[ext] || (type === "video" ? "video/mp4" : type === "audio" ? "audio/mpeg" : "application/octet-stream");
}
function streamOut(src: fs.ReadStream, res: http.ServerResponse): void {  // 0.5.24 Y2:pipe 不转发 src error——ENOENT/EISDIR 竞态窗曾 unhandled 崩 EH;统一挂 on(error)
    src.on("error", () => { try { if (!res.destroyed) { res.destroy(); } } catch { /* ignore */ } });
    src.pipe(res);
}
function serveStream(file: string, type: string, req: http.IncomingMessage, res: http.ServerResponse, stat: fs.Stats) {
    const etag = etagOf(stat);  // 0.5.18:指纹随响应下发,新鲜度协商归 HTTP 层(原 max-age=300 无验证器=跨会话供旧唯一层)
    const mime = mimeForFile(file, type);
    const range = req.headers.range;
    if (range) {
        // 0.5.18 If-Range 守卫:缓存分片属旧版本(≠当前 etag)→弃 Range 回 200 全量,防旧分片与新字节拼接损坏
        const ifRange = req.headers["if-range"];
        if (ifRange && ifRange !== etag) {
            res.writeHead(200, { "Content-Length": stat.size, "Content-Type": mime, "Accept-Ranges": "bytes", "Cache-Control": "no-cache", "ETag": etag });
            streamOut(fs.createReadStream(file), res); return;
        }
        const m = /^bytes=(\d+)-(\d*)$/.exec(range);
        if (!m) { res.writeHead(416); res.end("invalid range"); return; }
        const start = parseInt(m[1], 10);
        const end = Math.min(m[2] ? parseInt(m[2], 10) : stat.size - 1, stat.size - 1);
        if (start > end || start >= stat.size) { res.writeHead(416); res.end("unsatisfiable"); return; }
        res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1, "Content-Type": mime, "Cache-Control": "no-cache", "ETag": etag });
        streamOut(fs.createReadStream(file, { start, end }), res);
    } else {
        if (req.headers["if-none-match"] === etag) { res.writeHead(304, { "ETag": etag, "Cache-Control": "no-cache" }); res.end(); return; }  // 0.5.18:304 协商(零字节重传)
        res.writeHead(200, { "Content-Length": stat.size, "Content-Type": mime, "Accept-Ranges": "bytes", "Cache-Control": "no-cache", "ETag": etag });  // no-cache=存储但每次协商(禁 max-age:同名覆盖跨会话供旧根因)
        streamOut(fs.createReadStream(file), res);
    }
}

// v0.4 /lib/:name —— lazy 库（pdf.min.mjs/three bundle，从 INSTALL_DIR/resources/lib/）。正则净化文件名（防穿越）
function serveLib(url: URL, res: http.ServerResponse) {
    const name = url.pathname.slice("/lib/".length);
    if (!/^[\w.\-]+$/.test(name)) { res.writeHead(400); res.end("invalid lib name"); return; }
    const libPath = path.join(__dirname, "..", "resources", "lib", name);
    try { if (!fs.statSync(libPath).isFile()) throw 0; } catch { res.writeHead(404); res.end("lib not found"); return; }  // 0.5.12🟡:statSync + catch(原 existsSync+statSync 双调用 TOCTOU + 冗余)
    res.writeHead(200, { "Content-Type": name.endsWith(".mjs") ? "text/javascript" : "application/octet-stream" });
    streamOut(fs.createReadStream(libPath), res);
}

// 图片:异步读 + base64。0.5.18:ETag 协商(指纹由 servePreview 的 stat 传入,零新增 IO);max-age=300 已删=同名覆盖供旧根因
function serveImage(file: string, req: http.IncomingMessage, res: http.ServerResponse, stat: fs.Stats) {
    const etag = etagOf(stat);
    if (req.headers["if-none-match"] === etag) { res.writeHead(304, { "ETag": etag, "Cache-Control": "no-cache" }); res.end(); return; }  // 304 只带验证器,无 body
    fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(500); res.end("read error"); return; }
        const ext = path.extname(file).slice(1);
        const mime = "image/" + (ext === "jpg" ? "jpeg" : ext === "svg" ? "svg+xml" : ext === "ico" ? "x-icon" : ext || "octet-stream");  // 0.5.12🔵:无扩展名兜底 octet-stream(原直拼得 "image/" 无效 MIME)
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache", "ETag": etag });  // no-cache=存储但每次协商(Chromium 自动 If-None-Match;fetch() 对 304 会用缓存副本重组完整 200,overlay 透明)
        res.end(JSON.stringify({ type: "image", mime, base64: data.toString("base64"), sizeBytes: data.length }));
    });
}

// 档3 ffmpeg 探测:模块级 Promise 缓存(execFile 异步,0.5.12🟡修:原 execFileSync 同步阻塞 EH event loop 最坏 8s;
// 首次 /transcode await 期间 EH 不冻结,其他请求/IPC 正常。4 候选含绝对路径,免依赖 PATH)
let _ffmpegPromise: Promise<string | null> | null = null;
function findFfmpeg(): Promise<string | null> {
    if (_ffmpegPromise) return _ffmpegPromise;
    const candidates = ["ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/bin/ffmpeg"];
    _ffmpegPromise = (async () => {
        for (const p of candidates) {
            try { await new Promise<void>((res, rej) => execFile(p, ["-version"], { timeout: 2000 }, (err: Error | null) => err ? rej(err) : res())); return p; }
            catch { /* 试下一个 */ }
        }
        return null;
    })();
    return _ffmpegPromise;
}

// 档3 /transcode: ffmpeg 实时转码非 web 格式 → fMP4(video)/WAV(audio),流式 pipe(<video>/<audio> 直吃 chunked fMP4)
let _ffprobeMissLogged = false;  // 0.5.27d 🟡-2:ffprobe 缺失降级只留痕一次
let _ffMissingLogged = false;    // 0.5.28:ffmpeg 缺失留痕一次(静默降级必留痕)
async function serveTranscode(url: URL, req: http.IncomingMessage, res: http.ServerResponse, roots: string[]) {
    let file = url.searchParams.get("file");
    const type = url.searchParams.get("type");
    if (!file || !type) { res.writeHead(400); res.end("missing params"); return; }
    if (type !== "video" && type !== "audio") { res.writeHead(400); res.end("bad type"); return; }  // 0.5.12🟡:type 白名单(防 image/3d 等误走 ffmpeg 浪费 spawn)
    if (file.startsWith("~")) file = file.replace(/^~/, os.homedir());
    const resolved = path.resolve(file);
    let realPath: string;
    try { realPath = fs.realpathSync(resolved); } catch { res.writeHead(404); res.end("not found"); return; }
    if (roots.length > 0) {  // read 端点 fail-open(roots=[] 放行)——见 servePreview 同款注释
        const realRoots = roots.map(r => { try { return fs.realpathSync(r); } catch { return r; } });
        if (!realRoots.some(r => realPath === r || realPath.startsWith(r + path.sep))) { res.writeHead(403); res.end("outside workspace"); return; }
    }
    const ff = await findFfmpeg();  // 0.5.12🟡异步:不阻塞 EH
    if (!ff || res.writableEnded) {
        if (!res.writableEnded) { res.writeHead(404); res.end("no ffmpeg"); if (!_ffMissingLogged) { _ffMissingLogged = true; console.error("[mp] /transcode 需 ffmpeg——候选路径(ffmpeg//usr/local/bin//opt/homebrew/bin//usr/bin)均未找到;AAC 家族(mp4/mov/m4v/m4a/aac)与非原生视频预览降级(回退原生,无声)"); } }  // 0.5.28 留痕(静默降级必留痕)
        return;
    }  // 无 ffmpeg→404(overlay error→回退原生);或探测期间客户端已断开
    const isAudio = type === "audio";
    // 0.5.28:vc=webm 强制走重编码路(overlay 自愈梯:remux 产物音频解码 0 字节时整转重试)——跳过 ffprobe 直取 webm
    const forceWebm = !isAudio && url.searchParams.get("vc") === "webm";
    // 0.5.27 🔴根因修正:video 输出禁 AAC(VSCode 出厂 libffmpeg 无 AAC——本机二进制已验:仅 h264/flac/mp3/pcm/vorbis/vp8
    //   +Chromium 内建 libopus;vscode#329811/#310736 同证)→ fMP4+AAC 在 workbench 里视频可见而音轨死
    //   (HasAudio()=false→原生 mute 置 disabled 死键+无声)。双路输出,全部落在 VSCode 实持有的解码器集合:
    //   ① 源视频=h264(占绝对多数:mp4/mkv-h264/flv/mov-h264)→ 【零视频重编码】remux 成 fMP4 + MP3 音轨
    //      (实测 39s 片 0.46s = 85× 实时;mp3-in-mp4 Chromium demux+decode 已 rig 实证)
    //   ② 其余(avi-mpeg4/prores/hevc…)→ webm/VP8/Opus 重编码(scale=640 保 realtime)
    //   音频支路 WAV(pcm_s16le)本就是自由编解码,不动。
    let vcodec = "";
    if (!isAudio && !forceWebm) {  // 0.5.28:vc=webm 跳过探测直取重编码
        const ffprobe = ff.replace(/ffmpeg$/, "ffprobe");
        try {
            vcodec = await new Promise<string>((res2, rej2) => execFile(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", realPath], { timeout: 4000 }, (e: Error | null, out?: string) => e ? rej2(e) : res2((out || "").trim().split("\n")[0] || "")));
        } catch { vcodec = ""; if (!_ffprobeMissLogged) { _ffprobeMissLogged = true; console.error("[mp] ffprobe 不可用 — h264 remux 快路降级为 webm 重编码慢路(ffmpeg 同源 ffprobe 缺失;0.5.8 教训:静默降级必留痕)"); } }
    }
    const remux = !forceWebm && vcodec === "h264";
    const args = isAudio
        ? ["-i", realPath, "-f", "wav", "-c:a", "pcm_s16le", "-"]
        : remux
            ? ["-i", realPath, "-c:v", "copy", "-c:a", "libmp3lame", "-b:a", "128k", "-ar", "44100", "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-"]  // -ar 44100:钉死输出采样率(ffmpeg 自动重采样因版本而异;实证 8.1.2 对 96k 源自动降采 48k 不报错——0.5.28b 审查纠注,原"会失败"论断不实)
            : ["-i", realPath, "-vf", "scale=640:-2", "-f", "webm", "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "5", "-b:v", "2M", "-c:a", "libopus", "-b:a", "96k", "-"];
    let ffmpeg;
    try { ffmpeg = spawn(ff, args, { stdio: ["ignore", "pipe", "pipe"] }); }
    catch { res.writeHead(500); res.end("spawn failed"); return; }
    let headersSent = false;
    let stderrBuf = "";
    ffmpeg.stderr?.on("data", (d: Buffer) => { if (stderrBuf.length < 800) stderrBuf += d.toString(); });
    ffmpeg.on("error", () => { try { if (!headersSent) { headersSent = true; res.writeHead(500); res.end("ffmpeg error"); } else res.end(); } catch { /* ignore */ } });
    ffmpeg.on("close", (code: number) => { if (code !== 0) console.error(`[mp] ffmpeg exited ${code} (${path.basename(realPath)}): ${stderrBuf.slice(0, 400)}`); });
    res.writeHead(200, { "Content-Type": isAudio ? "audio/wav" : remux ? "video/mp4" : "video/webm", "Cache-Control": "no-store" });  // 0.5.27:双路 remux=mp4 / 重编码=webm
    headersSent = true;
    ffmpeg.stdout.pipe(res);
    req.on("close", () => { try { ffmpeg.kill("SIGKILL"); } catch { /* ignore */ } });
}

// ===== 0.5.29 音频旁路:/audio —— 音轨提取 MP3 磁盘缓存 =====
// 背景:VSCode 出厂 libffmpeg 无 AAC 解码器(nm 二进制定案)——原生 <video> 的 AAC 轨零解码。
// 架构:视频回归【原文件直读】(完整时长/秒拖,回归用户要的最初方案形态),音频走旁路:
//   ffmpeg 提取音轨 → MP3(宿主实持解码器,纯 .mp3 文件零容器变量)→ 磁盘缓存(键=path|size|mtimeMs,
//   同名覆盖自动失效,与新鲜度哲学一致)→ 完整 Content-Length + Range 服务(audio 元素拿到全量时长)。
//   .noaudio 负缓存标记(确定性失败)防重复 spawn。首次实测 39s 片 1.36s(≈29× 实时,rig5),此后零成本。
const AUDIO_CACHE_DIR = path.join(os.homedir(), process.platform === "darwin" ? path.join("Library", "Caches") : ".cache", "vscode-resource-hover-preview");
const AUDIO_CACHE_MAX_BYTES = 300 * 1024 * 1024;
function cacheEvict(keepPath: string): void {  // 懒驱逐:超 300MB 删最旧(跳过 keepPath;异常静默——缓存非正确性依赖)
    try {
        const entries = fs.readdirSync(AUDIO_CACHE_DIR).map(f => { const p = path.join(AUDIO_CACHE_DIR, f); try { return { p, st: fs.statSync(p) }; } catch { return null; } }).filter(Boolean) as { p: string; st: fs.Stats }[];
        let total = entries.reduce((a, e) => a + e.st.size, 0);
        if (total <= AUDIO_CACHE_MAX_BYTES) return;
        entries.filter(e => e.p !== keepPath).sort((a, b) => a.st.mtimeMs - b.st.mtimeMs).forEach(e => {
            if (total <= AUDIO_CACHE_MAX_BYTES) return;
            try { fs.unlinkSync(e.p); total -= e.st.size; } catch { /* ignore */ }
        });
    } catch { /* ignore */ }
}
// 静态文件 Range 服务(完整 Content-Length → <audio> 全量时长;audio/mpeg)
function serveStaticAudio(file: string, stat: fs.Stats, etag: string, req: http.IncomingMessage, res: http.ServerResponse): void {
    const range = req.headers.range;
    const base = { "Content-Type": "audio/mpeg", "Accept-Ranges": "bytes", "Cache-Control": "no-cache", "ETag": etag };
    if (req.headers["if-none-match"] === etag) { res.writeHead(304, { "ETag": etag, "Cache-Control": "no-cache" }); res.end(); return; }
    if (range) {
        const m = /^bytes=(\d+)-(\d*)$/.exec(range);
        if (!m) { res.writeHead(416); res.end("invalid range"); return; }
        const start = parseInt(m[1], 10), end = Math.min(m[2] ? parseInt(m[2], 10) : stat.size - 1, stat.size - 1);
        if (start > end || start >= stat.size) { res.writeHead(416); res.end("unsatisfiable"); return; }
        res.writeHead(206, { ...base, "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Content-Length": end - start + 1 });
        streamOut(fs.createReadStream(file, { start, end }), res); return;
    }
    res.writeHead(200, { ...base, "Content-Length": stat.size });
    streamOut(fs.createReadStream(file), res);
}
// 0.5.30 ensureAudioCacheByPath:音轨提取缓存单一入口(/audio 端点 + EH 启动预热 双消费,零漂移)。
// 去重:_audioJobs 并发表(同键并发只跑一个 ffmpeg;端点用户请求与预热任务同文件时天然合流)。
// lowPriority:预热走 /usr/bin/nice -n 10(macOS)——用户实时请求不 nice,OS 调度器天然优先级反转。
const _audioJobs = new Map<string, Promise<string | null>>();
export async function ensureAudioCacheByPath(filePath: string, lowPriority: boolean): Promise<string | null> {
    let realPath: string;
    try { realPath = fs.realpathSync(path.resolve(filePath)); } catch { return null; }
    let stat: fs.Stats;
    try { stat = fs.statSync(realPath); if (!stat.isFile() || stat.size > MAX_FILE_SIZE) return null; } catch { return null; }
    const key = createHash("sha1").update(realPath + "|" + stat.size + "|" + stat.mtimeMs).digest("hex").slice(0, 24);
    const cached = path.join(AUDIO_CACHE_DIR, key + ".mp3"), marker = path.join(AUDIO_CACHE_DIR, key + ".noaudio");
    if (fs.existsSync(marker)) return null;  // 确定性失败负缓存(文件变更→新键自动失效)
    if (fs.existsSync(cached)) return cached;
    const running = _audioJobs.get(key);
    if (running) return running;  // 同键合流
    const job = (async (): Promise<string | null> => {
        const ff = await findFfmpeg();
        if (!ff) return null;
        try { fs.mkdirSync(AUDIO_CACHE_DIR, { recursive: true }); } catch { return null; }
        const tmp = cached + "." + Date.now() + ".mp3";  // ⚠️ 须 .mp3 后缀:ffmpeg 按扩展名推输出格式,.tmp 会失败(0.5.29 rig 实证;配合显式 -f mp3 双保险)
        const argv = ["-i", realPath, "-vn", "-c:a", "libmp3lame", "-b:a", "192k", "-ar", "44100", "-f", "mp3", tmp];
        let ffTimeout = false;
        const ok = await new Promise<boolean>(r2 => {
            const run = (bin: string, pre: string[]) => execFile(bin, [...pre, ...argv], { timeout: 120000, windowsHide: true }, (e: Error | null, _so?: string, se?: string) => {  // 0.5.30b:windowsHide(Windows 默认弹控制台黑框,Node child_process 文档)
                if (e) { ffTimeout = !!(e as { killed?: boolean }).killed; console.error("[mp] /audio 提取失败" + (ffTimeout ? "(超时)" : "") + ":", (se || e.message || "").slice(0, 300)); }
                r2(!e);
            });
            if (lowPriority && process.platform === "darwin" && fs.existsSync("/usr/bin/nice")) run("/usr/bin/nice", ["-n", "10"]);
            else run(ff, []);
        });
        try {
            const st2 = ok ? fs.statSync(tmp) : null;
            if (st2 && st2.size > 0) { fs.renameSync(tmp, cached); cacheEvict(cached); return cached; }  // 原子落位(并发双写者 last-win 无害)
            try { fs.unlinkSync(tmp); } catch { /* ignore */ }
            if (!ffTimeout) fs.writeFileSync(marker, "");  // 超时(killed)不落负缓存——瞬时失败允许下轮重试
            return null;
        } catch { try { fs.unlinkSync(tmp); } catch { /* ignore */ } return null; }
    })();
    _audioJobs.set(key, job);
    const clear = () => { _audioJobs.delete(key); };
    job.then(clear, clear);
    return job;
}

async function serveAudioExtract(url: URL, req: http.IncomingMessage, res: http.ServerResponse, roots: string[]) {
    let file = url.searchParams.get("file");
    if (!file) { res.writeHead(400); res.end("missing file"); return; }
    if (file.startsWith("~")) file = file.replace(/^~/, os.homedir());
    const resolved = path.resolve(file);
    let realPath: string;
    try { realPath = fs.realpathSync(resolved); } catch { res.writeHead(404); res.end("not found"); return; }
    if (roots.length > 0) {  // containment 同 /preview
        const realRoots = roots.map(r => { try { return fs.realpathSync(r); } catch { return r; } });
        if (!realRoots.some(r => realPath === r || realPath.startsWith(r + path.sep))) { res.writeHead(403); res.end("outside workspace"); return; }
    }
    const cachedPath = await ensureAudioCacheByPath(realPath, false);
    if (!cachedPath) { res.writeHead(404); res.end("no audio"); return; }  // 无音轨/无 ffmpeg/提取失败(负缓存已按需落)
    let cstat: fs.Stats;
    try { cstat = fs.statSync(cachedPath); } catch { res.writeHead(500); res.end("cache miss"); return; }
    serveStaticAudio(cachedPath, cstat, etagOf(cstat), req, res);  // 0.5.29c 🔴-1修:etagOf(缓存键内容寻址,同键字节不变/覆盖换键恒新)
}
