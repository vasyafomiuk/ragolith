// Dashboard frontend — vanilla JS, no bundler, no framework.
//
// Routes (hash-based, server stays dumb):
//   #projects               project list
//   #search                 search form + results
//   #config                 form + JSON editor for ragc.config.json
//   #health                 stack health probe
//   #project/<name>         drill into one project

// ----- helpers --------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const fmtDate = (s) => {
  if (!s) return '';
  try {
    return new Date(s).toLocaleString();
  } catch {
    return s;
  }
};

const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function api(path, init) {
  const r = await fetch(path, init);
  const text = await r.text();
  if (!r.ok) {
    let msg = text;
    try {
      const j = JSON.parse(text);
      if (j.error) msg = j.error;
    } catch {
      // body wasn't JSON — use the raw text as the message.
    }
    throw new Error(`${r.status}: ${msg}`);
  }
  return text ? JSON.parse(text) : {};
}

// ----- first-run state -----------------------------------------------------
//
// On every navigation we re-check /api/config to know whether a
// ragc.config.json exists. If not, we surface a setup banner on every view
// except #config itself, and (one time per session) auto-redirect a fresh
// visit to #config so a new user lands directly in the editor.

let configExists = null; // null = unknown, then true/false
let autoRedirected = false;

async function refreshConfigPresence() {
  try {
    const c = await api('/api/config');
    configExists = !!c.exists;
  } catch {
    configExists = null; // unknown — treat as ok, don't false-positive
  }
  applySetupBanner();
}

function applySetupBanner() {
  const banner = $('setup-banner');
  if (!banner) return;
  const onConfig = (window.location.hash || '').startsWith('#config');
  banner.hidden = !(configExists === false && !onConfig);
}

// ----- routing --------------------------------------------------------------

const VIEWS = ['projects', 'search', 'project', 'config', 'health'];

function showView(view) {
  for (const v of VIEWS) {
    const el = $(`view-${v}`);
    if (el) el.hidden = v !== view;
  }
  document.querySelectorAll('.navlink').forEach((a) => {
    a.classList.toggle('active', a.dataset.route === view);
  });
}

async function route() {
  let hash = window.location.hash.replace(/^#/, '') || 'projects';
  // legacy default route
  if (hash === 'home') hash = 'projects';

  // First-run redirect: if this is a fresh tab AND the config file doesn't
  // exist, drop the user straight into #config. We only do this once per
  // session so they can still navigate away to #projects / #health.
  if (configExists === null) await refreshConfigPresence();
  if (configExists === false && !autoRedirected && hash === 'projects') {
    autoRedirected = true;
    window.location.hash = '#config';
    return;
  }
  applySetupBanner();

  if (hash.startsWith('project/')) {
    const name = decodeURIComponent(hash.slice('project/'.length));
    showView('project');
    await renderProject(name);
    return;
  }
  if (hash === 'search') {
    showView('search');
    await ensureProjectFilter();
    return;
  }
  if (hash === 'config') {
    showView('config');
    await loadConfig();
    return;
  }
  if (hash === 'health') {
    showView('health');
    await renderHealth();
    return;
  }
  showView('projects');
  await renderProjects();
}

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', () => {
  // Show the bound host in the top bar so it's clear which Weaviate the
  // dashboard is targeting.
  $('topbar-host').textContent = window.location.host;
  route();
});

// ----- projects view --------------------------------------------------------

async function renderProjects() {
  const body = $('projects-body');
  const card = $('projects-card');
  const empty = $('projects-empty');
  body.innerHTML = '<tr><td colspan="6" class="muted">Loading…</td></tr>';
  card.hidden = false;
  empty.hidden = true;
  try {
    const projects = await api('/api/projects');
    if (projects.length === 0) {
      card.hidden = true;
      empty.hidden = false;
      return;
    }
    body.innerHTML = projects
      .map((p) => {
        const langs = Object.entries(p.languages || {})
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([k, v]) => `<span class="lang-pill">${escape(k)} ${v}</span>`)
          .join(' ');
        const sha = p.commit_sha ? p.commit_sha.slice(0, 7) : '—';
        return `
          <tr>
            <td>
              <a href="#project/${encodeURIComponent(p.name)}">${escape(p.name)}</a>
              <span class="muted small"> · ${escape(p.source)}</span>
            </td>
            <td class="num">${p.file_count}</td>
            <td class="num">${p.chunk_count}</td>
            <td>${langs || '<span class="muted">—</span>'}</td>
            <td><code>${escape(sha)}</code></td>
            <td class="muted small">${escape(fmtDate(p.updated_at))}</td>
          </tr>
        `;
      })
      .join('');
  } catch (err) {
    body.innerHTML = `<tr><td colspan="6" class="muted">Error: ${escape(err.message)}</td></tr>`;
  }
}

