// One-time maintenance: reclassify legacy threads with source_kind='unknown'
// using the SAME sourceKindFromPath() logic the live ingest pipeline uses, so
// historical rows match current behavior. Idempotent (only touches 'unknown').
//
// Run: node scripts/reclassify-source.mjs
import Database from "better-sqlite3";
import { homedir } from "os";
import { join } from "path";
import { sourceKindFromPath } from "../memory-schema.js";

const DB = process.env.MEMORY_DB_PATH || join(homedir(), ".claude", "memory-server", "data", "memory.db");
const db = new Database(DB);
db.pragma("busy_timeout = 5000");

const rows = db.prepare(
  "SELECT id, source_file FROM threads WHERE source_kind = 'unknown' AND source_file IS NOT NULL AND source_file != ''"
).all();

const upd = db.prepare("UPDATE threads SET source_kind = ? WHERE id = ?");
let claude = 0, codex = 0, stillUnknown = 0;
db.transaction(() => {
  for (const r of rows) {
    const kind = sourceKindFromPath(r.source_file);
    if (kind === "unknown") { stillUnknown++; continue; }
    upd.run(kind, r.id);
    if (kind === "claude") claude++; else codex++;
  }
})();

console.log(`Reclassified ${claude + codex} of ${rows.length} unknown threads: claude=${claude}, codex=${codex}, still-unknown=${stillUnknown}`);
const dist = db.prepare("SELECT source_kind, COUNT(*) c FROM threads GROUP BY source_kind ORDER BY c DESC").all();
console.log("Distribution now:", dist.map(r => `${r.source_kind}=${r.c}`).join(", "));
db.close();
