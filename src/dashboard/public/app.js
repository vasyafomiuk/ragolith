// Dashboard frontend — vanilla JS, no bundler, no framework.
//
// Routes (hash-based, server stays dumb):
//   #home                   landing: search box + needs-attention + projects
//   #search                 unified search (code / docs / SDLC) + results
//   #analysis               gaps / modernization / decomposition
//   #ingest #backup #config #health
//   #project/<name>         drill into one project (reached from Home)

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

const VIEWS = ['home', 'search', 'analysis', 'project', 'ingest', 'backup', 'config', 'health'];

// Nav links are grouped now; map a view to the nav route that should light up.
function navRouteFor(view) {
  if (view === 'project') return 'home'; // project detail lives under Home
  return view;
}

function showView(view) {
  for (const v of VIEWS) {
    const el = $(`view-${v}`);
    if (el) el.hidden = v !== view;
  }
  const active = navRouteFor(view);
  document.querySelectorAll('.navlink').forEach((a) => {
    a.classList.toggle('active', a.dataset.route === active);
  });
}

async function route() {
  let hash = window.location.hash.replace(/^#/, '') || 'home';
  // Legacy routes → Home (which now hosts the project list).
  if (hash === 'projects') hash = 'home';

  // First-run redirect: if this is a fresh tab AND the config file doesn't
  // exist, drop the user straight into #config. We only do this once per
  // session so they can still navigate away.
  if (configExists === null) await refreshConfigPresence();
  if (configExists === false && !autoRedirected && hash === 'home') {
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
    runPendingSearch();
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
  showView('home');
  await renderHome();
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

// ----- home view ------------------------------------------------------------

async function renderHome() {
  await Promise.all([renderProjects(), renderNeedsAttention()]);
}

async function renderNeedsAttention() {
  const out = $('home-attention');
  if (!out) return;
  out.innerHTML = '<span class="muted small">Loading…</span>';
  try {
    const [gaps, mod] = await Promise.all([
      api('/api/analysis/gaps'),
      api('/api/analysis/modernization'),
    ]);
    const g = gaps.counts || {};
    const highGaps = g.unimplemented_requirement || 0;
    const otherGaps =
      (g.untested_requirement || 0) +
      (g.unimplemented_decision || 0) +
      (g.orphan_test || 0) +
      (g.dangling_link || 0);
    let modHigh = 0;
    let modWarn = 0;
    for (const r of Array.isArray(mod) ? mod : []) {
      modHigh += r.counts?.high || 0;
      modWarn += r.counts?.warning || 0;
    }
    const totalGaps = Array.isArray(gaps.gaps) ? gaps.gaps.length : 0;

    if (totalGaps === 0 && modHigh === 0 && modWarn === 0) {
      out.innerHTML =
        '<span class="ok-text">✓ Nothing flagged — no traceability gaps or modernization findings.</span>';
      return;
    }
    const tile = (n, label, hot) =>
      `<a class="attn-tile ${n > 0 ? (hot ? 'attn-high' : 'attn-warn') : 'attn-ok'}" href="#analysis">` +
      `<span class="attn-num">${n}</span><span class="attn-label">${label}</span></a>`;
    out.innerHTML =
      '<div class="attn-row">' +
      tile(highGaps, 'unimplemented requirements', true) +
      tile(otherGaps, 'other traceability gaps', false) +
      tile(modHigh, 'end-of-life findings', true) +
      tile(modWarn, 'modernization warnings', false) +
      '</div>';
  } catch (err) {
    out.innerHTML = `<span class="muted small">Analysis unavailable: ${escape(err.message)}</span>`;
  }
}

// Home search box → jump to the Search view and run the query there.
let pendingSearchQuery = null;
$('home-search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('home-search-input').value.trim();
  if (!q) return;
  pendingSearchQuery = q;
  window.location.hash = '#search';
});

function runPendingSearch() {
  if (pendingSearchQuery == null) return;
  const q = pendingSearchQuery;
  pendingSearchQuery = null;
  $('search-input').value = q;
  $('search-scope').value = 'everything';
  void doSearch();
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

let currentProject = null;
let currentGrain = 'module';

async function renderProject(name) {
  currentProject = name;
  currentGrain = 'module';
  $('project-title').textContent = name;
  $('project-meta').textContent = 'Loading…';
  const body = $('project-body');
  body.innerHTML = '';
  // Reset the granularity toggle to Modules.
  document.querySelectorAll('#view-project .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.grain === 'module');
  });

  void renderProjectGraph(name, 'module');

  // If the user clicked a symbol in search, jump straight into its call graph;
  // otherwise reset the call-graph card to its prompt.
  if (pendingCallSymbol && pendingCallSymbol.project === name) {
    const sym = pendingCallSymbol.symbol;
    pendingCallSymbol = null;
    $('callgraph-symbol').value = sym;
    void runCallGraph(sym);
  } else {
    pendingCallSymbol = null;
    $('callgraph-out').innerHTML =
      '<span class="muted small">Enter a function/method name to see what calls it and what it calls.</span>';
    $('callgraph-symbol').value = '';
  }

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

async function renderProjectGraph(name, grain) {
  const out = $('project-graph');
  out.innerHTML = '<span class="muted small">Building graph…</span>';
  try {
    const q = `?project=${encodeURIComponent(name)}${grain === 'file' ? '&granularity=file' : ''}`;
    const r = await api('/api/analysis/decomposition' + q);
    if (r.error) {
      out.innerHTML = `<span class="muted small">${escape(r.error)}</span>`;
      return;
    }
    if (!r.modules || r.modules.length < 2) {
      out.innerHTML =
        '<span class="muted small">Not enough call-graph data to draw a map (needs ≥2 linked ' +
        (grain === 'file' ? 'files' : 'modules') +
        ' — best for TS/JS, C#, Java, Python, Go, Rust, Ruby, PHP).</span>';
      return;
    }
    out.innerHTML =
      `<p class="muted small">${r.totals.modules} ${grain === 'file' ? 'files' : 'modules'} · ` +
      `${r.totals.crossModuleCalls} cross-${grain === 'file' ? 'file' : 'module'} calls</p>` +
      buildServiceGraph(r);
  } catch (err) {
    out.innerHTML = `<span class="err-text">Error: ${escape(err.message)}</span>`;
  }
}

// Granularity toggle (Modules / Files) on the project page.
document.querySelectorAll('#view-project .seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const grain = btn.dataset.grain;
    if (grain === currentGrain || !currentProject) return;
    currentGrain = grain;
    document.querySelectorAll('#view-project .seg-btn').forEach((b) => {
      b.classList.toggle('active', b === btn);
    });
    void renderProjectGraph(currentProject, grain);
  });
});

