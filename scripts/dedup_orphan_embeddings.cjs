#!/usr/bin/env node
const Database = require("better-sqlite3");
const sqliteVec = require("sqlite-vec");
const { join } = require("path");
const { homedir } = require("os");

const DB_PATH = join(homedir(), ".claude", "memory-server", "data", "memory.db");

const db = new Database(DB_PATH, { timeout: 30000 });
sqliteVec.load(db);
db.pragma("busy_timeout = 30000");

const orphans = db.prepare(`
  SELECT turn_id FROM turn_embeddings
  WHERE turn_id NOT IN (SELECT id FROM turns)
`).all();

console.log(`Found ${orphans.length} orphan embeddings`);

if (orphans.length > 0) {
  const del = db.prepare(`DELETE FROM turn_embeddings WHERE turn_id = ?`);
  const tx = db.transaction((rows) => {
    for (const o of rows) del.run(o.turn_id);
  });
  tx(orphans);
  console.log(`Deleted ${orphans.length} orphan embeddings`);
}

const remaining = db.prepare(`SELECT COUNT(*) AS c FROM turn_embeddings`).get();
console.log(`turn_embeddings now has ${remaining.c} rows`);

const gap = db.prepare(`
  SELECT COUNT(*) AS c FROM turns
  WHERE embed_status='done' AND id NOT IN (SELECT turn_id FROM turn_embeddings)
`).get();
console.log(`turns marked done but missing embedding: ${gap.c}`);

if (gap.c > 0) {
  const reset = db.prepare(`
    UPDATE turns SET embed_status='pending'
    WHERE embed_status='done' AND id NOT IN (SELECT turn_id FROM turn_embeddings)
  `).run();
  console.log(`Reset ${reset.changes} turns to pending so worker re-embeds them`);
}

db.close();
