# Changelog

All notable changes to this project are recorded here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

- `pickChunker(...)` now takes a single options object (`{ content, filePath, project, language }`) instead of positional args.
- Java/C# method-detection regex character classes cleaned up — removed unnecessary `\[` escapes inside the classes.

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
