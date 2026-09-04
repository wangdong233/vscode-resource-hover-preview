// test-preview-freshness：预览新鲜度契约闸门（0.5.18 起,npm test 链第 6 道）。
// 📕 起源（真机 bug=SH08 同名覆盖供旧）：AIGC 管线同名覆盖 PNG 后，直接打开=新图、悬停预览=旧图。
//   根因（4-agent 工作流终裁）：client 四层叠加——overlay _cache 键=path|type 无版本信号（主犯）+
//   lastRenderedItem dedup + prefetch 放大器 + HTTP max-age=300 无验证器（唯一跨会话层）。
//   修法=新鲜度单一责任归属：server（唯一能 stat 方）以强 ETag(size-mtimeMs) 下发指纹 + Cache-Control: no-cache
//   （协商执行归 HTTP 层）；overlay image 退出版本化缓存（fetchImageFresh 仅 _inflight 去重）。
//   本闸门：① 源码 scrape 防半吊子修法（尤其"只换 no-cache 不加 ETag"）② 真跑 server 断言 304/覆盖/If-Range 全序列。
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";

const base = fileURLToPath(new URL("../", import.meta.url));
const serverSrc = readFileSync(base + "companion/src/server.ts", "utf8");
const overlaySrc = readFileSync(base + "resources/overlay.template.js", "utf8");
let fails = 0;
const fail = (m) => { console.error("  FAIL:", m); fails++; };