// Ego call graph for a symbol within the current project.
async function runCallGraph(symbol) {
  const out = $('callgraph-out');
  if (!symbol || !currentProject) return;
  out.innerHTML = '<span class="muted small">Building call graph…</span>';
  try {
    const r = await api(
      `/api/callgraph?project=${encodeURIComponent(currentProject)}&symbol=${encodeURIComponent(symbol)}`,
    );
    if (!r.matched) {
      out.innerHTML = `<span class="muted small">No call edges found for "${escape(symbol)}". Try a simple function/method name.</span>`;
      return;
    }
    out.innerHTML = buildCallGraph(r);
  } catch (err) {
    out.innerHTML = `<span class="err-text">Error: ${escape(err.message)}</span>`;
  }
}

$('callgraph-form').addEventListener('submit', (e) => {
  e.preventDefault();
  void runCallGraph($('callgraph-symbol').value.trim());
});

// Click any node in the call graph → re-center on that symbol (drill through).
$('callgraph-out').addEventListener('click', (ev) => {
  const g = ev.target.closest?.('[data-node-id]');
  if (!g) return;
  const id = g.dataset.nodeId;
  // Node ids are `c:<center>`, `in:<name>`, `out:<name>` — strip the prefix.
  const symbol = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
  $('callgraph-symbol').value = symbol;
  void runCallGraph(symbol);
});