// ----- project detail view --------------------------------------------------

async function renderProject(name) {
  $('project-title').textContent = name;
  $('project-meta').textContent = 'Loading…';
  const body = $('project-body');
  body.innerHTML = '';
  try {
    const files = await api(`/api/projects/${encodeURIComponent(name)}/files`);
    if (files.length === 0) {
      $('project-meta').textContent = 'No indexed files for this project yet.';
      return;
    }
    const total = files.reduce((a, f) => a + f.chunk_count, 0);
    $('project-meta').textContent = `${files.length} files · ${total} chunks`;
    body.innerHTML = files
      .map(
        (f) => `
          <tr>
            <td><code>${escape(f.file_path)}</code></td>
            <td><span class="lang-pill">${escape(f.language)}</span></td>
            <td class="num">${f.chunk_count}</td>
          </tr>
        `,
      )
      .join('');
  } catch (err) {
    $('project-meta').textContent = `Error: ${err.message}`;
  }
}

// ----- search view ----------------------------------------------------------

let projectFilterFilled = false;
async function ensureProjectFilter() {
  if (projectFilterFilled) return;
  try {
    const projects = await api('/api/projects');
    const sel = $('search-project');
    for (const p of projects) {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.name;
      sel.appendChild(opt);
    }
    projectFilterFilled = true;
  } catch {
    // empty filter is fine
  }
}

$('search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const query = $('search-input').value.trim();
  const project = $('search-project').value;
  if (!query) return;
  const list = $('search-results');
  const status = $('search-status');
  list.innerHTML = '';
  status.textContent = 'Searching…';
  try {
    const body = { query, limit: 20 };
    if (project) body.project = project;
    const hits = await api('/api/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (hits.length === 0) {
      status.textContent = `No matches for "${query}"`;
      return;
    }
    status.textContent = `${hits.length} hit${hits.length === 1 ? '' : 's'} for "${query}"`;
    list.innerHTML = hits
      .map((h) => {
        const tags = [
          h.symbol ? `<code>${escape(h.symbol)}</code>` : '',
          `<span class="lang-pill">${escape(h.language)}</span>`,
          `<span class="muted">${escape(h.chunk_type)}</span>`,
          `<span class="score">${h.score.toFixed(3)}</span>`,
        ]
          .filter(Boolean)
          .join('');
        return `
          <li>
            <div class="meta">
              <span class="file">${escape(h.project)} · ${escape(h.file_path)}:${h.start_line}-${h.end_line}</span>
              ${tags}
            </div>
            <pre>${escape(h.content)}</pre>
          </li>
        `;
      })
      .join('');
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
  }
});

// ----- health view ----------------------------------------------------------

async function renderHealth() {
  const grid = $('health-grid');
  const dump = $('health-dump');
  grid.innerHTML = '<div class="muted">Probing…</div>';
  try {
    const h = await api('/api/health');
    const card = (label, ok, value, note) => `
      <div class="health-card">
        <div class="label">${escape(label)}</div>
        <div class="value">
          <span class="dot ${ok ? 'ok' : 'bad'}"></span>
          <span>${escape(value)}</span>
        </div>
        ${note ? `<div class="note">${escape(note)}</div>` : ''}
      </div>
    `;
    grid.innerHTML = [
      card(
        'Weaviate HTTP',
        h.weaviate.http,
        h.weaviate.http ? 'reachable' : 'unreachable',
        h.weaviate.error,
      ),
      card('Weaviate gRPC', h.weaviate.grpc, h.weaviate.grpc ? 'reachable' : 'unreachable'),
      card(
        'Embedder',
        h.embedder.reachable,
        h.embedder.reachable ? 'text2vec-transformers loaded' : 'module not loaded',
        h.embedder.error,
      ),
      card(
        'Reranker',
        h.reranker.reachable || !h.reranker.enabled,
        h.reranker.reachable
          ? `loaded (${h.reranker.enabled ? 'used' : 'disabled in config'})`
          : h.reranker.enabled
            ? 'module not loaded'
            : 'disabled in config',
      ),
      card(
        'Ingest state',
        h.state.exists,
        h.state.exists
          ? `${h.state.projects.length} projects, ${h.state.files.length} files`
          : 'not yet created',
        h.state.path,
      ),
    ].join('');
    dump.textContent = JSON.stringify(h, null, 2);
  } catch (err) {
    grid.innerHTML = `<div class="muted">Error: ${escape(err.message)}</div>`;
  }
}

// ----- config view ----------------------------------------------------------

let configState = null;

