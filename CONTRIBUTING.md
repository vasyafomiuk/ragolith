# Contributing to ragolith

Thanks for your interest — patches, bug reports, and new chunkers are all welcome.

## Quick start

```bash
git clone https://github.com/vasyafomiuk/ragolith.git
cd ragolith
npm install
npm run weaviate:up      # starts Weaviate + embedder + reranker in Docker
cp ragc.config.example.json ragc.config.json
$EDITOR ragc.config.json
npm run ingest           # populate the index
npm run server           # spin up the MCP server (stdio)
```

## Project layout

```
src/
├── core/          ← pure library: types, config, weaviate schema, search, chunkers
│   └── chunkers/  ← one file per language + a dispatch function
├── mcp/           ← MCP-over-stdio adapter (server.ts only)
└── cli/           ← ingest + backup CLIs
```

**Layering rules**, enforced by `npm run check:layers`:
- `core/` MUST NOT import from `mcp/` or `cli/`.
- `mcp/` MUST NOT import from `cli/` (and vice versa).
- `core/` is the only thing exported by the `exports` map in [`package.json`](package.json) — treat reaching into a sub-path as internal.

When in doubt, the contracts between layers are the types in [`src/core/types.ts`](src/core/types.ts).

## Before you open a PR

```bash
npm run check:layers     # must pass — no inter-layer leaks
npm run typecheck        # must pass
npm test                 # must pass
npm run build            # must succeed
```

CI runs all four on Node 20 and Node 22.

## Tests

The test suite uses Node's built-in `node:test` runner — zero extra dependencies. Files live under `tests/`, mirroring `src/`:

```
tests/
├── chunkers/                # one *.test.ts per chunker
├── config.test.ts
├── dispatch.test.ts
├── file-reader.test.ts
└── search.test.ts
```

Run a single test file directly:

```bash
node --import tsx --test tests/chunkers/sql-chunker.test.ts
```

Add tests for any new chunker or pure helper. Anything that needs Weaviate or the network goes behind an `// integration:` tag — keep `npm test` fast (currently <1s).

If your change touches the search pipeline or chunkers, please describe the index/query you tested it against in the PR body. A 10-line reproducer is worth more than a long argument.

## Adding a new language chunker

1. Create `src/<lang>-chunker.ts` exporting a function that returns `ChunkResult`.
2. Wire it up in the `pickChunker` switch in [`src/ingest.ts`](src/ingest.ts).
3. Add the extension(s) to `EXT_LANG` in [`src/file-reader.ts`](src/file-reader.ts) and to the default `extensions` list in [`src/config.ts`](src/config.ts).
4. Add a row to the Components table in the README.

A chunker may emit `symbols` and `edges` if structurally meaningful; if not, returning just `chunks` is fine. When in doubt, fall back to `chunkFallback` for content the parser doesn't understand — keeping ingestion total.

## Adding a new MCP tool

1. Add a `server.tool(name, description, schema, handler)` block in [`src/server.ts`](src/server.ts).
2. Use `zod` for the input schema. Describe each field — MCP clients show those descriptions to the model.
3. Return a `jsonResult(value)`; clients render text blocks.
4. Keep tools small and orthogonal — composition belongs in the LLM client, not here.

## Reporting bugs

Include the Weaviate version (the docker-compose pins 1.28), Node version, the config snippet (with secrets redacted), and the smallest input that reproduces. Crashes inside a chunker — please attach a snippet of the file, not the whole file.

## Code style

- TypeScript strict mode is on. New code must typecheck without `any` unless you leave a comment explaining why.
- Comments explain *why*, not *what*. The code already says *what*.
- Match the surrounding code's idioms — file headers, error formatting, log prefixes.

## Releases

Versioned via [SemVer](https://semver.org). Bumps and changelog entries live in [CHANGELOG.md](CHANGELOG.md).