// Ego call graph → nodes (center + callers + callees), edges (caller→center, center→callee).
function buildCallGraph(ego) {
  const center = ego.center;
  const nodes = [{ id: `c:${center}`, label: center, r: 12, fill: 'var(--accent)', title: center }];
  const edges = [];
  for (const c of ego.callers) {
    const id = `in:${c.name}`;
    nodes.push({
      id,
      label: c.name,
      r: 7 + Math.min(8, c.count * 1.5),
      fill: 'var(--warn)',
      title: `${c.name} → ${center} (${c.count})`,
    });
    edges.push({ s: id, t: `c:${center}`, w: c.count, title: `${c.name} calls ${center}` });
  }
  for (const c of ego.callees) {
    const id = `out:${c.name}`;
    nodes.push({
      id,
      label: c.name,
      r: 7 + Math.min(8, c.count * 1.5),
      fill: 'var(--ok)',
      title: `${center} → ${c.name} (${c.count})`,
    });
    edges.push({ s: `c:${center}`, t: id, w: c.count, title: `${center} calls ${c.name}` });
  }
  return (
    renderForceGraph(nodes, edges, { aria: 'call graph', interactive: true }) +
    legendHtml([
      '<span><i class="dot" style="background:var(--accent)"></i>this symbol</span>',
      '<span><i class="dot" style="background:var(--warn)"></i>callers (in)</span>',
      '<span><i class="dot" style="background:var(--ok)"></i>callees (out)</span>',
      '<span class="muted">click a node to re-center</span>',
    ])
  );
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

// One search box, multiple scopes. "Everything" runs code/doc + artifact
// search in parallel and shows two groups; the others target one index.
const DOC_LANGS = new Set(['pdf', 'docx', 'markdown', 'text']);

function codeHitHtml(h) {
  // A symbol hit links to its project's call graph (data-* read by a delegated
  // click handler on #search-results).
  const symbolTag = h.symbol
    ? `<button type="button" class="hit-symbol" data-project="${escape(h.project)}" data-symbol="${escape(h.symbol)}" title="Show call graph for ${escape(h.symbol)}"><code>${escape(h.symbol)}</code></button>`
    : '';
  const tags = [
    symbolTag,
    `<span class="lang-pill">${escape(h.language)}</span>`,
    `<span class="muted">${escape(h.chunk_type)}</span>`,
    `<span class="score">${h.score.toFixed(3)}</span>`,
  ]
    .filter(Boolean)
    .join('');
  return (
    `<li><div class="meta"><span class="file">${escape(h.project)} · ` +
    `${escape(h.file_path)}:${h.start_line}-${h.end_line}</span>${tags}</div>` +
    `<pre>${escape(h.content)}</pre></li>`
  );
}

function artifactHitHtml(h) {
  const tags = [
    `<span class="lang-pill">${escape(h.kind)}</span>`,
    h.status ? `<span class="muted">${escape(h.status)}</span>` : '',
    `<span class="muted small">${escape(h.project)} · ${escape(h.source)}</span>`,
    `<span class="score">${h.score.toFixed(3)}</span>`,
  ]
    .filter(Boolean)
    .join('');
  return (
    `<li><div class="meta"><span class="file"><code>${escape(h.artifact_id)}</code> ` +
    `${escape(h.title)}</span>${tags}</div><pre>${escape(h.excerpt)}</pre></li>`
  );
}

function postSearch(path, body) {
  return api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function doSearch() {
  const query = $('search-input').value.trim();
  const scope = $('search-scope').value;
  const project = $('search-project').value;
  if (!query) return;
  const list = $('search-results');
  const status = $('search-status');
  list.innerHTML = '';
  status.textContent = 'Searching…';
  try {
    const base = { query, limit: 20 };
    if (project) base.project = project;
    let html = '';
    let count = 0;

    if (scope === 'sdlc') {
      const hits = await postSearch('/api/sdlc/search', base);
      count = hits.length;
      html = hits.map(artifactHitHtml).join('');
    } else if (scope === 'code' || scope === 'docs') {
      const hits = await postSearch('/api/search', base);
      const filtered = hits.filter((h) =>
        scope === 'docs' ? DOC_LANGS.has(h.language) : !DOC_LANGS.has(h.language),
      );
      count = filtered.length;
      html = filtered.map(codeHitHtml).join('');
    } else {
      // everything — code/docs + artifacts, two labeled groups.
      const [code, arts] = await Promise.all([
        postSearch('/api/search', base),
        postSearch('/api/sdlc/search', base).catch(() => []),
      ]);
      count = code.length + arts.length;
      if (code.length)
        html += '<li class="hit-group">Code &amp; docs</li>' + code.map(codeHitHtml).join('');
      if (arts.length)
        html += '<li class="hit-group">SDLC artifacts</li>' + arts.map(artifactHitHtml).join('');
    }

    if (count === 0) {
      status.textContent = `No matches for "${query}"`;
      return;
    }
    status.textContent = `${count} result${count === 1 ? '' : 's'} for "${query}"`;
    list.innerHTML = html;
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
  }
}

$('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  void doSearch();
});
// Re-run when the scope changes if there's already a query, for quick pivoting.
$('search-scope').addEventListener('change', () => {
  if ($('search-input').value.trim()) void doSearch();
});

// Click a symbol in a code hit → open its project and run the ego call graph.
// The project page reads `pendingCallSymbol` once it renders.
let pendingCallSymbol = null;
$('search-results').addEventListener('click', (ev) => {
  const btn = ev.target.closest?.('.hit-symbol');
  if (!btn) return;
  const project = btn.dataset.project;
  const symbol = btn.dataset.symbol;
  if (!project || !symbol) return;
  pendingCallSymbol = { project, symbol };
  window.location.hash = `#project/${encodeURIComponent(project)}`;
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
      buildServiceGraph(r) +
      '<table class="analysis-table"><thead><tr><th>module</th><th class="num">files</th><th class="num">cohesion</th><th class="num">instability</th><th class="num">fanIn</th><th class="num">fanOut</th></tr></thead><tbody>' +
      moduleRows +
      '</tbody></table>' +
      seams +
      couplings;
  } catch (err) {
    out.innerHTML = `<span class="err-text">Error: ${escape(err.message)}</span>`;
  }
});

