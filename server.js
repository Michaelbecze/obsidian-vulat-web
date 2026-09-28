// Obsidian vault web viewer/editor backed by a GitHub repo.
// Reads and writes go through the GitHub REST API, so the app is stateless:
// no clone on disk, and every save is a commit.

const express = require('express');
const path = require('path');
const crypto = require('crypto');

const cfg = {
  token: process.env.GITHUB_TOKEN,            // fine-grained PAT: Contents read/write on the vault repo
  repo: process.env.GITHUB_REPO,              // "owner/name", e.g. Michaelbecze/Obsidian
  branch: process.env.GITHUB_BRANCH || 'main',
  vaultRoot: (process.env.VAULT_PATH || '').replace(/^\/+|\/+$/g, ''), // subfolder if the vault isn't the repo root
  api: (process.env.GITHUB_API || 'https://api.github.com').replace(/\/+$/, ''),
  authUser: process.env.BASIC_AUTH_USER,      // optional; prefer Azure Easy Auth in production
  authPass: process.env.BASIC_AUTH_PASS,
  commitName: process.env.COMMIT_AUTHOR_NAME || 'Vault Web',
  commitEmail: process.env.COMMIT_AUTHOR_EMAIL || 'vault-web@users.noreply.github.com',
  port: process.env.PORT || 3000,
};

