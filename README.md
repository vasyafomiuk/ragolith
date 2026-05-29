<p align="center">
  <img src="assets/ragolith.png" alt="ragolith" width="520">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/ragolith"><img src="https://img.shields.io/npm/v/ragolith" alt="npm"></a>
  <a href="https://github.com/vasyafomiuk/ragolith/actions/workflows/ci.yml"><img src="https://github.com/vasyafomiuk/ragolith/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/vasyafomiuk/ragolith/actions/workflows/ci.yml"><img src="https://img.shields.io/badge/coverage-%E2%89%A588%25-brightgreen" alt="Coverage: ≥88%"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node.js Version"></a>
  <a href="tsconfig.json"><img src="https://img.shields.io/badge/TypeScript-strict-blue" alt="TypeScript"></a>
</p>

# ragolith

A **tool-agnostic SDLC knowledge platform**: index everything across the software-development lifecycle — code, requirements, design decisions (ADRs), tickets, tests, runbooks, API specs — into Weaviate, then search it semantically, find traceability gaps, and plan modernization and monolith→microservices migrations. Exposed to any LLM client via **MCP (Model Context Protocol)** over stdio, plus CLIs and a localhost dashboard.

## What it does

- **Ingest** — clones git repos, walks files (respecting `.gitignore`), reads PDF/DOCX, dispatches to language-specific chunkers, and batch-inserts into Weaviate. Also ingests **SDLC artifacts** from a portable interchange format (see below).
- **Search** — hybrid (BM25 + vector) + cross-encoder rerank, classified alpha, autocut, diversity filter — over both code and SDLC artifacts.
- **Analyze** — `ragolith-analyze` finds **traceability gaps** (unimplemented requirements, untested code, orphan tests, dangling links), flags **modernization** targets (end-of-life runtimes + frameworks), and suggests **microservice seams** for monolith decomposition.
- **Serve** — an MCP server over stdio exposing 23 tools (search, find symbol, callers/callees, trace_flow, get full file, project structure, compare systems, tech stack, search_sdlc, list/get artifact, analyze_gaps, analyze_modernization, analyze_decomposition, …) for any MCP-aware LLM client.
- **Dashboard** — a localhost web UI (`ragolith-dashboard`) to browse indexed projects, run queries, edit `ragc.config.json`, kick off ingest/backup jobs with live progress, and check stack health.
- **Backup** — Weaviate filesystem backups with optional S3 push/pull.

Tool-agnostic by design: ragolith never calls Jira/Confluence/Linear/GitHub APIs. Any tool exports to **RSIF** (the Ragolith SDLC Interchange Format) and ragolith indexes that. All embeddings and reranking run locally in Docker — no external API keys needed.

## SDLC artifacts (RSIF)

Point ragolith at a directory of SDLC artifacts via the `sdlc` config section. Two portable encodings, both decoding to the same artifact shape:

- **Markdown + YAML frontmatter** (`.md`) — human- and git-friendly, one artifact per file:

  ```markdown
  ---
  id: REQ-001
  kind: requirement
  title: Users can reset their password via email
  status: done
  tags: [auth, security]
  links:
    - rel: implemented_by
      target: repo:webapp/src/auth/reset.ts
    - rel: tested_by
      target: TC-12
  ---

  As a registered user, I want to reset my password through an emailed link…
  ```

- **NDJSON / JSONL / JSON array** — lossless, machine-friendly bulk export (one artifact object per line).

`kind` is folded to a canonical vocabulary (requirement, story, epic, feature, decision, ticket, risk, test_case, runbook, api_spec, design_doc, meeting_note, incident, other) with aliases (`adr`→decision, `bug`→ticket, `openapi`→api_spec, …). `links` use a relationship vocabulary (`implements`, `implemented_by`, `tests`, `tested_by`, `depends_on`, `supersedes`, …) where targets are other artifact ids or code references (`repo:`/`symbol:`/`file:`). Those links are what gap analysis traverses. Write an adapter to convert any vendor export into RSIF — the format is the only integration contract.

## Analysis