// ----- SDLC traceability graph ----------------------------------------------

const REQ_KINDS = new Set(['requirement', 'story', 'feature', 'epic']);
const ARTIFACT_KIND_COLOR = {
  requirement: '#2563eb',
  story: '#2563eb',
  feature: '#2563eb',
  epic: '#1d4ed8',
  decision: '#7c3aed',
  test_case: 'var(--ok)',
  ticket: 'var(--warn)',
  risk: 'var(--warn)',
  incident: 'var(--bad)',
};
function artifactKindColor(kind) {
  return ARTIFACT_KIND_COLOR[kind] || 'var(--text-faint)';
}
function isArtifactCodeRef(t) {
  return /^(repo|symbol|file|code):/i.test(t);
}

// Stash the last-rendered artifacts so node clicks can show details without refetching.
let traceArtifactsById = new Map();

$('analysis-run-trace').addEventListener('click', async () => {
  const out = $('analysis-trace-out');
  const project = $('analysis-project').value;
  out.innerHTML = '<span class="muted small">Building map…</span>';
  try {
    const artifacts = await api(
      '/api/sdlc/artifacts' + (project ? `?project=${encodeURIComponent(project)}` : ''),
    );
    if (!artifacts.length) {
      out.innerHTML = '<span class="muted small">No SDLC artifacts indexed yet.</span>';
      return;
    }
    traceArtifactsById = new Map(artifacts.map((a) => [a.artifact_id, a]));
    out.innerHTML = buildTraceabilityGraph(artifacts);
  } catch (err) {
    out.innerHTML = `<span class="err-text">Error: ${escape(err.message)}</span>`;
  }
});

