# Changelog

All notable changes to this project are recorded here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