if (!cfg.token || !cfg.repo) {
  console.error('GITHUB_TOKEN and GITHUB_REPO must be set.');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10mb' }));

// ---- optional basic auth -------------------------------------------------
if (cfg.authUser && cfg.authPass) {
  const safeEq = (a, b) => {
    const x = Buffer.from(a), y = Buffer.from(b);
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };
  app.use((req, res, next) => {
    if (req.path === '/healthz') return next();
    const [scheme, enc] = (req.headers.authorization || '').split(' ');
    if (scheme === 'Basic' && enc) {
      const [u, ...p] = Buffer.from(enc, 'base64').toString().split(':');
      if (safeEq(u, cfg.authUser) && safeEq(p.join(':'), cfg.authPass)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Vault"').status(401).send('Authentication required');
  });
}

// ---- GitHub helpers ------------------------------------------------------
async function gh(method, url, { body, accept } = {}) {
  const res = await fetch(cfg.api + url, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: accept || 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'obsidian-vault-web',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

async function ghJson(method, url, opts) {
  const res = await gh(method, url, opts);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (!res.ok) {
    const err = new Error(data.message || `GitHub ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Reject traversal and anything under .git; paths are relative to the vault root.
function vaultPath(p) {
  if (typeof p !== 'string' || !p) throw Object.assign(new Error('path required'), { status: 400 });
  const clean = path.posix.normalize(p.replace(/\\/g, '/')).replace(/^\/+/, '');
  if (clean.startsWith('..') || clean.split('/').includes('.git') || clean === '.') {
    throw Object.assign(new Error('invalid path'), { status: 400 });
  }
  return clean;
}
const repoPath = (p) => (cfg.vaultRoot ? `${cfg.vaultRoot}/${p}` : p);
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
const ref = () => `ref=${encodeURIComponent(cfg.branch)}`;

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => res.status(e.status || 500).json({ error: e.message }));

// ---- API -----------------------------------------------------------------
app.get('/healthz', (req, res) => res.send('ok'));

app.get('/api/config', (req, res) =>
  res.json({ repo: cfg.repo, branch: cfg.branch, vaultRoot: cfg.vaultRoot }));

// Full file list (one API call, recursive tree).
app.get('/api/tree', wrap(async (req, res) => {
  const data = await ghJson('GET', `/repos/${cfg.repo}/git/trees/${encodeURIComponent(cfg.branch)}?recursive=1`);
  const prefix = cfg.vaultRoot ? cfg.vaultRoot + '/' : '';
  const files = data.tree
    .filter((t) => t.type === 'blob' && t.path.startsWith(prefix))
    .map((t) => ({ path: t.path.slice(prefix.length), sha: t.sha, size: t.size }))
    .filter((f) => !f.path.split('/').some((seg) => seg.startsWith('.'))); // hide .obsidian, .trash, .gitignore…
  res.json({ files, truncated: !!data.truncated });
}));

// Read a text file; sha is returned so saves can detect conflicts.
app.get('/api/file', wrap(async (req, res) => {
  const p = vaultPath(req.query.path);
  const data = await ghJson('GET', `/repos/${cfg.repo}/contents/${encPath(repoPath(p))}?${ref()}`);
  if (Array.isArray(data)) throw Object.assign(new Error('is a directory'), { status: 400 });
  let content;
  if (data.encoding === 'base64' && data.content) {
    content = Buffer.from(data.content, 'base64').toString('utf8');
  } else {
    // Files over 1 MB come back without inline content; fetch the blob.
    const blob = await ghJson('GET', `/repos/${cfg.repo}/git/blobs/${data.sha}`);
    content = Buffer.from(blob.content, 'base64').toString('utf8');
  }
  res.json({ path: p, sha: data.sha, content });
}));

// Create or update. Pass the sha you loaded; GitHub returns 409 if it changed.
app.put('/api/file', wrap(async (req, res) => {
  const p = vaultPath(req.body.path);
  const { content, sha, message } = req.body;
  if (typeof content !== 'string') throw Object.assign(new Error('content required'), { status: 400 });
  try {
    const data = await ghJson('PUT', `/repos/${cfg.repo}/contents/${encPath(repoPath(p))}`, {
      body: {
        message: message || `${sha ? 'Update' : 'Create'} ${p} (web)`,
        content: Buffer.from(content, 'utf8').toString('base64'),
        branch: cfg.branch,
        committer: { name: cfg.commitName, email: cfg.commitEmail },
        ...(sha ? { sha } : {}),
      },
    });
    res.json({ path: p, sha: data.content.sha, commit: data.commit.sha });
  } catch (e) {
    if (e.status === 409 || (e.status === 422 && /sha/i.test(e.message))) {
      e.status = 409;
      e.message = 'This note changed on GitHub since you opened it (probably a sync from another device). Reload it before saving, or copy your edits first.';
    }
    throw e;
  }
}));

app.delete('/api/file', wrap(async (req, res) => {
  const p = vaultPath(req.body.path);
  if (!req.body.sha) throw Object.assign(new Error('sha required'), { status: 400 });
  await ghJson('DELETE', `/repos/${cfg.repo}/contents/${encPath(repoPath(p))}`, {
    body: {
      message: `Delete ${p} (web)`,
      sha: req.body.sha,
      branch: cfg.branch,
      committer: { name: cfg.commitName, email: cfg.commitEmail },
    },
  });
  res.json({ ok: true });
}));

// Raw bytes for images/PDFs/attachments embedded in notes.
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', bmp: 'image/bmp', pdf: 'application/pdf', mp3: 'audio/mpeg', wav: 'audio/wav',
  mp4: 'video/mp4', webm: 'video/webm', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
};
app.get('/api/raw', wrap(async (req, res) => {
  const p = vaultPath(req.query.path);
  const r = await gh('GET', `/repos/${cfg.repo}/contents/${encPath(repoPath(p))}?${ref()}`, {
    accept: 'application/vnd.github.raw+json',
  });
  if (!r.ok) throw Object.assign(new Error(`GitHub ${r.status}`), { status: r.status });
  const ext = p.split('.').pop().toLowerCase();
  res.set('Content-Type', MIME[ext] || 'application/octet-stream');
  res.set('Cache-Control', 'private, max-age=300');
  // SVGs can carry script; keep them inert when opened directly.
  if (ext === 'svg') res.set('Content-Security-Policy', "script-src 'none'");
  res.send(Buffer.from(await r.arrayBuffer()));
}));

// ---- static UI -----------------------------------------------------------
app.get('/vendor/marked.js', (req, res) =>
  res.sendFile(path.join(__dirname, 'node_modules', 'marked', 'lib', 'marked.umd.js')));
app.use(express.static(path.join(__dirname, 'public')));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(cfg.port, () =>
  console.log(`Vault web on :${cfg.port} → ${cfg.repo}@${cfg.branch}${cfg.vaultRoot ? '/' + cfg.vaultRoot : ''}`));