// Click an artifact node → show its details (from the already-loaded set).
$('analysis-trace-out').addEventListener('click', (ev) => {
  const g = ev.target.closest?.('[data-node-id]');
  const panel = $('trace-detail');
  if (!g || !panel) return;
  const a = traceArtifactsById.get(g.dataset.nodeId);
  if (!a) return; // code-ref or dangling node — nothing to show
  const links = (a.links || [])
    .map(
      (l) =>
        `<li><span class="muted small">${escape(l.rel)}</span> → <code>${escape(l.target)}</code></li>`,
    )
    .join('');
  panel.innerHTML =
    '<div class="trace-card">' +
    `<div class="trace-card-head"><span class="lang-pill">${escape(a.kind)}</span> ` +
    `<code>${escape(a.artifact_id)}</code> <strong>${escape(a.title)}</strong>` +
    (a.status ? ` <span class="muted small">· ${escape(a.status)}</span>` : '') +
    '</div>' +
    (a.body
      ? `<p class="muted small trace-body">${escape(a.body.slice(0, 400))}${a.body.length > 400 ? '…' : ''}</p>`
      : '') +
    (links ? `<ul class="seam-list">${links}</ul>` : '<p class="muted small">No links.</p>') +
    '</div>';
  panel.scrollIntoView({ block: 'nearest' });
});

function buildTraceabilityGraph(artifacts) {
  const CAP = 120;
  const capped = artifacts.length > CAP;
  const list = artifacts.slice(0, CAP);
  const known = new Set(list.map((a) => a.artifact_id));

  const nodes = new Map(); // id → node
  const edges = [];
  const indeg = new Map();
  const bump = (id) => indeg.set(id, (indeg.get(id) ?? 0) + 1);

  for (const a of list) {
    nodes.set(a.artifact_id, {
      id: a.artifact_id,
      label: a.artifact_id,
      r: 9,
      fill: artifactKindColor(a.kind),
      title: `[${a.kind}] ${a.artifact_id} — ${a.title}`,
      _kind: a.kind,
      _links: (a.links || []).length,
    });
  }
  for (const a of list) {
    for (const link of a.links || []) {
      const target = link.target;
      if (isArtifactCodeRef(target)) {
        if (!nodes.has(target)) {
          nodes.set(target, {
            id: target,
            label: target.replace(/^[a-z]+:/i, ''),
            r: 6,
            fill: 'var(--accent)',
            title: target,
          });
        }
      } else if (!nodes.has(target)) {
        // Dangling — referenced but not indexed.
        nodes.set(target, {
          id: target,
          label: target,
          r: 7,
          fill: 'var(--bad)',
          ring: 'var(--bad)',
          title: `${target} — referenced but not indexed (dangling)`,
        });
      }
      edges.push({ s: a.artifact_id, t: target, title: `${a.artifact_id} ${link.rel} ${target}` });
      bump(target);
    }
  }
  // Flag requirement-ish nodes with no links in or out as likely-untraced.
  for (const n of nodes.values()) {
    if (REQ_KINDS.has(n._kind) && n._links === 0 && (indeg.get(n.id) ?? 0) === 0) {
      n.ring = 'var(--bad)';
      n.title += ' · untraced (no links)';
    }
  }

  const nodeArr = [...nodes.values()];
  if (nodeArr.length < 2) {
    return '<span class="muted small">Not enough linked artifacts to draw a map. Add <code>links</code> to your RSIF artifacts.</span>';
  }
  return (
    (capped
      ? `<p class="muted small">Showing first ${CAP} of ${artifacts.length} artifacts.</p>`
      : '') +
    '<div id="trace-detail"></div>' +
    renderForceGraph(nodeArr, edges, {
      aria: 'SDLC traceability graph',
      height: 480,
      interactive: true,
    }) +
    legendHtml([
      '<span><i class="dot" style="background:#2563eb"></i>requirement</span>',
      '<span><i class="dot" style="background:#7c3aed"></i>decision</span>',
      '<span><i class="dot" style="background:var(--ok)"></i>test</span>',
      '<span><i class="dot" style="background:var(--accent)"></i>code</span>',
      '<span><i class="ring" style="border-color:var(--bad)"></i>untraced / dangling</span>',
      '<span class="muted">click an artifact for details</span>',
    ])
  );
}