```bash
ragolith-analyze gaps        # traceability holes across the SDLC graph
ragolith-analyze modernize   # end-of-life / legacy runtimes + frameworks
ragolith-analyze decompose --project <p>   # suggested microservice seams
```

- **gaps** — unimplemented requirements (high), implemented-but-untested (warning), accepted-but-unbuilt decisions, orphan tests, and dangling links. `--strict` exits non-zero on any high-severity gap, so it can gate CI.
- **modernize** — checks detected runtimes (Java 8, Node 16, Python 2, …) and frameworks (Spring Boot 2.x, AngularJS, Vue 2, legacy `javax.*` Java EE, …) against a curated knowledge table, each with an upgrade recommendation.
- **decompose** — builds a module dependency graph from call edges and reports per-module cohesion + Martin instability + fan-in/out, ranks the tightest cross-module couplings (migration friction), and suggests cohesive, loosely-coupled modules to extract first.

Each subcommand has a `--json` mode and a matching MCP tool (`analyze_gaps`, `analyze_modernization`, `analyze_decomposition`).

## Architecture

```
                                  stdio
   ┌─────────────┐    JSON-RPC   ┌─────────────────────┐
   │  MCP Client │ ────────────► │ MCP Server          │
   │  (LLM/IDE)  │               │ src/mcp/server.ts   │
   └─────────────┘               └──────────┬──────────┘
                                            │
   ┌─────────────┐                          │
   │  Ingest CLI │ ───────────────┐         │
   │ src/cli/    │                │         │
   └─────────────┘                │         │
                                  ▼         ▼
   ┌─────────────┐           ┌──────────────────────┐
   │  Dashboard  │ ────────► │ Weaviate 1.28        │
   │ src/dash... │  HTTP +   │ (Docker)             │
   └─────────────┘   gRPC    └──────────┬───────────┘
                                        ▲   ▲
                       ┌────────────────┘   │
                       │                    │
   ┌─────────────┐   ┌─┴────────────┐   ┌───┴──────────┐
   │  Git Repos  │   │ t2v-trans    │   │ reranker     │
   │  PDF/DOCX   │   │ MiniLM-L6    │   │ MiniLM       │
   └─────────────┘   └──────────────┘   └──────────────┘
```

## Components

| Component        | File                                  | Role                                                                                                           |
| ---------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| MCP Server       | `src/mcp/server.ts`                   | 17 search / structure / SDLC / analysis tools exposed to LLM clients                                           |
| Dashboard        | `src/dashboard/server.ts`             | Localhost web UI: browse projects, run searches, check stack health                                            |
| Manifest Scanner | `src/core/manifest-scan.ts`           | Detects frameworks + runtime versions from package.json / pom.xml / gradle / pyproject / requirements / csproj |
| Ingest CLI       | `src/cli/ingest.ts`                   | Clones repos, walks files, chunks, writes code + SDLC artifacts to Weaviate                                    |
| Analyze CLI      | `src/cli/analyze.ts`                  | gaps / modernize / decompose analyses over the SDLC + code graph                                               |
| RSIF Parser      | `src/core/sdlc.ts`                    | Parses the SDLC interchange format (Markdown+frontmatter, NDJSON, JSON)                                        |
| Analysis         | `src/core/analysis/`                  | Pure gap / modernization / decomposition engines                                                               |
| Backup CLI       | `src/cli/backup.ts`                   | Weaviate backup/restore + S3 push/pull                                                                         |
| AST Chunker      | `src/core/chunkers/ast-chunker.ts`    | TS/JS: splits at function/class boundaries, extracts symbols + call edges                                      |
| Java Chunker     | `src/core/chunkers/java-chunker.ts`   | tree-sitter via web-tree-sitter; annotations, generics, nested classes, records                                |
| C# Chunker       | `src/core/chunkers/csharp-chunker.ts` | tree-sitter via web-tree-sitter; attributes, file-scoped namespaces, records                                   |
| Other Chunkers   | `src/core/chunkers/tree-sitter.ts`    | Java, C#, Python, Go, Rust, Ruby, PHP — symbols + call edges via tree-sitter                                   |
| SQL Chunker      | `src/core/chunkers/sql-chunker.ts`    | Statement-boundary splitting                                                                                   |
| Fallback Chunker | `src/core/chunkers/chunker.ts`        | Line-based (~4000 chars, 4-line overlap)                                                                       |
| Dispatch         | `src/core/chunkers/dispatch.ts`       | Picks the right chunker per language                                                                           |
| File Reader      | `src/core/file-reader.ts`             | PDF (pdfjs-dist), DOCX (mammoth), UTF-8                                                                        |
| Git Manager      | `src/core/git-manager.ts`             | Clone/fetch/diff, token auth, push disabled                                                                    |
| Config           | `src/core/config.ts`                  | env > `ragc.config.json` > defaults                                                                            |
| Search           | `src/core/search.ts`                  | classify → expand → hybrid → rerank → autocut → diversity                                                      |
| Weaviate Client  | `src/core/weaviate-client.ts`         | Connection + collection schemas, batched deletes                                                               |

