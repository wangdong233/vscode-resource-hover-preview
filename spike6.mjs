#!/usr/bin/env node
// =============================================================================
// Spike 6 — 端到端验证：CSP patch 三件 + mp-config.js 配置注入 + overlay fetch /ping
// -----------------------------------------------------------------------------
// 证明链路（v0.1 第一关）：
//   workbench.html 静态 <script src=mp-config.js>  →  window.__MP_CONFIG__={port,token}
//   workbench.html 静态 <script src=mp-overlay.js> →  fetch http://127.0.0.1:PORT/ping → 200 "ok"
//
// 关键已验证事实（Spike 1/2 + 本 Spike）：
//   1. CSP script-src 'self' 允许同源静态外链 script（Spike 2 实证 mp-test.js 加载成功）
//   2. CSP 无 'unsafe-inline' → 不能用内联 <script>window.__MP_CONFIG__=...</script>
//      但 mp-config.js 是【外链文件】，由 script-src 'self' 放行，与 inline 无关
//   3. Trusted Types 仅管 DOM XSS sinks（innerHTML/document.write/eval/Function/script.src setter）
//      window.__MP_CONFIG__={...} 是纯属性赋值，非 sink → TT 不拦（W3C spec + MDN 确证）
//   4. 两个相邻 classic <script src> 无 async/defer → 严格按文档序执行 → config 先于 overlay 就绪
//
// 用法：
//   node spike6.mjs --patch     # patch + 烘焙 mp-config.js + 写 overlay + 起 server(:17741)
//   node spike6.mjs --revert    # 停 server + 还原 workbench.html/product.json + 清 mp-*.js
//   MP_APP_ROOT=/tmp/fake-app node spike6.mjs --patch   # 测试用，指向 fake fixture
//
// ⚠️ patch 后必须 Cmd+Q 完全退出 VSCode 再重开（Reload Window 用 Chromium disk cache
//    不重读 workbench.html，patch 不生效 — RK13 / main.js:1068345 webContents.reload 普通模式）
// =============================================================================
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import http from 'http';
import os from 'os';

// ---- 路径（可用 MP_APP_ROOT 环境变量覆盖以指向测试 fixture）-----------------
const APP = process.env.MP_APP_ROOT || '/Applications/Visual Studio Code.app/Contents/Resources/app';
const WB_DIR = path.join(APP, 'out/vs/code/electron-browser/workbench');
const WB = path.join(WB_DIR, 'workbench.html');
const PRODUCT = path.join(APP, 'product.json');
const CONFIG_JS = path.join(WB_DIR, 'mp-config.js');   // 静态外链配置（烘焙 port/token）
const OVERLAY_JS = path.join(WB_DIR, 'mp-overlay.js'); // 静态外链 overlay（fetch /ping）
const SERVER_RUNNER = path.join(os.tmpdir(), 'mp-spike6-server.mjs'); // detached server 入口
const PIDFILE = path.join(os.tmpdir(), 'mp-spike6.pid');
const TOKENFILE = path.join(os.tmpdir(), 'mp-spike6.token');

const WB_CHECKSUM_KEY = 'vs/code/electron-browser/workbench/workbench.html';
const MARKER_START = '<!--mp-spike6-->';
const MARKER_END = '<!--/mp-spike6-->';
const VERSION = 'v0.1.0-spike6';
const BASE_PORT = 17741;
const PORT_MAX = 17760; // 递增上限（冲突时 17741→...→17760）

// ---- 工具 ------------------------------------------------------------------
function sha256Checksum(buf) {
  return crypto.createHash('sha256').update(buf).digest('base64').replace(/=+$/, '');
}
function backup(p) {
  const bak = p + '.mp.bak';
  if (!fs.existsSync(bak)) fs.copyFileSync(p, bak);
}