// ----- generic force-directed graph ----------------------------------------
//
// One renderer for every graph in the dashboard (service composition, SDLC
// traceability, ego call graph, file-level deps). Dependency-light and
// deterministic: a fixed-iteration spring simulation seeded on a circle, no
// animation loop, no library.
//
//   nodes: [{ id, label, r?, fill?, ring?, title? }]
//   edges: [{ s, t, w?, title? }]    (s/t are node ids)

function cohesionColor(c) {
  if (c >= 0.66) return 'var(--ok)';
  if (c >= 0.33) return 'var(--warn)';
  return 'var(--bad)';
}

function renderForceGraph(nodes, edges, opts = {}) {
  const W = opts.width ?? 640;
  const H = opts.height ?? 440;
  const pad = 46;
  if (nodes.length === 0) {
    return `<p class="muted small">${escape(opts.empty ?? 'Nothing to graph.')}</p>`;
  }
  const idx = new Map(nodes.map((n, i) => [n.id, i]));
  const E = edges
    .map((e) => ({ s: idx.get(e.s), t: idx.get(e.t), w: e.w ?? 1, title: e.title }))
    .filter((e) => e.s !== undefined && e.t !== undefined && e.s !== e.t);

  const P = nodes.map(() => ({ x: 0, y: 0, vx: 0, vy: 0 }));
  const cx = W / 2;
  const cy = H / 2;
  const R = Math.min(W, H) / 2 - pad;
  P.forEach((p, i) => {
    const a = (2 * Math.PI * i) / nodes.length;
    p.x = cx + R * Math.cos(a);
    p.y = cy + R * Math.sin(a);
  });

  const iters = opts.iterations ?? 320;
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < P.length; i++) {
      for (let j = i + 1; j < P.length; j++) {
        let dx = P[i].x - P[j].x;
        let dy = P[i].y - P[j].y;
        const d2 = dx * dx + dy * dy || 0.01;
        const d = Math.sqrt(d2);
        const rep = 2400 / d2;
        dx = (dx / d) * rep;
        dy = (dy / d) * rep;
        P[i].vx += dx;
        P[i].vy += dy;
        P[j].vx -= dx;
        P[j].vy -= dy;
      }
    }
    for (const e of E) {
      const a = P[e.s];
      const b = P[e.t];
      const k = 0.02 * Math.min(4, e.w);
      a.vx += (b.x - a.x) * k;
      a.vy += (b.y - a.y) * k;
      b.vx -= (b.x - a.x) * k;
      b.vy -= (b.y - a.y) * k;
    }
    for (const p of P) {
      p.vx += (cx - p.x) * 0.006;
      p.vy += (cy - p.y) * 0.006;
      p.x += p.vx * 0.85;
      p.y += p.vy * 0.85;
      p.vx *= 0.82;
      p.vy *= 0.82;
      p.x = Math.max(pad, Math.min(W - pad, p.x));
      p.y = Math.max(pad, Math.min(H - pad, p.y));
    }
  }

  const edgeSvg = E.map((e) => {
    const a = P[e.s];
    const b = P[e.t];
    const sw = 1 + Math.min(5, Math.log2(e.w + 1));
    return (
      `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" ` +
      `stroke-width="${sw.toFixed(2)}" class="svc-edge">${e.title ? `<title>${escape(e.title)}</title>` : ''}</line>`
    );
  }).join('');

  const nodeSvg = nodes
    .map((n, i) => {
      const p = P[i];
      const r = n.r ?? 9;
      const ring = n.ring
        ? ` stroke="${n.ring}" stroke-width="2.5"`
        : ' stroke="#fff" stroke-width="1.5"';
      const raw = n.label ?? n.id ?? '';
      const label = raw.length > 18 ? raw.slice(0, 17) + '…' : raw;
      return (
        `<g class="svc-node" data-node-id="${escape(n.id)}">` +
        `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r.toFixed(1)}" fill="${n.fill ?? 'var(--accent)'}"${ring}>` +
        `${n.title ? `<title>${escape(n.title)}</title>` : ''}</circle>` +
        `<text x="${p.x.toFixed(1)}" y="${(p.y + r + 11).toFixed(1)}" class="svc-label">${escape(label)}</text>` +
        '</g>'
      );
    })
    .join('');

  return (
    `<div class="svc-graph${opts.interactive ? ' interactive' : ''}"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${escape(opts.aria ?? 'graph')}">` +
    edgeSvg +
    nodeSvg +
    '</svg></div>'
  );
}

