#!/usr/bin/env node
// Spike 8 验证脚本：Explorer 文件项 DOM 实测 + 完整路径先验
// -----------------------------------------------------------------------------
// 目的：Cmd+Q 完全退出重启后，在 DevTools Console 实测 1.129.1 Explorer 文件项的真实
//   DOM 结构，一锤定音回答 Spike 8 核心问题：「Explorer 行 DOM 的 title/aria-label/
//   data-* 是否已含完整绝对路径？」——若含 → 直接读，删整个 EH 文件索引子系统。
//
// 白盒源码已 trace（confidence: high，evidence 见 doc/06）：
//   explorerViewer.ts FilesRenderer.renderStat → label.setResource({resource,name}, 无 title)
//   → labels.ts ResourceLabelWidget.render: options.title 为空 →
//       iconLabelOptions.title = computedPathLabel = labelService.getUriLabel(resource)
//       (= 完整绝对路径；若有 FileDecorationProvider 的 tooltip 再追加 " • decoration")
//   → iconLabel.ts IconLabel.setLabel: aria-label = options.title = 完整路径
//   本脚本把上述源码结论在真实 DOM 上验证。
//
// TT 安全：probe 只做 DOM 读取 + console.log + localStorage.setItem，无 innerHTML sink。
//
// 用法： node spike8-dom.mjs --patch   |   node spike8-dom.mjs --revert
// 关键：patch 后必须 Cmd+Q 完全退出 VSCode 再启动（Reload Window 走 Chromium HTTP cache
//   不重读 workbench.html，patch 不生效——见 doc/10 RK13）。重启后打开 DevTools Console
//   看 [mp-spike8] 日志；折叠/展开几个文件夹让 Explorer 渲染足够多的行。
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const APP = '/Applications/Visual Studio Code.app/Contents/Resources/app';

// 多候选 workbench.html（Spike 3 实证：1.129.1 命中第一个 electron-browser/workbench.html）
// 候选顺序与 doc/05 一致；首个存在即用，其余作 fallback。
const WB_CANDIDATES = [
  'out/vs/code/electron-browser/workbench/workbench.html',   // ✅ 1.129.1 实证命中
  'out/vs/code/electron-sandbox/workbench/workbench.esm.html',
  'out/vs/code/electron-sandbox/workbench/workbench.html',
  'out/vs/code/electron-browser/workbench/workbench.esm.html',
  'out/vs/code/electron-sandbox/workbench/workbench-apc-extension.html', // Cursor
];

