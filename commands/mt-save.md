---
description: Save the current Claude Code session as a named MemoryThread bookmark
argument-hint: "<name>"
---

Use the `save_thread` MCP tool to bookmark this session under the name `$ARGUMENTS`.

You will need to derive these arguments:
- `name`: `$ARGUMENTS` (the bookmark name)
- `session_id`: parse from your current transcript_path (the JSONL filename without `.jsonl`)
- `project_path`: your current working directory

After saving, confirm to the user with:
- The bookmark name
- The instruction: "Resume from any terminal with `mt launch`"