// CSP meta：用 backreference 捕获开引号，避免 'none'/'self' 的单引号被误当闭合引号
// （实测 doc02 原正则 [^"'] 在 'none' 处截断，只捕到 22 字符）
const CSP_META_RE = /(<meta\b[^>]*?\bhttp-equiv\s*=\s*(["'])Content-Security-Policy\2[^>]*?\bcontent\s*=\s*(["']))([\s\S]*?)(\3)/i;

// 幂等地在某 directive 段追加 token（已存在则跳过；directive 缺失则不动 CSP）
function injectCspDirective(csp, directive, token) {
  const segRe = new RegExp(`(${directive}\\s+)([^;]*?)(\\s*;)`, 'i');
  const sm = csp.match(segRe);
  if (!sm) return csp;                       // directive 不存在 → 保守不动
  if (sm[2].includes(token.trim())) return csp; // 已含 token → 幂等跳过
  return csp.replace(segRe, (full, a, b, c) => a + b + token + c);
}

function patchCsp(html) {
  const m = html.match(CSP_META_RE);
  if (!m) { console.warn('[csp] ⚠️ 未找到 CSP meta，跳过 CSP patch（罕见，需人工查）'); return html; }
  let csp = m[4];
  const LOCAL = ' http://127.0.0.1:*';       // 通配端口（VSCode 开发版 workbench-dev.html 自用格式）
  csp = injectCspDirective(csp, 'connect-src', LOCAL);           // overlay fetch
  csp = injectCspDirective(csp, 'img-src', LOCAL);               // <img> http/blob
  csp = injectCspDirective(csp, 'media-src', LOCAL + ' blob:');  // <video>/<audio> blob/http
  return html.replace(CSP_META_RE, `$1${csp}$5`);
}

// 注入标记块（幂等：先清旧块再注新）。mp-config.js 必须在 mp-overlay.js 之前（文档序=执行序）
function injectScriptTags(html) {
  const block =
    `${MARKER_START}\n` +
    `\t<script src="./mp-config.js"></script>\n` +   // 先：烘焙 {port,token,version}
    `\t<script src="./mp-overlay.js"></script>\n` +  // 后：读 __MP_CONFIG__ 后 fetch /ping
    `\t${MARKER_END}\n`;
  let cleaned = html.replace(/<!--mp-spike6-->[\s\S]*?<!--\/mp-spike6-->\n?\s*/g, '');
  if (/<\/body>/i.test(cleaned)) return cleaned.replace(/<\/body>/i, `${block}$&`);
  if (/<\/html>/i.test(cleaned)) return cleaned.replace(/<\/html>/i, `${block}$&`);
  return cleaned + block;
}

// ---- 端口发现（递增直到可用）----------------------------------------------
function listenOnAvailablePort(basePort, maxPort) {
  return new Promise((resolve, reject) => {
    function tryPort(p) {
      if (p > maxPort) return reject(new Error(`no free port in ${basePort}..${maxPort}`));
      const server = http.createServer();
      server.once('error', (e) => { if (e.code === 'EADDRINUSE') tryPort(p + 1); else reject(e); });
      server.once('listening', () => resolve({ server, port: p }));
      server.listen(p, '127.0.0.1');
    }
    tryPort(basePort);
  });
}

// ---- 静态文件内容 ----------------------------------------------------------
function configJsContent(port, token) {
  // 纯 window 属性赋值，非 TT sink，非 inline → 受 script-src 'self' 放行
  return `// ${VERSION} 配置（patch 时烘焙实际 port/token；勿手改）
// CSP script-src 'self' 允许本外链加载；Trusted Types 不管 window 属性赋值
window.__MP_CONFIG__ = { port: ${port}, token: ${JSON.stringify(token)}, version: ${JSON.stringify(VERSION)} };
console.log('%c[mp-config] loaded', 'color:#0f0', window.__MP_CONFIG__);
`;
}

function overlayJsContent() {
  return `// ${VERSION} overlay IIFE — 证明 fetch EH server 链路通
(() => {
  const cfg = window.__MP_CONFIG__ || {};
  const BASE = 'http://127.0.0.1:' + (cfg.port || ${BASE_PORT});
  const tok = cfg.token || '';
  const tag = (c, s) => console.log('%c[mp-overlay] ' + s, 'color:' + c + ';font-weight:bold');
  tag('#0ff', 'overlay loaded, target=' + BASE);

  const ping = async () => {
    try {
      const r = await fetch(BASE + '/ping');
      const t = await r.text();
      tag('#0f0', '/ping -> ' + r.status + ' ' + JSON.stringify(t) + (r.status === 200 ? ' ✅ PASS' : ' 🔴 FAIL'));
    } catch (e) { tag('#f00', '/ping fetch FAILED: ' + e.message + ' (检查 CSP connect-src / server 是否在跑)'); }
    try {
      const r2 = await fetch(BASE + '/config?token=' + encodeURIComponent(tok));
      if (r2.ok) { const j = await r2.json(); tag('#0f0', '/config -> ' + r2.status + ' port=' + j.port + ' ✅'); }
      else tag('#f00', '/config -> ' + r2.status + ' 🔴');
    } catch (e) { tag('#f00', '/config fetch FAILED: ' + e.message); }
    tag('#0f0', 'Spike 6 端到端验证完成。fetch 通=connect-src patch 生效。');
  };
  if (document.readyState === 'complete') ping();
  else window.addEventListener('load', ping);
})();
`;
}

// detached server runner（由 --patch spawn，独立进程存活到 --revert）
// ⚠️ 本文件是 .mjs(ESM)，必须用 import，不能用 require（实测 require('os') 崩 ReferenceError）
function serverRunnerSrc() {
  return `import http from 'http'; import fs from 'fs'; import path from 'path'; import os from 'os';
const TOKEN = process.env.MP_TOKEN; const PORT = parseInt(process.env.MP_PORT,10);
const LISTENING_SENTINEL = path.join(os.tmpdir(), 'mp-spike6.listening');
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1:' + PORT);
  if (u.pathname === '/ping') { res.writeHead(200); res.end('ok'); return; }
  if (u.pathname === '/config') {
    if (u.searchParams.get('token') !== TOKEN) { res.writeHead(403); res.end('forbidden'); return; }
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ port: PORT, version: '${VERSION}', types: { image: { exts:['png','jpg'] } } }));
    return;
  }
  res.writeHead(404); res.end('not found');
});
server.listen(PORT, '127.0.0.1', () => {
  fs.writeFileSync(LISTENING_SENTINEL, String(PORT));
  console.log('[mp-spike6-server] listening on 127.0.0.1:' + PORT);
});
process.on('SIGTERM', () => server.close(() => { try{fs.unlinkSync(LISTENING_SENTINEL);}catch(e){} process.exit(0); }));
`;
}

// ---- patch -----------------------------------------------------------------
async function patch() {
  if (!fs.existsSync(WB)) { console.error('workbench.html 不存在：' + WB); process.exit(1); }
  backup(WB); backup(PRODUCT);

  // 1. workbench.html：CSP patch + 注入两 script 标签
  let html = fs.readFileSync(WB, 'utf8');
  const cspBefore = /connect-src[^;]*127\.0\.0\.1/.test(html);
  html = patchCsp(html);
  html = injectScriptTags(html);
  fs.writeFileSync(WB, html);
  const cspAfter = /connect-src[^;]*127\.0\.0\.1/.test(html);
  console.log('[patch] CSP connect-src 加 127.0.0.1:*:', !cspBefore && cspAfter ? '✅' : (cspBefore ? '(已存在,幂等)' : '🔴'));
  const cnt = (html.match(/127\.0\.0\.1:\*/g) || []).length;
  console.log('[patch] 127.0.0.1:* 出现次数 =', cnt, '(期望 3：connect/img/media)');

  // 2. 写 mp-config.js + mp-overlay.js
  // 2a. 先起 server 拿到【实际】port（端口冲突会递增），再烘焙进 mp-config.js
  console.log('[patch] 探测可用端口（base ' + BASE_PORT + ')...');
  const { server, port: actualPort } = await listenOnAvailablePort(BASE_PORT, PORT_MAX);
  server.close(); // 关掉探测实例，下面用 detached runner 重起（拿到 actualPort）
  const token = crypto.randomBytes(12).toString('hex');
  fs.writeFileSync(CONFIG_JS, configJsContent(actualPort, token));
  fs.writeFileSync(OVERLAY_JS, overlayJsContent());
  fs.writeFileSync(TOKENFILE, token);
  console.log('[patch] mp-config.js 烘焙 port=' + actualPort + ', token=' + token.slice(0, 8) + '...');
  console.log('[patch] mp-overlay.js 写入（fetch /ping + /config）');

  // 3. product.json：重算 workbench.html checksum 填回（字符串替换，保留格式）
  const newChecksum = sha256Checksum(fs.readFileSync(WB));
  let productRaw = fs.readFileSync(PRODUCT, 'utf8');
  const re = new RegExp(`("${WB_CHECKSUM_KEY.replace(/\//g, '\\/')}")\\s*:\\s*"([^"]+)"`);
  if (re.test(productRaw)) {
    const old = productRaw.match(re)[2];
    productRaw = productRaw.replace(re, `$1: "${newChecksum}"`);
    console.log('[patch] checksum ' + WB_CHECKSUM_KEY + ':\n   旧: ' + old + '\n   新: ' + newChecksum);
  } else { console.warn('[patch] ⚠️ 未找到 checksum key（product.json 结构变？）'); }
  fs.writeFileSync(PRODUCT, productRaw);

  // 4. 起 detached server（独立进程，活到 --revert）
  fs.writeFileSync(SERVER_RUNNER, serverRunnerSrc());
  const { spawn } = await import('child_process');
  const child = spawn(process.execPath, [SERVER_RUNNER], {
    env: { ...process.env, MP_PORT: String(actualPort), MP_TOKEN: token },
    detached: true, stdio: 'ignore',
  });
  child.unref();
  fs.writeFileSync(PIDFILE, String(child.pid));
  console.log('[patch] detached server pid=' + child.pid + ' @ 127.0.0.1:' + actualPort);

  // 5. post-verify（轮询 listening sentinel，比固定 sleep 稳）
  const listeningFile = path.join(os.tmpdir(), 'mp-spike6.listening');
  try { fs.unlinkSync(listeningFile); } catch (e) { /* 首跑无文件，忽略 */ }
  let up = false;
  for (let i = 0; i < 30; i++) {            // 最多等 ~3s
    if (fs.existsSync(listeningFile)) { up = true; break; }
    await new Promise(r => setTimeout(r, 100));
  }
  const vp = JSON.parse(fs.readFileSync(PRODUCT, 'utf8'));
  const ok = vp.checksums[WB_CHECKSUM_KEY] === sha256Checksum(fs.readFileSync(WB));
  console.log('[verify] marker in workbench.html:', fs.readFileSync(WB, 'utf8').includes(MARKER_START) ? '✅' : '🔴');
  console.log('[verify] checksum 匹配:', ok ? '✅ 完全重启不弹损坏' : '🔴 仍会弹损坏');
  console.log('[verify] server listening:', up ? '✅' : '🔴（未起来，查 stderr: node ' + SERVER_RUNNER + '）');

  // 6. server 自检（fetch /ping + /config）
  try {
    const r = await fetch('http://127.0.0.1:' + actualPort + '/ping');
    console.log('[verify] server /ping ->', r.status, JSON.stringify(await r.text()), r.status === 200 ? '✅' : '🔴');
    const r2 = await fetch('http://127.0.0.1:' + actualPort + '/config?token=' + token);
    console.log('[verify] server /config ->', r2.status, r2.status === 200 ? '✅' : '🔴 (token=' + token.slice(0,8) + '...)');
    const wrongTok = await fetch('http://127.0.0.1:' + actualPort + '/config?token=wrong');
    console.log('[verify] 错 token /config ->', wrongTok.status, wrongTok.status === 403 ? '✅ token 校验生效' : '🔴 安全洞');
  } catch (e) { console.warn('[verify] server /ping 失败:', e.message); }

  console.log('\n✅ patch 完成。现在请：');
  console.log('   1) Cmd+Q 【完全退出】VSCode（不要用 Reload Window）');
  console.log('   2) 重开 VSCode，打开任意文件夹');
  console.log('   3) Help → Toggle Developer Tools → Console');
  console.log('   4) 应见 [mp-config] loaded + [mp-overlay] /ping -> 200 "ok" ✅ PASS');
  console.log('   5) Network 面板查 ping 请求 status 200，Response Headers 无第二 CSP');
  console.log('   验证完跑: node spike6.mjs --revert');
}

// ---- revert ----------------------------------------------------------------
async function revert() {
  // 停 server
  if (fs.existsSync(PIDFILE)) {
    const pid = parseInt(fs.readFileSync(PIDFILE, 'utf8'), 10);
    try { process.kill(pid, 'SIGTERM'); console.log('[revert] killed server pid=' + pid); }
    catch (e) { console.log('[revert] server pid=' + pid + ' 已不在 (kill: ' + e.message + ')'); }
    fs.unlinkSync(PIDFILE);
  }
  // 还原两个文件
  for (const p of [WB, PRODUCT]) {
    const bak = p + '.mp.bak';
    if (fs.existsSync(bak)) { fs.copyFileSync(bak, p); fs.unlinkSync(bak); console.log('[revert] restored ' + path.basename(p)); }
  }
  // 清 mp-*.js + server runner + listening sentinel
  const listeningFile = path.join(os.tmpdir(), 'mp-spike6.listening');
  for (const p of [CONFIG_JS, OVERLAY_JS, SERVER_RUNNER, TOKENFILE, listeningFile]) {
    if (fs.existsSync(p)) { fs.unlinkSync(p); console.log('[revert] removed ' + path.basename(p)); }
  }
  console.log('\n✅ revert 完成。Cmd+Q 完全退出 VSCode 后重开，恢复原状。');
}

const cmd = process.argv[2];
if (cmd === '--patch') patch().catch(e => { console.error(e); process.exit(1); });
else if (cmd === '--revert') revert().catch(e => { console.error(e); process.exit(1); });
else console.log('usage: node spike6.mjs --patch | --revert   [MP_APP_ROOT=/path 指向测试 fixture]');