## Data model (Weaviate collections)

- **CodeChunk** — vectorized code/doc chunks with `file_path`, `project`, `lines`, `language`, `chunk_type`.
- **SymbolRecord** — function/class/method index with `name`, `kind`, `signature`, `parent`, `exports`.
- **CallEdge** — `caller → callee` edges with `call_type`, `file`, `line`. Extracted for **every chunked language** (TS/JS, C#, Java, Python, Go, Rust, Ruby, PHP). Powers `callers_of`/`callees_of` and the decomposition graph.
- **ProjectStack** — one row per project: detected `languages[]`, `build_tools[]`, `framework_names[]`, plus rich `frameworks_json` / `runtimes_json` / `manifests_json` blobs. Powers the `tech_stack` MCP tool and modernization analysis.
- **SdlcArtifact** — vectorized SDLC artifacts (requirements, decisions, tickets, tests, …) with `artifact_id`, `kind`, `title`, `status`, `source`, `project`, `tags`, `links_json` + denormalized `link_rels`/`link_targets` facets. Powers `search_sdlc` and gap analysis.

## Search pipeline

1. Classify query shape → select `alpha` (keyword vs semantic blend).
2. Expand query (camelCase split, synonyms).
3. Hybrid search (BM25 + vector) with 2× over-fetch.
4. Cross-encoder rerank (graceful fallback if unavailable).
5. Autocut at largest score gap.
6. Diversity filter (max 3 results per file).

## Ingest pipeline

1. Load config (`repos[]` for git repositories, `documents[]` for standalone files; legacy `projects`/`files` keys still accepted).
2. Clone/fetch repos via Git Manager.
3. Detect tech stack (manifests at repo root + `subPaths`) → upsert `ProjectStack`.
4. Detect incremental vs full (`git diff` since last SHA).
5. Walk files respecting `.gitignore` + extension filters.
6. Dispatch to language-specific chunker.
7. Prepend project context prefix to chunks.
8. Batch insert chunks/edges into Weaviate.
9. Record ingested commit SHA to `data.json`.

## Key design decisions

- **Hybrid search** — BM25 catches exact identifiers, vectors catch semantic intent.
- **Reranker** — cross-encoder reorders candidates for precision; fallback keeps system available.
- **AST chunking** — preserves function boundaries so results are self-contained.
- **Incremental ingest** — git diff avoids re-processing unchanged files.
- **Array `subPath`** — one project entry can index multiple monorepo subdirectories.
- **Stdio transport** — zero network config; MCP client spawns server as child process.
- **All local** — embeddings + reranking run in Docker, no external API keys needed.

## Install

### From npm (recommended)

```bash
npm install -g ragolith
```

This puts eight CLIs on your PATH: `ragolith-init`, `ragolith-server`, `ragolith-ingest`, `ragolith-backup`, `ragolith-dashboard`, `ragolith-doctor`, `ragolith-eval`, `ragolith-analyze`. No source clone needed.

### From source

```bash
git clone https://github.com/vasyafomiuk/ragolith.git
cd ragolith
npm install
npm run build
```

## Quick start (npm install)

```bash
# 1. install
npm install -g ragolith

# 2. interactive wizard creates ragc.config.json in $PWD
ragolith-init

# 3. download the docker-compose stack
curl -O https://raw.githubusercontent.com/vasyafomiuk/ragolith/main/docker-compose.yml

# 4. start the Weaviate + embedder + reranker stack
docker compose up -d

# 5. ingest your repos and docs
RAGOLITH_CONFIG=$PWD/ragc.config.json ragolith-ingest

# 6. browse the result
RAGOLITH_CONFIG=$PWD/ragc.config.json ragolith-dashboard --open

# 7. wire the MCP server into your client
#    command: ragolith-server
#    env:     RAGOLITH_CONFIG=/absolute/path/to/ragc.config.json
```

`ragolith-init` accepts `--yes` for scripted/CI use (writes a default config with no projects, you fill in `projects` and `files` later) and `--force` to overwrite an existing config without confirmation.

## Quick start (from source)

```bash
# 1. install + build
npm install
npm run build

# 2. start Weaviate + embedder + reranker containers
npm run weaviate:up

# 3. configure
cp ragc.config.example.json ragc.config.json
$EDITOR ragc.config.json

# 4. ingest
npm run ingest

# 5. wire the MCP server into your client
#    command: node /path/to/ragolith/dist/mcp/server.js
#    or:      npx tsx /path/to/ragolith/src/mcp/server.ts
```

## MCP client config

All MCP-aware clients use roughly the same shape — a `mcpServers` map keyed by name, with `command` + `args` + an optional `env`. The path you want is **`dist/mcp/server.js`** after `npm run build`. If you'd rather skip the build, point the command at `npx tsx /path/to/ragolith/src/mcp/server.ts`.

> All examples below assume you installed via `npm install -g ragolith`. If you cloned the repo instead, swap `"command": "ragolith-server"` for `"command": "node"` and add `"args": ["/absolute/path/to/ragolith/dist/mcp/server.js"]`.

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "ragolith": {
      "command": "ragolith-server",
      "env": {
        "RAGOLITH_CONFIG": "/absolute/path/to/ragc.config.json"
      }
    }
  }
}
```

### Cursor

`~/.cursor/mcp.json` for the global config, or `.cursor/mcp.json` at the workspace root:

```json
{
  "mcpServers": {
    "ragolith": {
      "command": "ragolith-server",
      "env": {
        "RAGOLITH_CONFIG": "/absolute/path/to/ragc.config.json"
      }
    }
  }
}
```

### Cline (VS Code extension)

VS Code Command Palette → "Cline: Open MCP Settings", which opens `~/.cline/mcp_settings.json`:

```json
{
  "mcpServers": {
    "ragolith": {
      "command": "ragolith-server",
      "env": {
        "RAGOLITH_CONFIG": "/absolute/path/to/ragc.config.json"
      },
      "disabled": false
    }
  }
}
```

### Continue.dev

`~/.continue/config.json` — add ragolith under `mcpServers`:

```json
{
  "mcpServers": [
    {
      "name": "ragolith",
      "command": "ragolith-server",
      "env": {
        "RAGOLITH_CONFIG": "/absolute/path/to/ragc.config.json"
      }
    }
  ]
}
```

### Smoke-testing without a client

Once wired, you can call any of the 23 tools through the client's tool UI:

- **Code & docs**: `search`, `search_code`, `search_docs`, `search_code_bulk`, `search_code_by_file`, `find_symbol`, `file_structure`, `read_chunk`, `get_full_file`, `get_project_structure`, `list_projects`, `list_files`, `tech_stack`
- **Call graph**: `callers_of`, `callees_of`, `trace_flow`
- **SDLC artifacts**: `search_sdlc`, `list_artifacts`, `get_artifact`
- **Analysis**: `analyze_gaps`, `analyze_modernization`, `analyze_decomposition`, `compare_systems`

The integration test in [`tests/integration/end-to-end.test.ts`](tests/integration/end-to-end.test.ts) shows the same calls made programmatically with the MCP SDK.

## Dashboard

A localhost web UI for browsing your index, debugging chunkers, and checking stack health — no MCP client needed.

```bash
ragolith-dashboard --open    # opens http://127.0.0.1:7777 in your browser
```

| Flag                | Default     | What it does                                                                                             |
| ------------------- | ----------- | -------------------------------------------------------------------------------------------------------- |
| `-p, --port <port>` | `7777`      | Port to listen on                                                                                        |
| `-h, --host <host>` | `127.0.0.1` | Bind host. Stays localhost-only by default — pass `0.0.0.0` only if you understand the network exposure. |
| `-o, --open`        | `false`     | Open the URL in your default browser on start                                                            |

The dashboard has six views:

- **Projects** — table of indexed projects with file/chunk counts, language breakdown, last-ingested commit SHA, and update time. Click a row to drill into per-file chunk counts.
- **Search** — runs the same hybrid pipeline as the MCP server. Optional project filter. Results show file path, line range, chunk type, language, score, and content excerpt. Useful for "why didn't my query return what I expected?"
- **Ingest** — wraps `ragolith-ingest`. "Index everything", re-index a single project, or run `--migrate-only` without leaving the browser. Force-full toggle, live stdout/stderr stream, idle/running/success/failed badge.
- **Backup** — wraps `ragolith-backup`. Create a snapshot with a chosen id, restore by id, run `verify` to round-trip the index, or push/pull a snapshot to/from S3 (requires `aws` CLI and `backup.s3.bucket`). Same live-streamed log as Ingest.
- **Config** — load, edit, and save `ragc.config.json` from a form (Weaviate connection, reranker toggle, projects[], standalone files[]) or a raw-JSON pane. Atomic writes (tmp + rename) so an interrupted save can't corrupt the file.
- **Health** — coloured indicators for Weaviate HTTP / gRPC reachability, embedder + reranker module presence, and ingest-state-file presence. Raw JSON dump expandable.

Ingest and Backup share a single Server-Sent Events stream (`/api/jobs/stream`), so only one CLI runs at a time (the second request returns 409) — both touch Weaviate and the dashboard is a single-user tool.

## Config precedence

`env > ragc.config.json > defaults`. Override the config path with `RAGOLITH_CONFIG`. Common env overrides: `WEAVIATE_HOST`, `WEAVIATE_HTTP_PORT`, `WEAVIATE_GRPC_PORT`, `GIT_TOKEN`.

## Testing

```bash
npm test                 # unit tests via node:test (zero deps, <1s)
npm run coverage         # same tests + c8 line/branch/function coverage
npm run coverage:open    # opens coverage/index.html in your browser
npm run check:layers     # asserts core/ doesn't depend on mcp/ or cli/