function resolveWorkbench() {
  for (const rel of WB_CANDIDATES) {
    const abs = path.join(APP, rel);
    if (fs.existsSync(abs)) {
      // checksum key 去掉 'out/' 前缀（Spike 4 实测）
      const checksumKey = rel.replace(/^out\//, '');
      return { wbAbs: abs, wbDir: path.dirname(abs), rel, checksumKey };
    }
  }
  throw new Error('未找到任何 workbench.html 候选（检查 APP 路径）');
}

const { wbAbs: WB, wbDir: WB_DIR, checksumKey: WB_CHECKSUM_KEY } = resolveWorkbench();
const PRODUCT = path.join(APP, 'product.json');
const PROBE_JS = path.join(WB_DIR, 'mp-dom-probe.js');
const MARKER_START = '<!--mp-spike8-->';
const MARKER_END = '<!--/mp-spike8-->';
const BLOCK = MARKER_START + '\n\t\t<script src="./mp-dom-probe.js"></script>\n\t' + MARKER_END + '\n';

function sha256Checksum(buf) {
  return crypto.createHash('sha256').update(buf).digest('base64').replace(/=+$/, '');
}
function backup(p) {
  const bak = p + '.mp.bak';
  if (!fs.existsSync(bak)) fs.copyFileSync(p, bak);
}

function patch() {
  console.log('[patch] workbench.html = ' + WB);
  console.log('[patch] checksum key   = ' + WB_CHECKSUM_KEY);
  backup(WB); backup(PRODUCT);

  // 1. workbench.html：注入静态 script（标记块，幂等，先清旧块）
  let html = fs.readFileSync(WB, 'utf8');
  html = html.replace(/<!--mp-spike8-->[\s\S]*?<!--\/mp-spike8-->\n?\s*/g, '');
  if (/<\/html>/i.test(html)) html = html.replace(/<\/html>/i, BLOCK + '</html>');
  else html += BLOCK;
  fs.writeFileSync(WB, html);
  console.log('[patch] injected <script src=./mp-dom-probe.js> into workbench.html');

  // 2. product.json：重算 workbench.html 的 checksum 填回（字符串替换，保留原格式）
  const newChecksum = sha256Checksum(fs.readFileSync(WB));
  let productRaw = fs.readFileSync(PRODUCT, 'utf8');
  const re = new RegExp('("' + WB_CHECKSUM_KEY.replace(/\//g, '\\/') + '")\\s*:\\s*"([^"]+)"');
  if (re.test(productRaw)) {
    const old = productRaw.match(re)[2];
    productRaw = productRaw.replace(re, '$1: "' + newChecksum + '"');
    console.log('[patch] checksum ' + WB_CHECKSUM_KEY + ':\n   旧: ' + old + '\n   新: ' + newChecksum);
  } else {
    console.log('[patch] ⚠️ 未在 product.json 找到 checksum key "' + WB_CHECKSUM_KEY + '"（可能已改/版本漂移）');
  }
  fs.writeFileSync(PRODUCT, productRaw);

  // 3. 写 mp-dom-probe.js（TT 安全的 DOM 诊断）
  fs.writeFileSync(PROBE_JS, PROBE_JS_SOURCE);
  console.log('[patch] wrote mp-dom-probe.js');

  // 4. post-verify：checksum 必须匹配
  const vp = JSON.parse(fs.readFileSync(PRODUCT, 'utf8'));
  const vc = sha256Checksum(fs.readFileSync(WB));
  const ok = vp.checksums && vp.checksums[WB_CHECKSUM_KEY] === vc;
  console.log('[verify] marker in workbench.html:', fs.readFileSync(WB, 'utf8').includes(MARKER_START));
  console.log('[verify] checksum 匹配:', ok, ok ? '✅ 完全重启不应弹损坏' : '🔴 仍会弹损坏');
  console.log('\n✅ patch 完成。下一步：');
  console.log('   1) 完全退出 VSCode（Cmd+Q，不是 Reload Window！）');
  console.log('   2) 重新打开 VSCode，打开一个有多层文件夹/多种文件类型的工作区');
  console.log('   3) Help → Toggle Developer Tools → Console');
  console.log('   4) 折叠/展开几个文件夹让 Explorer 渲染足够多的行');
  console.log('   5) 看 [mp-spike8] 日志（含选择器命中 + 每行的 aria-label/title/label-name）');
  console.log('   6) 鼠标悬停某个文件 → 触发一次性 HOVER PROBE 详细 dump');
  console.log('   7) Console 跑 window.__mpScan("manual") 可随时重扫; window.__mpGetStored() 读最近一次 dump');
  console.log('   8) Application → Local Storage → mp.spike8.dom 可看完整 JSON');
}

function revert() {
  for (const p of [WB, PRODUCT]) {
    const bak = p + '.mp.bak';
    if (fs.existsSync(bak)) { fs.copyFileSync(bak, p); fs.unlinkSync(bak); console.log('[revert] restored', path.basename(p)); }
    else console.log('[revert] 无备份可恢复（已干净）:', path.basename(p));
  }
  if (fs.existsSync(PROBE_JS)) { fs.unlinkSync(PROBE_JS); console.log('[revert] removed mp-dom-probe.js'); }
  console.log('\n✅ revert 完成。请 Cmd+Q 完全退出 VSCode 再启动恢复。');
}

// -----------------------------------------------------------------------------
// mp-dom-probe.js 源码（运行在 workbench renderer，DOM 只读 + console + localStorage）
// 严禁 innerHTML 等 TT sink；全部用 createElement 风格的读 API。
// 用字符串数组拼接避免 .mjs 模板字符串内的反引号转义问题。
// -----------------------------------------------------------------------------
const PROBE_JS_SOURCE = [
  '// mp-spike8 DOM probe — TT-safe (reads + console + localStorage only)',
  '(() => {',
  '  var LS_KEY = "mp.spike8.dom";',
  '  var TAG = "%c[mp-spike8]";',
  '  var STY = "color:#0f0;font-weight:bold";',
  '  console.log(TAG, STY, "mp-dom-probe.js LOADED (proof script injected & executed)");',
  '',
  '  // 选择器多层 fallback（doc/06 §二），从精到宽',
  '  var SELECTOR_TIERS = [',
  '    ".explorer-viewlet .monaco-list-row[role=\\"treeitem\\"]",',
  '    ".explorer-folders-view .monaco-list-row",',
  '    ".explorer-viewlet [role=\\"treeitem\\"]",',
  '    ".part.sidebar .monaco-list-row",',
  '    "[role=\\"treeitem\\"]"',
  '  ];',
  '',
  '  function waitFor(test, cb, timeout) {',
  '    var start = Date.now();',
  '    (function tick() {',
  '      try { if (test()) { cb(); return; } } catch (e) {}',
  '      if (Date.now() - start > (timeout || 15000)) { console.log(TAG, STY, "waitFor TIMEOUT (explorer 未渲染?)"); cb(); return; }',
  '      setTimeout(tick, 300);',
  '    })();',
  '  }',
  '',
  '  function firstHitSelector() {',
  '    for (var i = 0; i < SELECTOR_TIERS.length; i++) {',
  '      try { if (document.querySelector(SELECTOR_TIERS[i])) return SELECTOR_TIERS[i]; } catch (e) {}',
  '    }',
  '    return null;',
  '  }',
  '',
  '  function rowIsExplorer(row) {',
  '    if (!row || !row.closest) return false;',
  '    return !!(row.closest(".explorer-viewlet") || row.closest(".explorer-folders-view") || row.closest("#workbench.view.explorer"));',
  '  }',
  '',
  '  function attrsToObj(el) {',
  '    var o = {};',
  '    if (!el) return o;',
  '    for (var i = 0; i < el.attributes.length; i++) {',
  '      var a = el.attributes[i];',
  '      o[a.name] = a.value;',
  '    }',
  '    return o;',
  '  }',
  '',
  '  // 核心：把一个 row 的所有与「路径推导」相关的属性抽出来',
  '  function describeRow(row, idx) {',
  '    var iconLabel = row.querySelector(".monaco-icon-label");',
  '    var labelNames = Array.prototype.slice.call(row.querySelectorAll("a.label-name"));',
  '    var labelDesc = row.querySelector(".label-description");',
  '    var labelSuffix = row.querySelector(".label-suffix");',
  '    var nameTexts = labelNames.map(function (n) { return n.textContent; });',
  '    var ariaLabel = iconLabel ? iconLabel.getAttribute("aria-label") : null;',
  '    // Spike 8 关键判定：aria-label 是否含路径分隔符（/或\\）→ 是否完整路径',
  '    var looksLikePath = !!ariaLabel && (ariaLabel.indexOf("/") >= 0 || ariaLabel.indexOf("\\\\") >= 0);',
  '    // 装饰后缀（FileDecorationProvider tooltip 追加）: "<path> • <tooltip>"',
  '    var sepIdx = ariaLabel ? ariaLabel.indexOf(" \\u2022 ") : -1; // \\u2022 = •',
  '    var pathPart = sepIdx >= 0 ? ariaLabel.slice(0, sepIdx) : ariaLabel;',
  '    return {',
  '      idx: idx,',
  '      role: row.getAttribute("role"),',
  '      rowClass: row.className,',
  '      rowAriaLabel: row.getAttribute("aria-label"),',
  '      rowTitle: row.getAttribute("title"),',
  '      ariaLevel: row.getAttribute("aria-level"),',
  '      ariaExpanded: row.getAttribute("aria-expanded"),',
  '      rowId: row.getAttribute("id"),',
  '      dataId: row.getAttribute("data-id"),',
  '      labelNameText: nameTexts.join(" / "),',
  '      labelNameCount: labelNames.length,',
  '      compressed: labelNames.length > 1,',
  '      labelDescription: labelDesc ? labelDesc.textContent : null,',
  '      labelSuffix: labelSuffix ? labelSuffix.textContent : null,',
  '      iconLabelClass: iconLabel ? iconLabel.className : null,',
  '      iconLabelAriaLabel: ariaLabel,',
  '      iconLabelTitle: iconLabel ? iconLabel.getAttribute("title") : null, // 是否有原生 title',
  '      // ---- Spike 8 判定字段 ----',
  '      ariaLabelLooksLikePath: looksLikePath,',
  '      decorationSuffixPresent: sepIdx >= 0,',
  '      extractedPath: pathPart,',
  '      extractedPathMatchesName: pathPart ? (pathPart.indexOf(nameTexts[nameTexts.length - 1] || "\\u0001") >= 0) : false,',
  '      allRowAttrs: attrsToObj(row),',
  '      allIconLabelAttrs: attrsToObj(iconLabel),',
  '      outerHTMLHead: (row.outerHTML || "").slice(0, 500)',
  '    };',
  '  }',
  '',
  '  function scan(label) {',
  '    var hitSel = firstHitSelector();',
  '    var allRows = [];',
  '    if (hitSel) allRows = Array.prototype.slice.call(document.querySelectorAll(hitSel)).filter(rowIsExplorer);',
  '    var described = allRows.map(function (r, i) { return describeRow(r, i); });',
  '    var tierCounts = SELECTOR_TIERS.map(function (s) {',
  '      var c; try { c = document.querySelectorAll(s).length; } catch (e) { c = "ERR"; }',
  '      return { selector: s, count: c };',
  '    });',
  '    var summary = {',
  '      scanLabel: label || "manual",',
  '      timestamp: new Date().toISOString(),',
  '      hitSelector: hitSel,',
  '      selectorTierCounts: tierCounts,',
  '      explorerRowCount: described.length,',
  '      // Spike 8 一锤定音聚合判定',
  '      spike8Verdict: {',
  '        rowsWithIconLabelAriaLabel: described.filter(function (r) { return !!r.iconLabelAriaLabel; }).length,',
  '        rowsWhereAriaLabelLooksLikePath: described.filter(function (r) { return r.ariaLabelLooksLikePath; }).length,',
  '        rowsWithNativeTitle: described.filter(function (r) { return !!r.iconLabelTitle; }).length,',
  '        rowsWithDecorationSuffix: described.filter(function (r) { return r.decorationSuffixPresent; }).length,',
  '        rowsWhereExtractedPathContainsName: described.filter(function (r) { return r.extractedPathMatchesName; }).length',
  '      },',
  '      rows: described',
  '    };',
  '    try { localStorage.setItem(LS_KEY, JSON.stringify(summary)); } catch (e) { console.log(TAG, STY, "localStorage.setItem failed", e); }',
  '',
  '    console.log(TAG, STY, "scan \\"" + summary.scanLabel + "\\" explorerRows=" + described.length + " hit=" + (hitSel || "NONE"));',
  '    console.log(TAG, STY, "Spike8 verdict:", JSON.stringify(summary.spike8Verdict));',
  '    console.table(tierCounts);',
  '    if (described.length) {',
  '      console.table(described.map(function (r) {',
  '        return {',
  '          idx: r.idx,',
  '          name: r.labelNameText,',
  '          compressed: r.compressed,',
  '          level: r.ariaLevel,',
  '          expanded: r.ariaExpanded,',
  '          rowAriaLabelEqName: r.rowAriaLabel === r.labelNameText,',
  '          iconAriaLikePath: r.ariaLabelLooksLikePath,',
  '          iconAriaHasDecor: r.decorationSuffixPresent,',
  '          nativeTitle: r.iconLabelTitle ? "SET" : "null",',
  '          desc: r.labelDescription',
  '        };',
  '      }));',
  '    }',
  '    // 前 6 行全属性详打',
  '    described.slice(0, 6).forEach(function (r) {',
  '      console.log(TAG, STY, "--- row #" + r.idx + " ---");',
  '      console.log("  row class          :", r.rowClass);',
  '      console.log("  row aria-label     :", JSON.stringify(r.rowAriaLabel));',
  '      console.log("  row title(native)  :", JSON.stringify(r.rowTitle));',
  '      console.log("  aria-level/expand  :", r.ariaLevel, r.ariaExpanded);',
  '      console.log("  label-name text    :", JSON.stringify(r.labelNameText), "count=" + r.labelNameCount, "compressed=" + r.compressed);',
  '      console.log("  label-description  :", JSON.stringify(r.labelDescription));',
  '      console.log("  icon-label class   :", r.iconLabelClass);',
  '      console.log("  icon aria-label    :", JSON.stringify(r.iconLabelAriaLabel));',
  '      console.log("  icon title(native) :", JSON.stringify(r.iconLabelTitle));',
  '      console.log("  >>> Spike8: ariaLabelLooksLikePath=" + r.ariaLabelLooksLikePath + " extractedPath=" + JSON.stringify(r.extractedPath) + " pathContainsName=" + r.extractedPathMatchesName);',
  '      console.log("  all row attrs      :", JSON.stringify(r.allRowAttrs));',
  '      console.log("  all icon-label attrs:", JSON.stringify(r.allIconLabelAttrs));',
  '    });',
  '    return summary;',
  '  }',
  '',
  '  // 暴露给 DevTools 手动调用',
  '  window.__mpScan = scan;',
  '  window.__mpGetStored = function () { try { return JSON.parse(localStorage.getItem(LS_KEY) || "null"); } catch (e) { return null; } };',
  '  window.__mpDescribeHovered = function () {',
  '    // 手动：悬停某文件后调用，dump 当前被悬停 row 的完整属性',
  '    var rows = Array.prototype.slice.call(document.querySelectorAll(":hover"));',
  '    var row = null;',
  '    for (var i = 0; i < rows.length; i++) { if (rows[i].closest && rows[i].closest(".monaco-list-row[role=\\"treeitem\\"]")) { row = rows[i].closest(".monaco-list-row[role=\\"treeitem\\"]"); break; } }',
  '    if (!row) { console.log(TAG, STY, "无悬停的 explorer row"); return null; }',
  '    var d = describeRow(row, "HOVER-MANUAL");',
  '    console.log(TAG, STY, "=== HOVERED ROW ===");',
  '    console.log(JSON.stringify(d, null, 2));',
  '    return d;',
  '  };',
  '  console.log(TAG, STY, "helpers: window.__mpScan(\\"label\\") / window.__mpGetStored() / window.__mpDescribeHovered() | localStorage key = " + LS_KEY);',
  '',
  '  // 自动扫描：等 explorer 渲染后扫，再周期补扫（虚拟滚动/异步/展开）',
  '  waitFor(function () { return firstHitSelector() !== null; }, function () {',
  '    var n = 0;',
  '    var run = function () { scan("auto-" + (n++)); };',
  '    run();',
  '    var iv = setInterval(function () { if (n < 8) run(); else clearInterval(iv); }, 1500);',
  '    // 用户点击/折叠展开后补扫',
  '    document.addEventListener("click", function (e) {',
  '      var row = e.target && e.target.closest && e.target.closest(".monaco-list-row[role=\\"treeitem\\"]");',
  '      if (row && rowIsExplorer(row)) setTimeout(function () { scan("after-click"); }, 450);',
  '    }, { capture: true, passive: true });',
  '    // 一次性 hover 探针：首次悬停 explorer row 时 dump 该行',
  '    var hoverProbe = function (e) {',
  '      var row = e.target && e.target.closest && e.target.closest(".monaco-list-row[role=\\"treeitem\\"]");',
  '      if (!row || !rowIsExplorer(row)) return;',
  '      console.log(TAG, STY, "=== HOVER PROBE (first hovered explorer row) ===");',
  '      console.log(JSON.stringify(describeRow(row, "HOVERED"), null, 2));',
  '      document.removeEventListener("mouseover", hoverProbe, true);',
  '      console.log(TAG, STY, "(hover probe 已触发一次；后续用 window.__mpDescribeHovered() 或 window.__mpScan())");',
  '    };',
  '    document.addEventListener("mouseover", hoverProbe, true);',
  '  });',
  '})();',
  '\n',
].join('\n');

const cmd = process.argv[2];
if (cmd === '--patch') patch();
else if (cmd === '--revert') revert();
else console.log('usage: node spike8-dom.mjs --patch | --revert\n\n本脚本实测 Explorer DOM，验证 Spike 8（title/aria-label 是否含完整路径）。\npatch 后必须 Cmd+Q 完全退出 VSCode 再启动（不是 Reload Window）。');
