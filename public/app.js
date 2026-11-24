/* 写作台 —— 前端逻辑（无框架，直接操作 DOM） */
'use strict';

const $ = (s) => document.querySelector(s);
const el = {
  repoName: $('#repoName'), btnRepo: $('#btnRepo'),
  fileList: $('#fileList'), chapList: $('#chapList'), chapCount: $('#chapCount'),
  fileName: $('#fileName'), saveState: $('#saveState'),
  statNow: $('#statNow'), statTotal: $('#statTotal'),
  workspace: $('#workspace'), editor: $('#editor'), preview: $('#preview'), modeBar: $('#modeBar'),
  hlCode: $('#hlCode'), scroller: $('#scroller'),
  footInfo: $('#footInfo'), notice: $('#notice'),
  gitHead: $('#gitHead'), gitOut: $('#gitOut'),
  sbBranch: $('#sbBranch'), sbMode: $('#sbMode'),
  commitMsg: $('#commitMsg'), btnCommit: $('#btnCommit'),
};

const state = {
  repo: '',
  file: null,        // 相对路径
  content: '',       // 文件全文
  chapters: [],      // [{title,start,end,count}]
  cur: -1,
  mode: 'edit',
  dirty: false,
  readOnly: false,
  saveTimer: null,
  statTimer: null,
  previewTimer: null,
  rev: 0,            // 输入版本号，用于判断保存期间是否又有新输入
  composing: false,  // 输入法是否正在组字（候选窗开着）
  editStart: 0,      // 编辑器内容对应全文的区间 [editStart, editEnd)
  editEnd: 0,
};

const LARGE_FILE = 400000;   // 超过 40 万字符的文件只读，避免卡顿
const SCAN_YIELD = 150000;   // 分章时每扫描 15 万字符让出一次主线程
// 章节标题：兼容「第一章 xxx」「第【1】段：第一章 xxx」「第3回：xxx」「后 记」等
// 前缀部分（如 第【1】段：）可有可无，序号支持阿拉伯数字/中文数字/带括号
const CHAP_RE = /^[ \t\u3000]*(?:第[【\[（(]?[0-9０-９零〇一二三四五六七八九十百千两]{1,12}[】\]）)]?[段节集部辑][：:、.．]?[ \t\u3000]*)?(?:第[0-9０-９零〇○一二三四五六七八九十百千万两]{1,12}[章节回卷篇][^\n]{0,60}|(?:序[ \u3000]?章|序[ \u3000]?言|楔[ \u3000]?子|引[ \u3000]?子|尾[ \u3000]?声|尾[ \u3000]?聲|后[ \u3000]?记|後[ \u3000]?記|番[ \u3000]?外)[^\n]{0,60})[ \t\u3000]*$/;

/* ---------------- 字数统计 ---------------- */
// 分块统计，避免超长字符串一次性建数组（3MB 一次 match 要 2 秒）
const CHUNK = 100000;
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
const NONSPACE_RE = /[^\s]/g;
function countBy(s, re) {
  if (s.length <= CHUNK) { const m = s.match(re); return m ? m.length : 0; }
  let n = 0;
  for (let i = 0; i < s.length; i += CHUNK) {
    const m = s.slice(i, i + CHUNK).match(re);
    if (m) n += m.length;
  }
  return n;
}
function countCJK(s) { return countBy(s, CJK_RE); }
function countAll(s) { return countBy(s, NONSPACE_RE); }


