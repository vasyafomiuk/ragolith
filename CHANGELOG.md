# Changelog

All notable changes to this project are recorded here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
