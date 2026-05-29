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

const VIEWS = [
  'projects',
  'search',
  'sdlc',
  'analysis',
  'project',
  'ingest',
  'backup',
  'config',
  'health',
];

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
  if (hash === 'sdlc') {
    showView('sdlc');
    return;
  }
  if (hash === 'analysis') {
    showView('analysis');
    await ensureAnalysisProjectFilter();
    return;
  }
  if (hash === 'ingest') {
    showView('ingest');
    await enterIngestView();
    return;
  }
  if (hash === 'backup') {
    showView('backup');
    await enterBackupView();
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
  body.innerHTML = '<tr><td colspan="7" class="muted">Loading…</td></tr>';
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
        // Stash chunk_count on the row so the delete confirm can surface it
        // without re-fetching. data-* attributes survive innerHTML rendering.
        return `
          <tr data-project-name="${escape(p.name)}" data-chunk-count="${p.chunk_count}">
            <td>
              <a href="#project/${encodeURIComponent(p.name)}">${escape(p.name)}</a>
              <span class="muted small"> · ${escape(p.source)}</span>
            </td>
            <td class="num">${p.file_count}</td>
            <td class="num">${p.chunk_count}</td>
            <td>${langs || '<span class="muted">—</span>'}</td>
            <td><code>${escape(sha)}</code></td>
            <td class="muted small">${escape(fmtDate(p.updated_at))}</td>
            <td class="num row-actions">
              <button type="button" class="btn btn-ghost btn-sm" data-action="reindex">
                Re-index
              </button>
              <button type="button" class="btn btn-ghost btn-sm" data-action="delete">
                Delete
              </button>
            </td>
          </tr>
        `;
      })
      .join('');
  } catch (err) {
    body.innerHTML = `<tr><td colspan="7" class="muted">Error: ${escape(err.message)}</td></tr>`;
  }
}

// Event delegation — one listener on tbody handles every row's buttons. Means
// we don't need to re-bind after each re-render.
$('projects-body').addEventListener('click', (ev) => {
  const btn = ev.target.closest?.('button[data-action]');
  if (!btn) return;
  const tr = btn.closest('tr');
  const name = tr?.dataset.projectName;
  if (!name) return;
  if (btn.dataset.action === 'reindex') {
    void requestRowReindex(name);
  } else if (btn.dataset.action === 'delete') {
    const chunkCount = Number(tr.dataset.chunkCount ?? 0);
    void requestRowDelete(name, chunkCount);
  }
});

async function requestRowReindex(name) {
  if (
    !confirmDestructive(
      `Re-index "${name}"?\n\n` +
        'Changed files will be re-chunked and re-embedded.\n\n' +
        'Continue?',
    )
  ) {
    return;
  }
  try {
    await api('/api/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: name }),
    });
    // Drop the user onto the Ingest view so the live log is immediately visible.
    window.location.hash = '#ingest';
  } catch (err) {
    window.alert(`Failed to start ingest for "${name}": ${err.message}`);
  }
}

