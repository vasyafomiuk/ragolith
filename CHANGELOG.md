# Changelog

All notable changes to this project are recorded here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial release scaffolding: MCP server, ingest CLI, backup CLI.
- Weaviate schema: `CodeChunk`, `SymbolRecord`, `CallEdge`.
- Chunkers: TS/JS (AST), Java, C#, SQL, plus line-based fallback.
- File readers: PDF (pdfjs-dist), DOCX (mammoth), UTF-8.
- Search pipeline: classify → expand → hybrid → rerank → autocut → diversity.
- Incremental ingest via `git diff` against the last recorded commit SHA.
- Docker Compose stack: Weaviate 1.28 + MiniLM-L6 embedder + cross-encoder reranker.

[Unreleased]: https://github.com/vasyafomiuk/ragolith/commits/main
