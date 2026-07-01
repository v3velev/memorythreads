---
description: Ingest a reference doc (URL, llms.txt, or local file) into MemoryThreads
argument-hint: "<source> [tags]"
---

Parse `$ARGUMENTS` as `<source> [tags]`:
- `source` = the first whitespace-delimited token (URL or absolute file path)
- `tags` = the remainder (optional, comma-separated)

Call the `ingest_doc` MCP tool with those values and report the result.

Examples:
- `/mt-doc-ingest https://example.com/llms.txt api,reference`
- `/mt-doc-ingest ~/docs/architecture.md architecture,reference`
