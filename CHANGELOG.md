# Changelog

All notable changes to this project are recorded here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Dashboard simplified.** It had grown to 8 flat nav items with two separate search boxes and power-user controls on every view. Reworked for clarity:
  - **One unified Search** with a scope toggle (Everything / Code / Docs / SDLC artifacts) replaces the separate Search and SDLC tabs. "Everything" runs code + artifact search in parallel and shows two labeled groups; switching scope re-runs instantly.
  - **Grouped sidebar** — 7 items in two labeled sections, **Explore** (Home, Search, Analysis) and **Manage** (Ingest, Backup, Config, Health), so daily-use views stand out and admin tools recede.
  - **Advanced disclosures** — power-user controls fold behind `Advanced` `<details>`: search-effort sliders (the 3 preset buttons + token estimate stay visible), Backup verify + S3 push/pull, Ingest force-full + migrate-only. Default surface is clean.
  - **Home landing** (new default route) — a single page with a search box, a colour-coded "Needs attention" summary (unimplemented requirements / other gaps / end-of-life / modernization counts, linking to Analysis), and the indexed-projects table. The standalone Projects tab folded into Home; `#projects` redirects there.

### Added

- **Call edges for every chunked language** — Python, Go, Rust, Ruby, and PHP now emit `caller → callee` edges from the tree-sitter walker (joining TS/JS, C#, Java), so `callers_of`/`callees_of` and the **decomposition / service-composition graph** work for all eight languages. Per-grammar callee extraction (Python `attribute`, Go `selector_expression`, Rust `field_expression`/`scoped_identifier`/`macro_invocation`, Ruby receiver-method, PHP member/scoped calls), verified empirically against each grammar and covered by a per-language edge test. Member calls tag `call_type: 'method'`, bare calls `'static'`.
- **C# / .NET native-app support deepened**:

  - **Call edges for C# and Java** — the tree-sitter walker now extracts `caller → callee` edges from method/invocation bodies, so `callers_of`, `callees_of`, and the **decomposition / service-composition graph** work on C# and Java repos (previously TS/JS only).
  - **Desktop / native framework detection** — `parseCsproj` now recognizes WPF, WinForms, .NET MAUI, Native AOT (`<PublishAot>`), Blazor, ASP.NET Core (SDK), and Worker Service from MSBuild properties + the project SDK, plus Avalonia / WinUI 3 / MVVM Toolkit from package refs. Reads `<TargetFrameworks>` (plural) too.
  - **XAML / Razor indexing** — `.xaml`, `.razor`, `.cshtml` are now chunked + searchable (new `xaml` / `razor` languages), not just the `.cs` code-behind.
  - **.NET Framework modernization fix** — TFMs are now classified properly: legacy `net48`/`net472` (.NET Framework) and `netcoreapp*` flag **high**, out-of-support `net5.0`–`net7.0` flag **warning**, `net8.0`+ / `netstandard*` pass. Previously `net48` slipped through as "major 48".

- **Search effort presets** — tune the quality/token-consumption tradeoff from the dashboard Config view. Three one-click presets (**Max productivity** / **Balanced** / **Minimum tokens**) drive sliders for result count, max content chars per hit (the main token lever — truncates what an LLM ingests), over-fetch ×, and max hits/file, plus a reranker toggle. A live estimate shows approximate tokens per search. Nudging any slider switches to a "custom" profile. Persisted to `ragc.config.json`'s `search` block, so both the dashboard and the MCP server honor it. New `SEARCH_PROFILES` + `truncateContent` in core; `SearchConfig` gains `limit`, `maxContentChars`, `profile`.
- **Service composition graph** — the dashboard's Analysis → Decomposition output now renders a force-directed SVG of the module dependency graph: nodes sized by file count and colored by cohesion (green = cohesive, amber = mixed, red = coupling-heavy), edges weighted by call volume, suggested seams ringed. Deterministic layout, vanilla SVG, no dependencies — reuses the existing decomposition data.

- **SDLC knowledge platform** — ragolith now indexes the whole software-development lifecycle, not just code. New capabilities:

  - **RSIF (Ragolith SDLC Interchange Format)** — a tool-agnostic format for SDLC artifacts (requirements, decisions/ADRs, tickets, tests, runbooks, API specs, …). Two encodings: Markdown + YAML frontmatter and NDJSON/JSON. ragolith never calls vendor APIs — any tool exports to RSIF and ragolith indexes it (`core/sdlc.ts`). Configure sources in the new `sdlc` config section.
  - **SdlcArtifact collection** + ingest path: artifacts are chunked, vectorized, and searchable; a 15-verb link vocabulary (`implemented_by`, `tested_by`, `supersedes`, …) captures cross-artifact and artifact→code traceability.
  - **`ragolith-analyze`** (8th CLI) with three analyses, each with `--json` and a matching MCP tool:
    - **gaps** — unimplemented requirements, untested implementations, accepted-but-unbuilt decisions, orphan tests, dangling links; `--strict` gates CI.
    - **modernize** — flags end-of-life/legacy runtimes (Java 8, Node 16, Python 2, …) and frameworks (Spring Boot 2.x, AngularJS, Vue 2, legacy `javax.*`, …) with upgrade recommendations.
    - **decompose** — builds a module dependency graph from call edges; reports cohesion + Martin instability + fan-in/out, ranks cross-module couplings, and suggests microservice seams for monolith migration.
  - **6 new MCP tools** (11 → 17): `search_sdlc`, `list_artifacts`, `get_artifact`, `analyze_gaps`, `analyze_modernization`, `analyze_decomposition`.

- **`ragc.config.json` keys renamed for clarity**: `projects` → `repos`, `files` → `documents`. Old keys still accepted as backward-compat aliases; `loadConfig` emits a single stderr line on first encounter ("legacy aliases — canonical names are repos/documents") so existing configs keep working untouched. New configs from `ragolith-init`, the dashboard's Config form, and `--migrate-only` runs write the canonical names. Type aliases (`ProjectConfig`, `FileConfig`) kept as deprecated exports so any downstream importer still compiles. State file (`.ragolith/data.json`) keeps `projects`/`files` keys — those are internal incremental-tracking state and renaming them would invalidate every existing user's progress. Weaviate's `project` field on `CodeChunk` also unchanged.
- **Per-row Re-index + Delete on Projects view** — Projects table gets an Actions column. Re-index confirms (mentions the project name), POSTs to `/api/ingest` with `--project=<name>`, then auto-navigates to the Ingest view so the live log is immediately visible. Delete confirms with the chunk count, calls a new `DELETE /api/projects/:name` endpoint that drops every chunk whose `project` field matches and removes the entry from `data.json` (atomic write). `ragc.config.json` is deliberately untouched — if the project is still listed there, the next ingest re-adds it from scratch; use the Config view to remove it permanently. Event delegation on `<tbody>` so re-renders don't need re-binding.
- **Snapshot registry** (`src/core/backups-registry.ts`) — `ragolith-backup` records every create/verify under `.ragolith/backups.json` (atomic write, upsert by id), and the dashboard's Backup view renders this as a table at the top: id, status badge, formatted timestamp, S3 marker, inline Restore + Push-to-S3 buttons per row. `prefillSnapshotIdIfEmpty()` drops a `snapshot-<lowercase-ISO-stamp>` default into the Create field so the button is one-click for daily use. Weaviate's strict `[a-z0-9_-]+` id rule mirrored client-side so bad ids fail fast instead of round-tripping. `GET /api/backups` returns the list.
- **Confirmation prompts for destructive dashboard actions** — Ingest's "Force full rebuild" (whether across all projects or one), "Re-index project" (incremental or full), and Backup's "Restore" now go through `window.confirm` with a message that names the target (project, snapshot id) and spells out what gets wiped. Migrate-only, incremental "Index everything", Verify, Create, Push, and Pull stay click-and-go.
- **Dashboard CLI parity** — the localhost dashboard now wraps both `ragolith-ingest` and `ragolith-backup`. The Ingest view lets you "Index everything", re-index a single project, or run `--migrate-only`; the new Backup view exposes `create`, `restore`, `verify`, and S3 `push`/`pull` with an id input + checkbox toggles. Both views share a single Server-Sent Events stream (`/api/jobs/stream`) so live stdout/stderr fans out to whoever's watching, and only one job can run at a time across kinds (a 409 surfaces the conflict). Late page loads get the buffered output replayed.
- **Search-quality eval harness** (`src/core/eval.ts` + `ragolith-eval` CLI). Golden-set JSON of `{id, query, expect, project?}` entries → live search runs → scorecard with recall@K and mean reciprocal rank. `--threshold` makes it CI-gating; `--json` makes it pipe-friendly. Catches regressions when tuning the alpha classifier / synonyms / reranker.
- **Structured logger** (`src/core/log.ts`). Levels (debug/info/warn/error) + `LOG_FORMAT=json` for log aggregators; default text format preserves the historical `[scope] msg` look. `createLogger('scope').child({ project })` for context-stamped sub-loggers.
- **Backup verify** subcommand (`ragolith-backup verify`). Snapshots current Weaviate state under a `verify-<ms>` id and waits for `SUCCESS`. Round-trip test for the backup backend.
- **Schema migrations** (`src/core/migrations.ts` + `ragolith-ingest --migrate-only`). Versioned migrations stored in a `SchemaMeta` collection inside Weaviate. Renaming a property or changing tokenization stops being "manual destructive rebuild". MIGRATIONS array starts empty; example shape in the file comment.
- **Tree-sitter Python, Go, Rust, Ruby, PHP** chunkers, joining the existing Java + C#. Adding a new language is now a four-line patch. Statement-form namespaces (PHP `namespace X;`, C# file-scoped) handled correctly via sibling-context tracking in `walkChildren`.
- **`ragolith-doctor` CLI** — terminal version of the dashboard's Health view. Coloured scorecard for Weaviate HTTP, Weaviate gRPC, embedder, reranker, ingest state file. `--json` for piping into `jq`. Exit code reflects whether the stack is usable (Weaviate up + embedder module loaded).
- **Container memory ceilings** in `docker-compose.yml` — `mem_limit: 1g` on `t2v-transformers` and `reranker-transformers` so a large ingest can't starve other containers on the host.
- **Tree-sitter Java + C# chunkers** via `web-tree-sitter` + `tree-sitter-wasms`. Replaces the regex+brace-counter implementations with a real AST walk per language. Annotations, generics, nested classes, Java records, C# attributes, file-scoped namespaces, primary constructors, and expression-bodied methods are now all extracted correctly. Falls through to the line-based fallback chunker on parse failure.
- **Live ingest progress counter** (`src/core/progress.ts`). The ingest CLI no longer goes silent for minutes on large repos — it prints in-place `N/total · chunks · symbols · edges` updates in a TTY and periodic milestone lines in non-TTY runs (CI logs).
- **Interactive setup wizard** (`ragolith-init`). Fifth binary. Walks new users through Weaviate connection settings, project entries (git URL or local path, branch, sub-paths, optional token env var), standalone files (PDF/DOCX/TXT), and reranker enablement — then atomically writes a validated `ragc.config.json`. Uses Node's built-in `readline/promises` (no new deps). Supports `--yes` for scripted/CI use and `--force` to overwrite existing configs without confirmation. The pure config-building functions (`buildConfig`, `defaultAnswers`) are exported and unit-tested.
- **Localhost web dashboard** (`ragolith-dashboard`). New fourth binary. Four views: indexed-projects table with file/chunk counts and language breakdown, hybrid-search box with same pipeline as the MCP server, per-project file drill-down, stack-health probe (Weaviate HTTP/gRPC, embedder, reranker, ingest state file). Vanilla HTML+JS, no bundler. Localhost-only by default. New `dashboard` layer in `src/dashboard/`, enforced by `scripts/check-layers.mjs`.
- **Published to npm as [`ragolith`](https://www.npmjs.com/package/ragolith)**. `npm install -g ragolith` puts `ragolith-server`, `ragolith-ingest`, `ragolith-backup`, `ragolith-dashboard` on your PATH. Source clone no longer required.
- **Release workflow** (`.github/workflows/release.yml`) publishes via **npm Trusted Publishing** (OIDC) on `v*` tag push — no long-lived NPM_TOKEN, no 2FA-bypass tokens, no secrets to leak. Each tarball carries a [provenance attestation](https://docs.npmjs.com/generating-provenance-statements) signed by GitHub Actions and verifiable against the exact commit + workflow run.
- **Layered source layout**: `src/core/`, `src/mcp/`, `src/cli/`. The `core` layer is the public surface (re-exported through `src/core/index.ts`); `mcp` and `cli` are sibling adapters. Boundary enforced by `scripts/check-layers.mjs` + a CI step.
- **Chunker dispatch** moved into `src/core/chunkers/dispatch.ts` so any future transport can reuse it (not just the ingest CLI).
- **Unit test suite** (`tests/**/*.test.ts`) using `node:test` — zero new runtime deps. 50 tests covering chunkers, search helpers, config, file-reader, and dispatch.
- **Integration test** (`tests/integration/end-to-end.test.ts`) that drives a real ingest + MCP server via the official `@modelcontextprotocol/sdk` Client against a live Weaviate. Runs in CI behind a slim `docker-compose.integration.yml`.
- **Coverage gate** via `c8`. Strict thresholds: lines 85% / statements 85% / branches 78% / functions 95%. CI fails on regression.
- **ESLint 9** (flat config) + **Prettier 3** with project-tuned rules and a CI `format:check` step.
- **Dependabot** config: weekly npm + GitHub-Actions updates, dev deps grouped to one PR.
- **`npm run all`** convenience script — runs the full local pipeline (`check:layers → lint → format:check → typecheck → coverage → build`), mirroring CI.
- **MCP client config examples** for Cursor, Cline, and Continue.dev in addition to Claude Desktop.
- **`ensureSchema(client, { reranker })`** option so the CodeChunk schema can be created against a Weaviate without the reranker module loaded.

### Changed

- `weaviate-client` pinned to `~3.12.1` (last version with Node-20 support). 3.13+ requires Node 22; we'll revisit when our engines floor moves.
- `pickChunker(...)` now takes a single options object (`{ content, filePath, project, language }`) instead of positional args.
- Java/C# method-detection regex character classes cleaned up — removed unnecessary `\[` escapes inside the classes.

### Known issues

- `npm audit` reports one moderate finding in a transitive `uuid` dep (CVE about `uuid.v3/v5/v6` buffer bounds when a `buf` argument is supplied). Not exploitable in ragolith — weaviate-client never passes that argument. Resolves naturally when we bump engines to Node ≥22 and pull `weaviate-client@3.13+`.

### Fixed

- Reranker module no longer required at schema-create time when `rerankerEnabled: false`. Previously `ensureSchema` would 422 if Weaviate didn't have `reranker-transformers` loaded, even when search would never request reranking.

### Initial scaffolding (carried forward)

- MCP server, ingest CLI, backup CLI.
- Weaviate schema: `CodeChunk`, `SymbolRecord`, `CallEdge`.
- Chunkers: TS/JS (AST), Java, C#, SQL, plus line-based fallback.
- File readers: PDF (pdfjs-dist), DOCX (mammoth), UTF-8.
- Search pipeline: classify → expand → hybrid → rerank → autocut → diversity.
- Incremental ingest via `git diff` against the last recorded commit SHA.
- Docker Compose stack: Weaviate 1.28 + MiniLM-L6 embedder + cross-encoder reranker.

[Unreleased]: https://github.com/vasyafomiuk/ragolith/commits/main
