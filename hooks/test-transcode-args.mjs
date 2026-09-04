// test-transcode-args：ffmpeg 转码参数契约闸门（03 §1.2 项8 宿主契约 + §1.7 项7 可机械化 + §2.2 项4 producer 契约同步）。
// 📕 起源：0.5.0 引入 /transcode 时 movflags 写成 "frag+emptymoov+default_base_moof"（凭记忆，从未真跑），
//   ffmpeg 解析失败 "Undefined constant 'frag'" → stdout 0 字节 → <video> error → 静默 hidePopup。潜伏到 0.5.7 才被发现。
// 📕 0.5.27 二轮同族教训:video 支路换 webm/VP8/Opus(🔴根因:VSCode 出厂 libffmpeg 无 AAC——fMP4+AAC 在 workbench
//   里音轨死)。本闸门改抽 webm 参数并真跑断言:容器 EBML(webm) + vp8 流 + opus 流。若有人把 -c:a 改回 aac/
//   容器改回 mp4 → 本测 fail(而非潜伏到用户——AAC 在 VSCode 里 0 解码)。
//
// 准入：companion/src/server.ts 存在 + 环境有 ffmpeg（无则 skip，不阻断无 ffmpeg 的 CI）。
// 准出：① webm 参数可从源码抽出(-f webm/-c:v libvpx/-c:a libopus/scale=640) ② 真跑产非空 stdout
//       ③ stdout 为合法 EBML(webm) 且 ffprobe 见 vp8+opus 流。
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SERVER_SRC = join(ROOT, "companion", "src", "server.ts");
const TMP = join(HERE, "..", ".transcode-fixture");

function fail(msg) { console.error("❌ test-transcode-args: " + msg); process.exit(1); }

// ① 抽双路参数（源码 ↔ 运行 同源：测源码里的串，不是硬编码副本——改源码即改被测值）
const src = readFileSync(SERVER_SRC, "utf8");
const m = src.match(/"-movflags",\s*"([^"]+)"/);
if (!m) fail("未在 server.ts 抽到 movflags 字面量(remux 路需要;0.5.0 错token教训)");
const movflags = m[1];
const hasRemux = /"-c:v",\s*"copy",\s*"-c:a",\s*"libmp3lame"/.test(src);
const hasProbe = /ffprobe/.test(src) && /vcodec === "h264"/.test(src);
const hasVpx = /"-c:v",\s*"libvpx"/.test(src);
const hasOpus = /"-c:a",\s*"libopus"/.test(src);
const hasScale = /"-vf",\s*"scale=640:-2"/.test(src);
if (!hasRemux) fail("缺 h264 remux 路(-c:v copy + libmp3lame;h264 源零重编码=85× 实时)");
if (!hasProbe) fail("缺 ffprobe 探测源视频编码(vcodec=h264 分流)");
if (!hasVpx || !hasOpus || !hasScale) fail("缺 webm 重编码路(libvpx/libopus/scale=640;非 h264 源)");
if (/"-c:a",\s*"aac"/.test(src)) fail("转码输出残留 -c:a aac(🔴VSCode libffmpeg 无 AAC 解码器=音轨死键回归;音频输出只允许 pcm_s16le/libmp3lame/libopus)");
console.log("[1/5] 双路参数抽自源码 ✓ (remux copy+mp3 / webm vpx+opus / movflags=" + movflags + ")");

// ② 同步抽 audio args 里的 wav 编码（防音频路径参数漂移）
const hasWav = /"-f",\s*"wav",\s*"-c:a",\s*"pcm_s16le"/.test(src);
if (!hasWav) fail("audio transcode args 不含 -f wav -c:a pcm_s16le（AIFF/M4A→WAV 路径是否被改？）");
console.log("[2/4] audio wav args 存在 ✓");

// ③ ffmpeg 可用性（无 ffmpeg → skip，不阻断无 ffmpeg 环境）
const ff = ["ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/bin/ffmpeg"]
    .find(p => { try { spawnSync(p, ["-version"], { stdio: "ignore", timeout: 2000 }); return true; } catch { return false; } });
if (!ff) { console.log("[3/4] ffmpeg 未安装 → skip（本闸门在有 ffmpeg 的开发机/CI 跑）"); console.log("OK: test-transcode-args（skipped: no ffmpeg）"); process.exit(0); }
console.log(`[3/4] ffmpeg 可用: ${ff}`);

// ④ 双路真跑:remux 路(h264+aac 输入→copy+mp3)+ webm 路(mpeg4 输入→vp8+opus)
const avi = TMP + ".avi", webm = TMP + ".webm", rmx = TMP + "-r.mp4";
let r = spawnSync(ff, ["-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-c:a", "aac", "-shortest", avi, "-y"], { stdio: "ignore" });
if (r.status !== 0) fail("生成测试 MP4/AVI 失败（ffmpeg lavfi 不可用？）");
// remux 路(源码同款 -c:v copy + libmp3lame + movflags)
r = spawnSync(ff, ["-i", avi, "-c:v", "copy", "-c:a", "libmp3lame", "-b:a", "128k", "-f", "mp4", "-movflags", movflags, "-"], {
    stdio: ["ignore", "pipe", "ignore"], encoding: "buffer", maxBuffer: 50 * 1024 * 1024, timeout: 30000
});
if (r.status !== 0 || !r.stdout || r.stdout.length === 0) fail(`remux 路失败(status=${r.status})——movflags "${movflags}" 错 token?(0.5.0 教训:应为 frag_keyframe+empty_moov+default_base_moof)`);
writeFileSync(rmx, r.stdout);
let pr = spawnSync(ff.replace(/ffmpeg$/, "ffprobe"), ["-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0", rmx], { encoding: "utf8", timeout: 15000 });
if (!/h264/.test(pr.stdout || "")) fail("remux 产物视频流非 h264(copy 失效?): " + (pr.stdout || "").trim());
if (!/mp3/.test(pr.stdout || "")) fail("remux 产物音频流非 mp3: " + (pr.stdout || "").trim());
console.log(`[4/5] remux 路: ${r.stdout.length}B → h264+mp3 ✓`);
// webm 路(源码同款)
r = spawnSync(ff, ["-i", avi, "-vf", "scale=640:-2", "-f", "webm", "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "5", "-b:v", "2M", "-c:a", "libopus", "-b:a", "96k", "-"], {
    stdio: ["ignore", "pipe", "ignore"], encoding: "buffer", maxBuffer: 50 * 1024 * 1024, timeout: 60000
});
if (r.status !== 0 || !r.stdout || r.stdout.length === 0) fail("webm 转码失败(参数集不可用)");
const EBML = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
if (!r.stdout.slice(0, 4).equals(EBML)) fail("webm 产物非 EBML 头: " + r.stdout.slice(0, 4).toString("hex"));
writeFileSync(webm, r.stdout);
pr = spawnSync(ff.replace(/ffmpeg$/, "ffprobe"), ["-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0", webm], { encoding: "utf8", timeout: 15000 });
if (!/vp8/.test(pr.stdout || "")) fail("webm 产物无 vp8: " + (pr.stdout || "").trim());
if (!/opus/.test(pr.stdout || "")) fail("webm 产物无 opus: " + (pr.stdout || "").trim());
console.log(`[5/5] webm 路: ${r.stdout.length}B → vp8+opus ✓`);

// 清理
try { unlinkSync(avi); unlinkSync(webm); unlinkSync(rmx); } catch { /* ignore */ }
console.log("OK: test-transcode-args（双路源码契约 + 真跑:h264→copy+mp3 remux / mpeg4→vp8+opus webm + audio wav args）");
