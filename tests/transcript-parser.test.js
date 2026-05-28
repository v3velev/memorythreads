import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseTranscript, generateSourceThreadId } from "../transcript-parser.js";

const dir = mkdtempSync(join(tmpdir(), "mt-parser-"));

function writeJsonl(name, rows) {
  const path = join(dir, name);
  writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  return path;
}

const codexPath = writeJsonl("rollout-test.jsonl", [
  {
    timestamp: "2026-05-05T10:00:00.000Z",
    type: "session_meta",
    payload: {
      id: "codex-session-1",
      cwd: "/tmp/project",
      originator: "Codex Desktop",
    },
  },
  {
    timestamp: "2026-05-05T10:00:01.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "List my saved MemoryThreads." }],
    },
  },
  {
    timestamp: "2026-05-05T10:00:02.000Z",
    type: "response_item",
    payload: { type: "function_call", name: "list_threads", call_id: "call_1" },
  },
  {
    timestamp: "2026-05-05T10:00:03.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      phase: "commentary",
      content: [{ type: "output_text", text: "I am checking your saved threads." }],
    },
  },
  {
    timestamp: "2026-05-05T10:00:04.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: "You have three saved MemoryThreads." }],
    },
  },
  {
    timestamp: "2026-05-05T10:00:05.000Z",
    type: "compacted",
    payload: { reason: "test" },
  },
]);

const codex = await parseTranscript(codexPath);
assert.equal(codex.sourceKind, "codex");
assert.equal(codex.sourceSessionId, "codex-session-1");
assert.equal(codex.cwd, "/tmp/project");
assert.equal(codex.turns.length, 1);
assert.equal(codex.turns[0].user_content, "List my saved MemoryThreads.");
assert.equal(
  codex.turns[0].assistant_content,
  "I am checking your saved threads.\n\nYou have three saved MemoryThreads."
);
assert.equal(codex.turns[0].tool_calls_count, 1);
assert.equal(codex.compactMarkers.length, 1);

const stableA = generateSourceThreadId("codex", "codex-session-1", codexPath, codex.turns);
const stableB = generateSourceThreadId("codex", "codex-session-1", codexPath, []);
assert.equal(stableA, stableB);

const claudePath = writeJsonl("claude-session.jsonl", [
  {
    uuid: "u1",
    timestamp: "2026-05-05T11:00:00.000Z",
    type: "user",
    message: { content: "Fix the hook." },
  },
  {
    uuid: "a1",
    timestamp: "2026-05-05T11:00:01.000Z",
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Reading it now." },
        { type: "tool_use", name: "Read", input: { file_path: "hook.sh" } },
      ],
    },
  },
  { type: "summary", leafUuid: "leaf-1", summary: "Hook work summary" },
]);

const claude = await parseTranscript(claudePath);
assert.equal(claude.sourceKind, "claude");
assert.equal(claude.sourceSessionId, "claude-session");
assert.equal(claude.turns.length, 1);
assert.equal(claude.turns[0].assistant_content, "Reading it now.");
assert.equal(claude.turns[0].tool_calls_count, 1);
assert.equal(claude.summaries.length, 1);

const emptyCodexPath = writeJsonl("empty-codex.jsonl", [
  { timestamp: "2026-05-05T12:00:00.000Z", type: "session_meta", payload: { id: "empty", cwd: "/tmp/project" } },
]);
const emptyCodex = await parseTranscript(emptyCodexPath);
assert.equal(emptyCodex.sourceKind, "codex");
assert.equal(emptyCodex.turns.length, 0);

console.log("transcript parser tests passed");
