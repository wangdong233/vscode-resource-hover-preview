# 06 — DOM 选择器容错策略 + 文件路径推导

> 本文档管两件事：① 在无公开契约的 Explorer DOM 上**容错找到文件项元素**（选择器多层 fallback）；② 从元素**推导出完整文件路径**（文件索引 + 重名消歧）。
>
> ⚠️ **文件路径推导是 make-or-break**（[10 RK5/Spike 8](10_风险登记册与spike验证.md)）：原方案B `index.set(name,full)` 同名覆盖 → 悬停 `logo.png` 看到错文件（比没有更糟）。本篇给出消歧方案。

## 0. 实测验证状态（Spike 8，2026-08-08 白盒预填，待 probe 实测确认）

本节选择器/属性读取已**端到端白盒源码 trace**（confidence: high），但须用 `../spike8-dom.mjs` 在 1.129.1 真实 DOM 上跑一次实证后转 ✅。源码 trace 路径见各条 evidence。

### DOM 结构修正（白盒确证，非快照推测）

原 §一 HTML 把 `.explorer-item` 画成 `.monaco-icon-label` 的**外层包裹 div**——**错误**。源码确证：
- explorerViewer.ts renderStat 把 `extraClasses=['explorer-item']` 经 setResource→iconLabelOptions.extraClasses→labelClasses，最终 `this.domNode.classNames=['monaco-icon-label','explorer-item',...]`。两个 class 在**同一个 div** 上（domNode 就是 .monaco-icon-label 元素）。
- `.monaco-tl-twistie` / `.monaco-tl-contents` 是 abstractTree 的模板包裹层（行容器内），IconLabel 渲染在 .monaco-tl-contents 内。

修正后的结构（1.129.1）：
```
.monaco-list-row[role=treeitem]                    ← 行容器(listView)
  ├ aria-label=<filename 仅文件名>                   ← listWidget AccessibiltyRenderer(仅名!)
  ├ aria-level=<depth 数字>
  └ .monaco-tl-row
     ├ .monaco-tl-twistie                            ← 折叠箭头
     └ .monaco-tl-contents
        └ .monaco-icon-label.explorer-item            ← 同一 div 两个 class(非包裹!)
           ├ aria-label=<完整绝对路径[ • decoration]>  ← Spike8 真相源!!
           ├ [managed hover: 悬停显路径,非原生 title]
           ├ .monaco-icon-label-container
           │  ├ span.monaco-icon-name-container
           │  │  └ a.label-name  textContent=<filename>
           │  │     (compressed 时多个 a.label-name + span.label-separator)
           │  └ span.monaco-icon-description-container
           │     └ span.label-description  textContent=<相对父目录>
           └ .monaco-icon-label-iconpath (可选,自定义图标)
```

### 选择器命中实测

首选 `.explorer-viewlet .monaco-list-row[role="treeitem"]`（白盒确证 .explorer-viewlet 是 explorer-viewlet 容器 class，listView 产出 .monaco-list-row[role=treeitem]）。**真实命中 tier + 计数见 probe 的 selectorTierCounts 表**（spike8-dom.mjs 自动 console.table）。若 1.129.1 实测 tier1 命中→锁定 tier1；否则 probe 报告哪个 tier 命中，据此定稿候选顺序。

### 文件名 + 完整路径推导（Spike 8 结论：方案 0 aria-label 先验，白盒已确证）

**白盒 trace（high conf）**：`.monaco-icon-label` 的 aria-label = `labelService.getUriLabel(resource)` = 完整绝对路径；若有 FileDecorationProvider tooltip 则追加 ` • decoration`。**overlay 直接读 aria-label 即得完整路径，免建 EH 文件索引**（删 §四方案 B 的 walk/findFiles/Watcher/重名消歧整个子系统）。

pathExtractionFromDom() 实现见本调研 implementation_blueprint。

### ⚠️ 必读路径源是 `.monaco-icon-label` aria-label，不是行的 aria-label

行 `.monaco-list-row` 的 aria-label = `element.name`（仅文件名，listWidget AccessibiltyRenderer 设）。doc06 原 getFilename 的 fallback `element.getAttribute('aria-label')` 若 element 是行→只拿到文件名，**别用错元素层级**。

## 一、Explorer DOM 结构（2025 快照，无公开契约）

