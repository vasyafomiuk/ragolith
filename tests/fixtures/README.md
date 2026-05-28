# Test fixtures

Small documents used by `tests/file-reader.test.ts` to exercise the PDF and DOCX read paths in `src/core/file-reader.ts`.

| File          | Size    | Source                                                  |
| ------------- | ------- | ------------------------------------------------------- |
| `sample.txt`  | ~380 B  | hand-written                                            |
| `sample.docx` | ~3.7 KB | `textutil -convert docx -output sample.docx sample.txt` |
| `sample.pdf`  | ~17 KB  | `cupsfilter sample.txt > sample.pdf`                    |

Both `textutil` and `cupsfilter` are macOS-only, but the resulting files are platform-agnostic — once committed, the fixtures work in CI on Linux just fine. If you need to regenerate them on a non-macOS box, any equivalent tool that produces a valid Office Open XML `.docx` and a text-based PDF will work. The tests only assert that two recognizable marker phrases survive the read — they aren't sensitive to the exact byte layout.

## Updating fixtures

```bash
# Regenerate from sample.txt (macOS)
textutil -convert docx -output tests/fixtures/sample.docx tests/fixtures/sample.txt
cupsfilter tests/fixtures/sample.txt > tests/fixtures/sample.pdf 2>/dev/null
```

If you change the marker phrases in `sample.txt`, update the corresponding `assert.match(...)` calls in `tests/file-reader.test.ts`.
