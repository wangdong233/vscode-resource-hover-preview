#!/usr/bin/env node
// Spike 2 验证脚本 v2：静态 <script src> 注入能否加载 + 重算 checksum（不删 key）
// 关键修正（v1 教训）：删 checksum key 在 1.129.1 仍弹"安装损坏" → 改"重算 SHA256 填回" + product.json 字符串替换（保留原格式）
// 用法： node spike2.mjs --patch   |   node spike2.mjs --revert
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const APP = '/Applications/Visual Studio Code.app/Contents/Resources/app';
const WB_DIR = path.join(APP, 'out/vs/code/electron-browser/workbench');
const WB = path.join(WB_DIR, 'workbench.html');
const PRODUCT = path.join(APP, 'product.json');
const TESTJS = path.join(WB_DIR, 'mp-test.js');
const MARKER_START = '<!--mp-spike2-->';
const MARKER_END = '<!--/mp-spike2-->';
const BLOCK = `${MARKER_START}\n\t\t<script src="./mp-test.js"></script>\n\t${MARKER_END}\n`;
// checksums 的 key 是 workbench.html 相对 app 资源路径，去掉 out/ 前缀（本机实测）
const WB_CHECKSUM_KEY = 'vs/code/electron-browser/workbench/workbench.html';

function sha256Checksum(buf) {
  return crypto.createHash('sha256').update(buf).digest('base64').replace(/=+$/, '');
}
function backup(p) {
  const bak = p + '.mp.bak';
  if (!fs.existsSync(bak)) fs.copyFileSync(p, bak);
}

function patch() {
  backup(WB); backup(PRODUCT);

  // 1. workbench.html：注入静态 script（标记块，幂等）
  let html = fs.readFileSync(WB, 'utf8');
  html = html.replace(/<!--mp-spike2-->[\s\S]*?<!--\/mp-spike2-->\n?\s*/g, '');
  if (/<\/html>/i.test(html)) html = html.replace(/<\/html>/i, `${BLOCK}</html>`);
  else html += BLOCK;
  fs.writeFileSync(WB, html);
  console.log('[patch] injected <script src=./mp-test.js> into workbench.html');

  // 2. product.json：重算 workbench.html 的 checksum 填回（字符串替换，保留原格式，不删 key）
  const newChecksum = sha256Checksum(fs.readFileSync(WB)); // 基于改后的 workbench.html
  let productRaw = fs.readFileSync(PRODUCT, 'utf8');
  const re = new RegExp(`("${WB_CHECKSUM_KEY.replace(/\//g, '\\/')}")\\s*:\\s*"([^"]+)"`);
  if (re.test(productRaw)) {
    const old = productRaw.match(re)[2];
    productRaw = productRaw.replace(re, `$1: "${newChecksum}"`);
    console.log(`[patch] checksum ${WB_CHECKSUM_KEY}:\n   旧: ${old}\n   新: ${newChecksum}`);
  } else {
    console.log('[patch] ⚠️ 未找到 checksum key（product.json 可能已被改）');
  }
  fs.writeFileSync(PRODUCT, productRaw); // 字符串替换，格式/其他字段完全不变

  // 3. 写 mp-test.js（运行时诊断：renderer 实际加载的 workbench.html 是哪个版本）
  const testJs = `// mp-spike2 诊断 —— renderer 视角的 workbench.html 真相
(() => {
  console.log('%c[mp] ✅ mp-test.js LOADED（证明 script 被加载）', 'color:#0f0;font-weight:bold');
  const run = async () => {
    // ① renderer DOM 是否含我们的注入标记
    const html = document.documentElement.outerHTML;
    console.log('[mp] document 含 mp-spike2 标记:', html.includes('mp-spike2'), '(若 false=加载的不是改后文件)');
    // ② 关键：fetch 当前文档源 → 算 sha256 → 对比我们填的 vs 原始
    try {
      const resp = await fetch(location.href);
      const text = await resp.text();
      const data = new TextEncoder().encode(text);
      const hashBuf = await crypto.subtle.digest('SHA-256', data);
      const b64 = btoa(String.fromCharCode(...new Uint8Array(hashBuf))).replace(/=+$/,'');
      console.log('%c[mp] renderer 视角 workbench.html sha256: ' + b64, 'color:#0ff;font-weight:bold');
      console.log('[mp] 我们填进 product.json 的: JY/WyM+MzRRD1M3sc79VBtIvjwWNBIYwJoMgQZqW8ZE');
      console.log('[mp] 原始出厂的           : Jy2ZZdrDEOIkNVFIGQnt5xfjEHfc0fqlvjQnLx8V7ck');
      console.log('[mp] = 我们填的?:', b64 === 'JY/WyM+MzRRD1M3sc79VBtIvjwWNBIYwJoMgQZqW8ZE');
      console.log('[mp] = 原始出厂?:', b64 === 'Jy2ZZdrDEOIkNVFIGQnt5xfjEHfc0fqlvjQnLx8V7ck');
      console.log('[mp] fetch 到的源含 mp-spike2:', text.includes('mp-spike2'), '长度:', text.length);
    } catch (e) { console.log('[mp] fetch location.href 失败:', e.message); }
    // ③ TT
    try { document.body.innerHTML='<div>x</div>'; console.log('[mp] TT 未拦 innerHTML'); }
    catch(e) { console.log('[mp] ✅ TT 拦 innerHTML:', e.name); }
    console.log('%c[mp] 诊断完成', 'color:#0f0');
  };
  if (document.readyState === 'complete') run();
  else window.addEventListener('load', run);
})();
`;
  fs.writeFileSync(TESTJS, testJs);
  console.log('[patch] wrote mp-test.js');

  // 4. post-verify：checksum 必须匹配，否则 reload 仍弹损坏
  const vp = JSON.parse(fs.readFileSync(PRODUCT, 'utf8'));
  const vc = sha256Checksum(fs.readFileSync(WB));
  const ok = vp.checksums[WB_CHECKSUM_KEY] === vc;
  console.log('[verify] marker in workbench.html:', fs.readFileSync(WB, 'utf8').includes(MARKER_START));
  console.log('[verify] checksum 匹配:', ok, ok ? '✅ reload 不应弹损坏' : '🔴 仍会弹损坏');
  console.log('\n✅ patch v2 完成。请 Cmd+Shift+P → Reload Window，看是否还弹"安装损坏" + DevTools Console [mp-spike2] 日志。');
}

function revert() {
  for (const p of [WB, PRODUCT]) {
    const bak = p + '.mp.bak';
    if (fs.existsSync(bak)) { fs.copyFileSync(bak, p); fs.unlinkSync(bak); console.log('[revert] restored', path.basename(p)); }
  }
  if (fs.existsSync(TESTJS)) { fs.unlinkSync(TESTJS); console.log('[revert] removed mp-test.js'); }
  console.log('\n✅ revert 完成。请 Reload Window 恢复。');
}

const cmd = process.argv[2];
if (cmd === '--patch') patch();
else if (cmd === '--revert') revert();
else console.log('usage: node spike2.mjs --patch | --revert');
