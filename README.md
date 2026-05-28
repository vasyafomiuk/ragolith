<p align="center">
  <img src="assets/ragolith.png" alt="ragolith" width="520">
</p>

<p align="center">
  <a href="https://github.com/vasyafomiuk/ragolith/actions/workflows/ci.yml"><img src="https://github.com/vasyafomiuk/ragolith/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node.js Version"></a>
  <a href="tsconfig.json"><img src="https://img.shields.io/badge/TypeScript-strict-blue" alt="TypeScript"></a>
</p>

# ragolith

A RAG pipeline that indexes git repositories and documents into Weaviate, then exposes semantic search to LLM clients via **MCP (Model Context Protocol)** over stdio.

## What it does

- **Ingest** — clones git repos, walks files (respecting `.gitignore`), reads PDF/DOCX, dispatches to language-specific chunkers, and batch-inserts into Weaviate.
- **Search** — hybrid (BM25 + vector) + cross-encoder rerank, classified alpha, autocut, diversity filter.
- **Serve** — an MCP server over stdio that exposes ~10 tools (search, find symbol, file structure, callers/callees, etc.) for any MCP-aware LLM client.
- **Backup** — Weaviate filesystem backups with optional S3 push/pull.

All embeddings and reranking run locally in Docker — no external API keys needed.

## Architecture

```
                                stdio
   ┌─────────────┐   JSON-RPC   ┌──────────────────┐
   │  MCP Client │ ───────────► │ MCP Server       │
   │  (LLM/IDE)  │              │ src/server.ts    │
   └─────────────┘              └────────┬─────────┘
                                         │ HTTP + gRPC
   ┌─────────────┐                       ▼
   │  Ingest CLI │ ─── HTTP + gRPC ── ► ┌──────────────────┐
   │ src/ingest  │                      │ Weaviate 1.28    │
   └─────────────┘                      │ (Docker)         │
                                        └──────────────────┘
                                              ▲   ▲
                       ┌──────────────────────┘   │
                       │                          │
   ┌─────────────┐   ┌─┴────────────┐   ┌─────────┴────┐
   │  Git Repos  │   │ t2v-trans    │   │ reranker     │
   │  PDF/DOCX   │   │ MiniLM-L6    │   │ MiniLM       │
   └─────────────┘   └──────────────┘   └──────────────┘
```

## Components

| Component        | File                                  | Role                                                                      |
| ---------------- | ------------------------------------- | ------------------------------------------------------------------------- |
| MCP Server       | `src/mcp/server.ts`                   | 10 search/structure tools exposed to LLM clients                          |
| Ingest CLI       | `src/cli/ingest.ts`                   | Clones repos, walks files, chunks, writes to Weaviate                     |
| Backup CLI       | `src/cli/backup.ts`                   | Weaviate backup/restore + S3 push/pull                                    |
| AST Chunker      | `src/core/chunkers/ast-chunker.ts`    | TS/JS: splits at function/class boundaries, extracts symbols + call edges |
| Java Chunker     | `src/core/chunkers/java-chunker.ts`   | Regex-based class/method splitting                                        |
| C# Chunker       | `src/core/chunkers/csharp-chunker.ts` | Regex-based namespace/class/method splitting                              |
| SQL Chunker      | `src/core/chunkers/sql-chunker.ts`    | Statement-boundary splitting                                              |
| Fallback Chunker | `src/core/chunkers/chunker.ts`        | Line-based (~4000 chars, 4-line overlap)                                  |
| Dispatch         | `src/core/chunkers/dispatch.ts`       | Picks the right chunker per language                                      |
| File Reader      | `src/core/file-reader.ts`             | PDF (pdfjs-dist), DOCX (mammoth), UTF-8                                   |
| Git Manager      | `src/core/git-manager.ts`             | Clone/fetch/diff, token auth, push disabled                               |
| Config           | `src/core/config.ts`                  | env > `ragc.config.json` > defaults                                       |
| Search           | `src/core/search.ts`                  | classify → expand → hybrid → rerank → autocut → diversity                 |
| Weaviate Client  | `src/core/weaviate-client.ts`         | Connection + collection schemas, batched deletes                          |

## Data model (Weaviate collections)

- **CodeChunk** — vectorized code/doc chunks with `file_path`, `project`, `lines`, `language`, `chunk_type`.
- **SymbolRecord** — function/class/method index with `name`, `kind`, `signature`, `parent`, `exports`.
- **CallEdge** — `caller → callee` edges with `call_type`, `file`, `line` (TS/JS only).

## Search pipeline

1. Classify query shape → select `alpha` (keyword vs semantic blend).
2. Expand query (camelCase split, synonyms).
3. Hybrid search (BM25 + vector) with 2× over-fetch.
4. Cross-encoder rerank (graceful fallback if unavailable).
5. Autocut at largest score gap.
6. Diversity filter (max 3 results per file).

## Ingest pipeline

1. Load config (projects + standalone files).
2. Clone/fetch repos via Git Manager.
3. Detect incremental vs full (`git diff` since last SHA).
4. Walk files respecting `.gitignore` + extension filters.
5. Dispatch to language-specific chunker.
6. Prepend project context prefix to chunks.
7. Batch insert chunks/edges into Weaviate.
8. Record ingested commit SHA to `data.json`.

## Key design decisions

- **Hybrid search** — BM25 catches exact identifiers, vectors catch semantic intent.
- **Reranker** — cross-encoder reorders candidates for precision; fallback keeps system available.
- **AST chunking** — preserves function boundaries so results are self-contained.
- **Incremental ingest** — git diff avoids re-processing unchanged files.
- **Array `subPath`** — one project entry can index multiple monorepo subdirectories.
- **Stdio transport** — zero network config; MCP client spawns server as child process.
- **All local** — embeddings + reranking run in Docker, no external API keys needed.

## Quick start

```bash
# 1. install
npm install

# 2. start Weaviate + embedding + reranker containers
npm run weaviate:up

# 3. configure (edit ragc.config.json — see ragc.config.example.json)
cp ragc.config.example.json ragc.config.json
$EDITOR ragc.config.json

# 4. ingest your repos and docs
npm run ingest

# 5. wire the MCP server into your client (e.g. Claude Desktop)
#    Point its config at:  npx tsx /path/to/ragolith/src/server.ts
#    or after `npm run build`:  node /path/to/ragolith/dist/server.js
```

## MCP client config

Example `claude_desktop_config.json` entry:

```json
{
  "mcpServers": {
    "ragolith": {
      "command": "node",
      "args": ["/absolute/path/to/ragolith/dist/server.js"],
      "env": {
        "RAGOLITH_CONFIG": "/absolute/path/to/ragolith/ragc.config.json"
      }
    }
  }
}
```

## Config precedence

`env > ragc.config.json > defaults`. Override the config path with `RAGOLITH_CONFIG`. Common env overrides: `WEAVIATE_HOST`, `WEAVIATE_HTTP_PORT`, `WEAVIATE_GRPC_PORT`, `GIT_TOKEN`.

## Testing

```bash
npm test                 # unit tests via node:test (zero deps, <1s)
npm run check:layers     # asserts core/ doesn't depend on mcp/ or cli/
```

Tests cover the chunkers, search helpers (`classifyAlpha`, `expandQuery`, `autocut`, `diversityFilter`), config loader, file-reader, and chunker dispatch. End-to-end tests that need a running Weaviate are integration-only — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Contributing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the dev loop, the `core / mcp / cli` layering rules, how to add a new chunker or MCP tool, and the code-style notes. By participating you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) © 2026 Vasyl Fomiuk