function legendHtml(items) {
  return '<div class="svc-legend">' + items.join('') + '</div>';
}

// Service composition graph — modules sized by files, colored by cohesion.
function buildServiceGraph(report) {
  if (report.modules.length < 2) {
    return '<p class="muted small">Graph needs at least 2 modules with call edges.</p>';
  }
  const seamSet = new Set(report.seams.map((s) => s.module));
  const nodes = report.modules.map((m) => ({
    id: m.module,
    label: m.module,
    r: 7 + Math.min(16, Math.sqrt(m.files || 1) * 2.4),
    fill: cohesionColor(m.cohesion),
    ring: seamSet.has(m.module) ? 'var(--accent)' : null,
    title: `${m.module} — ${m.files} files, cohesion ${m.cohesion.toFixed(2)}, instability ${m.instability.toFixed(2)}${seamSet.has(m.module) ? ' · suggested seam' : ''}`,
  }));
  const edges = report.couplings.map((c) => ({
    s: c.a,
    t: c.b,
    w: c.calls,
    title: `${c.a} ↔ ${c.b}: ${c.calls} calls`,
  }));
  return (
    renderForceGraph(nodes, edges, { aria: 'service composition graph' }) +
    legendHtml([
      '<span><i class="dot" style="background:var(--ok)"></i>cohesive</span>',
      '<span><i class="dot" style="background:var(--warn)"></i>mixed</span>',
      '<span><i class="dot" style="background:var(--bad)"></i>coupling-heavy</span>',
      '<span><i class="ring"></i>suggested seam</span>',
      '<span class="muted">node size = files · edge width = call volume</span>',
    ])
  );
}

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

// Effort presets — must mirror SEARCH_PROFILES in src/core/search.ts.
const EFFORT_PRESETS = {
  productivity: {
    overFetch: 3,
    diversityPerFile: 4,
    rerankerEnabled: true,
    limit: 20,
    maxContentChars: 4000,
  },
  balanced: {
    overFetch: 2,
    diversityPerFile: 3,
    rerankerEnabled: true,
    limit: 10,
    maxContentChars: 1200,
  },
  frugal: {
    overFetch: 1,
    diversityPerFile: 2,
    rerankerEnabled: false,
    limit: 5,
    maxContentChars: 400,
  },
};

function fillForm(cfg) {
  $('cfg-weaviate-host').value = cfg.weaviate?.host ?? 'localhost';
  $('cfg-weaviate-http').value = cfg.weaviate?.httpPort ?? 8080;
  $('cfg-weaviate-grpc').value = cfg.weaviate?.grpcPort ?? 50051;
  $('cfg-weaviate-secure').checked = !!cfg.weaviate?.secure;

  const s = cfg.search ?? {};
  $('cfg-search-reranker').checked = s.rerankerEnabled !== false;
  $('cfg-search-limit').value = s.limit ?? 10;
  $('cfg-search-maxchars').value = s.maxContentChars ?? 1200;
  $('cfg-search-overfetch').value = s.overFetch ?? 2;
  $('cfg-search-diversity').value = s.diversityPerFile ?? 3;
  syncEffortUI(s.profile);

  // Accept legacy keys so an existing ragc.config.json renders correctly
  // until the user saves (which writes the canonical names back).
  renderProjectsList(cfg.repos ?? cfg.projects ?? []);
  renderFilesList(cfg.documents ?? cfg.files ?? []);
}

