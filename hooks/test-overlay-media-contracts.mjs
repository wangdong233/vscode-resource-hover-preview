// test-overlay-media-contracts：视频/媒体交互契约闸门(0.5.20,npm test 链第 7 道)。
// 📕 起源:用户报"视频预览声音还是不能打开"+"图片缩放不跟手"。工作流终裁(判别树未定案,但稳健修复集对
//   H1(mkv/编解码)/H2(重建竞态)/H5(fallback 只 play)全命中):S1 settle-before-show(可见后几何不变)、
//   S4 fallback unmute、mkv 移出原生、媒体隐藏延时 400ms、缩放 K 0.0022/捏合独立/单事件封顶。
//   本闸门把这些契约钉死,防回退(尤其 autoplay 属性回流/settle 拆除/K 被拍脑袋改)。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const base = fileURLToPath(new URL("../", import.meta.url));
const ov = readFileSync(base + "resources/overlay.template.js", "utf8");
let fails = 0;
const fail = (m) => { console.error("  FAIL:", m); fails++; };

// 1. mkv 不在 NATIVE_VIDEO(Chromium 无 matroska demuxer,原生路径必死)
if (/NATIVE_VIDEO\s*=\s*\[[^\]]*"mkv"/.test(ov)) fail("NATIVE_VIDEO 含 mkv(Chromium 无 matroska demuxer→原生必死,应走 /transcode)");
if (/var NATIVE_VIDEO = \["mp4", "webm", "mov", "m4v"\]/.test(ov) === false) fail("NATIVE_VIDEO 白名单非预期形态(改数组须同步本闸门)");

