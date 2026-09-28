/* Obsidian vault web viewer/editor — client */
(() => {
  'use strict';

  // ---------- state ----------
  const S = {
    files: [],            // [{path, sha, size}]
    fileSet: new Set(),
    lower: new Map(),     // lowercase path -> path
    byName: new Map(),    // lowercase basename (".md" dropped) -> [paths]
    cur: null,            // {path, sha, saved, kind}
    mode: 'read',
    openFolders: new Set(),
    noteCache: new Map(), // path -> {sha, content} for embeds
    pendingHeading: null,
    ignoreHash: false,
  };

  const $ = (s) => document.querySelector(s);
  const el = {
    tree: $('#tree'), filter: $('#filter'), preview: $('#preview'), editor: $('#editor'),
    content: $('#content'), crumbs: $('#crumbs'), status: $('#status'),
    save: $('#saveBtn'), del: $('#deleteBtn'), vaultName: $('#vaultName'), repoInfo: $('#repoInfo'),
  };

  const store = {
    get(k, d) { try { const v = localStorage.getItem('vw:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('vw:' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };

  const TEXT_EXT = /\.(md|txt|canvas|json|css|js|csv|ya?ml|html?|xml|sh|py)$/i;
  const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
  const AUDIO_EXT = /\.(mp3|wav|m4a|ogg|flac)$/i;
  const VIDEO_EXT = /\.(mp4|webm|mov|mkv)$/i;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const baseName = (p) => p.split('/').pop();
  const dirName = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const stem = (p) => baseName(p).replace(/\.md$/i, '');
  const isDirty = () => S.cur && S.cur.kind === 'text' && el.editor.value !== S.cur.saved;
  const rawUrl = (p) => 'api/raw?path=' + encodeURIComponent(p);
  const routeFor = (p) => '#/' + p.split('/').map(encodeURIComponent).join('/');
  const slug = (s) => s.toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');

  function status(msg, cls = '') { el.status.textContent = msg; el.status.className = cls; }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
    return data;
  }

  // ---------- file index / link resolution ----------
  function setFiles(files) {
    S.files = files.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base', numeric: true }));
    S.fileSet = new Set(files.map((f) => f.path));
    S.lower = new Map(files.map((f) => [f.path.toLowerCase(), f.path]));
    S.byName = new Map();
    for (const f of files) {
      const key = baseName(f.path).toLowerCase().replace(/\.md$/, '');
      if (!S.byName.has(key)) S.byName.set(key, []);
      S.byName.get(key).push(f.path);
    }
    // Obsidian picks the shortest path when a name is ambiguous.
    for (const arr of S.byName.values()) arr.sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length);
  }

  // Resolve a wikilink / relative link target to a vault path, or null.
  function resolve(target, from) {
    let t = target.trim().replace(/\\/g, '/');
    if (!t) return from || null; // [[#Heading]] refers to the current note
    t = t.replace(/^\.\//, '').replace(/^\//, '');
    const hasExt = /\.[a-z0-9]{1,5}$/i.test(t) && !/\.md$/i.test(t) ? true : /\.md$/i.test(t);
    const candidates = hasExt ? [t] : [t + '.md', t];
    const fromDir = from ? dirName(from) : '';
    for (const c of candidates) {
      // relative to the current note's folder
      if (fromDir) {
        const rel = normalize(fromDir + '/' + c);
        if (rel && S.lower.has(rel.toLowerCase())) return S.lower.get(rel.toLowerCase());
      }
      const abs = normalize(c);
      if (abs && S.lower.has(abs.toLowerCase())) return S.lower.get(abs.toLowerCase());
    }
    // by basename anywhere in the vault
    const key = baseName(t).toLowerCase().replace(/\.md$/, '');
    const hits = (S.byName.get(key) || []).filter((p) => {
      if (!t.includes('/')) return true;
      return p.toLowerCase().replace(/\.md$/, '').endsWith(t.toLowerCase().replace(/\.md$/, ''));
    });
    return hits[0] || null;
  }

  function normalize(p) {
    const out = [];
    for (const seg of p.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') { if (!out.length) return null; out.pop(); } else out.push(seg);
    }
    return out.join('/');
  }

  function splitTarget(inner) {
    // "Note#Heading|Alias"  → {target, sub, alias}
    const pipe = inner.indexOf('|');
    const left = pipe >= 0 ? inner.slice(0, pipe) : inner;
    const alias = pipe >= 0 ? inner.slice(pipe + 1).trim() : '';
    const hash = left.indexOf('#');
    return {
      target: hash >= 0 ? left.slice(0, hash) : left,
      sub: hash >= 0 ? left.slice(hash + 1).replace(/^\^/, '') : '',
      alias,
    };
  }

  // ---------- markdown (Obsidian flavour) ----------
  marked.use({
    gfm: true,
    breaks: true, // Obsidian's default "strict line breaks: off"
    extensions: [
      {
        name: 'wiki', level: 'inline',
        start(src) { const i = src.indexOf('[['); return i < 0 ? undefined : (i > 0 && src[i - 1] === '!' ? i - 1 : i); },
        tokenizer(src) {
          const m = /^(!?)\[\[([^\]\n]+?)\]\]/.exec(src);
          if (m) return { type: 'wiki', raw: m[0], embed: !!m[1], inner: m[2] };
        },
        renderer(tok) { return renderWiki(tok); },
      },
      {
        name: 'highlight', level: 'inline',
        start(src) { const i = src.indexOf('=='); return i < 0 ? undefined : i; },
        tokenizer(src) {
          const m = /^==(?=\S)([\s\S]*?\S)==/.exec(src);
          if (m) return { type: 'highlight', raw: m[0], tokens: this.lexer.inlineTokens(m[1]) };
        },
        renderer(tok) { return `<mark>${this.parser.parseInline(tok.tokens)}</mark>`; },
      },
      {
        name: 'tag', level: 'inline',
        start(src) { const m = /(^|\s)#[^\s#]/.exec(src); return m ? m.index + m[1].length : undefined; },
        tokenizer(src) {
          const m = /^#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/u.exec(src);
          if (m) return { type: 'tag', raw: m[0], tag: m[1] };
        },
        renderer(tok) { return `<span class="tag">#${esc(tok.tag)}</span>`; },
      },
    ],
  });

  function renderWiki(tok) {
    const { target, sub, alias } = splitTarget(tok.inner);
    const path = resolve(target, renderCtx.path);
    if (tok.embed) {
      if (!path) return `<span class="embed-file">⚠ ${esc(target)} not found</span>`;
      const src = rawUrl(path);
      if (IMG_EXT.test(path)) {
        const size = /^(\d+)(?:x(\d+))?$/.exec(alias);
        const dims = size ? ` width="${size[1]}"${size[2] ? ` height="${size[2]}"` : ''}` : '';
        return `<img src="${src}" alt="${esc(size ? baseName(path) : alias || baseName(path))}"${dims} loading="lazy">`;
      }
      if (AUDIO_EXT.test(path)) return `<audio controls src="${src}"></audio>`;
      if (VIDEO_EXT.test(path)) return `<video controls src="${src}" style="max-width:100%"></video>`;
      if (/\.pdf$/i.test(path)) return `<iframe class="pdf" src="${src}"></iframe>`;
      if (/\.md$/i.test(path)) {
        return `<span class="embed-slot" data-path="${esc(path)}" data-sub="${esc(sub)}"></span>`;
      }
      return `<a class="embed-file" href="${src}" target="_blank">📎 ${esc(baseName(path))}</a>`;
    }
    const label = alias || (sub ? `${target || stem(renderCtx.path || '')} › ${sub}` : target);
    if (!path) return `<a class="internal missing" data-create="${esc(target)}" href="#" title="Create note">${esc(label)}</a>`;
    return `<a class="internal" data-path="${esc(path)}" data-sub="${esc(sub)}" href="${routeFor(path)}">${esc(label)}</a>`;
  }

  let renderCtx = { path: null };

  function splitFrontmatter(md) {
    const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(md);
    return m ? { fm: m[1], body: md.slice(m[0].length), offsetLines: m[0].split('\n').length - 1 } : { fm: null, body: md, offsetLines: 0 };
  }

  function renderProps(fm) {
    const rows = [];
    let key = null;
    for (const line of fm.split(/\r?\n/)) {
      const kv = /^([^\s:#][^:]*):\s*(.*)$/.exec(line);
      const li = /^\s+-\s*(.*)$/.exec(line);
      if (kv) { key = kv[1].trim(); rows.push([key, kv[2].trim() ? [kv[2].trim()] : []]); }
      else if (li && rows.length) rows[rows.length - 1][1].push(li[1].trim());
    }
    if (!rows.length) return '';
    const cell = (k, vals) => {
      const clean = vals.map((v) => v.replace(/^["']|["']$/g, ''));
      if (/^(tags?|aliases)$/i.test(k)) {
        const items = clean.flatMap((v) => v.replace(/^\[|\]$/g, '').split(',')).map((s) => s.trim()).filter(Boolean);
        return /^tags?$/i.test(k) ? items.map((t) => `<span class="tag">#${esc(t.replace(/^#/, ''))}</span>`).join(' ') : esc(items.join(', '));
      }
      return esc(clean.join(', '));
    };
    return `<details class="props" open><summary>Properties</summary><dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${cell(k, v)}</dd>`).join('')}</dl></details>`;
  }

  function sanitize(root) {
    root.querySelectorAll('script, style, object, embed, form, base, meta, link').forEach((n) => n.remove());
    root.querySelectorAll('*').forEach((n) => {
      for (const a of [...n.attributes]) {
        const name = a.name.toLowerCase();
        if (name.startsWith('on') || name === 'srcdoc') n.removeAttribute(a.name);
        else if (['href', 'src', 'action', 'formaction', 'xlink:href'].includes(name) && /^\s*(javascript|vbscript|data:text)/i.test(a.value)) n.removeAttribute(a.name);
      }
      if (n.tagName === 'IFRAME') {
        const src = n.getAttribute('src') || '';
        if (n.classList.contains('pdf') && src.startsWith('api/raw')) return;
        if (!/^https:\/\//i.test(src)) n.remove();
        else n.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-presentation');
      }
    });
  }

  function extractSection(md, sub) {
    const lines = md.split('\n');
    const want = slug(sub);
    let start = -1, level = 0;
    for (let i = 0; i < lines.length; i++) {
      const h = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
      if (start < 0) {
        if (h && slug(h[2]) === want) { start = i; level = h[1].length; }
        else if (lines[i].includes('^' + sub)) return lines[i].replace(new RegExp('\\s*\\^' + sub + '\\s*$'), '');
      } else if (h && h[1].length <= level) return lines.slice(start, i).join('\n');
    }
    return start >= 0 ? lines.slice(start).join('\n') : `*Section “${sub}” not found.*`;
  }

  // Render markdown into a container element. Returns the container.
  function renderMarkdown(md, path, depth = 0) {
    const { fm, body } = splitFrontmatter(md);
    const cleaned = body.replace(/%%[\s\S]*?%%/g, ''); // Obsidian comments
    const prev = renderCtx; renderCtx = { path };
    let html;
    try { html = marked.parse(cleaned); } finally { renderCtx = prev; }

    const box = document.createElement('div');
    const tpl = document.createElement('template');
    tpl.innerHTML = (depth === 0 && fm ? renderProps(fm) : '') + html;
    sanitize(tpl.content);
    box.append(tpl.content);

    // heading ids for [[Note#Heading]]
    box.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((h) => { if (!h.id) h.id = slug(h.textContent); });

    // callouts: > [!type]± Title
    box.querySelectorAll('blockquote').forEach((bq) => {
      const p = bq.firstElementChild;
      if (!p || p.tagName !== 'P') return;
      const m = /^\[!([\w-]+)\]([+-]?)[ \t]*(.*?)(?:<br>\n?|\n|$)/.exec(p.innerHTML.trimStart());
      if (!m) return;
      const type = m[1].toLowerCase();
      const rest = p.innerHTML.trimStart().slice(m[0].length);
      if (rest.trim()) p.innerHTML = rest; else p.remove();
      const c = document.createElement('div');
      c.className = 'callout' + (m[2] === '-' ? ' folded' : '');
      c.dataset.type = type;
      const title = document.createElement('div');
      title.className = 'callout-title';
      title.innerHTML = `<span>${m[3] || esc(type[0].toUpperCase() + type.slice(1))}</span>${m[2] ? '<span class="foldmark">▼</span>' : ''}`;
      if (m[2]) title.style.cursor = 'pointer', title.onclick = () => c.classList.toggle('folded');
      const bodyEl = document.createElement('div');
      bodyEl.className = 'callout-body';
      bodyEl.append(...bq.childNodes);
      c.append(title, bodyEl);
      bq.replaceWith(c);
    });

    // relative markdown links and images
    box.querySelectorAll('a[href]:not(.internal):not(.embed-file)').forEach((a) => {
      const href = a.getAttribute('href');
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; return; }
      if (href.startsWith('#')) {
        a.dataset.path = path; a.dataset.sub = decodeURIComponent(href.slice(1)); a.classList.add('internal');
        return;
      }
      const [p, frag] = href.split('#');
      const target = resolve(decodeURIComponent(p), path);
      if (target) {
        a.classList.add('internal'); a.dataset.path = target; a.dataset.sub = frag ? decodeURIComponent(frag) : '';
        a.setAttribute('href', routeFor(target));
      }
    });
    box.querySelectorAll('img[src]').forEach((img) => {
      const src = img.getAttribute('src');
      if (/^([a-z][a-z0-9+.-]*:|\/\/|api\/raw)/i.test(src)) return;
      const target = resolve(decodeURIComponent(src), path);
      if (target) img.setAttribute('src', rawUrl(target));
    });

    // task checkboxes (top-level note only; embedded ones stay read-only)
    box.querySelectorAll('li > input[type=checkbox], li > p > input[type=checkbox]').forEach((cb) => {
      const li = cb.closest('li');
      li.classList.add('task');
      if (cb.checked) li.classList.add('done');
      if (depth === 0) { cb.disabled = false; cb.classList.add('task-cb'); }
    });

    // note embeds
    if (depth < 3) {
      box.querySelectorAll('.embed-slot').forEach((slot) => fillEmbed(slot, depth));
    }
    return box;
  }

  async function fillEmbed(slot, depth) {
    const p = slot.dataset.path, sub = slot.dataset.sub;
    const wrap = document.createElement('div');
    wrap.className = 'embed-note';
    wrap.innerHTML = `<div class="embed-title"><a class="internal" data-path="${esc(p)}" data-sub="${esc(sub)}" href="${routeFor(p)}">${esc(stem(p))}${sub ? ' › ' + esc(sub) : ''}</a></div>`;
    slot.replaceWith(wrap);
    try {
      const f = S.files.find((x) => x.path === p);
      let cached = S.noteCache.get(p);
      if (!cached || (f && cached.sha !== f.sha)) {
        const d = await api('GET', 'api/file?path=' + encodeURIComponent(p));
        cached = { sha: d.sha, content: d.content };
        S.noteCache.set(p, cached);
      }
      const md = sub ? extractSection(splitFrontmatter(cached.content).body, sub) : cached.content;
      wrap.append(renderMarkdown(md, p, depth + 1));
    } catch (e) {
      wrap.append(Object.assign(document.createElement('em'), { textContent: 'Could not load: ' + e.message }));
    }
  }

  // ---------- preview ----------
  let previewTimer = null;
  function renderPreview() {
    if (!S.cur) return;
    const p = S.cur.path;
    el.preview.replaceChildren();
    if (S.cur.kind === 'binary') {
      let node;
      if (IMG_EXT.test(p)) node = Object.assign(document.createElement('img'), { src: rawUrl(p), alt: baseName(p) });
      else if (/\.pdf$/i.test(p)) node = Object.assign(document.createElement('iframe'), { src: rawUrl(p), className: 'pdf' });
      else if (AUDIO_EXT.test(p)) node = Object.assign(document.createElement('audio'), { src: rawUrl(p), controls: true });
      else if (VIDEO_EXT.test(p)) node = Object.assign(document.createElement('video'), { src: rawUrl(p), controls: true });
      else { node = document.createElement('p'); node.innerHTML = `<a href="${rawUrl(p)}" target="_blank">Download ${esc(baseName(p))}</a>`; }
      el.preview.append(node);
      return;
    }
    const text = el.editor.value;
    if (/\.md$/i.test(p)) {
      el.preview.append(renderMarkdown(text, p));
    } else {
      const pre = document.createElement('pre');
      pre.append(Object.assign(document.createElement('code'), { textContent: text }));
      el.preview.append(pre);
    }
  }
  const schedulePreview = () => { clearTimeout(previewTimer); previewTimer = setTimeout(renderPreview, 150); };

  // Map rendered checkbox N to its source line so clicking it edits the note.
  function taskLines(md) {
    const lines = md.split('\n');
    const { offsetLines } = splitFrontmatter(md);
    const out = [];
    let fence = null, inComment = false;
    for (let i = offsetLines; i < lines.length; i++) {
      const l = lines[i];
      const f = /^\s*(?:>\s*)*(`{3,}|~{3,})/.exec(l);
      if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = null; continue; }
      if (fence) continue;
      const commentMarks = (l.match(/%%/g) || []).length;
      if (inComment) { if (commentMarks % 2) inComment = false; continue; }
      if (commentMarks % 2) { inComment = true; continue; }
      if (/^(?:\s*>)*\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\](?:\s|$)/.test(l)) out.push(i);
    }
    return out;
  }

  el.preview.addEventListener('change', (e) => {
    const cb = e.target;
    if (!cb.classList || !cb.classList.contains('task-cb')) return;
    const boxes = [...el.preview.querySelectorAll('.task-cb')];
    const idx = boxes.indexOf(cb);
    const lines = el.editor.value.split('\n');
    const map = taskLines(el.editor.value);
    if (map.length !== boxes.length || idx < 0) { cb.checked = !cb.checked; status('Could not map that checkbox — edit it in the editor', 'err'); return; }
    const i = map[idx];
    lines[i] = lines[i].replace(/\[([ xX])\]/, cb.checked ? '[x]' : '[ ]');
    el.editor.value = lines.join('\n');
    cb.closest('li').classList.toggle('done', cb.checked);
    onEdit();
    if (S.mode === 'read') save(); // quick-tick in reading view commits straight away
  });

  // ---------- tree ----------
  function buildTree() {
    const root = { dirs: new Map(), files: [] };
    for (const f of S.files) {
      const parts = f.path.split('/');
      let node = root, acc = '';
      for (const seg of parts.slice(0, -1)) {
        acc = acc ? acc + '/' + seg : seg;
        if (!node.dirs.has(seg)) node.dirs.set(seg, { dirs: new Map(), files: [], path: acc });
        node = node.dirs.get(seg);
      }
      node.files.push(f);
    }
    return root;
  }

  function renderTree() {
    const q = el.filter.value.trim().toLowerCase();
    el.tree.replaceChildren();
    if (!S.files.length) { el.tree.innerHTML = '<div class="tree-empty">No files found.</div>'; return; }
    if (q) {
      const hits = S.files.filter((f) => f.path.toLowerCase().includes(q)).slice(0, 300);
      if (!hits.length) { el.tree.innerHTML = '<div class="tree-empty">No matches.</div>'; return; }
      hits.forEach((f) => el.tree.append(fileNode(f, true)));
      return;
    }
    el.tree.append(dirChildren(buildTree()));
  }

  function dirChildren(node) {
    const frag = document.createDocumentFragment();
    const dirs = [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base', numeric: true }));
    for (const [name, d] of dirs) {
      const wrap = document.createElement('div');
      wrap.className = 'folder' + (S.openFolders.has(d.path) ? ' open' : '');
      const row = document.createElement('div');
      row.className = 'node dir';
      row.innerHTML = `<span class="caret">▶</span><span class="label">${esc(name)}</span>`;
      const kids = document.createElement('div');
      kids.className = 'children';
      let built = false;
      const build = () => { if (!built) { kids.append(dirChildren(d)); built = true; } };
      if (S.openFolders.has(d.path)) build();
      row.onclick = () => {
        const open = wrap.classList.toggle('open');
        if (open) { S.openFolders.add(d.path); build(); } else S.openFolders.delete(d.path);
        store.set('open', [...S.openFolders]);
      };
      wrap.append(row, kids);
      frag.append(wrap);
    }
    node.files.forEach((f) => frag.append(fileNode(f, false)));
    return frag;
  }

  function fileNode(f, showPath) {
    const row = document.createElement('a');
    const md = /\.md$/i.test(f.path);
    row.className = 'node file' + (md ? '' : ' nonmd') + (S.cur && S.cur.path === f.path ? ' active' : '');
    row.href = routeFor(f.path);
    row.dataset.path = f.path;
    row.style.color = 'inherit'; row.style.textDecoration = 'none';
    const label = showPath ? f.path.replace(/\.md$/i, '') : stem(f.path);
    const ext = md ? '' : `<span class="ext">${esc((f.path.split('.').pop() || '').toUpperCase())}</span>`;
    row.innerHTML = `<span class="caret"></span><span class="label" title="${esc(f.path)}">${esc(label)}</span>${ext}`;
    return row;
  }

  function markActive() {
    el.tree.querySelectorAll('.node.file').forEach((n) => n.classList.toggle('active', !!S.cur && n.dataset.path === S.cur.path));
  }

  function revealInTree(p) {
    const parts = p.split('/');
    let acc = '', changed = false;
    for (const seg of parts.slice(0, -1)) {
      acc = acc ? acc + '/' + seg : seg;
      if (!S.openFolders.has(acc)) { S.openFolders.add(acc); changed = true; }
    }
    if (changed) { store.set('open', [...S.openFolders]); renderTree(); } else markActive();
    const node = el.tree.querySelector(`.node.file[data-path="${CSS.escape(p)}"]`);
    if (node) node.scrollIntoView({ block: 'nearest' });
  }

  // ---------- open / save / create / delete ----------
  function setMode(m) {
    if (S.cur && S.cur.kind === 'binary') m = 'read';
    S.mode = m;
    el.content.className = m;
    document.querySelectorAll('.mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
    if (m !== 'edit') renderPreview();
    if (m !== 'read') el.editor.focus();
  }

  function updateChrome() {
    const c = S.cur;
    if (!c) {
      el.crumbs.textContent = '';
      el.save.disabled = true; el.del.disabled = true;
      document.title = 'Vault';
      return;
    }
    const parts = c.path.split('/');
    el.crumbs.innerHTML = parts.slice(0, -1).map(esc).join(' / ') + (parts.length > 1 ? ' / ' : '') + `<b>${esc(stem(c.path))}</b>`;
    document.title = stem(c.path) + ' — Vault';
    el.del.disabled = c.kind === 'binary' || !c.sha;
    el.save.disabled = !isDirty();
    document.querySelectorAll('.mode').forEach((b) => { b.disabled = c.kind === 'binary' && b.dataset.mode !== 'read'; });
  }

  function onEdit() {
    const d = isDirty();
    el.save.disabled = !d;
    status(d ? 'Unsaved changes' : '', d ? 'dirty' : '');
    if (S.mode === 'split') schedulePreview();
  }

  async function openPath(p) {
    closeSidebarMobile();
    if (!S.fileSet.has(p)) {
      const r = resolve(p, null);
      if (!r) { showEmpty(`“${esc(p)}” isn't in the vault.`); return; }
      p = r;
    }
    const kind = TEXT_EXT.test(p) ? 'text' : 'binary';
    S.cur = { path: p, sha: null, saved: '', kind };
    store.set('last', p);
    updateChrome();
    revealInTree(p);
    if (kind === 'binary') { el.editor.value = ''; setMode('read'); status(''); return; }
    status('Loading…');
    el.preview.innerHTML = '';
    try {
      const d = await api('GET', 'api/file?path=' + encodeURIComponent(p));
      if (!S.cur || S.cur.path !== p) return; // navigated away meanwhile
      S.cur.sha = d.sha; S.cur.saved = d.content;
      S.noteCache.set(p, { sha: d.sha, content: d.content });
      el.editor.value = d.content;
      status('');
      updateChrome();
      setMode(S.mode);
      scrollToHeading();
    } catch (e) {
      status(e.message, 'err');
    }
  }

  function scrollToHeading() {
    const sub = S.pendingHeading; S.pendingHeading = null;
    if (!sub) { el.content.querySelector('#previewPane').scrollTop = 0; return; }
    const id = slug(sub);
    const target = el.preview.querySelector(`[id="${CSS.escape(id)}"]`)
      || [...el.preview.querySelectorAll('li, p')].find((n) => n.textContent.includes('^' + sub));
    if (target) target.scrollIntoView({ block: 'start' });
  }

  async function save() {
    const c = S.cur;
    if (!c || c.kind !== 'text' || !isDirty()) return;
    const content = el.editor.value;
    status('Saving…');
    el.save.disabled = true;
    try {
      const d = await api('PUT', 'api/file', { path: c.path, content, sha: c.sha });
      if (S.cur !== c) return;
      c.sha = d.sha; c.saved = content;
      S.noteCache.set(c.path, { sha: d.sha, content });
      const f = S.files.find((x) => x.path === c.path);
      if (f) f.sha = d.sha;
      status('Saved ✓ ' + d.commit.slice(0, 7), 'ok');
      setTimeout(() => { if (!isDirty() && el.status.classList.contains('ok')) status(''); }, 3000);
    } catch (e) {
      if (e.status === 409) {
        status('Conflict', 'err');
        if (confirm(e.message + '\n\nLoad the GitHub version now? Your unsaved text will be copied to the clipboard first.')) {
          try { await navigator.clipboard.writeText(content); } catch { /* clipboard blocked */ }
          c.saved = el.editor.value; // allow reload without the unsaved-changes prompt
          await openPath(c.path);
          status('Reloaded — your edits are on the clipboard', 'dirty');
          return;
        }
      } else {
        status('Save failed', 'err');
        alert(e.message);
      }
    }
    updateChrome();
  }

  async function createNote(suggested) {
    const def = suggested || ((S.cur && dirName(S.cur.path)) ? dirName(S.cur.path) + '/' : '') + 'Untitled.md';
    let p = prompt('New note path (folders with /):', def);
    if (!p) return;
    p = normalize(p.trim().replace(/\\/g, '/'));
    if (!p) return;
    if (!/\.[a-z0-9]{1,5}$/i.test(p)) p += '.md';
    if (S.fileSet.has(p) || S.lower.has(p.toLowerCase())) { location.hash = routeFor(S.lower.get(p.toLowerCase())); return; }
    status('Creating…');
    try {
      const content = /\.md$/i.test(p) ? `# ${stem(p)}\n\n` : '';
      const d = await api('PUT', 'api/file', { path: p, content, message: `Create ${p} (web)` });
      setFiles([...S.files, { path: p, sha: d.sha, size: content.length }]);
      renderTree();
      S.mode = 'edit';
      location.hash = routeFor(p);
    } catch (e) { status('Create failed', 'err'); alert(e.message); }
  }

  async function deleteNote() {
    const c = S.cur;
    if (!c || !c.sha) return;
    if (!confirm(`Delete “${c.path}”? This commits a deletion to GitHub (recoverable from git history).`)) return;
    try {
      await api('DELETE', 'api/file', { path: c.path, sha: c.sha });
      setFiles(S.files.filter((f) => f.path !== c.path));
      S.cur = null;
      el.editor.value = '';
      renderTree();
      S.ignoreHash = true;
      location.hash = '';
      showEmpty('Note deleted.');
    } catch (e) { alert(e.message); }
  }

  function showEmpty(msg) {
    S.cur = null;
    updateChrome();
    markActive();
    el.content.className = 'read';
    el.preview.innerHTML = `<div class="empty-state"><h2>${msg || 'Pick a note'}</h2><p>Choose a file from the sidebar, or create a new note with ＋.</p></div>`;
  }

  async function loadTree() {
    status('Syncing…');
    const d = await api('GET', 'api/tree');
    setFiles(d.files);
    renderTree();
    status(d.truncated ? 'Repo too large — file list truncated' : '', d.truncated ? 'err' : '');
  }

  // ---------- routing ----------
  let lastHash = location.hash;
  function currentRoutePath() {
    const h = location.hash;
    if (!h.startsWith('#/')) return null;
    return h.slice(2).split('/').map(decodeURIComponent).join('/');
  }

  window.addEventListener('hashchange', () => {
    if (S.ignoreHash) { S.ignoreHash = false; lastHash = location.hash; return; }
    if (isDirty() && !confirm('You have unsaved changes. Leave this note without saving?')) {
      S.ignoreHash = true; location.hash = lastHash; return;
    }
    lastHash = location.hash;
    const p = currentRoutePath();
    if (p) openPath(p); else showEmpty();
  });

  window.addEventListener('beforeunload', (e) => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } });

  // ---------- events ----------
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a.internal');
    if (!a || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    if (a.dataset.create) {
      if (confirm(`“${a.dataset.create}” doesn't exist yet. Create it?`)) createNote(a.dataset.create + '.md');
      return;
    }
    const p = a.dataset.path, sub = a.dataset.sub;
    if (S.cur && p === S.cur.path) { S.pendingHeading = sub; scrollToHeading(); return; }
    S.pendingHeading = sub || null;
    location.hash = routeFor(p);
  });

  document.querySelectorAll('.mode').forEach((b) => b.addEventListener('click', () => { setMode(b.dataset.mode); store.set('mode', b.dataset.mode); }));
  el.save.onclick = save;
  el.del.onclick = deleteNote;
  $('#newNoteBtn').onclick = () => createNote();
  $('#refreshBtn').onclick = async () => {
    try {
      await loadTree();
      if (S.cur && !isDirty() && S.cur.kind === 'text') { S.noteCache.clear(); await openPath(S.cur.path); }
      status('Up to date', 'ok');
    } catch (e) { status(e.message, 'err'); }
  };
  el.filter.addEventListener('input', renderTree);
  el.editor.addEventListener('input', onEdit);
  el.editor.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: t, value: v } = el.editor;
      if (s === t && !e.shiftKey) { el.editor.setRangeText('\t', s, t, 'end'); onEdit(); return; }
      // indent / outdent selected lines
      const ls = v.lastIndexOf('\n', s - 1) + 1;
      const block = v.slice(ls, t);
      const next = e.shiftKey ? block.replace(/^(\t| {1,4})/gm, '') : block.replace(/^/gm, '\t');
      el.editor.setRangeText(next, ls, t, 'select');
      onEdit();
    }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'e' && S.cur && S.cur.kind === 'text') {
      e.preventDefault(); const m = S.mode === 'read' ? 'edit' : 'read'; setMode(m); store.set('mode', m);
    }
  });

  const closeSidebarMobile = () => document.body.classList.remove('side-open');
  $('#menuBtn').onclick = () => document.body.classList.toggle('side-open');
  $('#scrim').onclick = closeSidebarMobile;

  // ---------- boot ----------
  (async function boot() {
    S.openFolders = new Set(store.get('open', []));
    S.mode = store.get('mode', 'read');
    if (S.mode === 'split' && matchMedia('(max-width: 760px)').matches) S.mode = 'read';
    try {
      const cfg = await api('GET', 'api/config');
      const name = cfg.vaultRoot ? baseName(cfg.vaultRoot) : cfg.repo.split('/')[1];
      el.vaultName.textContent = name;
      el.repoInfo.textContent = `${cfg.repo} · ${cfg.branch}${cfg.vaultRoot ? ' · /' + cfg.vaultRoot : ''}`;
      await loadTree();
    } catch (e) {
      status(e.message, 'err');
      el.preview.innerHTML = `<div class="empty-state"><h2>Couldn't reach the vault</h2><p>${esc(e.message)}</p></div>`;
      return;
    }
    const p = currentRoutePath();
    const last = store.get('last', null);
    const home = ['Home.md', 'index.md', 'README.md', 'Readme.md'].find((h) => S.fileSet.has(h));
    if (p) openPath(p);
    else if (last && S.fileSet.has(last)) { S.ignoreHash = true; location.hash = routeFor(last); openPath(last); }
    else if (home) { S.ignoreHash = true; location.hash = routeFor(home); openPath(home); }
    else showEmpty();
  })();
})();