// ===== A. 源码契约 =====
console.log("[1/3] 源码契约(no-cache+ETag / image 退出版本化缓存 / 视频静音契约)...");
if (/max-age/.test(serverSrc.replace(/\/\/[^\n]*/g, ""))) fail("server.ts 代码仍含 max-age(半吊子修法:无验证器的定时供旧——须 no-cache+ETag;注释中的 max-age 为修法说明,豁免)");
for (const tok of ["etagOf", "if-none-match", "304", "if-range"]) {
    if (!serverSrc.includes(tok)) fail(`server.ts 缺 ${tok}(协商链不全)`);
}
const feBlock = overlaySrc.match(/function fetchImageFresh\(p\) \{[\s\S]*?\n    \}/);
if (!feBlock) fail("overlay 缺 fetchImageFresh(image 新鲜度路径)");
else if (/cachePut/.test(feBlock[0])) fail("fetchImageFresh 不得 cachePut(image 退出版本化缓存=本修核心)");
else if (!/_imgMemo\.get\(p\)/.test(feBlock[0]) || !/headers\.get\("etag"\)/.test(feBlock[0])) fail("fetchImageFresh 须按响应 etag 查 _imgMemo 版本化 memo(G4:未变免全量 JSON.parse)");
const riBlock = overlaySrc.match(/function renderImage\(filePath, ep, rect\) \{[\s\S]{0,200}/);
if (!riBlock || !/fetchImageFresh\(/.test(riBlock[0])) fail("renderImage 未走 fetchImageFresh");
if (!/_prefetched/.test(overlaySrc) || !/PREFETCH_TTL/.test(overlaySrc)) fail("schedulePrefetch 缺 _prefetched 节流(image 无缓存键后防重复条件请求)");
// 视频静音契约(用户铁则:预览绝不主动出声;默认静音;控件可人为开声/调音量)——0.5.20 更新:settle-before-show 删 autoplay 属性(显式 play),细契约见 test-overlay-media-contracts
if (/\.controls = true/.test(overlaySrc) || /video\.autoplay/.test(overlaySrc)) fail("0.5.27:禁 controls=true(自研 mp-mb)+禁 autoplay 属性;renderVideo 须 muted=true 起播");  // 0.5.27 契约升级:原生 UA 控件弃用
if (!/content\.replaceChildren\.apply\(content, kids\);/.test(overlaySrc)) fail("0.5.29:video+twin+bar 须同刻插入(kids 数组;S1 不变式)");

// ===== B. 真跑 server:304 协商 / 同名覆盖 / If-Range =====
console.log("[2/3] 真跑 server(304/覆盖换新/同尺寸覆盖/If-Range)...");
const distServer = base + "companion/dist/server.js";
let mod;
try { mod = await import(pathToFileURL(distServer).href); }
catch (e) { fail("companion/dist/server.js 不可 import(先 npm run companion:build):" + e.message); }
if (mod) {
    const start = mod.startPreviewServer || mod.default?.startPreviewServer;
    if (typeof start !== "function") { fail("startPreviewServer 导出不可达(CJS interop)"); }
    else {
        const dir = mkdtempSync(join(tmpdir(), "mp-fresh-"));
        const imgPath = join(dir, "card.png"), vidPath = join(dir, "clip.mp4");
        const token = randomBytes(12).toString("hex");
        const { server } = start(token, [dir], undefined, 0);  // port 0=临时端口(0.5.18 第4参,测试密闭)
        await new Promise(r => server.listen ? (server.listening ? r() : server.once("listening", r)) : r());
        const port = server.address().port;
        const U = (p) => `http://127.0.0.1:${port}/preview?file=${encodeURIComponent(p)}&type=`;
        try {
            // ① image 首发:200 + no-cache + ETag + 正确 base64
            writeFileSync(imgPath, "IMG-V1-OLD");
            let r1 = await fetch(U(imgPath) + "image" + `&token=${token}`);
            let j1 = await r1.json();
            const etag1 = r1.headers.get("etag");
            if (r1.status !== 200 || !etag1 || r1.headers.get("cache-control") !== "no-cache") fail(`①首发头不全: status=${r1.status} etag=${etag1} cc=${r1.headers.get("cache-control")}`);
            if (j1.base64 !== Buffer.from("IMG-V1-OLD").toString("base64")) fail("①首发字节不符");

            // ② 未变重放(If-None-Match)→304 同 etag 空 body
            let r2 = await fetch(U(imgPath) + "image" + `&token=${token}`, { headers: { "If-None-Match": etag1 } });
            if (r2.status !== 304 || r2.headers.get("etag") !== etag1) fail(`②未变重放应 304 同 etag: got ${r2.status}/${r2.headers.get("etag")}`);
            if ((await r2.text()) !== "") fail("②304 应空 body");

            // ③ 同名覆盖(不同尺寸)→携旧 etag→200 新字节+新 etag ★本 bug 回归锚(SH08)
            writeFileSync(imgPath, "IMG-V2-NEW-LONGER");
            let r3 = await fetch(U(imgPath) + "image" + `&token=${token}`, { headers: { "If-None-Match": etag1 } });
            if (r3.status !== 200) fail(`③覆盖后须 200: got ${r3.status}`);  // 状态先行(复审:先 json 会让 etag 退化崩成 SyntaxError 脏红)
            const etag3 = r3.headers.get("etag");
            let j3 = await r3.json();
            if (etag3 === etag1) fail("③覆盖后 etag 不得不变(指纹失效)");
            if (j3.base64 !== Buffer.from("IMG-V2-NEW-LONGER").toString("base64")) fail("③覆盖后仍旧字节(SH08 供旧回归!)");

            // ④ 同尺寸覆盖 + sleep→mtime 变→etag 变(指纹不只依赖 size)
            writeFileSync(imgPath, "AAAAAAAAAA");
            let rA = await fetch(U(imgPath) + "image" + `&token=${token}`);
            const etagA = rA.headers.get("etag");
            await new Promise(r => setTimeout(r, 15));
            writeFileSync(imgPath, "BBBBBBBBBB");
            let rB = await fetch(U(imgPath) + "image" + `&token=${token}`, { headers: { "If-None-Match": etagA } });
            if (rB.status !== 200 || rB.headers.get("etag") === etagA) fail(`④同尺寸覆盖 etag 应变(须含 mtimeMs): ${etagA} → ${rB.headers.get("etag")}`);

            // ⑤ video/serveStream:200+ETag / 条件 304 / Range 206+ETag / 旧 etag 的 If-Range+Range→200 全量
            writeFileSync(vidPath, "MP4BYTES-0123456789");
            const vU = U(vidPath) + "video" + `&token=${token}`;
            let v1 = await fetch(vU);
            const vtag = v1.headers.get("etag");
            if (v1.status !== 200 || !vtag || v1.headers.get("cache-control") !== "no-cache") fail(`⑤video 首发头不全: ${v1.status}/${vtag}`);
            await v1.arrayBuffer();
            let v2 = await fetch(vU, { headers: { "If-None-Match": vtag } });
            if (v2.status !== 304) fail(`⑤video 未变重放应 304: got ${v2.status}`);
            let v3 = await fetch(vU, { headers: { "Range": "bytes=0-0" } });
            if (v3.status !== 206 || !v3.headers.get("etag") || !v3.headers.get("content-range")) fail(`⑤Range 应 206+ETag+Content-Range: ${v3.status}`);
            await v3.arrayBuffer();
            writeFileSync(vidPath, "MP4NEWBYTES-9876543210");  // 覆盖后,旧分片属旧版本
            let v4 = await fetch(vU, { headers: { "Range": "bytes=0-4", "If-Range": vtag } });
            if (v4.status !== 200) fail(`⑤旧 etag 的 If-Range+Range 应弃 Range 回 200 全量(防新旧字节拼接): got ${v4.status}`);
            await v4.arrayBuffer();
            // ⑥ 复审高 ROI 补:覆盖后裸 Range(无 If-Range,=3D probeSize 的探测形态)→ Content-Range total 须=新尺寸(探测恒新契约)
            let v5 = await fetch(vU, { headers: { "Range": "bytes=0-0" } });
            const cr5 = v5.headers.get("content-range") || "";
            if (v5.status !== 206 || !cr5.endsWith("/22")) fail(`⑥覆盖后裸 Range 探测应拿新 total(22): got ${v5.status} ${cr5}`);  // "MP4NEWBYTES-9876543210"=22 字节
            await v5.arrayBuffer();
            console.log("    image: 200/304/覆盖换新/同尺寸换新 ✓  video: 200/304/206/If-Range 弃 Range/裸探测新 total ✓");
        } finally {
            server.close(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
    }
}

// ===== C. 收尾 =====
console.log("[3/3] 收尾。");
// 0.5.29c /audio HTTP 层(🔴-1 复发防线):自足 server 真跑 200+ETag → If-None-Match 304 → Range 206
{
  const { spawnSync } = await import("node:child_process");
  const ffq = ["ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/bin/ffmpeg"].find(p => { try { spawnSync(p, ["-version"], { stdio: "ignore", timeout: 2000 }); return true; } catch { return false; } });  // 0.5.31 🔵-4:与 server 四候选对齐
  if (!ffq) console.log("    /audio: 无 ffmpeg → skip");
  else {
    const dirA = mkdtempSync(join(tmpdir(), "mp-aud-"));
    const srcV = join(dirA, "av.mp4");
    spawnSync(ffq, ["-f", "lavfi", "-i", "sine=duration=1", "-f", "lavfi", "-i", "testsrc=duration=1:size=64x48:rate=5", "-c:a", "aac", "-c:v", "libx264", "-shortest", srcV, "-y"], { stdio: "ignore", timeout: 20000 });
    const tokA = randomBytes(12).toString("hex");
    const modA = await import(pathToFileURL(base + "companion/dist/server.js").href);
    const srvA = (modA.startPreviewServer || modA.default?.startPreviewServer)(tokA, [dirA], undefined, 0);
    await new Promise(r => srvA.server.once("listening", r));
    const au = "http://127.0.0.1:" + srvA.server.address().port + "/audio?file=" + encodeURIComponent(srcV) + "&token=" + tokA;
    const r1 = await fetch(au);
    if (r1.status !== 200) fail("/audio 首请求非 200(实得 " + r1.status + "——🔴-1 类/提取失败)");
    await r1.arrayBuffer();
    const et = r1.headers.get("etag");
    if (!et || et.includes("+")) fail("/audio ETag 异常:[" + et + "](🔴-1 字面量笔误特征)");
    const r2 = await fetch(au, { headers: { "If-None-Match": et } });
    if (r2.status !== 304) fail("/audio 304 协商失效(实得 " + r2.status + ")");
    const r3 = await fetch(au, { headers: { Range: "bytes=0-99" } });
    if (r3.status !== 206 || r3.headers.get("content-length") !== "100") fail("/audio Range 失效(" + r3.status + ")");
    console.log("    /audio: 200+ETag / 304 / 206 ✓");
    // 0.5.31 🟡-7:containment 403 反例(删 server containment 块曾致八闸全绿——mutation 幸存者)
    const outsidePath = join(tmpdir(), "mp-aud-out-" + Date.now() + ".mp4");  // 真建工作区外文件(原从不落盘→404 短路 containment,假防线——终验 M7 抓)
    spawnSync(ffq, ["-f", "lavfi", "-i", "sine=duration=1", "-f", "lavfi", "-i", "testsrc=duration=1:size=64x48:rate=5", "-c:a", "aac", "-c:v", "libx264", "-shortest", outsidePath, "-y"], { stdio: "ignore", timeout: 20000 });
    const rOut = await fetch("http://127.0.0.1:" + srvA.server.address().port + "/audio?file=" + encodeURIComponent(outsidePath) + "&token=" + tokA);
    if (rOut.status !== 403) fail("/audio containment 失效(工作区外真实文件实得 " + rOut.status + ",须 403——无 404 兜底)");
    // 0.5.30 预热函数:二次调用走缓存(<100ms)——EH 启动预热消费的同一入口
    const ensure = (modA2 => modA2.ensureAudioCacheByPath || modA2.default?.ensureAudioCacheByPath)(await import(pathToFileURL(base + "companion/dist/server.js").href));
    const tA = Date.now(); const rA = await ensure(srcV, true); const firstMs = Date.now() - tA;
    const tB = Date.now(); const rB2 = await ensure(srcV, true); const secondMs = Date.now() - tB;
    if (!rA || !rB2) fail("ensureAudioCacheByPath 返回 null(缓存应已就绪)");
    if (secondMs > 100) fail("预热二次调用未走缓存(" + secondMs + "ms > 100ms——首次 " + firstMs + "ms)");
    srvA.server.close();
  }
}

if (fails) { console.error(`\nFAIL: test-preview-freshness（${fails} 处）`); process.exit(1); }
console.log("OK: test-preview-freshness（源码契约 + 真跑 304/同名覆盖/同尺寸覆盖/If-Range 全序列 + 视频静音契约）");
process.exit(0);

