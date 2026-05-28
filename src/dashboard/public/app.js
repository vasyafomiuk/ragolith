// Dashboard frontend — vanilla JS, no bundler, no framework.
//
// Routes are hash-based so the server stays dumb:
//   #home               → project list
//   #search             → search form + results
//   #project/<name>     → file list for one project
//   #health             → connection status

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
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`${r.status}: ${body}`);
  }
  return r.json();
}

// ----- routing --------------------------------------------------------------

const views = ['home', 'search', 'project', 'health'];

function show(view) {
  for (const v of views) {
    const el = $(`view-${v}`);
    if (el) el.hidden = v !== view;
  }
  document.querySelectorAll('nav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.route === view);
  });
}

async function route() {
  const hash = window.location.hash.replace(/^#/, '') || 'home';
  if (hash.startsWith('project/')) {
    const name = decodeURIComponent(hash.slice('project/'.length));
    show('project');
    await renderProject(name);
    return;
  }
  if (hash === 'search') {
    show('search');
    await ensureProjectFilter();
    return;
  }
  if (hash === 'health') {
    show('health');
    await renderHealth();
    return;
  }
  show('home');
  await renderHome();
}

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', route);

// ----- home view ------------------------------------------------------------

async function renderHome() {
  const body = $('home-body');
  body.innerHTML = '<tr><td colspan="6" class="muted">Loading…</td></tr>';
  try {
    const projects = await api('/api/projects');
    if (projects.length === 0) {
      $('home-empty').hidden = false;
      $('home-table').hidden = true;
      return;
    }
    $('home-empty').hidden = true;
    $('home-table').hidden = false;
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
              <span class="muted">(${p.source})</span>
            </td>
            <td class="num">${p.file_count}</td>
            <td class="num">${p.chunk_count}</td>
            <td>${langs || '<span class="muted">—</span>'}</td>
            <td><code>${escape(sha)}</code></td>
            <td class="muted">${escape(fmtDate(p.updated_at))}</td>
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
    const totalChunks = files.reduce((a, f) => a + f.chunk_count, 0);
    $('project-meta').textContent = `${files.length} files · ${totalChunks} chunks`;
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
    // fine — filter just stays empty
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
      status.textContent = `0 hits for "${query}"`;
      return;
    }
    status.textContent = `${hits.length} hit${hits.length === 1 ? '' : 's'} for "${query}"`;
    list.innerHTML = hits
      .map((h) => {
        const meta = [
          h.symbol ? `<span><code>${escape(h.symbol)}</code></span>` : '',
          `<span><span class="lang-pill">${escape(h.language)}</span></span>`,
          `<span class="muted">${escape(h.chunk_type)}</span>`,
          `<span class="score">score ${h.score.toFixed(3)}</span>`,
        ]
          .filter(Boolean)
          .join('');
        return `
          <li>
            <div class="meta">
              <span class="file">${escape(h.project)} · ${escape(h.file_path)}:${h.start_line}-${h.end_line}</span>
              ${meta}
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
        ${note ? `<div class="muted" style="margin-top:4px;font-size:12px">${escape(note)}</div>` : ''}
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
        h.reranker.reachable,
        h.reranker.reachable
          ? `reranker-transformers loaded (${h.reranker.enabled ? 'used' : 'disabled in config'})`
          : h.reranker.enabled
            ? 'module not loaded'
            : 'disabled in config',
      ),
      card(
        'Ingest state file',
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