```html
<div id="workbench">
  <div class="monaco-workbench">
    <div class="part.sidebar">
      <div class="content">
        <div class="monaco-viewlet" id="workbench.view.explorer">
          <div class="explorer-viewlet">
            <div class="explorer-folders-view">
              <div class="monaco-list">
                <div class="monaco-scrollable-element">
                  <div class="monaco-list-rows">
                    <div class="monaco-list-row" role="treeitem" ...>
                      <div class="explorer-item">
                        <div class="monaco-icon-label">
                          <a class="label-name">filename.png</a>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
```

> class name / DOM 层级在 VSCode 版本间**会变**，无公开契约。下面所有选择器/属性读取都是多层 fallback。

## 二、选择器策略：多层 fallback

```javascript
const EXPLORER_ITEM_SELECTORS = [
    '.explorer-viewlet .monaco-list-row[role="treeitem"]',   // Tier 1 最精确
    '.explorer-folders-view .monaco-list-row',               // Tier 2
    '.explorer-viewlet [role="treeitem"]',                   // Tier 3
    '.part.sidebar .monaco-list-row',                        // Tier 4（⚠️ 见 viewlet scoping）
    '[role="treeitem"]',                                      // Tier 5 终极兜底
];
```

> **viewlet scoping（新增，防误触发）**：Tier 4/5 过宽会命中 Search/SCM viewlet 的 treeitem → 悬停搜索结果也弹预览。mouseover handler 内**先判断 explorer viewlet 可见/激活**：
> ```javascript
> function isExplorerActive() {
>     const v = document.getElementById('workbench.view.explorer');
>     return !!v && v.offsetParent !== null;  // 可见
> }
> ```
> 不活跃则跳过（避免 Search/SCM 树误触发）。

## 三、文件名提取（修正：先 aria-label 拿路径，再切 basename）

```javascript
function getLabelName(element) {  // element = .monaco-list-row[role=treeitem]
    const iconLabel = element.querySelector('.monaco-icon-label');
    const ln = iconLabel && iconLabel.querySelector('a.label-name');
    return ln && ln.textContent ? ln.textContent.trim() : null;
}
```

## 四、文件完整路径推导（修正：方案 0 = aria-label 先验，白盒已确证）

**原方案 0 说「验证 title/data-* 是否含完整路径」——白盒确证：路径在 aria-label（非 title 非 data-*），且在 `.monaco-icon-label` 元素上（非行上）。**

pathExtractionFromDom() 见本调研 implementation_blueprint。fallback（remote/compressed/path含' • '）保留方案 B 的 Map<basename,string[]>+DOM 父目录消歧，但降为「仅 aria-label 失败时启用」。

### 方案 B（fallback）：EH 文件索引 + 重名消歧

若方案 0 不可用，EH 建 `basename → string[]` 索引（**值是数组，不是单值**），overlay 传 DOM 推导的父目录给 EH 消歧。

```typescript
// EH 侧：用 vscode.workspace.findFiles 替代手写 walk（原生异步、尊重 files.exclude、不阻塞）
async function buildFileIndex(root: string): Promise<Map<string, string[]>> {
    const index = new Map<string, string[]>();
    const uris = await vscode.workspace.findFiles(
        '**/*',
        '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.next/**,**/target/**,**/out/**}'
    );
    for (const uri of uris) {
        const base = path.basename(uri.fsPath);
        if (!index.has(base)) index.set(base, []);
        index.get(base)!.push(uri.fsPath);
    }
    return index;
}

// GET /resolve?name=image.png&hint=<DOM 推导的父目录相对路径>
function resolve(name: string, hint?: string): { paths: string[]; resolved?: string } {
    const paths = fileIndex.get(name) || [];
    if (paths.length === 0) return { paths };
    if (paths.length === 1) return { paths, resolved: paths[0] };
    // 重名消歧：用 hint（DOM 沿父级 treeitem 推导的相对父目录）匹配
    if (hint) {
        const match = paths.find(p => p.includes(hint));
        if (match) return { paths, resolved: match };
    }
    // 无法消歧 → 返回全部，overlay 提示"重名，点击选择"（诚实，不静默返错文件）
    return { paths };
}
```

**EH 侧补充**：
- **增量**：`vscode.workspace.createFileSystemWatcher` 监听新建/删除，增量更新索引（避免 rebuild）。
- **性能预算**：文件数 > 阈值（如 50k）时降级为按需 `stat`（悬停时才 resolve），不全量索引。
- **多 root workspace**：`vscode.workspace.workspaceFolders` 遍历每个 root。