/** Render the Config view's heading/lead/button label for the given state.
 *  Called from loadConfig() and from the save handler so the two stay in
 *  sync. Crucially, we never put id'd elements inside the rewritten innerHTML
 *  — earlier versions did and the resulting null `getElementById('config-path')`
 *  crashed on the next loadConfig. */
function renderConfigViewState(path, exists) {
  const title = $('config-title');
  const lead = $('config-lead');
  const saveLabel = $('config-save-label');
  if (exists) {
    title.textContent = 'Config';
    lead.innerHTML =
      'Editing <code>' +
      escape(path) +
      '</code>. Saved changes take effect on the next <code>ragolith-ingest</code> / <code>ragolith-server</code> run.';
    saveLabel.textContent = 'Save';
  } else {
    title.textContent = 'Welcome — let’s set up ragolith';
    lead.innerHTML =
      'No config file on disk yet. Fill in the form below and click ' +
      '<strong>Create config</strong> to write <code>' +
      escape(path) +
      '</code>. After that you can run <code>ragolith-ingest</code> to populate the index.';
    saveLabel.textContent = 'Create config';
  }
}

async function loadConfig() {
  const status = $('config-status');
  status.textContent = 'Loading…';
  status.className = 'status';
  try {
    const { path, config, exists } = await api('/api/config');
    configState = config;
    configExists = exists;
    configPathCached = path;
    fillForm(config);
    $('cfg-raw').value = JSON.stringify(config, null, 2);
    renderConfigViewState(path, exists);
    status.textContent = '';
    status.className = 'status';
    applySetupBanner();
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    status.className = 'status err';
  }
}

let configPathCached = '';

function fillForm(cfg) {
  $('cfg-weaviate-host').value = cfg.weaviate?.host ?? 'localhost';
  $('cfg-weaviate-http').value = cfg.weaviate?.httpPort ?? 8080;
  $('cfg-weaviate-grpc').value = cfg.weaviate?.grpcPort ?? 50051;
  $('cfg-weaviate-secure').checked = !!cfg.weaviate?.secure;
  $('cfg-search-reranker').checked = cfg.search?.rerankerEnabled !== false;
  renderProjectsList(cfg.projects || []);
  renderFilesList(cfg.files || []);
}

function renderProjectsList(items) {
  const list = $('cfg-projects-list');
  list.innerHTML = '';
  if (items.length === 0) {
    list.innerHTML = '<div class="muted small">No projects yet — click "+ Add project".</div>';
    return;
  }
  items.forEach((p, idx) => {
    const div = document.createElement('div');
    div.className = 'item';
    div.dataset.idx = String(idx);
    div.innerHTML = `
      <div class="item-head">
        <h3>project ${idx + 1}</h3>
        <button type="button" class="btn btn-danger" data-remove-project="${idx}">Remove</button>
      </div>
      <div class="grid grid-2">
        <label><span>Name</span><input type="text" data-project-field="name" value="${escape(p.name ?? '')}" /></label>
        <label><span>Branch</span><input type="text" data-project-field="branch" value="${escape(p.branch ?? '')}" placeholder="main" /></label>
        <label><span>Git URL</span><input type="text" data-project-field="repo" value="${escape(p.repo ?? '')}" placeholder="https://github.com/…" /></label>
        <label><span>Local path</span><input type="text" data-project-field="localPath" value="${escape(p.localPath ?? '')}" placeholder="/abs/path (overrides Git URL)" /></label>
        <label><span>Sub-paths (comma-separated)</span><input type="text" data-project-field="subPaths" value="${escape((p.subPaths ?? []).join(', '))}" placeholder="src, docs" /></label>
        <label><span>Token env var</span><input type="text" data-project-field="tokenEnv" value="${escape(p.tokenEnv ?? '')}" placeholder="GIT_TOKEN" /></label>
      </div>
    `;
    list.appendChild(div);
  });
}

function renderFilesList(items) {
  const list = $('cfg-files-list');
  list.innerHTML = '';
  if (items.length === 0) {
    list.innerHTML = '<div class="muted small">No standalone files — click "+ Add file".</div>';
    return;
  }
  items.forEach((f, idx) => {
    const div = document.createElement('div');
    div.className = 'item';
    div.dataset.idx = String(idx);
    div.innerHTML = `
      <div class="item-head">
        <h3>file ${idx + 1}</h3>
        <button type="button" class="btn btn-danger" data-remove-file="${idx}">Remove</button>
      </div>
      <div class="grid grid-2">
        <label><span>Name</span><input type="text" data-file-field="name" value="${escape(f.name ?? '')}" /></label>
        <label><span>Absolute path</span><input type="text" data-file-field="path" value="${escape(f.path ?? '')}" placeholder="/abs/path/to/spec.pdf" /></label>
      </div>
    `;
    list.appendChild(div);
  });
}