async function requestRowDelete(name, chunkCount) {
  const chunkPart = chunkCount > 0 ? `${chunkCount} chunk${chunkCount === 1 ? '' : 's'}` : 'chunks';
  if (
    !confirmDestructive(
      `Delete project "${name}"?\n\n` +
        `This drops ${chunkPart} from Weaviate. ` +
        `If "${name}" is still listed in ragc.config.json, the next ` +
        `ragolith-ingest will re-add it from scratch (use the Config view to remove it ` +
        `permanently). The git checkout on disk is not touched.\n\n` +
        'Continue?',
    )
  ) {
    return;
  }
  try {
    const result = await api(`/api/projects/${encodeURIComponent(name)}`, { method: 'DELETE' });
    // Refresh the table so the row disappears (or shrinks to empty languages).
    await renderProjects();
    if (typeof result?.deletedChunks === 'number') {
      // Brief affirmation; alert is loud but unambiguous.
      window.alert(
        `Deleted ${result.deletedChunks} of ${result.matchedChunks} chunks for "${name}".`,
      );
    }
  } catch (err) {
    window.alert(`Failed to delete "${name}": ${err.message}`);
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

// ----- SDLC view ------------------------------------------------------------

$('sdlc-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const query = $('sdlc-input').value.trim();
  const kind = $('sdlc-kind').value;
  if (!query) return;
  const list = $('sdlc-results');
  const status = $('sdlc-status');
  list.innerHTML = '';
  status.textContent = 'Searching…';
  try {
    const body = { query, limit: 20 };
    if (kind) body.kind = kind;
    const hits = await api('/api/sdlc/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (hits.length === 0) {
      status.textContent = `No artifacts match "${query}"`;
      return;
    }
    status.textContent = `${hits.length} artifact${hits.length === 1 ? '' : 's'} for "${query}"`;
    list.innerHTML = hits
      .map((h) => {
        const tags = [
          `<span class="lang-pill">${escape(h.kind)}</span>`,
          h.status ? `<span class="muted">${escape(h.status)}</span>` : '',
          `<span class="muted small">${escape(h.project)} · ${escape(h.source)}</span>`,
          `<span class="score">${h.score.toFixed(3)}</span>`,
        ]
          .filter(Boolean)
          .join('');
        return `
          <li>
            <div class="meta">
              <span class="file"><code>${escape(h.artifact_id)}</code> ${escape(h.title)}</span>
              ${tags}
            </div>
            <pre>${escape(h.excerpt)}</pre>
          </li>
        `;
      })
      .join('');
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
  }
});

// ----- Analysis view --------------------------------------------------------

let analysisProjectFilled = false;
async function ensureAnalysisProjectFilter() {
  if (analysisProjectFilled) return;
  try {
    const projects = await api('/api/projects');
    const sel = $('analysis-project');
    for (const p of projects) {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.name;
      sel.appendChild(opt);
    }
    analysisProjectFilled = true;
  } catch {
    // empty filter is fine
  }
}

const SEV_CLASS = { high: 'badge-failed', warning: 'badge-running', info: 'badge-idle' };

function sevBadge(sev) {
  const cls = SEV_CLASS[sev] ?? 'badge-idle';
  return `<span class="badge ${cls}">${escape(sev)}</span>`;
}

$('analysis-run-gaps').addEventListener('click', async () => {
  const out = $('analysis-gaps-out');
  const project = $('analysis-project').value;
  out.innerHTML = '<span class="muted small">Analyzing…</span>';
  try {
    const r = await api(
      '/api/analysis/gaps' + (project ? `?project=${encodeURIComponent(project)}` : ''),
    );
    if (r.gaps.length === 0) {
      out.innerHTML = `<span class="ok-text">No gaps found across ${r.totals.artifacts} artifacts.</span>`;
      return;
    }
    const c = r.counts;
    const summary = `<p class="muted small">${c.unimplemented_requirement} unimplemented · ${c.untested_requirement} untested · ${c.unimplemented_decision} unbuilt decision · ${c.orphan_test} orphan test · ${c.dangling_link} dangling — over ${r.totals.artifacts} artifacts</p>`;
    const rows = r.gaps
      .map(
        (g) => `
          <tr>
            <td>${sevBadge(g.severity)}</td>
            <td>${escape(g.kind.replace(/_/g, ' '))}</td>
            <td><code>${escape(g.artifact_id)}</code> ${escape(g.title)}<div class="muted small">${escape(g.detail)}</div></td>
          </tr>`,
      )
      .join('');
    out.innerHTML = summary + `<table class="analysis-table"><tbody>${rows}</tbody></table>`;
  } catch (err) {
    out.innerHTML = `<span class="err-text">Error: ${escape(err.message)}</span>`;
  }
});

$('analysis-run-mod').addEventListener('click', async () => {
  const out = $('analysis-mod-out');
  const project = $('analysis-project').value;
  out.innerHTML = '<span class="muted small">Analyzing…</span>';
  try {
    const reports = await api(
      '/api/analysis/modernization' + (project ? `?project=${encodeURIComponent(project)}` : ''),
    );
    const withFindings = reports.filter((r) => r.findings.length > 0);
    if (withFindings.length === 0) {
      out.innerHTML = `<span class="ok-text">No modernization findings across ${reports.length} project(s).</span>`;
      return;
    }
    out.innerHTML = withFindings
      .map((r) => {
        const rows = r.findings
          .map(
            (f) => `
              <tr>
                <td>${sevBadge(f.severity)}</td>
                <td><code>${escape(f.subject)}</code> ${escape(f.version)}</td>
                <td>${escape(f.finding)}<div class="muted small">→ ${escape(f.recommendation)}</div></td>
              </tr>`,
          )
          .join('');
        return `<h3 class="analysis-sub">${escape(r.project)}</h3><table class="analysis-table"><tbody>${rows}</tbody></table>`;
      })
      .join('');
  } catch (err) {
    out.innerHTML = `<span class="err-text">Error: ${escape(err.message)}</span>`;
  }
});

$('analysis-run-dec').addEventListener('click', async () => {
  const out = $('analysis-dec-out');
  const project = $('analysis-project').value;
  if (!project) {
    out.innerHTML =
      '<span class="err-text">Pick a project first — decomposition is per-project.</span>';
    return;
  }
  out.innerHTML = '<span class="muted small">Analyzing…</span>';
  try {
    const r = await api(`/api/analysis/decomposition?project=${encodeURIComponent(project)}`);
    if (r.error) {
      out.innerHTML = `<span class="err-text">${escape(r.error)}</span>`;
      return;
    }
    const moduleRows = r.modules
      .slice(0, 25)
      .map(
        (m) => `
          <tr>
            <td><code>${escape(m.module)}</code></td>
            <td class="num">${m.files}</td>
            <td class="num">${m.cohesion.toFixed(2)}</td>
            <td class="num">${m.instability.toFixed(2)}</td>
            <td class="num">${m.fanIn}</td>
            <td class="num">${m.fanOut}</td>
          </tr>`,
      )
      .join('');
    const seams =
      r.seams.length > 0
        ? '<h3 class="analysis-sub">Suggested seams</h3><ul class="seam-list">' +
          r.seams
            .map(
              (s) =>
                `<li>◆ <code>${escape(s.module)}</code> <span class="muted small">(${s.files} files) — ${escape(s.rationale)}</span></li>`,
            )
            .join('') +
          '</ul>'
        : '<p class="muted small">No clear seams — modules are too small or too coupled.</p>';
    const couplings =
      r.couplings.length > 0
        ? '<h3 class="analysis-sub">Tightest couplings</h3><ul class="seam-list">' +
          r.couplings
            .slice(0, 8)
            .map(
              (c) =>
                `<li><span class="score">${c.calls}</span> calls — <code>${escape(c.a)}</code> ↔ <code>${escape(c.b)}</code></li>`,
            )
            .join('') +
          '</ul>'
        : '';
    out.innerHTML =
      `<p class="muted small">${r.totals.modules} modules · ${r.totals.crossModuleCalls} cross-module calls · ${r.seams.length} seam(s)</p>` +
      '<table class="analysis-table"><thead><tr><th>module</th><th class="num">files</th><th class="num">cohesion</th><th class="num">instability</th><th class="num">fanIn</th><th class="num">fanOut</th></tr></thead><tbody>' +
      moduleRows +
      '</tbody></table>' +
      seams +
      couplings;
  } catch (err) {
    out.innerHTML = `<span class="err-text">Error: ${escape(err.message)}</span>`;
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
        'Config file',
        h.config?.exists ?? false,
        h.config?.exists ? 'ragc.config.json present' : 'ragc.config.json missing',
        h.config?.path ?? '',
      ),
      card(
        'Ingest state',
        h.state.exists,
        h.state.exists
          ? `${h.state.projects.length} projects, ${h.state.files.length} files`
          : 'not yet created — run ragolith-ingest',
        // Make it explicit this is the runtime artifact, not the config file.
        h.state.path + '  ·  runtime artifact, written by ragolith-ingest',
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

// ----- shared jobs stream --------------------------------------------------
//
// One EventSource feeds both the Ingest and Backup views. Each view registers
// a listener that filters by `payload.kind` so logs don't bleed across views.
// Only one job runs at a time on the backend, so this also keeps the UI
// honest: if backup is running, the ingest buttons stay disabled too.

let jobsStream = null;
const jobListeners = new Set();

function attachJobsStream() {
  if (jobsStream) return; // singleton — kept open for the page's lifetime
  const es = new EventSource('/api/jobs/stream');
  jobsStream = es;
  es.onmessage = (ev) => {
    let payload;
    try {
      payload = JSON.parse(ev.data);
    } catch {
      return;
    }
    for (const fn of jobListeners) {
      try {
        fn(payload);
      } catch {
        // never let one view break another
      }
    }
  };
  es.onerror = () => {
    // EventSource auto-reconnects; the server replays buffered state on the
    // new connection so no manual recovery needed.
  };
}

function listenJobs(fn) {
  attachJobsStream();
  jobListeners.add(fn);
  return () => jobListeners.delete(fn);
}

function setBadge(id, state) {
  const badge = $(id);
  if (!badge) return;
  badge.className = 'badge badge-' + state;
  badge.textContent = state;
}

function setControlsDisabled(ids, disabled) {
  for (const id of ids) {
    const el = $(id);
    if (el) el.disabled = disabled;
  }
}

function appendLogLine(logId, line) {
  const log = $(logId);
  if (!log) return;
  // Auto-scroll only if the user is at the bottom — preserve manual scroll
  // position if they're inspecting earlier output.
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
  log.textContent += (log.textContent.length ? '\n' : '') + line;
  if (atBottom) log.scrollTop = log.scrollHeight;
}

// ----- ingest view ---------------------------------------------------------

let ingestProjectsFilled = false;
let ingestListenerAttached = false;

const INGEST_CONTROL_IDS = [
  'ingest-run-all',
  'ingest-run-project',
  'ingest-migrate',
  'ingest-full',
  'ingest-project-pick',
];

function setIngestStatus(state) {
  setBadge('ingest-status-badge', state);
}

function setIngestRunningUI(running) {
  setControlsDisabled(INGEST_CONTROL_IDS, running);
}

function appendIngestLine(line) {
  appendLogLine('ingest-log', line);
}

function attachIngestListener() {
  if (ingestListenerAttached) return;
  ingestListenerAttached = true;
  listenJobs((payload) => {
    if (payload.kind !== 'ingest') return;
    if (payload.type === 'start') {
      $('ingest-log').textContent = '';
      setIngestStatus('running');
      setIngestRunningUI(true);
    } else if (payload.type === 'log') {
      appendIngestLine(payload.line ?? '');
    } else if (payload.type === 'exit') {
      const code = payload.code;
      setIngestStatus(code === 0 ? 'success' : 'failed');
      setIngestRunningUI(false);
      appendIngestLine(`\n— exited with code ${code} —`);
    }
  });
}

async function fillIngestProjects() {
  if (ingestProjectsFilled) return;
  try {
    const projects = await api('/api/projects');
    const sel = $('ingest-project-pick');
    for (const p of projects) {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.name;
      sel.appendChild(opt);
    }
    ingestProjectsFilled = true;
  } catch {
    // If projects fail to load (Weaviate down) the dropdown stays empty —
    // the user can still click 'Index everything' which goes via config.
  }
}

async function reflectActiveJob(kindBadgeSetter, kindRunningSetter, kindWanted) {
  try {
    const active = await api('/api/jobs/active');
    if (active && active.id && active.kind === kindWanted) {
      kindBadgeSetter(active.status);
      kindRunningSetter(active.status === 'running');
    } else {
      kindBadgeSetter('idle');
      kindRunningSetter(false);
    }
  } catch {
    kindBadgeSetter('idle');
    kindRunningSetter(false);
  }
}

async function enterIngestView() {
  await fillIngestProjects();
  attachIngestListener();
  await reflectActiveJob(setIngestStatus, setIngestRunningUI, 'ingest');
}

async function runIngest(opts) {
  try {
    // Pre-flip state — the stream will reconfirm it, but this gives instant
    // feedback while the POST is in flight.
    setIngestStatus('running');
    setIngestRunningUI(true);
    $('ingest-log').textContent = '';
    await api('/api/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(opts),
    });
  } catch (err) {
    appendIngestLine(`Error: ${err.message}`);
    setIngestStatus('failed');
    setIngestRunningUI(false);
  }
}

// We gate the genuinely destructive / long-running buttons (full rebuild,
// per-project re-index, restore) behind window.confirm. The native dialog is
// universally recognized as "are you sure?", keyboard-friendly out of the box,
// and doesn't pollute the DOM with custom modal markup. Cheaper-to-undo
// actions (incremental Index everything, migrate-only, verify, create, push,
// pull) stay click-and-go to keep daily use frictionless.
function confirmDestructive(message) {
  return window.confirm(message);
}

$('ingest-run-all').addEventListener('click', () => {
  const full = $('ingest-full').checked;
  if (full) {
    if (
      !confirmDestructive(
        'Force full rebuild will DELETE every existing chunk and re-process every ' +
          'file in every project from scratch.\n\n' +
          'On large repos this can take many minutes (and your index will be ' +
          'partially empty while it runs).\n\n' +
          'Continue with the full rebuild?',
      )
    ) {
      return;
    }
  }
  runIngest({ full });
});

$('ingest-run-project').addEventListener('click', () => {
  const name = $('ingest-project-pick').value;
  if (!name) {
    appendIngestLine('Pick a project from the dropdown first.');
    return;
  }
  const full = $('ingest-full').checked;
  const lead = full
    ? `Re-index "${name}" with FORCE FULL REBUILD?\n\nEvery existing chunk for "${name}" will be deleted and re-processed from scratch.`
    : `Re-index "${name}"?\n\nChanged files will be re-chunked and re-embedded.`;
  if (!confirmDestructive(`${lead}\n\nContinue?`)) return;
  runIngest({ project: name, full });
});

// Migrate-only just bumps the schema-version row — no chunks touched, no
// rebuild — so it stays click-and-go.
$('ingest-migrate').addEventListener('click', () => {
  runIngest({ migrateOnly: true });
});

// ----- backup view ---------------------------------------------------------

let backupListenerAttached = false;

const BACKUP_CONTROL_IDS = [
  'backup-create',
  'backup-restore',
  'backup-verify',
  'backup-push',
  'backup-pull',
  'backup-create-id',
  'backup-create-push',
  'backup-restore-id',
  'backup-restore-pull',
  'backup-verify-keep',
  'backup-s3-id',
];

function setBackupStatus(state) {
  setBadge('backup-status-badge', state);
}

function setBackupRunningUI(running) {
  setControlsDisabled(BACKUP_CONTROL_IDS, running);
}

function appendBackupLine(line) {
  appendLogLine('backup-log', line);
}

function attachBackupListener() {
  if (backupListenerAttached) return;
  backupListenerAttached = true;
  listenJobs((payload) => {
    if (payload.kind !== 'backup') return;
    if (payload.type === 'start') {
      $('backup-log').textContent = '';
      setBackupStatus('running');
      setBackupRunningUI(true);
    } else if (payload.type === 'log') {
      appendBackupLine(payload.line ?? '');
    } else if (payload.type === 'exit') {
      const code = payload.code;
      setBackupStatus(code === 0 ? 'success' : 'failed');
      setBackupRunningUI(false);
      appendBackupLine(`\n— exited with code ${code} —`);
    }
  });
}

async function enterBackupView() {
  attachBackupListener();
  await reflectActiveJob(setBackupStatus, setBackupRunningUI, 'backup');
  prefillSnapshotIdIfEmpty();
  await loadSnapshotList();
}

/**
 * Pick a default id for the create-snapshot input so the user can just hit
 * the button. Only sets the value if the user hasn't typed something.
 *
 * Weaviate is strict about backup ids: `[a-z0-9_-]+` only — no dots, no
 * uppercase, no colons. We lowercase the ISO stamp and replace `T`/`:` with
 * dashes to satisfy that.
 *
 * Example: snapshot-2026-05-28-14-30-22
 */
function prefillSnapshotIdIfEmpty() {
  const input = $('backup-create-id');
  if (!input || input.value.trim() !== '') return;
  // toISOString → "2026-05-28T14:30:22.123Z". Strip ms+Z, replace T and colons.
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-').toLowerCase();
  input.value = `snapshot-${stamp}`;
}

function fmtSnapshotTime(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

async function loadSnapshotList() {
  const body = $('backup-list-body');
  const table = $('backup-table');
  const empty = $('backup-empty');
  if (!body || !table || !empty) return;
  try {
    const data = await api('/api/backups');
    const snapshots = Array.isArray(data?.snapshots) ? data.snapshots : [];
    if (snapshots.length === 0) {
      table.hidden = true;
      empty.hidden = false;
      body.innerHTML = '';
      return;
    }
    table.hidden = false;
    empty.hidden = true;
    body.innerHTML = '';
    for (const s of snapshots) {
      const tr = document.createElement('tr');
      tr.dataset.snapshotId = s.id;

      const idCell = document.createElement('td');
      const code = document.createElement('code');
      code.textContent = s.id;
      idCell.appendChild(code);

      const statusCell = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = 'badge badge-' + (s.status === 'success' ? 'success' : 'failed');
      badge.textContent = s.status;
      statusCell.appendChild(badge);

      const createdCell = document.createElement('td');
      createdCell.className = 'muted small';
      createdCell.textContent = fmtSnapshotTime(s.createdAt);

      const s3Cell = document.createElement('td');
      s3Cell.textContent = s.pushedToS3 ? '✓' : '';
      s3Cell.className = 'muted small';

      const actionsCell = document.createElement('td');
      actionsCell.className = 'num';
      const restoreBtn = document.createElement('button');
      restoreBtn.type = 'button';
      restoreBtn.className = 'btn btn-ghost btn-sm';
      restoreBtn.textContent = 'Restore';
      restoreBtn.addEventListener('click', () => triggerRowRestore(s.id));
      actionsCell.appendChild(restoreBtn);

      if (!s.pushedToS3) {
        const pushBtn = document.createElement('button');
        pushBtn.type = 'button';
        pushBtn.className = 'btn btn-ghost btn-sm';
        pushBtn.textContent = 'Push to S3';
        pushBtn.style.marginLeft = '6px';
        pushBtn.addEventListener('click', () => triggerRowPush(s.id));
        actionsCell.appendChild(pushBtn);
      }

      tr.appendChild(idCell);
      tr.appendChild(statusCell);
      tr.appendChild(createdCell);
      tr.appendChild(s3Cell);
      tr.appendChild(actionsCell);
      body.appendChild(tr);
    }
  } catch (err) {
    table.hidden = true;
    empty.hidden = false;
    empty.textContent = `Couldn't load snapshot list: ${err.message}`;
  }
}

function triggerRowRestore(id) {
  // Fill the Restore-by-id input so the confirm dialog and the request agree
  // on what we're restoring, then go through the same handler everyone else
  // does (which contains the confirm prompt).
  $('backup-restore-id').value = id;
  $('backup-restore-pull').checked = false;
  $('backup-restore').click();
}

function triggerRowPush(id) {
  $('backup-s3-id').value = id;
  $('backup-push').click();
}

// Refresh the snapshot list whenever a backup job finishes. We track the
// active job's args via the `start` event so the `exit` handler can tell
// whether to also reset the create-id field (so prefill picks a new
// timestamp next time the view is entered).
let lastBackupArgs = null;
listenJobs((payload) => {
  if (payload.kind !== 'backup') return;
  if (payload.type === 'start') {
    lastBackupArgs = payload.job?.args ?? null;
  } else if (payload.type === 'exit') {
    // small debounce so the registry's atomic write definitely lands first
    setTimeout(() => {
      void loadSnapshotList();
      if (
        payload.code === 0 &&
        Array.isArray(lastBackupArgs) &&
        lastBackupArgs.some((a) => a === 'create')
      ) {
        const input = $('backup-create-id');
        if (input) input.value = '';
        prefillSnapshotIdIfEmpty();
      }
      lastBackupArgs = null;
    }, 150);
  }
});

async function runBackup(opts) {
  try {
    setBackupStatus('running');
    setBackupRunningUI(true);
    $('backup-log').textContent = '';
    await api('/api/backup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(opts),
    });
  } catch (err) {
    appendBackupLine(`Error: ${err.message}`);
    setBackupStatus('failed');
    setBackupRunningUI(false);
  }
}

function readBackupId(inputId, label) {
  const el = $(inputId);
  const id = (el?.value ?? '').trim();
  if (!id) {
    appendBackupLine(`Enter a snapshot id for ${label}.`);
    return null;
  }
  return id;
}

$('backup-create').addEventListener('click', () => {
  const id = readBackupId('backup-create-id', 'create');
  if (!id) return;
  runBackup({ command: 'create', id, pushS3: $('backup-create-push').checked });
});

$('backup-restore').addEventListener('click', () => {
  const id = readBackupId('backup-restore-id', 'restore');
  if (!id) return;
  const pullS3 = $('backup-restore-pull').checked;
  const lead = pullS3
    ? `Pull "${id}" from S3 and restore it onto this Weaviate.`
    : `Restore "${id}" onto this Weaviate.`;
  if (
    !confirmDestructive(
      `${lead}\n\n` +
        'Weaviate refuses to restore on top of existing collections — so the restore ' +
        'will fail unless those collections have been dropped first. If it does land, ' +
        'it REPLACES your current index with the snapshot.\n\n' +
        'Continue?',
    )
  ) {
    return;
  }
  runBackup({ command: 'restore', id, pullS3 });
});

$('backup-verify').addEventListener('click', () => {
  runBackup({ command: 'verify', keep: $('backup-verify-keep').checked });
});

$('backup-push').addEventListener('click', () => {
  const id = readBackupId('backup-s3-id', 'push');
  if (!id) return;
  runBackup({ command: 'push', id });
});

$('backup-pull').addEventListener('click', () => {
  const id = readBackupId('backup-s3-id', 'pull');
  if (!id) return;
  runBackup({ command: 'pull', id });
});

$('backup-refresh').addEventListener('click', () => {
  void loadSnapshotList();
});

function fillForm(cfg) {
  $('cfg-weaviate-host').value = cfg.weaviate?.host ?? 'localhost';
  $('cfg-weaviate-http').value = cfg.weaviate?.httpPort ?? 8080;
  $('cfg-weaviate-grpc').value = cfg.weaviate?.grpcPort ?? 50051;
  $('cfg-weaviate-secure').checked = !!cfg.weaviate?.secure;
  $('cfg-search-reranker').checked = cfg.search?.rerankerEnabled !== false;
  // Accept legacy keys so an existing ragc.config.json renders correctly
  // until the user saves (which writes the canonical names back).
  renderProjectsList(cfg.repos ?? cfg.projects ?? []);
  renderFilesList(cfg.documents ?? cfg.files ?? []);
}

function renderProjectsList(items) {
  const list = $('cfg-projects-list');
  list.innerHTML = '';
  if (items.length === 0) {
    list.innerHTML = '<div class="muted small">No repositories yet — click "+ Add repo".</div>';
    return;
  }
  items.forEach((p, idx) => {
    const div = document.createElement('div');
    div.className = 'item';
    div.dataset.idx = String(idx);
    div.innerHTML = `
      <div class="item-head">
        <h3>repo ${idx + 1}</h3>
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
    list.innerHTML = '<div class="muted small">No documents — click "+ Add document".</div>';
    return;
  }
  items.forEach((f, idx) => {
    const div = document.createElement('div');
    div.className = 'item';
    div.dataset.idx = String(idx);
    div.innerHTML = `
      <div class="item-head">
        <h3>document ${idx + 1}</h3>
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

  // Drop any legacy keys from `base` so the saved file ends up canonical.
  delete base.projects;
  delete base.files;

  // Repos: collect every .item child of #cfg-projects-list. The selector +
  // data-project-field attribute names are internal DOM ids that we keep for
  // minimal churn — the JSON we *emit* uses the new canonical key.
  base.repos = [];
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
    if (p.name) base.repos.push(p);
  }

  base.documents = [];
  for (const el of document.querySelectorAll('#cfg-files-list .item')) {
    const f = {};
    for (const input of el.querySelectorAll('[data-file-field]')) {
      const field = input.dataset.fileField;
      const v = input.value.trim();
      if (v) f[field] = v;
    }
    if (f.name && f.path) base.documents.push(f);
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
  cur.repos = cur.repos || [];
  cur.repos.push({ name: '', branch: 'main' });
  configState = cur;
  renderProjectsList(cur.repos);
});

$('cfg-add-file').addEventListener('click', () => {
  const cur = collectFormToConfig();
  cur.documents = cur.documents || [];
  cur.documents.push({ name: '', path: '' });
  configState = cur;
  renderFilesList(cur.documents);
});

document.addEventListener('click', (e) => {
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.matches('[data-remove-project]')) {
    const idx = Number(target.getAttribute('data-remove-project'));
    const cur = collectFormToConfig();
    cur.repos.splice(idx, 1);
    configState = cur;
    renderProjectsList(cur.repos);
  } else if (target.matches('[data-remove-file]')) {
    const idx = Number(target.getAttribute('data-remove-file'));
    const cur = collectFormToConfig();
    cur.documents.splice(idx, 1);
    configState = cur;
    renderFilesList(cur.documents);
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
