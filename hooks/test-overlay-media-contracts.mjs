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
if (!/content\.replaceChildren\.apply\(content, kids\);/.test(ov) || !/buildMediaBar\(mixer\)/.test(ov)) fail("video+twin+bar 须同刻插入(kids 数组,bar 绑 mixer;S1)");
if (!/content\.replaceChildren\(audio, buildMediaBar\(audio\)\);/.test(ov)) fail("audio 须同款 mp-mb(同一组件双消费,原生控件同族死按钮风险)");
if (/点击播放/.test(ov)) fail("S4 ▶fallback 须已删(0.5.27 被 mp-mb play 按钮手势路径覆盖,残留=双路径)");
if (!/function buildMediaBar\(media\)/.test(ov)) fail("buildMediaBar 组件缺失");
if (!/media\.muted = !media\.muted; if \(!media\.muted && media\.volume === 0\) media\.volume = 0\.5;/.test(ov)) fail("mute 按钮须手势内翻 muted(Chromium:手势外程序解静音会被 autoplay 政策暂停)");
if (!/isFinite\(media\.duration\) && media\.duration > 0\) media\.currentTime/.test(ov)) fail("seek 须守 isFinite(duration)(/transcode fMP4 空_moov 期 duration=Infinity)");
if (!/media\.addEventListener\("volumechange"/.test(ov) || !/media\.addEventListener\("timeupdate"/.test(ov)) fail("mp-mb 须监听 volumechange/timeupdate(控件态与媒体态双向同步)");

// 2.5 0.5.29 🔴架构回归契约(用户裁决:回到最初方案基底——视频原文件直读+MP3 音频旁路)
if (/AAC_OK/.test(ov) || /mediaCapabilities/.test(ov)) fail("禁能力探测(编译期静态表在 stripped-ffmpeg 下说谎,0.5.28 定案)");
if (/AAC_FAMILY/.test(ov) || /audioRetryTried/.test(ov) || /vc=webm/.test(ov)) fail("0.5.27/28 转码路由/自愈梯已废弃(流式=进度条渐进+闪烁,用户实测否决)——禁止回流");
if (!/var TWIN_NEEDED = \["mp4", "mov", "m4v"\];/.test(ov)) fail("TWIN_NEEDED 家族缺失(AAC 家族视频需 MP3 旁路;webm 音轨宿主可解不需)");
if (!/twin\.src = audioUrl\(filePath\);/.test(ov) || !/function audioUrl\(p\)/.test(ov)) fail("twin 须以 audioUrl(单一构造点)接 /audio 提取端点");
if (!/Math\.abs\(a\.currentTime - master\.currentTime\) > 0\.2/.test(ov)) fail("mixer 漂移校正缺失(阈值 0.2s,主时钟=视频)");
if (!/master\.addEventListener\("seeking"/.test(ov) || !/master\.addEventListener\("ratechange"/.test(ov)) fail("mixer 须 seek 即时对齐 + ratechange 跟随");
if (!/a\.muted = m; if \(!m && !master\.paused && a\.paused\)/.test(ov) || !/master\.muted = true; \} else master\.muted = m;/.test(ov)) fail("twin 场景 master 须恒 muted;解静音手势内 twin 未随主起播须即刻补起(0.5.29b rig 实证)");
if (!/twin\._mpDead = true;/.test(ov)) fail("twin error 须 _mpDead 降级(mixer mute/volume 落回 master)");
if (!/video\.src = mediaUrl\(filePath, "video"\);/.test(ov)) fail("视频须原文件 mediaUrl 直读(原生家族=/preview 完整时长秒拖)");
if (/nativeFallbackTried/.test(ov)) fail("0.5.27d 转码回退已随恒路由废弃删除(原生家族不再走 /transcode,该分支不可达)");
if (!/if \(inTransitCorridor\(\)\) \{ hideTimer = setTimeout\(chain, 250\); return; \}/.test(ov) || !/hidePopup\(\); currentHovered = null;/.test(ov)) fail("0.5.31 F2:链尾走廊重挂+真关清 currentHovered 须在工厂内单点");
if (!/ext === "m4a" \|\| ext === "aac"\) \? audioUrl\(filePath\)/.test(ov)) fail("renderAudio 须 m4a/aac 走 /audio 提取主源");
if (!/querySelectorAll\("#mp-popup \.mp-content video, #mp-popup \.mp-content audio"\)/.test(ov)) fail("dispose 须 querySelectorAll 双媒体清理(视频+旁路 twin)");
if ((ov.match(/zoomGeomGrace = 0; zoomGeomHold = false;/g) || []).length !== 2) fail("0.5.31 Y3:handleHover 入口与 hidePopup 须各清一次 grace/hold(防 grace 到期击杀并发新弹窗)");

// 3. 缩放契约(0.5.22 增:上限 1000 实际无限 + pan + rail 复原按钮)
if (!/ZOOM_MAX = 1000/.test(ov)) fail("ZOOM_MAX 须 1000(用户决策解除放大上限;千倍=浮点护栏)");
if (!/var isPanning = false;/.test(ov)) fail("isPanning 模块 var 缺失(pan 状态)");
if (!/tagName === "IMG" && e\.target\._mpZoom && e\.target\._mpZoom\.s > 1/.test(ov)) fail("pan 触发条件缺失(target=IMG 且 s>1,优先于 pin 拖浮窗)");
if (!/pimg\.setPointerCapture/.test(ov) || !/is-panning/.test(ov)) fail("pan 须 setPointerCapture + is-panning 类(光标+出窗收事件)");
const panGuards = (ov.match(/&& !isPanning/g) || []).length;
if (!/if \(isPinned\) return;/.test(ov) || !/if \(isPanning \|\| Date\.now\(\) < zoomGeomGrace \|\| zoomGeomHold \|\| isMouseInPopup\(\)\) \{ hideTimer = setTimeout\(chain, 250\); return; \}/.test(ov)) fail("0.5.33:链守卫序破坏——pin 裸 return(设计)+暂态(pan/grace/hold/在窗内)必须短周期复查非死端(对抗审 H2 死端曾永卡;0.5.26 停驻保持亦须链内尊重)");
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
if (!/function armHideChain\(\)/.test(ov) || (ov.match(/armHideChain\(\)/g) || []).length !== 5) fail("0.5.31 F2:armHideChain 须定义+恰 4 布防点(原 4 份复制链收敛;>4=复制回流,<4=布防点丢失)");
const graceArms = (ov.match(/armZoomGeomGrace\(\)/g) || []).length;
if (!/function armZoomGeomGrace\(\)/.test(ov) || graceArms < 3) fail(`armZoomGeomGrace 须定义+两调用点(zoomBtn/resetBtn 点击),实得 ${graceArms}`);
if (!/zoomGeomGrace = Date\.now\(\) \+ 650/.test(ov) || !/!isMouseInPopup\(\) && !isPinned && !isPanning && !\(currentHovered && currentHovered\.matches\(":hover"\)\)/.test(ov)) fail("宽限到期(动过)须复检真实 :hover(popup 或源行)再定去留(防误关也防死悬窗)");
if (!/mp-mb-noaudio/.test(ov) || !/markNoAudio/.test(ov)) fail("0.5.32:无音轨源须藏 mute/volume(对 AAC 家族无实效免误导——.work_v.mp4 用户实测困惑)");
if (!(ov.indexOf("content.replaceChildren.apply(content, kids);") < ov.indexOf("if (twin && twin._mpDead) markNoAudio();"))) fail("0.5.32b 终验V2:settle 补查必须在 bar 入 DOM 之后(原在插入前=querySelector 恒空死代码)");
if (!(ov.indexOf('if (ep !== renderEpoch) return;  // 0.5.32b 终验 V4') < ov.indexOf("markNoAudio();  // 0.5.32:提取失败"))) fail("0.5.32b 终验V4:twin error 的 markNoAudio 须在 epoch 守卫内(陈旧 twin 迟到 error 误标当前 bar)");
if (!/var activeTwin = null;/.test(ov) || !/activeTwin = twin;/.test(ov)) fail("0.5.32b 终验:离屏 twin 模块引用缺失(hidePopup 早于 settle 时 /audio 孤儿拉取)");
if (!/if \(!hideTimer\) hideTimer = setTimeout\(armHideChain\(\), hideDelayMs\(\)\);/.test(ov) || !/function disarmHide\(\)/.test(ov)) fail("0.5.35:离开行须单次布防(!hideTimer 判)+disarmHide 置 null 单点(原每次 mousemove 清+重起=防抖重置,手微动永重置→停手后才关=用户延迟感)");
if (/inBand\(r\)/.test(ov)) fail("0.5.34:走廊禁含浮窗裙带 inBand(r)(离开浮窗必穿裙带→250ms×N 重挂=迟钝关,用户实测灵敏度回归);走廊=源行带+连接带,浮窗本体归 :hover");
if (!/Date\.now\(\) - lastMMoveTs > 500/.test(ov) || !/lastMMoveTs = Date\.now\(\);/.test(ov)) fail("0.5.33:走廊静止超时缺失(真机 rig8 定案:停带内=永卡——通过性须时间维判定,静止>500ms 即关)");
if (!/\.mp-rail\{[^}]*pointer-events:none/.test(ov) || !/#mp-popup:hover \.mp-rail\{pointer-events:auto/.test(ov)) fail("0.5.33 H2:隐形 rail 须 pointer-events:none(仅 popup 悬停态开放)——曾停在隐形轨道区=永卡");
if (!ov.includes("if (hoverTimer) clearTimeout(hoverTimer);  // 0.5.33 H3")) fail("0.5.33 H3:!item 分支须清 hoverTimer(迟到幽灵重渲染,与 root mouseleave 对称)");
if (!/zoomGeomHold = true; return;/.test(ov)) fail("宽限到期鼠标未动须进入 hold 停驻保持(0.5.26 用户语义:点复原停在原地=不关),而非直接关");
if (!/if \(!zoomGeomHold\) return;/.test(ov) || !/lastMX = e\.clientX; lastMY = e\.clientY;/.test(ov)) fail("须有 document mousemove 跟踪器(全局坐标记录+hold 首帧移动裁决——死区内无既有监听可达,必须 document 级)");

if (!/function disposeContent\(\) \{[\s\S]{0,420}resetImageZoom\(dPop\)/.test(ov)) fail("disposeContent 须调 resetImageZoom(🔴-1:图→图直切/hidePopup 拆除路径重置 img-zoomed 类+复原按钮,防假按钮假光标)");
// 4. 媒体隐藏延时 + 几何清理
if (/MEDIA_HIDE_DELAY/.test(ov)) fail("0.5.34:媒体 400ms 已统一 200(走廊时代前的补丁,连接带已覆盖——灵敏度回归)");
const hdCalls = (ov.match(/hideDelayMs\(\)\);/g) || []).length;
if ((ov.match(/setTimeout\(armHideChain\(\), hideDelayMs\(\)\)/g) || []).length !== 4) fail("0.5.31 F2:四布防点(popup 离开/root 非行/root mouseleave/hold 裁决)须统一走工厂");
if (!/popup\.style\.width = "";\s*popup\.style\.height = "";\s*popup\.style\.minHeight = "";\s*\/\/ 0\.5\.20\(A6\)\+0\.5\.21/.test(ov)) fail("hidePopup 须清残留几何 width/height/minHeight(A6+🔵-1)");

if (fails) { console.error(`\nFAIL: test-overlay-media-contracts（${fails} 处）`); process.exit(1); }
console.log("OK: test-overlay-media-contracts（mkv 非原生/settle-before-show/S4 unmute/无 autoplay 属性/缩放三常量/媒体隐藏延时/几何清理 全契约钉死）");