// 2. renderVideo settle-before-show 契约 + 0.5.27 自研控件条契约
if (/video\.autoplay/.test(ov)) fail("禁 video.autoplay 属性(0.5.20 显式 play() 单一路径;属性回流=S1 被拆)");
const mutedCount = (ov.match(/video\.muted = true/g) || []).length;
if (mutedCount !== 1) fail(`video.muted = true 应恰 1 处(renderVideo muted 起播),实得 ${mutedCount}`);
if (/\.controls = true/.test(ov)) fail("禁 media.controls = true(0.5.27:原生 UA 控件=闭影 DOM,VSCode 环境交互死+CDP 不可测——控件面唯一来源须为 mp-mb)");
if (!/video\.preload = "metadata"/.test(ov)) fail("renderVideo 须 preload=metadata(离屏先取元数据)");
if (!/var settled = false;/.test(ov) || !/settled = true;/.test(ov)) fail("settle latch 缺失(settle-before-show 单次入口契约)");
if (!/content\.replaceChildren\(video, buildMediaBar\(video\)\);/.test(ov)) fail("video+mp-mb 须同刻一次性插入(可见后几何不变,S1)");
if (!/content\.replaceChildren\(audio, buildMediaBar\(audio\)\);/.test(ov)) fail("audio 须同款 mp-mb(同一组件双消费,原生控件同族死按钮风险)");
if (/点击播放/.test(ov)) fail("S4 ▶fallback 须已删(0.5.27 被 mp-mb play 按钮手势路径覆盖,残留=双路径)");
if (!/function buildMediaBar\(media\)/.test(ov)) fail("buildMediaBar 组件缺失");
if (!/media\.muted = !media\.muted; if \(!media\.muted && media\.volume === 0\) media\.volume = 0\.5;/.test(ov)) fail("mute 按钮须手势内翻 muted(Chromium:手势外程序解静音会被 autoplay 政策暂停)");
if (!/isFinite\(media\.duration\) && media\.duration > 0\) media\.currentTime/.test(ov)) fail("seek 须守 isFinite(duration)(/transcode fMP4 空_moov 期 duration=Infinity)");
if (!/media\.addEventListener\("volumechange"/.test(ov) || !/media\.addEventListener\("timeupdate"/.test(ov)) fail("mp-mb 须监听 volumechange/timeupdate(控件态与媒体态双向同步)");

// 2.5 0.5.27 🔴根因路由契约:VSCode 出厂 libffmpeg 无 AAC(二进制已验)→ AAC 轨 HasAudio()=false → 原生 mute 死键+无声
if (/AAC_OK/.test(ov) || /mediaCapabilities/.test(ov)) fail("0.5.28:能力探测已删——decodingInfo 查编译期静态表,stripped-ffmpeg 下说谎(表称支持/实际无解码器),用户实测零声主因");
if (!/var AAC_FAMILY = \["mp4", "mov", "m4v", "m4a", "aac"\];/.test(ov) || !/if \(AAC_FAMILY\.indexOf\(ext\) >= 0\) return t;/.test(ov)) fail("0.5.28:AAC 家族须恒路由 /transcode(无探测;VSCode 必无 AAC,full-ffmpeg 自建仅付 ~0.5s remux)");
if (!/var nativeFallbackTried = false;/.test(ov) || !/video\.src\.indexOf\("\/transcode"\) >= 0/.test(ov)) fail("🔴-1:转码路死(无 ffmpeg 404)且原生可播时须回退 previewUrl 一次(0.5.27d 对抗审——否则无 ffmpeg 宿主 mp4 报错卡回归)");
if (!/if \(document\.activeElement !== seek\) seek\.value/.test(ov)) fail("🟡-1:seek 须 activeElement 守卫(拖动中不被 timeupdate 覆写)");
if (!/mp-mb-narrow/.test(ov) || !/mp-mb-tiny/.test(ov)) fail("🟡-4:窄窗自适应档位缺失(<300 藏 time,<250 藏 vol)");
if (!/var audioRetryTried = false;/.test(ov) || !/mediaUrl\(filePath, "video", "webm"\)/.test(ov) || !/webkitAudioDecodedByteCount \|\| 0\) > 0/.test(ov)) fail("0.5.28 自愈梯缺失:路由态验声零解码须强制 vc=webm 整转重试一次(URL 须经 mediaUrl 单点构造)");
if (!/ladderChecks > 12/.test(ov) || !/readyState < 2/.test(ov)) fail("0.5.28b 软边:不可判态(duration 未到/缓冲/暂停)须 500ms 重查且不消耗机会(≤12 轮),防误杀慢启动流/防首秒暂停被强制续播");
if (!/音频零解码/.test(ov)) fail("自愈梯触发须 console.warn 留痕(静默降级必留痕铁律)");
if (/\.controls = true/.test(ov)) fail("禁 controls=true(重复检查)");

// 3. 缩放契约(0.5.22 增:上限 1000 实际无限 + pan + rail 复原按钮)
if (!/ZOOM_MAX = 1000/.test(ov)) fail("ZOOM_MAX 须 1000(用户决策解除放大上限;千倍=浮点护栏)");
if (!/var isPanning = false;/.test(ov)) fail("isPanning 模块 var 缺失(pan 状态)");
if (!/tagName === "IMG" && e\.target\._mpZoom && e\.target\._mpZoom\.s > 1/.test(ov)) fail("pan 触发条件缺失(target=IMG 且 s>1,优先于 pin 拖浮窗)");
if (!/pimg\.setPointerCapture/.test(ov) || !/is-panning/.test(ov)) fail("pan 须 setPointerCapture + is-panning 类(光标+出窗收事件)");
const panGuards = (ov.match(/&& !isPanning/g) || []).length;
if (panGuards < 3) fail(`三处 hideTimer fire-time 须 && !isPanning(pan 中防销毁拖拽中的图),实得 ${panGuards}`);
if (!/isDragging \|\| isPanning/.test(ov)) fail("root mousemove/wheel 守卫须含 isPanning");
if (!/mp-gap2/.test(ov) || !/mp-zoomreset/.test(ov)) fail("rail 须含 gap2 间隔 + 缩放复原按钮(独立分组)");
if (!/zoomBtnEl\.style\.display = z\.s > 1 \? "flex" : "none"/.test(ov)) fail("复原按钮可见性须随 s>1 联动(applyImgZoom)");
if (!/ICON_ZOOMRESET/.test(ov)) fail("ICON_ZOOMRESET 缺失");
if (!/img-zoomed \.mp-content img\{cursor:grab\}/.test(ov)) fail("img-zoomed grab 光标 affordance CSS 缺失");
if (!/ZOOM_K = 0\.0022/.test(ov)) fail("ZOOM_K 须 0.0022(滚轮×1.30/格,用户定案灵敏度;改值须过终裁级论证)");
if (!/ZOOM_K_PINCH = 0\.01/.test(ov) || !/e\.ctrlKey \? ZOOM_K_PINCH : ZOOM_K/.test(ov)) fail("捏合须独立 K=0.01(0.5.25 用户实测 0.0015 不跟手;Excalidraw /100 同量级)+ctrlKey 分流");
if (!/ZOOM_STEP_PINCH = 0\.336/.test(ov) || !/e\.ctrlKey && step > ZOOM_STEP_PINCH/.test(ov)) fail("捏合支路单事件步长须封顶 0.336(ln1.4;K=0.01 后真鼠标 ctrl+滚轮一格防 2.7× 跳变,触控板小 dy 不触顶)");
if (!/ZOOM_DY_MAX = 200/.test(ov) || !/dy > ZOOM_DY_MAX/.test(ov)) fail("单事件 dy 须封顶 ±200(触控板惯性/line-mode 防一瞬顶格)");

// 3.5 复位几何宽限契约(0.5.25,用户实测🔴:点复原按钮→rail 在光标下缩走→mouseleave 误发→浮窗瞬间消失)
const graceGuards = (ov.match(/Date\.now\(\) >= zoomGeomGrace/g) || []).length;
if (graceGuards < 3) fail(`三处 hideTimer fire-time 须让位几何宽限(点复原 rail 缩走误关),实得 ${graceGuards}`);
const graceArms = (ov.match(/armZoomGeomGrace\(\)/g) || []).length;
if (!/function armZoomGeomGrace\(\)/.test(ov) || graceArms < 3) fail(`armZoomGeomGrace 须定义+两调用点(zoomBtn/resetBtn 点击),实得 ${graceArms}`);
if (!/zoomGeomGrace = Date\.now\(\) \+ 650/.test(ov) || !/!isMouseInPopup\(\) && !isPinned && !isPanning && !\(currentHovered && currentHovered\.matches\(":hover"\)\)/.test(ov)) fail("宽限到期(动过)须复检真实 :hover(popup 或源行)再定去留(防误关也防死悬窗)");
if (!/zoomGeomHold = true; return;/.test(ov)) fail("宽限到期鼠标未动须进入 hold 停驻保持(0.5.26 用户语义:点复原停在原地=不关),而非直接关");
if (!/if \(!zoomGeomHold\) return;/.test(ov) || !/lastMX = e\.clientX; lastMY = e\.clientY;/.test(ov)) fail("须有 document mousemove 跟踪器(全局坐标记录+hold 首帧移动裁决——死区内无既有监听可达,必须 document 级)");

if (!/function disposeContent\(\) \{[\s\S]{0,420}resetImageZoom\(dPop\)/.test(ov)) fail("disposeContent 须调 resetImageZoom(🔴-1:图→图直切/hidePopup 拆除路径重置 img-zoomed 类+复原按钮,防假按钮假光标)");
// 4. 媒体隐藏延时 + 几何清理
if (!/MEDIA_HIDE_DELAY = 400/.test(ov) || !/function hideDelayMs\(\)/.test(ov)) fail("MEDIA_HIDE_DELAY=400 + hideDelayMs 缺失(视频/音频弹窗加宽隐藏窗)");
const hdCalls = (ov.match(/hideDelayMs\(\)\);/g) || []).length;
if (hdCalls < 3) fail(`hideDelayMs() 须≥3 处调用(三布防点),实得 ${hdCalls}`);
if (!/popup\.style\.width = "";\s*popup\.style\.height = "";\s*popup\.style\.minHeight = "";\s*\/\/ 0\.5\.20\(A6\)\+0\.5\.21/.test(ov)) fail("hidePopup 须清残留几何 width/height/minHeight(A6+🔵-1)");

if (fails) { console.error(`\nFAIL: test-overlay-media-contracts（${fails} 处）`); process.exit(1); }
console.log("OK: test-overlay-media-contracts（mkv 非原生/settle-before-show/S4 unmute/无 autoplay 属性/缩放三常量/媒体隐藏延时/几何清理 全契约钉死）");
