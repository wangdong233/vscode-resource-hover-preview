// CSP surgical patch + 注入。详见 doc/02_workbench注入设计.md
// ⚠️ CSP_META_RE 用 backreference（spike6 修正：原 [^"']* 在 'none'/'self' 单引号处截断，只捕 22 字符）。
// 用 \2 闭 http-equiv 引号、\3 闭 content 引号，[\s\S]*? 跨行捕 CSP 内容（CSP meta 是多行）。
const CSP_META_RE = /(<meta\b[^>]*?\bhttp-equiv\s*=\s*(["'])Content-Security-Policy\2[^>]*?\bcontent\s*=\s*(["']))([\s\S]*?)(\3)/i;

const TOKEN = " http://127.0.0.1:*"; // 通配端口（server 递增 17741→17742...，配套）

// surgical patch：connect-src/img-src/media-src 各追加 token（media-src 再加 blob:）
export function patchCsp(html: string): string {
    const match = html.match(CSP_META_RE);
    if (!match) { console.warn("[mp] CSP meta 未匹配（可能 single-quote 包裹或结构变），CSP 未 patch——fetch 可能被拦"); return html; }
    let csp = match[4];
    csp = injectCspDirective(csp, "connect-src", TOKEN); // overlay fetch EH server（v0.1 功能最小集）
    csp = injectCspDirective(csp, "img-src", TOKEN);     // 前向兼容（v0.1 img-src 已含 data:，stream/blob 场景）
    csp = injectCspDirective(csp, "media-src", TOKEN + " blob:"); // video/audio（v0.2+）
    return html.replace(CSP_META_RE, `$1${csp}$5`);
}

// 在 directive 段追加 token（幂等：已含则跳过，防重 patch 叠加多个 token）
function injectCspDirective(csp: string, directive: string, token: string): string {
    const segRe = new RegExp(`(${directive}\\s+)([^;]*?)(\\s*;)`, "i");
    const sm = csp.match(segRe);
    if (!sm) return csp; // directive 不存在 → 不动（保守）
    if (sm[2].includes(token.trim())) return csp; // 已含 → 幂等跳过
    return csp.replace(segRe, (_full, a, b, c) => a + b + token + c);
}

// 注入静态 script 标记块（</html> 主锚 = vscode-custom-css 先例 + spike2 实证；</body>/EOF 兜底）
export function injectScriptTag(html: string, version: string, overlayHash: string): string {
    const block = `<!--mp-injected:${version}:${overlayHash}-->\n<script src="./mp-config.js"></script>\n<script src="./mp-overlay.js"></script>\n<!--/mp-injected-->\n`;
    if (/<\/html>/i.test(html)) return html.replace(/<\/html>/i, `${block}</html>`);
    if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${block}</body>`);
    return html + block;
}