/** Current slider values as a settings object. */
function readEffortSliders() {
  return {
    limit: Number($('cfg-search-limit').value),
    maxContentChars: Number($('cfg-search-maxchars').value),
    overFetch: Number($('cfg-search-overfetch').value),
    diversityPerFile: Number($('cfg-search-diversity').value),
    rerankerEnabled: $('cfg-search-reranker').checked,
  };
}

/** Which preset (if any) the current slider values exactly match. */
function detectEffortProfile() {
  const cur = readEffortSliders();
  for (const [name, p] of Object.entries(EFFORT_PRESETS)) {
    if (
      p.limit === cur.limit &&
      p.maxContentChars === cur.maxContentChars &&
      p.overFetch === cur.overFetch &&
      p.diversityPerFile === cur.diversityPerFile &&
      p.rerankerEnabled === cur.rerankerEnabled
    ) {
      return name;
    }
  }
  return 'custom';
}

/** Refresh slider value labels, the token estimate, and the active preset button. */
function syncEffortUI(forceProfile) {
  const cur = readEffortSliders();
  $('cfg-search-limit-val').textContent = String(cur.limit);
  $('cfg-search-maxchars-val').textContent =
    cur.maxContentChars === 0 ? 'unlimited' : String(cur.maxContentChars);
  $('cfg-search-overfetch-val').textContent = '×' + cur.overFetch;
  $('cfg-search-diversity-val').textContent = String(cur.diversityPerFile);

  const profile = forceProfile && forceProfile !== 'custom' ? forceProfile : detectEffortProfile();
  document.querySelectorAll('.effort-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.effort === profile);
  });

  // Rough upper-bound token estimate for a full result set: chars/4 heuristic.
  const perHit = cur.maxContentChars > 0 ? cur.maxContentChars : 4000;
  const approxTokens = Math.round((cur.limit * perHit) / 4);
  const rerank = cur.rerankerEnabled ? 'reranker on' : 'reranker off';
  $('cfg-search-estimate').textContent =
    `≈ up to ${approxTokens.toLocaleString()} tokens per search fed to the LLM · ${rerank}` +
    (profile === 'custom' ? ' · custom profile' : ` · ${profile} preset`);
}

function applyEffortPreset(name) {
  const p = EFFORT_PRESETS[name];
  if (!p) return;
  $('cfg-search-limit').value = p.limit;
  $('cfg-search-maxchars').value = p.maxContentChars;
  $('cfg-search-overfetch').value = p.overFetch;
  $('cfg-search-diversity').value = p.diversityPerFile;
  $('cfg-search-reranker').checked = p.rerankerEnabled;
  syncEffortUI(name);
}

// Wire preset buttons + live slider updates (once, at load).
document.querySelectorAll('.effort-btn').forEach((btn) => {
  btn.addEventListener('click', () => applyEffortPreset(btn.dataset.effort));
});
for (const id of [
  'cfg-search-limit',
  'cfg-search-maxchars',
  'cfg-search-overfetch',
  'cfg-search-diversity',
]) {
  const el = $(id);
  if (el) el.addEventListener('input', () => syncEffortUI());
}
$('cfg-search-reranker').addEventListener('change', () => syncEffortUI());

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
  base.search = base.search || {};
  const eff = readEffortSliders();
  base.search.overFetch = eff.overFetch;
  base.search.diversityPerFile = eff.diversityPerFile;
  base.search.rerankerEnabled = eff.rerankerEnabled;
  base.search.limit = eff.limit;
  base.search.maxContentChars = eff.maxContentChars;
  base.search.profile = detectEffortProfile();

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