function collectFormToConfig() {
  // Start from the last-loaded config so we preserve fields the form doesn't
  // touch (ingest.workDir, ingest.extensions, backup, etc.).
  const base = configState ? JSON.parse(JSON.stringify(configState)) : {};
  base.weaviate = base.weaviate || {};
  base.weaviate.host = $('cfg-weaviate-host').value.trim() || 'localhost';
  base.weaviate.httpPort = Number($('cfg-weaviate-http').value) || 8080;
  base.weaviate.grpcPort = Number($('cfg-weaviate-grpc').value) || 50051;
  base.weaviate.secure = $('cfg-weaviate-secure').checked;
  base.search = base.search || { overFetch: 2, diversityPerFile: 3 };
  base.search.rerankerEnabled = $('cfg-search-reranker').checked;

  // Projects: collect every .item child of #cfg-projects-list.
  base.projects = [];
  for (const el of document.querySelectorAll('#cfg-projects-list .item')) {
    const p = {};
    for (const input of el.querySelectorAll('[data-project-field]')) {
      const field = input.dataset.projectField;
      const v = input.value.trim();
      if (!v) continue;
      if (field === 'subPaths') {
        p.subPaths = v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      } else {
        p[field] = v;
      }
    }
    if (p.name) base.projects.push(p);
  }

  base.files = [];
  for (const el of document.querySelectorAll('#cfg-files-list .item')) {
    const f = {};
    for (const input of el.querySelectorAll('[data-file-field]')) {
      const field = input.dataset.fileField;
      const v = input.value.trim();
      if (v) f[field] = v;
    }
    if (f.name && f.path) base.files.push(f);
  }

  return base;
}

// Tab switching between Form and Raw JSON.
document.querySelectorAll('.config-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.configTab;
    document
      .querySelectorAll('.config-tab')
      .forEach((b) => b.classList.toggle('active', b === btn));
    $('config-form').classList.toggle('active', target === 'form');
    $('config-json').classList.toggle('active', target === 'json');
    // Sync form → JSON when leaving the form, JSON → form when leaving JSON.
    if (target === 'json') {
      const built = collectFormToConfig();
      $('cfg-raw').value = JSON.stringify(built, null, 2);
    } else {
      try {
        const parsed = JSON.parse($('cfg-raw').value);
        configState = parsed;
        fillForm(parsed);
      } catch {
        // Leave form alone if JSON is invalid; user can fix it and switch back.
      }
    }
  });
});

$('cfg-add-project').addEventListener('click', () => {
  const cur = collectFormToConfig();
  cur.projects = cur.projects || [];
  cur.projects.push({ name: '', branch: 'main' });
  configState = cur;
  renderProjectsList(cur.projects);
});

$('cfg-add-file').addEventListener('click', () => {
  const cur = collectFormToConfig();
  cur.files = cur.files || [];
  cur.files.push({ name: '', path: '' });
  configState = cur;
  renderFilesList(cur.files);
});

document.addEventListener('click', (e) => {
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.matches('[data-remove-project]')) {
    const idx = Number(target.getAttribute('data-remove-project'));
    const cur = collectFormToConfig();
    cur.projects.splice(idx, 1);
    configState = cur;
    renderProjectsList(cur.projects);
  } else if (target.matches('[data-remove-file]')) {
    const idx = Number(target.getAttribute('data-remove-file'));
    const cur = collectFormToConfig();
    cur.files.splice(idx, 1);
    configState = cur;
    renderFilesList(cur.files);
  }
});

$('config-reload').addEventListener('click', () => {
  loadConfig();
});

$('config-save').addEventListener('click', async () => {
  const status = $('config-status');
  status.className = 'status';
  status.textContent = 'Saving…';
  // Decide which pane is authoritative — JSON if it's visible.
  let next;
  if ($('config-json').classList.contains('active')) {
    try {
      next = JSON.parse($('cfg-raw').value);
    } catch (err) {
      status.textContent = `Invalid JSON: ${err.message}`;
      status.className = 'status err';
      return;
    }
  } else {
    next = collectFormToConfig();
  }
  try {
    const r = await api('/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(next),
    });
    configState = next;
    const wasNew = configExists === false;
    configExists = true;
    configPathCached = r.path;
    status.textContent = wasNew ? `Created · ${r.path}` : `Saved · ${r.path}`;
    status.className = 'status ok';
    // File exists now — flip heading/lead/button label to editing tone and
    // dismiss the global banner on other views.
    renderConfigViewState(r.path, true);
    applySetupBanner();
  } catch (err) {
    status.textContent = `Save failed: ${err.message}`;
    status.className = 'status err';
  }
});
