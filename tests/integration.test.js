// End-to-end ingest -> recall test through the real worker pipeline.
// Hermetic: SQLITE_ONLY (no OpenAI) + an isolated temp DB via MEMORY_DB_PATH.
// Covers: dual-format parsing (Claude + Codex), schema bootstrap, turn storage,
// FTS (BM25) recall, source_kind attribution, and the active-thread code path
// that a past ReferenceError broke.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "mt-integ-"));
process.env.SQLITE_ONLY = "true";               // no network/OpenAI
process.env.MEMORY_DB_PATH = join(dir, "memory.db");

// Import AFTER env is set so worker.js picks up MEMORY_DB_PATH.
const { ingestThread, openDatabase } = await import("../worker.js");

function writeJsonl(name, rows) {
  const p = join(dir, name);
  writeFileSync(p, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
  return p;
}

// Multi-turn sessions (the pipeline skips trivial single-turn sessions by design).
const claudePath = writeJsonl("claude.jsonl", [
  { type: "user", uuid: "u1", timestamp: "2026-05-05T10:00:00.000Z",
    message: { role: "user", content: "How do I configure the widget fluxcapacitor for the ingestion pipeline?" } },
  { type: "assistant", uuid: "a1", timestamp: "2026-05-05T10:00:01.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "Set fluxcapacitor=1.21 in the widget config and restart the service to apply." }] } },
  { type: "user", uuid: "u2", timestamp: "2026-05-05T10:01:00.000Z",
    message: { role: "user", content: "Does that persist across reboots or do I need a launch agent?" } },
  { type: "assistant", uuid: "a2", timestamp: "2026-05-05T10:01:01.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "It persists in the config file, so it survives reboots without a launch agent." }] } },
]);

const codexPath = writeJsonl("rollout-codex.jsonl", [
  { timestamp: "2026-05-05T11:00:00.000Z", type: "session_meta",
    payload: { id: "codex-integ-1", cwd: "/tmp/proj", originator: "Codex Desktop" } },
  { timestamp: "2026-05-05T11:00:01.000Z", type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "What port does the zephyr service listen on by default?" }] } },
  { timestamp: "2026-05-05T11:00:02.000Z", type: "response_item",
    payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "The zephyr service listens on port 8420 unless overridden in the config." }] } },
  { timestamp: "2026-05-05T11:01:01.000Z", type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "How do I change the zephyr port to 9000?" }] } },
  { timestamp: "2026-05-05T11:01:02.000Z", type: "response_item",
    payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Set ZEPHYR_PORT=9000 in the environment and restart the zephyr service." }] } },
]);

const db = openDatabase(); // ensureCanonicalSchema runs here, on the fresh temp DB

await ingestThread(db, claudePath, "projhash", "TestProj", false, null, null);
await ingestThread(db, codexPath, "projhash", "TestProj", false, null, null);

// Turns stored
const turnCount = db.prepare("SELECT COUNT(*) c FROM turns").get().c;
assert.ok(turnCount >= 2, `expected >= 2 turns, got ${turnCount}`);

// Both platforms attributed correctly
const kinds = new Set(db.prepare("SELECT DISTINCT source_kind FROM threads").all().map(r => r.source_kind));
assert.ok(kinds.has("claude"), "Claude thread ingested with source_kind=claude");
assert.ok(kinds.has("codex"), "Codex thread ingested with source_kind=codex");

// Recall (BM25) finds content from BOTH platforms - the core promise
assert.ok(db.prepare("SELECT COUNT(*) c FROM turns_fts WHERE turns_fts MATCH 'fluxcapacitor'").get().c >= 1, "recall finds Claude content");
assert.ok(db.prepare("SELECT COUNT(*) c FROM turns_fts WHERE turns_fts MATCH 'zephyr'").get().c >= 1, "recall finds Codex content");

db.close();
console.log("integration tests passed");
