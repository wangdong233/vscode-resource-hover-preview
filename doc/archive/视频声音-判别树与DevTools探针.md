# 视频声音 — 根因判别树与 DevTools 探针(0.5.20 配套)

> 背景:用户报"视频预览声音开不了"。0.5.20 已落地稳健修复集(S1 settle-before-show / S4 fallback unmute / mkv 走转码 / 媒体隐藏延时 400ms)——对竞态类、fallback 类、mkv 类嫌疑全命中。
> 若修后仍无声,按本文 10 分钟定案。来源:工作流终裁(R1 白盒∥R2 业界∥R4 对抗;R3 实验 429 未跑,结论为未实验验证态)。

## 一、零代码四问(先做,砍掉大半嫌疑)

1. **Q1 具体文件**:拿到路径跑(替换 `<文件>`):
   ```bash
   ffprobe -v error -show_entries stream=codec_type,codec_name -of csv=p=0 "<文件>"
   ```
   → 无 `audio|` 行 = **无声轨(非插件 bug)**;`audio|ac3`/`eac3`/`truehd`/`dts` = **文件固有**,Chromium 任何 build(含 Chrome 浏览器)都不解 → 拖进 Chrome 对照验证。
2. **Q2 点喇叭后图标状态**:灰/点不动=无音轨;变有声图标但无声=解码层;点击瞬间无反应=点击没落地(→探针分支 3)。
3. **Q3 先 pin(图钉)再点 unmute**——最强分叉:pin 后不存在任何重建路径。有声=竞态类(0.5.20 已修,此现象不应再出现);仍无声=竞态全灭,只剩文件/解码/输出层。
4. **Q4 当日 hover 一个 mp3/wav 点 ▶** + 其他 app 有声吗:有声=renderer 输出链路通;无声=输出设备问题(与插件无关)。

## 二、30 秒 DevTools 探针(⌘⇧P → Toggle Developer Tools → console)

先 hover 出视频,**用鼠标点原生喇叭开声/调音量**,再回 console 执行 `__mpsnap()`:

```js
(function(){var v=document.querySelector('#mp-popup video');
if(!v)return console.log('NO VIDEO — popup未渲染或已销毁(竞态线索)');
window.__mpv=v;
var s=function(){return{el:v===window.__mpv,muted:v.muted,vol:v.volume.toFixed(2),
 paused:v.paused,err:v.error?v.error.code+' '+v.error.message:null,
 aB:v.webkitAudioDecodedByteCount,vB:v.webkitVideoDecodedByteCount,ready:v.readyState};};
['volumechange','play','pause','error','emptied'].forEach(function(ev){
 v.addEventListener(ev,function(){console.log('[mp]',ev,Date.now()%1e5,JSON.stringify(s()))});});
window.__mpsnap=function(){console.table([s()])};
console.log('[mp] armed — 点原生喇叭开声/调音量,再执行 __mpsnap()');
console.log('初始:',JSON.stringify(s()));})()
```

## 三、解读表(点击 unmute 后的观测 → 定案 → 处置)

| 观测 | 定案 | 处置 |
|---|---|---|
| 无 volumechange log,喇叭灰/不可点 | 无音轨 | 非插件 bug(Q1 确认);可选做"无音轨"提示 |
| 无 volumechange,图标可点没反应 | 点击被吞 | 上报(带探针输出)——条件修复项 |
| volumechange: muted=false 且 **vol=0** | 音量残留(曾拖到 0) | 拖原生音量条即出声;非 bug |
| muted=false,数百 ms 内 pause log 跟随 | unmute 被策略暂停 | 上报——分叉 H3(转码音频改码 libmp3lame) |
| muted=false,vol>0,**aB=0 恒不增长**(vB 增长、画面在放) | **音频解码失败** | 跑 Q1:AC3 类=文件固有;**AAC=H3(缺 AAC 解码)→ server 转码音频改 libmp3lame(已设计好,触发即实施)** |
| muted=false,vol>0,**aB>0** 但确实无声 | 解码成功、输出层无声 | 用户环境(输出设备/路由),插件无责 |
| **el:false**(元素被换) | 重建竞态 | 0.5.20 已修,此观测=修复回归,上报 |

## 四、先验置信度(终裁,未定案)

H1 文件音轨固有 ~35% > H2 重建/销毁竞态 ~20%(已修) > H3 发行版缺 AAC 解码 ~15% > H4 会话/输出层 ~10% > H5 ▶ fallback 只 play ~10%(已修)。
分叉修复已预设计:H3 → server.ts 转码音频 `-c:a aac` 改探测式 libmp3lame(带回退);H1 AC3 类 → 音轨 ffprobe 探测+降级转码(Phase 2)。