**overlay 侧消歧**（方案 A 辅助）：
```javascript
// 沿 DOM 树向上收集父文件夹名作为 hint
function getDirHint(element) {
    const parts = [];
    let cur = element.closest('[role="treeitem"]')?.parentElement?.closest('[role="treeitem"]');
    while (cur) {
        const name = getFilename(cur);
        if (name) parts.unshift(name);
        cur = cur.closest('[role="treeitem"]')?.parentElement?.closest('[role="treeitem"]');
    }
    return parts.join('/');  // 如 "src/assets"
}

async function resolveFilePath(element, filename) {
    // 方案 0 先试
    const domPath = tryFullPathFromDom(element);
    if (domPath) return domPath;
    // 方案 B
    const hint = getDirHint(element);
    const r = await fetch(`${SERVER_BASE}/resolve?name=${encodeURIComponent(filename)}&hint=${encodeURIComponent(hint)}`);
    const data = await r.json();
    if (data.resolved) return data.resolved;
    if (data.paths.length > 1) {
        showPopupError('同名文件，无法确定（点击选择）');  // 诚实，不返错文件
        return null;
    }
    return data.paths[0] || null;
}
```

> **关键修正**：原 `index.set(name, full)`（同名 last-wins 覆盖）→ 改 `Map<basename, string[]>` + hint 消歧 + 无法消歧时**诚实报错而非返错文件**。一个显示错文件的悬停预览比没有更糟。

## 五、动态绑定（event delegation，虚拟滚动）

Explorer 列表是**虚拟滚动**（只有可见行在 DOM 中，滚动时行创建/销毁）。用 event delegation 在稳定父容器上监听冒泡：

```javascript
function setupHoverListeners() {
    const explorerRoot = document.querySelector('.explorer-viewlet')
                       || document.querySelector('.explorer-folders-view')
                       || document.querySelector('.part.sidebar');
    if (!explorerRoot) return;

    let currentHovered = null, hoverTimer = null;

    explorerRoot.addEventListener('mouseover', (e) => {
        if (!isExplorerActive()) return;  // viewlet scoping
        const item = e.target.closest('.monaco-list-row[role="treeitem"]')
                   || e.target.closest('[role="treeitem"]');
        if (!item || item === currentHovered) return;
        currentHovered = item;
        if (hoverTimer) clearTimeout(hoverTimer);
        const rect = item.getBoundingClientRect();
        hoverTimer = setTimeout(() => {
            if (currentHovered === item) handleHover(item, rect);
        }, HOVER_DELAY);  // 300ms 防抖
    });

    explorerRoot.addEventListener('mouseout', (e) => {
        const item = e.target.closest('[role="treeitem"]');
        if (item === currentHovered) {
            if (hoverTimer) clearTimeout(hoverTimer);
            setTimeout(() => { if (!isMouseInPopup() && !isPinned) hidePopup(); }, HIDE_DELAY);  // 200ms
        }
    });
}
```

## 六、MutationObserver 等待 Explorer 渲染

```javascript
function waitForExplorer(cb, timeout = 10000) {
    const start = Date.now();
    (function check() {
        const root = document.querySelector('.explorer-viewlet') || document.querySelector('.part.sidebar .monaco-list');
        if (root) { cb(); return; }
        if (Date.now() - start > timeout) { console.warn('[mp] explorer not found'); return; }
        requestAnimationFrame(check);
    })();
}
waitForExplorer(() => { setupHoverListeners(); reportEnvironment(); });
```

## 七、选择器命中遥测（写 localStorage，不依赖 server）

```javascript
function reportEnvironment() {
    const cfg = window.__MP_CONFIG__ || {};
    let hit = 'none';
    for (const sel of EXPLORER_ITEM_SELECTORS) {
        if (document.querySelector(sel)) { hit = sel; break; }
    }
    const env = { version: cfg.version, hitSelector: hit, items: hit !== 'none' ? document.querySelectorAll(hit).length : 0 };
    console.log('[mp]', JSON.stringify(env));
    localStorage.setItem('mp.env', JSON.stringify(env));  // drift 诊断用，不走 server
}
```

## 八、选择器全失败的降级

所有选择器 0 命中：① console.warn + 静默不弹；② 定期重试（每 5s 重查，可能 viewlet 切换）；③ localStorage 记录失败供诊断。