# Integration (requires Docker + a built dist/):
npm run weaviate:up      # start Weaviate + embedder + reranker
npm run build            # compile dist/
npm run test:integration # end-to-end via real MCP server + real Weaviate
```

Unit tests cover the chunkers, search helpers (`classifyAlpha`, `expandQuery`, `autocut`, `diversityFilter`), config loader, file-reader, and chunker dispatch. The integration test spins up a tiny git-repo fixture, runs the real ingest CLI, then drives the real MCP server over stdio with the official MCP client — covering the parts that have no unit tests (CLI, MCP server, Weaviate schema).

**Coverage gate.** CI fails if any of the following drops below the threshold:

| Metric     | Threshold | Current |
| ---------- | --------- | ------- |
| Lines      | 85%       | 88.8%   |
| Statements | 85%       | 88.8%   |
| Branches   | 78%       | 81.8%   |
| Functions  | 95%       | 97.6%   |

Files that need a live Weaviate (`weaviate-client.ts`, `cli/*`, `mcp/server.ts`) or real binaries (`file-reader.ts`, `git-manager.ts`) are excluded from the gate — they'll be covered by integration tests in a follow-up.

## Contributing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the dev loop, the `core / mcp / cli` layering rules, how to add a new chunker or MCP tool, and the code-style notes. By participating you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) © 2026 Vasyl Fomiuk