/* 中文数字 → 整数（十九 → 19，一百零八 → 108） */
function cnNum(str) {
  if (/^[0-9]+$/.test(str)) return parseInt(str, 10);
  const dig = { '零': 0, '〇': 0, '○': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  const unit = { '十': 10, '百': 100, '千': 1000, '万': 10000 };
  let total = 0, section = 0, num = 0;
  for (const ch of str) {
    if (ch in dig) num = dig[ch];
    else if (ch in unit) {
      const u = unit[ch];
      if (u === 10000) { section = (section + num) * u; total += section; section = 0; }
      else section += (num || 1) * u;
      num = 0;
    }
  }
  return total + section + num;
}

/* 从标题行里取「章号」：取最后一个 第X章/回/节/卷/篇；序号开头（序章/楔子）算 0 */
function chapterNo(line) {
  const re = /第([0-9零〇○一二三四五六七八九十百千万两]{1,12})[章节回卷篇]/g;
  let m, last = null;
  while ((m = re.exec(line)) !== null) last = m[1];
  if (last) return cnNum(last);
  return 0;   // 序章 / 楔子 / 尾声 / 后记
}

/**
 * 过滤误判：正文里偶尔出现「第三章 的伏笔」这类行，不应算新章。
 * 规则：章号必须比上一个保留的章号大（序章为 0）。
 * 若过滤掉超过 40%，说明这本书章号本来就不递增（分卷重新编号），那就原样保留。
 */
function filterChapters(list) {
  if (list.length < 3) return list;
  const kept = [];
  let lastNo = -1;
  for (const c of list) {
    const no = chapterNo(c.title);
    if (no === 0) { kept.push(c); continue; }   // 序章/楔子/后记/开篇 一律保留
    if (no > lastNo) { kept.push(c); lastNo = no; }
  }
  if (kept.length < list.length * 0.6) return list;
  return kept;
}


/* 章节标题行不算字数：拿到正文起点（跳过一个标题行） */
function bodyStartOf(text, start, end) {
  const nl = text.indexOf('\n', start);
  if (nl === -1 || nl >= end) return end;
  const first = text.slice(start, nl);
  return CHAP_RE.test(first.trim()) ? nl + 1 : start;
}

/* 编辑器里的文本：若首行是章节标题，统计时跳过 */
function stripTitleLine(text) {
  const nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  if (CHAP_RE.test(first.trim())) return nl === -1 ? '' : text.slice(nl + 1);
  return text;
}

/* ---------------- 分章 ---------------- */
// 同步版：保存后重算用（文件较小）
function parseChapters(text) {
  const out = [];
  const len = text.length;
  let i = 0;
  while (i <= len) {
    let nl = text.indexOf('\n', i);
    if (nl === -1) nl = len;
    const line = text.slice(i, nl);
    if (CHAP_RE.test(line)) out.push({ title: line.trim(), start: i });
    if (nl >= len) break;
    i = nl + 1;
  }
  if (!out.length || out[0].start > 0) out.unshift({ title: '（开篇）', start: 0 });
  const kept = filterChapters(out);
  for (let k = 0; k < kept.length; k++) {
    kept[k].end = k + 1 < kept.length ? kept[k + 1].start : len;
    kept[k].bodyStart = bodyStartOf(text, kept[k].start, kept[k].end);
    kept[k].count = countCJK(text.slice(kept[k].bodyStart, kept[k].end));
  }
  return kept;
}

/* ---------------- 接口 ---------------- */
async function api(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

/* 渐进分章：扫描大文件时每 15 万字符让出主线程，界面不会假死 */
async function parseChaptersLazy(text, token, onProgress) {
  const chapters = [];
  const len = text.length;
  let pos = 0, lastYield = 0;
  while (pos < len) {
    let nl = text.indexOf('\n', pos);
    if (nl === -1) nl = len;
    const line = text.slice(pos, nl);
    if (CHAP_RE.test(line)) chapters.push({ title: line.trim(), start: pos });
    pos = nl + 1;
    if (pos - lastYield > SCAN_YIELD) {
      lastYield = pos;
      if (token.cancelled) return null;
      if (onProgress) onProgress(pos, len, chapters.length);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  if (!chapters.length || chapters[0].start > 0) chapters.unshift({ title: '（开篇）', start: 0 });
  const kept = filterChapters(chapters);
  for (let k = 0; k < kept.length; k++) {
    kept[k].end = k + 1 < kept.length ? kept[k + 1].start : len;
    kept[k].bodyStart = bodyStartOf(text, kept[k].start, kept[k].end);
  }
  return kept;
}

/* 章节字数后台慢慢算，算完一项就刷新一项 */
async function fillCounts(text, chapters, token) {
  for (let k = 0; k < chapters.length; k++) {
    if (token.cancelled) return;
    const c = chapters[k];
    if (c.count == null) {
      if (c.bodyStart == null) c.bodyStart = bodyStartOf(text, c.start, c.end);
      c.count = countCJK(text.slice(c.bodyStart, c.end));
    }
    const li = el.chapList.children[k];
    if (li) {
      const n = li.querySelector('.num');
      if (n) n.textContent = c.count;
      else {
        const s = document.createElement('span');
        s.className = 'num';
        s.textContent = c.count;
        li.appendChild(s);
      }
    }
    if (k % 6 === 5) await new Promise((r) => setTimeout(r, 0));
  }
  updateStats();
}

/* ---------------- 界面渲染 ---------------- */
function renderFiles(files) {
  el.fileList.textContent = '';
  files
    .slice()
    .sort((a, b) => b.mtime - a.mtime)
    .forEach((f) => {
      const li = document.createElement('li');
      li.textContent = f.path.split('/').pop();
      li.title = f.path + '  ·  ' + fmtSize(f.size);
      if (f.size > LARGE_FILE) li.style.opacity = '.55';
      li.dataset.path = f.path;
      if (f.path === state.file) li.classList.add('on');
      li.onclick = () => openFile(f.path);
      el.fileList.appendChild(li);
    });
}

function fmtSize(n) {
  return n > 1024 * 1024 ? (n / 1048576).toFixed(1) + ' MB'
       : n > 1024 ? (n / 1024).toFixed(0) + ' KB' : n + ' B';
}

function renderChapters() {
  el.chapList.textContent = '';
  state.chapters.forEach((c, i) => {
    const li = document.createElement('li');
    li.textContent = c.title;
    if (c.count != null) {
      const n = document.createElement('span');
      n.className = 'num';
      n.textContent = c.count;
      li.appendChild(n);
    }
    if (i === state.cur) li.classList.add('on');
    li.onclick = () => openChapter(i);
    el.chapList.appendChild(li);
  });
  el.chapCount.textContent = state.chapters.length + ' 章';
}

function updateChapterCount(idx, text) {
  const li = el.chapList.children[idx];
  if (!li) return;
  const n = li.querySelector('.num');
  if (n) n.textContent = countCJK(stripTitleLine(text));
}

function updateStats() {
  const body = stripTitleLine(el.editor.value);
  const sel = selStats();
  el.statNow.textContent = `本章 ${countCJK(body)} 汉字 / ${countAll(body)} 字符${sel}`;
  const curCount = countCJK(body);
  const total = state.chapters.reduce((s, c, i) => s + (i === state.cur ? curCount : c.count || 0), 0);
  el.statTotal.textContent = `全书 ${total} 汉字 · ${state.chapters.length} 章`;
}

function selStats() {
  const e = el.editor;
  if (e.selectionEnd - e.selectionStart > 0) {
    const s = e.value.slice(e.selectionStart, e.selectionEnd);
    return ` · 选中 ${countCJK(s)} 汉字`;
  }
  return '';
}

function setSaveState(txt, warn) {
  el.saveState.textContent = txt;
  document.body.classList.toggle('dirty', !!warn);
  el.saveState.style.color = warn ? '#ffd27f' : '#e8f2f8';
}

function notice(msg) {
  if (!msg) { el.notice.classList.add('hidden'); el.notice.textContent = ''; return; }
  el.notice.textContent = msg;
  el.notice.classList.remove('hidden');
}

/* ---------------- 假语法高亮 ---------------- */
const HL_RULES = [
  { cls: 'hl-s', re: /“[^”\n]{0,300}”|「[^」\n]{0,300}」|『[^』\n]{0,300}』/y },
  { cls: 'hl-t', re: /《[^》\n]{0,80}》/y },
  { cls: 'hl-c', re: /（[^）\n]{1,60}）|\([^)\n]{1,60}\)/y },
  { cls: 'hl-b', re: /\*\*[^*\n]{1,80}\*\*/y },
  { cls: 'hl-n', re: /[0-9]{1,6}(?:\.[0-9]+)?/y },
  { cls: 'hl-k', re: /突然|忽然|陡然|猛然|但是|然而|因此|所以|因为|如果|已经|仿佛|似乎|竟然|终于|原来|果然|只是|不过|竟然/y },
];
const HL_MAX = 60000;   // 超过 6 万字的章节不做逐字扫描，直接原文输出

function escHtml(s) {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

// 扫描一行，输出高亮 HTML
function highlightLine(line) {
  const out = [];
  let i = 0, plain = 0;
  const n = line.length;
  while (i < n) {
    let hit = null;
    for (const r of HL_RULES) {
      r.re.lastIndex = i;
      const m = r.re.exec(line);
      if (m && m.index === i && m[0].length) { hit = { cls: r.cls, text: m[0] }; break; }
    }
    if (hit) {
      if (i > plain) out.push(escHtml(line.slice(plain, i)));
      out.push('<span class="' + hit.cls + '">' + escHtml(hit.text) + '</span>');
      i += hit.text.length;
      plain = i;
    } else {
      i++;
    }
  }
  if (n > plain) out.push(escHtml(line.slice(plain)));
  return out.join('');
}

function renderHighlight() {
  if (!el.hlCode) return;
  const text = el.editor.value;
  if (!text) { el.hlCode.textContent = ''; return; }
  if (text.length > HL_MAX) {           // 超大章节：不做逐字高亮，保证不卡
    el.hlCode.innerHTML = escHtml(text) + '\n ';
    return;
  }
  const lines = text.split('\n');
  const parts = new Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    parts[i] = CHAP_RE.test(line)
      ? '<span class="hl-h">' + escHtml(line) + '</span>'
      : highlightLine(line);
  }
  el.hlCode.innerHTML = parts.join('\n') + '\n ';
}

let hlPending = false;
function scheduleHighlight() {
  if (hlPending) return;
  hlPending = true;
  requestAnimationFrame(() => { hlPending = false; renderHighlight(); });
}

/* ---------------- 文件操作 ---------------- */
function isMarkdown(rel) { return /\.(md|markdown)$/i.test(rel || ''); }

/* 内存缓存：path -> { mtime, content, chapters }，避免重复读盘+分章 */
const fileCache = new Map();
const CACHE_LIMIT = 6;
function cachePut(rel, entry) {
  fileCache.delete(rel);
  fileCache.set(rel, entry);
  while (fileCache.size > CACHE_LIMIT) {
    const oldest = fileCache.keys().next().value;
    if (oldest === rel) break;
    fileCache.delete(oldest);
  }
}

async function openFile(rel) {
  if (state.dirty && !confirm('当前文件有未保存改动，仍然切换吗？')) return;

  // 先问元信息（很快），再决定要不要真读内容
  const stat = await api('/api/stat?path=' + encodeURIComponent(rel));
  const cached = fileCache.get(rel);
  const hit = cached && cached.mtime === stat.mtime && cached.chapters;
  let content, chapters = null;
  if (hit) {
    content = cached.content;
    chapters = cached.chapters;
  } else {
    const data = await api('/api/file?path=' + encodeURIComponent(rel));
    content = data.content;
  }

  state.file = rel;
  state.content = content;
  state.dirty = false;
  state.cur = -1;
  localStorage.setItem('nw.lastFile', rel);
  el.fileName.textContent = rel;
  notice(content.length > LARGE_FILE
    ? `文件较大（${fmtSize(stat.size)}），为避免卡顿已设为只读预览。`
    : '');
  [...el.fileList.children].forEach((li) => li.classList.toggle('on', li.dataset.path === rel));

  const md = isMarkdown(rel);
  el.modeBar.classList.toggle('hidden', !md);
  if (el.sbMode) el.sbMode.textContent = md ? 'Markdown' : '纯文本';
  setMode(md ? 'preview' : 'edit');

  // 缓存命中：秒开
  if (chapters) {
    state.chapters = chapters;
    renderChapters();
    openChapter(0);
    setSaveState('');
    refreshGit();
    return;
  }

  // 渐进分章：先清空列表，边扫边报进度
  state.chapters = [];
  el.chapList.textContent = '';
  el.chapCount.textContent = '解析中…';
  const token = { cancelled: false };
  if (state.parseToken) state.parseToken.cancelled = true;
  state.parseToken = token;

  const parsed = await parseChaptersLazy(content, token, (pos, len) => {
    el.chapCount.textContent = `解析中 ${Math.round((pos / len) * 100)}%`;
  });
  if (!parsed || token.cancelled) return;

  state.chapters = parsed;
  renderChapters();
  openChapter(0);
  setSaveState('');
  refreshGit();
  cachePut(rel, { mtime: stat.mtime, content, chapters: parsed });
  fillCounts(content, parsed, token);   // 字数后台慢慢填
}

function openChapter(i, keepTrailing) {
  if (i < 0 || i >= state.chapters.length) return;
  if (state.dirty) saveNow(true);
  state.cur = i;
  const c = state.chapters[i];
  const raw = state.content.slice(c.start, c.end);
  // 末尾的换行留给下一章，避免在章末打字时把下一章标题粘进来
  state.tailNl = /\n$/.test(raw) ? '\n' : '';
  state.editStart = c.start;
  state.editEnd = c.end;
  const text = keepTrailing ? raw : raw.replace(/\n+$/, '');
  el.editor.value = text;
  // 光标必须回到开头：否则 focus() 会把光标带到文末，版面直接滚到底部
  el.editor.selectionStart = el.editor.selectionEnd = 0;
  el.editor.readOnly = state.content.length > LARGE_FILE;
  state.readOnly = el.editor.readOnly;
  renderHighlight();
  resetScroll();
  [...el.chapList.children].forEach((li, k) => li.classList.toggle('on', k === i));
  updateStats();
  if (state.mode !== 'edit') renderPreview();
  el.footInfo.textContent = `第 ${i + 1}/${state.chapters.length} 章 · ${c.title}`;
  if (!state.readOnly) el.editor.focus({ preventScroll: true });
  resetScroll();
  // 高亮层渲染后高度会变，再兜一次，防止滚动锚定把位置拉回去
  requestAnimationFrame(resetScroll);
}

function resetScroll() {
  if (el.scroller) el.scroller.scrollTop = 0;
  el.editor.scrollTop = 0;
}

function scheduleSave(delay) {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => saveNow(), delay == null ? 900 : delay);
}

function onEditorInput() {
  if (state.readOnly) return;
  state.rev++;
  state.dirty = true;
  setSaveState('未保存…', true);
  scheduleHighlight();
  clearTimeout(state.statTimer);
  state.statTimer = setTimeout(() => {
    updateStats();
    updateChapterCount(state.cur, el.editor.value);
  }, 120);
  scheduleSave(900);
}

async function saveNow(silent, keepalive) {
  if (!state.file || state.readOnly || !state.dirty) return;
  // 输入法组字中不落盘：等组字结束再存，避免打断候选
  if (state.composing) { scheduleSave(600); return; }
  clearTimeout(state.saveTimer);

  const rev = state.rev;
  const text = el.editor.value;          // 本次保存的快照
  const after = state.content.slice(state.editEnd);
  const add = (after && !/\n$/.test(text)) ? (state.tailNl || '\n') : '';
  const content = state.content.slice(0, state.editStart) + text + add + after;

  try {
    const r = await api('/api/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: state.file, content }),
      keepalive: !!keepalive,
    });

    // 注意：整个过程绝不改写 el.editor.value ——
    // 否则输入法预编辑（组字中）会被打断，正在候选的字直接丢失。
    state.content = content;
    state.editEnd = state.editStart + text.length + add.length;
    if (state.rev === rev) state.dirty = false;   // 期间又打了字，就别清脏标记

    state.chapters = parseChapters(content);
    let idx = 0;
    for (let k = 0; k < state.chapters.length; k++) {
      if (state.chapters[k].start <= state.editStart) idx = k; else break;
    }
    state.cur = idx;

    renderChapters();
    updateStats();
    cachePut(state.file, { mtime: r.mtime, content, chapters: state.chapters });
    setSaveState('已保存 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }));
    if (!silent) refreshGit(); else scheduleGitRefresh();
  } catch (e) {
    setSaveState('保存失败：' + e.message, true);
  }
}

/* ---------------- 预览 ---------------- */
function renderPreview() {
  const text = el.editor.value;
  if (!text) { el.preview.textContent = ''; return; }
  if (window.marked) {
    el.preview.innerHTML = marked.parse(text, { gfm: true, breaks: true });
  } else {
    el.preview.textContent = text;
  }
}

function setMode(mode) {
  if (mode !== 'edit' && mode !== 'preview') mode = 'edit';
  state.mode = mode;
  el.workspace.className = 'mode-' + mode;
  document.querySelectorAll('.modes button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  if (mode === 'preview') renderPreview();
  else el.editor.focus();
}

/* ---------------- Git ---------------- */
let gitTimer = null;
function scheduleGitRefresh() {
  clearTimeout(gitTimer);
  gitTimer = setTimeout(refreshGit, 2000);
}

async function refreshGit() {
  try {
    const s = await api('/api/git/status');
    if (el.sbBranch) el.sbBranch.textContent = `git · ${s.branch}`;
    const ab = (s.ahead || s.behind)
      ? ` ↑${s.ahead} ↓${s.behind}` : '';
    el.gitHead.innerHTML = `<b>${s.branch}</b>${ab}` +
      (s.dirty ? ` · <b>${s.dirty}</b> 个改动` : ' · 干净');
    const lines = [];
    if (s.files.length) lines.push(s.files.slice(0, 12).join('\n'));
    lines.push('— 最近提交 —');
    lines.push(s.log.slice(0, 6).join('\n'));
    el.gitOut.textContent = lines.join('\n');
  } catch (e) {
    el.gitHead.textContent = 'git 不可用：' + e.message;
  }
}

async function gitAction(kind) {
  const btn = document.querySelector(`[data-git="${kind}"]`);
  if (btn) btn.disabled = true;
  el.gitOut.textContent = '执行中…';
  try {
    const r = await api('/api/git/' + kind, { method: 'POST' });
    el.gitOut.textContent = (r.output || '完成').trim() || '完成';
  } catch (e) {
    el.gitOut.textContent = '失败：' + e.message;
  } finally {
    if (btn) btn.disabled = false;
    refreshGit();
  }
}

async function doCommit() {
  const msg = el.commitMsg.value.trim();
  if (!msg) { el.commitMsg.focus(); el.commitMsg.placeholder = '先写提交信息…'; return; }
  if (state.dirty) await saveNow(true);
  el.btnCommit.disabled = true;
  el.gitOut.textContent = '提交中…';
  try {
    const r = await api('/api/git/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg }),
    });
    el.gitOut.textContent = r.output || '已提交';
    el.commitMsg.value = '';
  } catch (e) {
    el.gitOut.textContent = '失败：' + e.message;
  } finally {
    el.btnCommit.disabled = false;
    refreshGit();
  }
}

/* 默认打开：优先最近改过的 .txt 小说，其次最大的 .md，最后第一个 */
function pickDefaultFile(files) {
  const ok = files.filter((f) => f.size < LARGE_FILE);
  const txt = ok.filter((f) => /\.txt$/i.test(f.path)).sort((a, b) => b.mtime - a.mtime)[0];
  if (txt) return txt;
  const md = ok.sort((a, b) => b.size - a.size)[0];
  return md || files[0];
}

/* ---------------- 启动 ---------------- */
async function boot() {
  try {
    const cfg = await api('/api/config');
    state.repo = cfg.repo;
    el.repoName.textContent = cfg.repo.split('/').pop();
    el.repoName.title = cfg.repo;
    if (!cfg.valid) { notice('仓库无效：' + cfg.repo + '，点「换」重新选择'); return; }
    renderFiles(cfg.files);

    const last = localStorage.getItem('nw.lastFile');
    const pick = cfg.files.find((f) => f.path === last) || pickDefaultFile(cfg.files);
    if (pick) await openFile(pick.path);
    refreshGit();
  } catch (e) {
    notice('初始化失败：' + e.message);
  }
}

/* ---------------- 事件绑定 ---------------- */
el.editor.addEventListener('input', onEditorInput);
// 输入法组字期间不保存、不动内容
el.editor.addEventListener('compositionstart', () => { state.composing = true; });
el.editor.addEventListener('compositionend', () => {
  state.composing = false;
  state.rev++;
  scheduleSave(700);
});
el.editor.addEventListener('mouseup', () => { el.statNow.textContent = el.statNow.textContent.replace(/ · 选中.*$/, '') + selStats(); });

document.querySelectorAll('.modes button').forEach((b) => {
  b.onclick = () => setMode(b.dataset.mode);
});
document.querySelectorAll('[data-git]').forEach((b) => {
  b.onclick = () => gitAction(b.dataset.git);
});
el.btnCommit.onclick = doCommit;
el.commitMsg.addEventListener('keydown', (e) => { if (e.key === 'Enter') doCommit(); });

el.btnRepo.onclick = async () => {
  const p = prompt('git 仓库路径', state.repo);
  if (!p) return;
  try {
    const cfg = await api('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: p }),
    });
    state.repo = cfg.repo;
    state.file = null;
    el.repoName.textContent = cfg.repo.split('/').pop();
    el.repoName.title = cfg.repo;
    renderFiles(cfg.files);
    localStorage.removeItem('nw.lastFile');
    notice('');
    const p2 = pickDefaultFile(cfg.files);
    if (p2) openFile(p2.path);
  } catch (e) {
    alert('切换失败：' + e.message);
  }
};

window.addEventListener('beforeunload', (e) => {
  if (state.dirty) { saveNow(true, true); e.preventDefault(); e.returnValue = ''; }
});

// 切走窗口/切到后台时立即落盘（防关窗口丢字）
window.addEventListener('blur', () => { if (state.dirty) saveNow(true); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && state.dirty) saveNow(true, true);
});

// 连续敲字不停顿时，每 5 秒强制落盘一次（防抖定时器一直被重置）
setInterval(() => {
  if (state.dirty && state.file && !state.readOnly) saveNow(true);
}, 5000);

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveNow(); return; }
  if (mod && e.key.toLowerCase() === 'p') {
    e.preventDefault();
    if (!isMarkdown(state.file)) return;   // txt 只有编辑一种形态
    setMode(state.mode === 'preview' ? 'edit' : 'preview');
    return;
  }
  if (mod && e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    openChapter(state.cur + (e.key === 'ArrowRight' ? 1 : -1));
  }
});

boot();
