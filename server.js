#!/usr/bin/env node
/**
 * 小说写作台 —— 零依赖本地服务
 * 只监听 127.0.0.1，负责：静态页面、读写文本、调用 git
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const HOME = os.homedir();
const CONF_DIR = process.env.NOVEL_CONF_DIR || path.join(HOME, '.config', 'novel-writer');
const CONF_FILE = path.join(CONF_DIR, 'config.json');
const PUB_DIR = path.join(__dirname, 'public');

const PORT = Number(process.env.NOVEL_PORT || 7788);
const HOST = '127.0.0.1';
const TEXT_EXT = new Set(['.txt', '.md', '.markdown']);
const MAX_FILE = 8 * 1024 * 1024; // 单文件上限 8MB

// ---------- 配置 ----------
function defaultRepo() {
  // 可用环境变量 NOVEL_REPO 指定，其次找 ~/workspace/novel，最后退回 HOME
  if (process.env.NOVEL_REPO) return process.env.NOVEL_REPO;
  const guess = path.join(HOME, 'workspace', 'novel');
  return fs.existsSync(path.join(guess, '.git')) ? guess : HOME;
}

function loadConf() {
  try {
    const c = JSON.parse(fs.readFileSync(CONF_FILE, 'utf8'));
    if (c && typeof c.repo === 'string') return c;
  } catch (_) {}
  return { repo: defaultRepo() };
}

function saveConf(c) {
  fs.mkdirSync(CONF_DIR, { recursive: true });
  fs.writeFileSync(CONF_FILE, JSON.stringify(c, null, 2));
}

let conf = loadConf();

function isRepoDir(p) {
  try {
    return fs.statSync(path.join(p, '.git')).isDirectory() ||
           fs.statSync(path.join(p, '.git')).isFile();
  } catch (_) { return false; }
}

// ---------- 工具 ----------
function git(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd,
      timeout: 60000,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '1' },
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: (stdout || '').trimEnd(),
        stderr: (stderr || '').trimEnd(),
        message: err ? ((stderr || '').trim() || String(err.message)) : '',
      });
    });
  });
}

/** 把请求路径解析成仓库内的安全绝对路径 */
function safeJoin(repo, rel) {
  const abs = path.resolve(repo, rel);
  const root = path.resolve(repo);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('路径越界');
  return abs;
}

