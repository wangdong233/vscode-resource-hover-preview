// test-transcode-args：ffmpeg 转码参数契约闸门（03 §1.2 项8 宿主契约 + §1.7 项7 可机械化 + §2.2 项4 producer 契约同步）。
// 📕 起源：0.5.0 引入 /transcode 时 movflags 写成 "frag+emptymoov+default_base_moof"（凭记忆，从未真跑），
//   ffmpeg 解析失败 "Undefined constant 'frag'" → stdout 0 字节 → <video> error → 静默 hidePopup。
//   潜伏到 0.5.7 才被发现。本闸门从 server.ts 源码抽取 movflags，跑真实 ffmpeg，断言产合法流式 fMP4。
//   若有人把 movflags 改回错 token → 本测 fail（而非潜伏到用户）。
//
// 准入：companion/src/server.ts 存在 + 环境有 ffmpeg（无则 skip，不阻断无 ffmpeg 的 CI）。
// 准出：① movflags 可从源码抽出 ② ffmpeg 用该 movflags 产非空 stdout ③ box 序列含 ftyp+moov+moof（流式，Chromium 可渐进解）。
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SERVER_SRC = join(ROOT, "companion", "src", "server.ts");
const TMP = join(HERE, "..", ".transcode-fixture");  // 临时产物放 .transcode-fixture（gitignore 或运行后清）

function fail(msg) { console.error("❌ test-transcode-args: " + msg); process.exit(1); }

// ① 抽 movflags（源码 ↔ 运行 同源：测源码里的串，不是硬编码副本——改源码即改被测值）
const src = readFileSync(SERVER_SRC, "utf8");
const m = src.match(/"-movflags",\s*"([^"]+)"/);
if (!m) fail("未在 server.ts 抽到 movflags 字面量（/transcode args 是否被改？）");
const movflags = m[1];
console.log(`[1/4] movflags 抽自源码: "${movflags}"`);

// ② 同步抽 audio args 里的 wav 编码（防音频路径参数漂移；可选断言）
const hasWav = /"-f",\s*"wav",\s*"-c:a",\s*"pcm_s16le"/.test(src);
if (!hasWav) fail("audio transcode args 不含 -f wav -c:a pcm_s16le（AIFF→WAV 路径是否被改？）");
console.log("[2/4] audio wav args 存在 ✓");

// ③ ffmpeg 可用性（无 ffmpeg → skip，不阻断无 ffmpeg 环境）
const ff = ["ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/bin/ffmpeg"]
    .find(p => { try { spawnSync(p, ["-version"], { stdio: "ignore", timeout: 2000 }); return true; } catch { return false; } });
if (!ff) { console.log("[3/4] ffmpeg 未安装 → skip（本闸门在有 ffmpeg 的开发机/CI 跑）"); console.log("OK: test-transcode-args（skipped: no ffmpeg）"); process.exit(0); }
console.log(`[3/4] ffmpeg 可用: ${ff}`);

// ④ 生成 2s 测试 AVI + 用【源码同款 movflags + video args】转码 → 断言合法流式 fMP4
const avi = TMP + ".avi", out = TMP + ".mp4";
let r = spawnSync(ff, ["-f", "lavfi", "-i", "testsrc=duration=2:size=160x120:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "mpeg4", "-c:a", "aac", "-shortest", avi, "-y"], { stdio: "ignore" });
if (r.status !== 0) fail("生成测试 AVI 失败（ffmpeg lavfi 不可用？）");

// 用与 server.ts serveTranscode 完全一致的 video 参数（movflags 来自源码抽取）
r = spawnSync(ff, ["-i", avi, "-f", "mp4", "-movflags", movflags,
    "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-c:a", "aac", "-"], {
    stdio: ["ignore", "pipe", "ignore"], encoding: "buffer", maxBuffer: 50 * 1024 * 1024, timeout: 30000
});
if (r.status !== 0 || !r.stdout || r.stdout.length === 0) {
    fail(`ffmpeg 转码失败(status=${r.status}, stdout=${r.stdout ? r.stdout.length : 0}B)——movflags "${movflags}" 可能是错 token（对照:应为 frag_keyframe+empty_moov+default_base_moof）`);
}
console.log(`[4/4] 转码 stdout: ${r.stdout.length}B`);

// ⑤ box 序列断言：流式 fMP4 必含 ftyp + moov + moof（非整块 mdat）
const boxes = [];
let i = 0;
while (i + 8 <= r.stdout.length) {
    let size = r.stdout.readUInt32BE(i);
    const typ = r.stdout.slice(i + 4, i + 8).toString("latin1");
    if (size === 1 && i + 16 <= r.stdout.length) size = Number(r.stdout.readBigUInt64BE(i + 8));
    if (size < 8 || i + size > r.stdout.length) break;
    boxes.push(typ); i += size;
    if (boxes.length > 30) break;
}
const ok = boxes.includes("ftyp") && boxes.includes("moov") && boxes.includes("moof");
if (!ok) fail(`box 序列非流式 fMP4: ${boxes.slice(0, 12).join(" ")}（缺 ftyp/moov/moof，Chromium 需全量缓冲无法渐进解）`);
console.log(`     box 序列: ${boxes.slice(0, 12).join(" ")} ✓`);

// 清理
try { spawnSync("rm", ["-f", avi, out]); } catch { /* ignore */ }
console.log("OK: test-transcode-args（movflags 源码契约 + ffmpeg 真跑产流式 fMP4 + audio wav args）");