async function walk(dir, repo, depth = 0, out = []) {
  if (depth > 6) return out;
  let ents;
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of ents) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walk(abs, repo, depth + 1, out);
    } else if (TEXT_EXT.has(path.extname(e.name).toLowerCase())) {
      try {
        const st = await fsp.stat(abs);
        if (st.size > MAX_FILE) continue;
        out.push({
          path: path.relative(repo, abs),
          size: st.size,
          mtime: st.mtimeMs,
        });
      } catch (_) {}
    }
  }
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 32 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------- 路由 ----------
async function api(req, res, url) {
  const p = url.pathname;
  const repo = conf.repo;

  if (p === '/api/config' && req.method === 'GET') {
    return sendJson(res, 200, {
      repo,
      valid: isRepoDir(repo),
      files: isRepoDir(repo) ? (await walk(repo, repo)) : [],
    });
  }

  if (p === '/api/config' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    const target = path.resolve(String(body.repo || '').replace(/^~(?=$|\/)/, HOME));
    if (!isRepoDir(target)) return sendJson(res, 400, { error: '不是 git 仓库：' + target });
    conf = { repo: target };
    saveConf(conf);
    return sendJson(res, 200, { repo: target, valid: true, files: await walk(target, target) });
  }

  if (!isRepoDir(repo)) return sendJson(res, 400, { error: '仓库无效：' + repo });

  // 只返回元信息，用于判断缓存是否过期（不读文件内容）
  if (p === '/api/stat' && req.method === 'GET') {
    const rel = url.searchParams.get('path') || '';
    const abs = safeJoin(repo, rel);
    const st = await fsp.stat(abs);
    return sendJson(res, 200, { path: rel, size: st.size, mtime: st.mtimeMs });
  }

  if (p === '/api/file' && req.method === 'GET') {
    const rel = url.searchParams.get('path') || '';
    const abs = safeJoin(repo, rel);
    const st = await fsp.stat(abs);
    if (st.size > MAX_FILE) return sendJson(res, 413, { error: '文件过大' });
    const content = await fsp.readFile(abs, 'utf8');
    return sendJson(res, 200, { path: rel, content, mtime: st.mtimeMs, size: st.size });
  }

  if (p === '/api/file' && req.method === 'PUT') {
    const body = JSON.parse(await readBody(req) || '{}');
    const abs = safeJoin(repo, body.path || '');
    if (!TEXT_EXT.has(path.extname(abs).toLowerCase())) return sendJson(res, 400, { error: '不支持的文件类型' });

    // 写前自动备份：万一客户端逻辑出错，还能找回来
    try {
      const bdir = path.join(CONF_DIR, 'backups');
      await fsp.mkdir(bdir, { recursive: true });
      const key = Buffer.from(String(body.path || '')).toString('hex').slice(0, 20);
      const st0 = await fsp.stat(abs);
      if (st0.size > 0) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        await fsp.copyFile(abs, path.join(bdir, `${key}-${stamp}.txt`));
        const olds = (await fsp.readdir(bdir)).filter((f) => f.startsWith(key + '-')).sort();
        for (const f of olds.slice(0, Math.max(0, olds.length - 20))) {
          await fsp.unlink(path.join(bdir, f)).catch(() => {});
        }
      }
    } catch (_) { /* 备份失败不阻断写入 */ }

    const tmp = abs + '.tmp-' + process.pid;
    await fsp.writeFile(tmp, body.content, 'utf8');
    await fsp.rename(tmp, abs);
    const st = await fsp.stat(abs);
    return sendJson(res, 200, { ok: true, mtime: st.mtimeMs, size: st.size });
  }

  if (p === '/api/git/status' && req.method === 'GET') {
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repo);
    let ahead = 0, behind = 0;
    const up = await git(['rev-list', '--left-right', '--count', 'HEAD...@{u}'], repo);
    if (up.ok) {
      const [a, b] = up.stdout.split(/\s+/).map(Number);
      ahead = a || 0; behind = b || 0;
    }
    // core.quotepath=false：否则中文文件名会被转义成 \346\227\240 这类八进制
    const st = await git(['-c', 'core.quotepath=false', 'status', '--porcelain=v1'], repo);
    const files = st.stdout ? st.stdout.split('\n').filter(Boolean) : [];
    const log = await git(['log', '--oneline', '-10', '--no-decorate'], repo);
    return sendJson(res, 200, {
      branch: branch.ok ? branch.stdout : '(无提交)',
      ahead, behind,
      dirty: files.length,
      files: files.slice(0, 200),
      log: log.ok ? log.stdout.split('\n') : [],
    });
  }

  if (p === '/api/git/commit' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    const msg = String(body.message || '').trim();
    if (!msg) return sendJson(res, 400, { error: '提交信息不能为空' });
    const add = await git(['add', '-A'], repo);
    if (!add.ok) return sendJson(res, 500, { error: add.message });
    const commit = await git(['commit', '-m', msg], repo);
    if (!commit.ok && !/nothing to commit|干净/.test(commit.stdout + commit.message)) {
      return sendJson(res, 500, { error: commit.message || commit.stdout });
    }
    return sendJson(res, 200, { ok: true, output: (commit.stdout || '没有需要提交的改动') });
  }

  if (p === '/api/git/pull' && req.method === 'POST') {
    const r = await git(['pull', '--rebase', '--autostash'], repo);
    return sendJson(res, r.ok ? 200 : 500, { ok: r.ok, output: r.stdout + (r.message ? '\n' + r.message : '') });
  }

  if (p === '/api/git/push' && req.method === 'POST') {
    const r = await git(['push'], repo);
    return sendJson(res, r.ok ? 200 : 500, { ok: r.ok, output: r.stdout + (r.message ? '\n' + r.message : '') });
  }

  if (p === '/api/git/fetch' && req.method === 'POST') {
    const r = await git(['fetch', '--prune'], repo);
    return sendJson(res, r.ok ? 200 : 500, { ok: r.ok, output: r.stdout + (r.message ? '\n' + r.message : '') });
  }

  return sendJson(res, 404, { error: '未知接口' });
}

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const abs = path.join(PUB_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!abs.startsWith(PUB_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    const data = await fsp.readFile(abs);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch (_) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const done = (e) => {
    if (!res.headersSent) sendJson(res, 500, { error: String(e && e.message || e) });
    else res.end();
  };
  if (url.pathname.startsWith('/api/')) {
    api(req, res, url).catch(done);
  } else {
    serveStatic(req, res, url).catch(done);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[novel-writer] http://${HOST}:${PORT}  仓库：${conf.repo}`);
});
