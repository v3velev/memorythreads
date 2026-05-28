import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import OpenAI from "openai";
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import { execFile, execFileSync } from "child_process";
import { createHash } from "crypto";
import { z } from "zod";
import { get as httpsGet } from "https";
import { get as httpGet } from "http";
import { ensureCanonicalSchema, setActiveCanonicalThread } from "./memory-schema.js";

// ── Constants ────────────────────────────────────────────────────────────────

const HOME = homedir();
const SERVER_DIR = join(HOME, ".claude", "memory-server");
const DB_PATH = join(SERVER_DIR, "data", "memory.db");
const PROJECTS_DIR = join(HOME, ".claude", "projects");
const SNAPSHOTS_DIR = join(SERVER_DIR, "snapshots");
const WORKER_PID_FILE = join(SERVER_DIR, "worker.pid");
const ENV_PATH = join(SERVER_DIR, ".env");

mkdirSync(join(SERVER_DIR, "data"), { recursive: true });
mkdirSync(join(SERVER_DIR, "logs"), { recursive: true });
mkdirSync(SNAPSHOTS_DIR, { recursive: true });

// 4 active types + legacy types for existing atoms
const KNOWLEDGE_TYPES = [
  "preference", "decision", "correction", "insight",
  // Legacy types - no new atoms use these, but existing atoms still need them
  "fact", "pattern", "architecture", "tool_config",
  "debugging", "reasoning_chain", "workaround", "anti_pattern",
];

const TYPE_CONFIG = {
  preference:      { ttl: Infinity, decay_rate: 0.15 },
  decision:        { ttl: Infinity, decay_rate: 0.15 },
  correction:      { ttl: Infinity, decay_rate: 0.20 },
  insight:         { ttl: 180,      decay_rate: 0.25 },
  // Legacy types
  architecture:    { ttl: Infinity, decay_rate: 0.15 },
  pattern:         { ttl: 180,      decay_rate: 0.30 },
  reasoning_chain: { ttl: 180,      decay_rate: 0.30 },
  anti_pattern:    { ttl: 180,      decay_rate: 0.30 },
  debugging:       { ttl: 90,       decay_rate: 0.40 },
  fact:            { ttl: 90,       decay_rate: 0.40 },
  workaround:      { ttl: 90,       decay_rate: 0.40 },
  tool_config:     { ttl: 90,       decay_rate: 0.40 },
};

// Concept enrichment map for write-time tag enrichment
const CONCEPT_MAP = {
  "auth|login|signin|oauth|token|session|credential": "authentication login auth access identity",
  "api|endpoint|rest|graphql|request|response|fetch": "api endpoint http integration backend",
  "error|exception|crash|fail|bug|broken|throw": "error failure bug problem exception",
  "database|sql|query|migration|schema|table|postgres|sqlite|supabase": "database sql data storage persistence",
  "test|spec|assert|expect|mock|stub|jest|vitest": "test testing assertion mock verification",
  "deploy|ci|cd|pipeline|build|release|docker|vercel": "deployment cicd pipeline build release",
  "cache|redis|memcache|invalidat": "cache caching invalidation performance",
  "react|component|hook|state|props|render|jsx|tsx": "react component frontend ui rendering",
  "route|router|navigate|path|url|link|page": "routing navigation url path page",
  "style|css|tailwind|class|theme|color|font": "styling css design theme visual",
  "git|commit|branch|merge|push|pull|rebase": "git version-control branch commit",
  "env|environment|config|setting|variable|secret|key": "configuration environment setup settings",
  "type|interface|generic|typescript|enum|union": "typescript types typing interface",
  "async|await|promise|callback|concurrent|parallel": "async asynchronous concurrency promise",
};

const TOKEN_BUDGETS = {
  recall_default: 3000,
  expand_soft_cap: 10000,
};

// ── .env Loader ──────────────────────────────────────────────────────────────

function loadEnv() {
  if (!existsSync(ENV_PATH)) return;
  const lines = readFileSync(ENV_PATH, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

loadEnv();

// ── Mode Flags ───────────────────────────────────────────────────────────────
// SQLITE_ONLY disables all OpenAI embedding calls AND blocks new atom writes.
// Search falls back to BM25/FTS only; existing atoms remain readable.
const SQLITE_ONLY = (process.env.SQLITE_ONLY || "").toLowerCase() === "true";

// ── OpenAI Client ────────────────────────────────────────────────────────────

let openaiClient = null;

function getOpenAI() {
  if (SQLITE_ONLY) return null;
  if (!openaiClient && process.env.OPENAI_API_KEY) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

// ── Embedding LRU Cache ─────────────────────────────────────────────────────

const embeddingCache = new Map();
const CACHE_MAX = 20;

function serializeEmbedding(vec) {
  return Buffer.from(new Float32Array(vec).buffer);
}

async function generateQueryEmbedding(text) {
  const cached = embeddingCache.get(text);
  if (cached) return cached;

  const client = getOpenAI();
  if (!client) return null;

  try {
    const response = await client.embeddings.create({
      model: "text-embedding-3-small",
      input: [text],
      dimensions: 1536,
    });
    const vec = response.data[0].embedding;

    // LRU eviction
    if (embeddingCache.size >= CACHE_MAX) {
      const oldest = embeddingCache.keys().next().value;
      embeddingCache.delete(oldest);
    }
    embeddingCache.set(text, vec);
    return vec;
  } catch (err) {
    console.error(`[memory] Embedding error: ${err.message}`);
    return null;
  }
}

// ── Database Setup ───────────────────────────────────────────────────────────

function initDb() {
  const db = new Database(DB_PATH, { timeout: 5000 });
  loadSqliteVec(db);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  ensureCanonicalSchema(db);

  // Archive tables (kept for backward compat)
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      file_path TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      session_id TEXT,
      first_timestamp TEXT,
      last_timestamp TEXT,
      message_count INTEGER DEFAULT 0,
      file_mtime REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_file TEXT NOT NULL,
      session_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT,
      project TEXT NOT NULL,
      FOREIGN KEY (session_file) REFERENCES sessions(file_path)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      content='messages',
      content_rowid='id',
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
  `);

  // Injection cache for vector-quality matching in hooks
  db.exec(`
    CREATE TABLE IF NOT EXISTS injection_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      atom_id INTEGER NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
      score REAL NOT NULL,
      context_type TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project, atom_id, context_type)
    );
    CREATE INDEX IF NOT EXISTS idx_injection_cache_project ON injection_cache(project, context_type);
  `);

  // Repeat events - tracks when problems recurred despite existing atoms
  db.exec(`
    CREATE TABLE IF NOT EXISTS repeat_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_thread_id TEXT NOT NULL,
      similar_atom_id INTEGER NOT NULL REFERENCES knowledge(id),
      description TEXT NOT NULL,
      detected_at TEXT DEFAULT (datetime('now')),
      resolved INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_repeat_events_atom ON repeat_events(similar_atom_id);
    CREATE INDEX IF NOT EXISTS idx_repeat_events_thread ON repeat_events(session_thread_id);
  `);

  // Ensure non-stemmed FTS5 index exists (for exact identifier matching)
  try {
    db.prepare("SELECT 1 FROM knowledge_fts_exact LIMIT 0").run();
  } catch {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts_exact USING fts5(
        content, tags,
        content='knowledge',
        content_rowid='id',
        tokenize='unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS knowledge_fts_exact_ai AFTER INSERT ON knowledge BEGIN
        INSERT INTO knowledge_fts_exact(rowid, content, tags)
        VALUES (new.id, new.content, COALESCE(new.tags,''));
      END;

      CREATE TRIGGER IF NOT EXISTS knowledge_fts_exact_ad AFTER DELETE ON knowledge BEGIN
        INSERT INTO knowledge_fts_exact(knowledge_fts_exact, rowid, content, tags)
        VALUES ('delete', old.id, old.content, COALESCE(old.tags,''));
      END;

      CREATE TRIGGER IF NOT EXISTS knowledge_fts_exact_au AFTER UPDATE ON knowledge BEGIN
        INSERT INTO knowledge_fts_exact(knowledge_fts_exact, rowid, content, tags)
        VALUES ('delete', old.id, old.content, COALESCE(old.tags,''));
        INSERT INTO knowledge_fts_exact(rowid, content, tags)
        VALUES (new.id, new.content, COALESCE(new.tags,''));
      END;
    `);
    // Populate from existing data
    const atoms = db.prepare("SELECT id, content, tags FROM knowledge WHERE status = 'active'").all();
    const ins = db.prepare("INSERT INTO knowledge_fts_exact(rowid, content, tags) VALUES (?, ?, ?)");
    db.transaction(() => {
      for (const a of atoms) ins.run(a.id, a.content, a.tags || "");
    })();
  }

  return db;
}

// ── Scope Detection ──────────────────────────────────────────────────────────

function detectScope(content) {
  const lower = content.toLowerCase();
  const globalSignals = [
    /always use\b/i, /never use\b/i, /i prefer\b/i, /my preference/i,
    /my convention/i, /my style/i, /my rule/i, /our standard/i,
    /for all\b.*project/i, /every project/i, /across all/i,
    /coding style/i, /coding convention/i,
  ];
  const projectSignals = [
    /this project/i, /this app/i, /this codebase/i, /this repo/i,
    /our project/i, /our app/i, /our codebase/i,
    /src\//i, /components?\//i, /pages?\//i,
    /configured in\s+\w+\.(json|yaml|toml|yml)/i,
  ];

  const globalScore = globalSignals.filter(r => r.test(lower)).length;
  const projectScore = projectSignals.filter(r => r.test(lower)).length;

  if (globalScore > projectScore) return "global";
  return "project";
}

// ── Worker Health Check ─────────────────────────────────────────────────────

function ensureWorkerRunning() {
  try {
    if (existsSync(WORKER_PID_FILE)) {
      const pid = parseInt(readFileSync(WORKER_PID_FILE, "utf-8").trim());
      try {
        process.kill(pid, 0);
        return;
      } catch {
        // pid is dead
      }
    }

    const worker = execFile("node", [join(SERVER_DIR, "worker.js")], {
      cwd: SERVER_DIR,
      detached: true,
      stdio: "ignore",
    });
    worker.on("error", () => {}); // Prevent unhandled error on spawn failure
    worker.unref();
    console.error(`[memory] Spawned worker process`);
  } catch (err) {
    console.error(`[memory] Failed to ensure worker: ${err.message}`);
  }
}

// ── Concept Enrichment ──────────────────────────────────────────────────────

function enrichConcepts(text) {
  const lower = text.toLowerCase();
  const concepts = new Set();

  for (const [pattern, expansion] of Object.entries(CONCEPT_MAP)) {
    if (new RegExp(pattern, "i").test(lower)) {
      for (const term of expansion.split(" ")) {
        concepts.add(term);
      }
    }
  }

  return concepts.size > 0 ? [...concepts].join(" ") : null;
}

// ── Hybrid Search Pipeline ──────────────────────────────────────────────────

async function hybridSearchAtoms(db, query, { project, type, limit = 10, since, until, files }) {
  // Step 1: Generate query embedding
  const queryEmbedding = await generateQueryEmbedding(query);

  // Step 2: BM25 search on knowledge_fts (stemmed, top 30)
  let bm25Results = [];
  try {
    const ftsQuery = sanitizeFtsQuery(query);
    if (ftsQuery) {
      let sql = `
        SELECT k.*, rank
        FROM knowledge_fts
        JOIN knowledge k ON knowledge_fts.rowid = k.id
        WHERE knowledge_fts MATCH ? AND k.status = 'active'
      `;
      const params = [ftsQuery];

      if (project && project !== '*') {
        sql += " AND (k.project = ? OR k.scope = 'global')";
        params.push(project);
      }
      if (type) {
        sql += " AND k.type = ?";
        params.push(type);
      }
      sql += " ORDER BY rank LIMIT 30";

      bm25Results = db.prepare(sql).all(...params);
    }
  } catch (err) {
    console.error(`[memory] BM25 search error: ${err.message}`);
  }

  // Step 2b: Non-stemmed FTS5 search on knowledge_fts_exact (top 30)
  // Catches identifiers like useInfiniteQuery that Porter stemming mangles
  let exactResults = [];
  try {
    const ftsQuery = sanitizeFtsQuery(query);
    if (ftsQuery) {
      let sql = `
        SELECT k.*, rank
        FROM knowledge_fts_exact
        JOIN knowledge k ON knowledge_fts_exact.rowid = k.id
        WHERE knowledge_fts_exact MATCH ? AND k.status = 'active'
      `;
      const params = [ftsQuery];

      if (project && project !== '*') {
        sql += " AND (k.project = ? OR k.scope = 'global')";
        params.push(project);
      }
      if (type) {
        sql += " AND k.type = ?";
        params.push(type);
      }
      sql += " ORDER BY rank LIMIT 30";

      exactResults = db.prepare(sql).all(...params);
    }
  } catch (err) {
    console.error(`[memory] Exact FTS search error: ${err.message}`);
  }

  // Step 3: Vector KNN on knowledge_embeddings (top 30)
  let vectorResults = [];
  if (queryEmbedding) {
    try {
      const buf = serializeEmbedding(queryEmbedding);
      const knnRows = db.prepare(`
        SELECT atom_id, distance
        FROM knowledge_embeddings
        WHERE embedding MATCH ?
        ORDER BY distance
        LIMIT 30
      `).all(buf);

      // Fetch full atom data for KNN results
      if (knnRows.length > 0) {
        const ids = knnRows.map(r => r.atom_id);
        const placeholders = ids.map(() => "?").join(",");
        let sql = `SELECT * FROM knowledge WHERE id IN (${placeholders}) AND status = 'active'`;
        const params = [...ids];
        if (project && project !== '*') {
          sql += " AND (project = ? OR scope = 'global')";
          params.push(project);
        }
        if (type) {
          sql += " AND type = ?";
          params.push(type);
        }

        const atomMap = new Map();
        for (const a of db.prepare(sql).all(...params)) {
          atomMap.set(a.id, a);
        }

        vectorResults = knnRows
          .filter(r => atomMap.has(r.atom_id))
          .map(r => ({ ...atomMap.get(r.atom_id), distance: r.distance }));
      }
    } catch (err) {
      console.error(`[memory] Vector search error: ${err.message}`);
    }
  }

  // Step 4: RRF merge (k=15) - 3 signals: stemmed BM25, exact BM25, vector
  const scoreMap = new Map();
  const K = 15;

  for (let i = 0; i < bm25Results.length; i++) {
    const r = bm25Results[i];
    const score = 1.0 / (K + i + 1);
    scoreMap.set(r.id, { ...r, rrf: score });
  }
  for (let i = 0; i < exactResults.length; i++) {
    const r = exactResults[i];
    const existing = scoreMap.get(r.id);
    const score = 1.0 / (K + i + 1);
    if (existing) {
      existing.rrf += score;
    } else {
      scoreMap.set(r.id, { ...r, rrf: score });
    }
  }
  for (let i = 0; i < vectorResults.length; i++) {
    const r = vectorResults[i];
    const existing = scoreMap.get(r.id);
    const score = 1.0 / (K + i + 1);
    if (existing) {
      existing.rrf += score;
    } else {
      scoreMap.set(r.id, { ...r, rrf: score });
    }
  }

  let results = [...scoreMap.values()];

  // Step 5: File relevance boost (post-RRF)
  if (files && files.length > 0) {
    const fileNames = files.map(f => basename(f).replace(/\.[^.]*$/, "").toLowerCase());
    for (const r of results) {
      const contentLower = (r.content || "").toLowerCase();
      if (fileNames.some(fn => contentLower.includes(fn))) {
        r.rrf *= 1.15;
      }
    }
  }

  // Step 5b: Term-interaction re-ranker (lightweight cross-encoder approximation)
  // Computes query-document term overlap to boost results with strong lexical match
  {
    const queryTokens = query.toLowerCase().split(/\W+/).filter(t => t.length >= 3);
    const queryBigrams = [];
    for (let i = 0; i < queryTokens.length - 1; i++) {
      queryBigrams.push(queryTokens[i] + " " + queryTokens[i + 1]);
    }
    const querySet = new Set(queryTokens);

    for (const r of results) {
      const docTokens = (r.content || "").toLowerCase().split(/\W+/).filter(t => t.length >= 3);
      const docSet = new Set(docTokens);

      // Unigram overlap: fraction of query terms found in doc
      let unigramHits = 0;
      for (const qt of querySet) {
        if (docSet.has(qt)) unigramHits++;
      }
      const unigramScore = querySet.size > 0 ? unigramHits / querySet.size : 0;

      // Bigram overlap: fraction of query bigrams found in doc
      let bigramHits = 0;
      if (queryBigrams.length > 0) {
        const docText = (r.content || "").toLowerCase();
        for (const bg of queryBigrams) {
          if (docText.includes(bg)) bigramHits++;
        }
      }
      const bigramScore = queryBigrams.length > 0 ? bigramHits / queryBigrams.length : 0;

      // Combined: bigrams weighted 2x unigrams (bigram match = stronger signal)
      const interactionScore = (unigramScore + 2 * bigramScore) / 3;

      // Apply as multiplicative boost (max 20% boost for perfect match)
      if (interactionScore > 0) {
        r.rrf *= (1.0 + 0.20 * interactionScore);
      }
    }
  }

  // Step 6: ACT-R re-ranking at 150+ atoms
  const activeCount = db.prepare("SELECT COUNT(*) as c FROM knowledge WHERE status='active'").get().c;

  // Impasse context detection: scan query for struggle signals
  const strugglePatterns = /\b(crash|crashing|crashed|error|fail|failing|failed|broken|break|breaking|stuck|bug|buggy|wrong|slow|hang|hanging|timeout|undefined|null|NaN|ENOENT|EACCES|TypeError|ReferenceError|SyntaxError|Cannot read|not working|doesn't work|won't work|can't get|unable to)\b/i;
  const contextFlag = strugglePatterns.test(query) ? 1.0 : 0.0;

  if (activeCount >= 150) {
    const now = Date.now();
    for (const r of results) {
      const n = Math.max(1, r.access_count || 1);
      const d = Math.min(0.99, r.decay_rate || 0.30);
      const createdMs = r.created_at ? new Date(r.created_at + "Z").getTime() : now - 86400000 * 30;
      const accessedMs = r.last_accessed_at ? new Date(r.last_accessed_at + "Z").getTime() : createdMs;
      const T_total = Math.max(1, (now - createdMs) / 1000);
      const T_recent = Math.max(1, (now - accessedMs) / 1000);
      const B = Math.log(Math.pow(T_recent, -d) + (n - 1) / (1 - d) * Math.pow(T_total, -d));
      // Sigmoid normalization
      const actScore = 1.0 / (1.0 + Math.exp(-B));
      r.finalScore = 0.75 * r.rrf + 0.25 * actScore;

      // Impasse boost: only when query signals struggle
      const impasse = r.impasse_severity || 0;
      if (impasse > 0 && contextFlag > 0) {
        r.finalScore *= (1.0 + 0.10 * impasse * contextFlag);
      }
    }
  } else {
    for (const r of results) {
      r.finalScore = r.rrf;
    }
  }

  // Step 7: Priority tiebreaker (5% threshold)
  results.sort((a, b) => {
    const diff = b.finalScore - a.finalScore;
    if (Math.abs(diff) < 0.05 * Math.max(a.finalScore, b.finalScore)) {
      // Tiebreak by priority
      const prioOrder = { critical: 3, significant: 2, routine: 1 };
      const aPrio = prioOrder[a.priority] || 1;
      const bPrio = prioOrder[b.priority] || 1;
      if (aPrio !== bPrio) return bPrio - aPrio;
      // Then by confidence
      return (b.confidence || 0) - (a.confidence || 0);
    }
    return diff;
  });

  // Step 8: Temporal filters
  if (since) {
    results = results.filter(r => !r.created_at || r.created_at >= since);
  }
  if (until) {
    results = results.filter(r => !r.created_at || r.created_at <= until);
  }

  return results.slice(0, limit);
}

// Hybrid search on turns (for resolution 1 and 2)
async function hybridSearchTurns(db, query, { project, limit = 30, files }) {
  const queryEmbedding = await generateQueryEmbedding(query);

  // BM25 on turns_fts
  let bm25Results = [];
  try {
    const ftsQuery = sanitizeFtsQuery(query);
    if (ftsQuery) {
      let sql = `
        SELECT t.*, th.project, th.project_name, th.priority, rank
        FROM turns_fts
        JOIN turns t ON turns_fts.rowid = t.id
        JOIN threads th ON t.thread_id = th.id
        WHERE turns_fts MATCH ?
      `;
      const params = [ftsQuery];
      if (project && project !== '*') {
        sql += " AND (th.project = ?)";
        params.push(project);
      }
      sql += " ORDER BY rank LIMIT 30";
      bm25Results = db.prepare(sql).all(...params);
    }
  } catch (err) {
    console.error(`[memory] Turn BM25 error: ${err.message}`);
  }

  // Vector KNN on turn_embeddings
  let vectorResults = [];
  if (queryEmbedding) {
    try {
      const buf = serializeEmbedding(queryEmbedding);
      const knnRows = db.prepare(`
        SELECT turn_id, distance
        FROM turn_embeddings
        WHERE embedding MATCH ?
        ORDER BY distance
        LIMIT 30
      `).all(buf);

      if (knnRows.length > 0) {
        const ids = knnRows.map(r => r.turn_id);
        const placeholders = ids.map(() => "?").join(",");
        let sql = `
          SELECT t.*, th.project, th.project_name, th.priority
          FROM turns t JOIN threads th ON t.thread_id = th.id
          WHERE t.id IN (${placeholders})
        `;
        const params = [...ids];
        if (project && project !== '*') {
          sql += " AND th.project = ?";
          params.push(project);
        }

        const turnMap = new Map();
        for (const t of db.prepare(sql).all(...params)) {
          turnMap.set(t.id, t);
        }

        vectorResults = knnRows
          .filter(r => turnMap.has(r.turn_id))
          .map(r => ({ ...turnMap.get(r.turn_id), distance: r.distance }));
      }
    } catch (err) {
      console.error(`[memory] Turn vector error: ${err.message}`);
    }
  }

  // RRF merge
  const scoreMap = new Map();
  const K = 15;

  for (let i = 0; i < bm25Results.length; i++) {
    const r = bm25Results[i];
    scoreMap.set(r.id, { ...r, rrf: 1.0 / (K + i + 1) });
  }
  for (let i = 0; i < vectorResults.length; i++) {
    const r = vectorResults[i];
    const existing = scoreMap.get(r.id);
    const score = 1.0 / (K + i + 1);
    if (existing) {
      existing.rrf += score;
    } else {
      scoreMap.set(r.id, { ...r, rrf: score });
    }
  }

  const results = [...scoreMap.values()];
  results.sort((a, b) => b.rrf - a.rrf);

  // Group by thread
  const threadMap = new Map();
  for (const turn of results) {
    const tid = turn.thread_id;
    if (!threadMap.has(tid)) {
      threadMap.set(tid, {
        thread_id: tid,
        project: turn.project,
        project_name: turn.project_name,
        priority: turn.priority,
        turns: [],
        score: 0,
      });
    }
    const thread = threadMap.get(tid);
    thread.turns.push(turn);
    thread.score += turn.rrf;
  }

  // Thread scoring with log grouping bonus
  const threads = [...threadMap.values()];
  for (const t of threads) {
    t.score += Math.log2(t.turns.length + 1) * 0.15;
  }
  threads.sort((a, b) => b.score - a.score);

  return threads.slice(0, limit);
}

// ── Raw Turn Search (resolution 0) ──────────────────────────────────────────

async function hybridSearchRawTurns(db, query, { project, limit = 10, files }) {
  const queryEmbedding = await generateQueryEmbedding(query);

  // BM25 on turns_fts
  let bm25Results = [];
  try {
    const ftsQuery = sanitizeFtsQuery(query);
    if (ftsQuery) {
      let sql = `
        SELECT t.*, th.project, th.project_name, th.timestamp_start, rank
        FROM turns_fts
        JOIN turns t ON turns_fts.rowid = t.id
        JOIN threads th ON t.thread_id = th.id
        WHERE turns_fts MATCH ?
      `;
      const params = [ftsQuery];
      if (project && project !== '*') {
        sql += " AND (th.project = ?)";
        params.push(project);
      }
      sql += " ORDER BY rank LIMIT 30";
      bm25Results = db.prepare(sql).all(...params);
    }
  } catch (err) {
    console.error(`[memory] Raw turn BM25 error: ${err.message}`);
  }

  // Vector KNN on turn_embeddings
  let vectorResults = [];
  if (queryEmbedding) {
    try {
      const buf = serializeEmbedding(queryEmbedding);
      const knnRows = db.prepare(`
        SELECT turn_id, distance
        FROM turn_embeddings
        WHERE embedding MATCH ?
        ORDER BY distance
        LIMIT 30
      `).all(buf);

      if (knnRows.length > 0) {
        const ids = knnRows.map(r => r.turn_id);
        const placeholders = ids.map(() => "?").join(",");
        let sql = `
          SELECT t.*, th.project, th.project_name, th.timestamp_start
          FROM turns t JOIN threads th ON t.thread_id = th.id
          WHERE t.id IN (${placeholders})
        `;
        const params = [...ids];
        if (project && project !== '*') {
          sql += " AND th.project = ?";
          params.push(project);
        }

        const turnMap = new Map();
        for (const t of db.prepare(sql).all(...params)) {
          turnMap.set(t.id, t);
        }

        vectorResults = knnRows
          .filter(r => turnMap.has(r.turn_id))
          .map(r => ({ ...turnMap.get(r.turn_id), distance: r.distance }));
      }
    } catch (err) {
      console.error(`[memory] Raw turn vector error: ${err.message}`);
    }
  }

  // RRF merge - individual turns, no thread grouping
  const scoreMap = new Map();
  const K = 15;

  for (let i = 0; i < bm25Results.length; i++) {
    const r = bm25Results[i];
    scoreMap.set(r.id, { ...r, rrf: 1.0 / (K + i + 1) });
  }
  for (let i = 0; i < vectorResults.length; i++) {
    const r = vectorResults[i];
    const existing = scoreMap.get(r.id);
    const score = 1.0 / (K + i + 1);
    if (existing) {
      existing.rrf += score;
    } else {
      scoreMap.set(r.id, { ...r, rrf: score });
    }
  }

  const results = [...scoreMap.values()];
  results.sort((a, b) => b.rrf - a.rrf);

  return results.slice(0, limit);
}

// ── Resolve Project Directory from Hash ──────────────────────────────────────

function resolveProjectDir(projectHash) {
  const PROJECTS_DIR = join(HOME, ".claude", "projects");
  try {
    const dirs = readdirSync(PROJECTS_DIR);
    for (const d of dirs) {
      const hash = createHash("sha256").update(d).digest("hex").slice(0, 16);
      if (hash === projectHash) {
        const actualPath = d.replace(/^-/, "/").replace(/-/g, "/");
        if (existsSync(actualPath)) return actualPath;
        break;
      }
    }
  } catch { /* projects dir missing */ }
  return null;
}

// ── FTS5 Query Sanitization ─────────────────────────────────────────────────

function sanitizeFtsQuery(query) {
  if (!query || !query.trim()) return null;
  // Strip FTS5 operators and special chars that cause syntax errors
  let clean = query
    .replace(/[(){}^*:]/g, "")
    .replace(/\bAND\b/gi, "")
    .replace(/\bNOT\b/gi, "")
    .replace(/\bNEAR\b/gi, "");
  // Strip unbalanced double quotes (keep balanced pairs)
  const quoteCount = (clean.match(/"/g) || []).length;
  if (quoteCount % 2 !== 0) {
    clean = clean.replace(/"/g, "");
  }
  // Strip trailing/leading OR which causes FTS5 syntax error
  clean = clean.replace(/\s+/g, " ").trim();
  clean = clean.replace(/^OR\b\s*/i, "").replace(/\s*\bOR$/i, "").trim();
  if (!clean) return null;
  return clean;
}

// ── Resolution Formatting ───────────────────────────────────────────────────

function formatResolution3(atoms) {
  // Atoms view
  return atoms.map(a => {
    let line = `[#${a.id}] [${a.type}]`;
    if (a.source_thread_id) line += ` (thread:${a.source_thread_id})`;
    if (a.git_staleness) line += ` [STALE: ${a.git_staleness}]`;
    line += ` ${a.content}`;
    return line;
  }).join("\n");
}

function formatResolution0(turns) {
  // Raw individual turns view
  return turns.map(t => {
    const date = t.timestamp || t.timestamp_start || "unknown";
    const projectLabel = t.project_name || t.project || "unknown";
    let line = `[Turn #${t.turn_number}] (thread:${t.thread_id}, project:${projectLabel}, ${date})`;
    if (t.user_content) line += `\n  [user] ${truncate(t.user_content, 250)}`;
    if (t.assistant_content) line += `\n  [assistant] ${truncate(t.assistant_content, 250)}`;
    return line;
  }).join("\n\n");
}

function formatResolution2(db, threads) {
  // Key exchanges view
  const parts = [];
  for (const thread of threads) {
    const keyTurns = db.prepare(
      "SELECT * FROM turns WHERE thread_id = ? AND is_key_exchange = 1 ORDER BY turn_number"
    ).all(thread.thread_id);

    let turnsToShow;
    if (keyTurns.length > 0) {
      turnsToShow = keyTurns;
    } else {
      // Fallback: first and last 2 turns
      const allTurns = db.prepare(
        "SELECT * FROM turns WHERE thread_id = ? ORDER BY turn_number"
      ).all(thread.thread_id);
      if (allTurns.length <= 4) {
        turnsToShow = allTurns;
      } else {
        turnsToShow = [...allTurns.slice(0, 2), ...allTurns.slice(-2)];
      }
    }

    let text = `--- Thread ${thread.thread_id} (${thread.project_name || thread.project}) ---\n`;
    for (const t of turnsToShow) {
      if (t.user_content) text += `  [Turn ${t.turn_number}] User: ${truncate(t.user_content, 200)}\n`;
      if (t.assistant_content) text += `  [Turn ${t.turn_number}] Assistant: ${truncate(t.assistant_content, 300)}\n`;
    }
    parts.push(text);
  }
  return parts.join("\n");
}

function formatResolution1(db, threadId) {
  // Full thread view
  const allTurns = db.prepare(
    "SELECT * FROM turns WHERE thread_id = ? ORDER BY turn_number"
  ).all(threadId);

  const charBudget = TOKEN_BUDGETS.expand_soft_cap * 4; // ~4 chars per token
  let totalChars = 0;
  const lines = [];
  let truncatedFromBeginning = 0;

  // First pass: calculate total size
  let fullSize = 0;
  for (const t of allTurns) {
    fullSize += (t.user_content || "").length + (t.assistant_content || "").length;
  }

  if (fullSize > charBudget) {
    // Truncate non-key turns from beginning, keep key exchanges and end
    const keepTurns = [];
    const skipTurns = [];
    for (const t of allTurns) {
      if (t.is_key_exchange || t.turn_number > allTurns.length - 4) {
        keepTurns.push(t);
      } else {
        skipTurns.push(t);
      }
    }

    // Add skip turns from end until budget
    let remaining = charBudget;
    for (const t of keepTurns) {
      remaining -= (t.user_content || "").length + (t.assistant_content || "").length;
    }

    const finalTurns = [...keepTurns];
    for (let i = skipTurns.length - 1; i >= 0; i--) {
      const size = (skipTurns[i].user_content || "").length + (skipTurns[i].assistant_content || "").length;
      if (remaining - size > 0) {
        finalTurns.push(skipTurns[i]);
        remaining -= size;
      } else {
        truncatedFromBeginning++;
      }
    }
    finalTurns.sort((a, b) => a.turn_number - b.turn_number);

    for (const t of finalTurns) {
      if (t.user_content) lines.push(`[Turn ${t.turn_number}] User: ${t.user_content}`);
      if (t.assistant_content) lines.push(`[Turn ${t.turn_number}] Assistant: ${t.assistant_content}`);
    }
  } else {
    for (const t of allTurns) {
      if (t.user_content) lines.push(`[Turn ${t.turn_number}] User: ${t.user_content}`);
      if (t.assistant_content) lines.push(`[Turn ${t.turn_number}] Assistant: ${t.assistant_content}`);
    }
  }

  let header = `Thread ${threadId} (${allTurns.length} turns)`;
  if (truncatedFromBeginning > 0) {
    header += ` [${truncatedFromBeginning} early turns truncated]`;
  }
  return header + "\n" + lines.join("\n");
}

function truncate(text, maxLen) {
  if (!text || text.length <= maxLen) return text || "";
  return text.slice(0, maxLen - 3) + "...";
}

// ── Cosine Dedup ────────────────────────────────────────────────────────────

function cosineDedup(db, content, embedding) {
  // Exact content match first
  const exact = db.prepare(
    "SELECT id, content FROM knowledge WHERE content = ? AND status = 'active' LIMIT 1"
  ).get(content);
  if (exact) return { action: "reinforce", existingId: exact.id, distance: 0.0, existingContent: exact.content };

  // Cosine via embeddings
  let nearest = null;
  if (embedding) {
    try {
      const buf = serializeEmbedding(embedding);
      const similar = db.prepare(`
        SELECT atom_id, distance
        FROM knowledge_embeddings
        WHERE embedding MATCH ?
        ORDER BY distance
        LIMIT 3
      `).all(buf);

      for (const s of similar) {
        // Track nearest active atom for reporting
        const active = db.prepare(
          "SELECT id, content FROM knowledge WHERE id = ? AND status = 'active'"
        ).get(s.atom_id);
        if (active) {
          if (!nearest) nearest = { id: active.id, content: active.content, distance: s.distance };
          if (s.distance < 0.20) {
            return { action: "reinforce", existingId: s.atom_id, distance: s.distance, existingContent: active.content };
          }
        }
      }
    } catch {
      // No embeddings yet or search failed
    }
  }

  return { action: "create", nearest };
}

// ── Access Count Session Cap ────────────────────────────────────────────────

const accessedThisSession = new Set();

function trackAccess(db, atomId, sessionId) {
  const key = `${sessionId}:${atomId}`;
  if (accessedThisSession.has(key)) return;
  accessedThisSession.add(key);

  db.prepare(`
    UPDATE knowledge SET access_count = access_count + 1, last_accessed_at = datetime('now')
    WHERE id = ?
  `).run(atomId);
}

// ── MCP Server ──────────────────────────────────────────────────────────────

const db = initDb();

// Check worker
ensureWorkerRunning();

const server = new McpServer({
  name: "claude-memory",
  version: "3.0.0",
});

// ── Tool 1: recall_context ──────────────────────────────────────────────────

server.tool(
  "recall_context",
  "Hybrid BM25+vector search. Supports OR operator and \"quoted phrases\". resolution: 0=raw turns, 3=atoms, 2=exchanges, 1=full threads.",
  {
    query: z.string().describe("Search topic or question"),
    resolution: z.number().optional().default(0).describe("0=raw turns (default; atoms disabled in this install), 1=threads, 2=exchanges, 3=atoms (empty)"),
    project: z.string().optional().describe("Project filter ('*' for all)"),
    type: z.string().optional().describe("Knowledge type filter"),
    limit: z.number().optional().default(5).describe("Max results (default 5)"),
    expand: z.string().optional().describe("Thread ID for full content"),
    files: z.array(z.string()).optional().describe("Active file paths for context"),
    include_threads: z.boolean().optional().describe("Also search raw turns"),
  },
  async ({ query, resolution, project, type, limit, expand, files, include_threads }) => {
    try {
      // Expand mode: return full thread
      if (expand) {
        const thread = db.prepare("SELECT * FROM threads WHERE id = ?").get(expand);
        if (!thread) {
          return { content: [{ type: "text", text: `Thread ${expand} not found.` }] };
        }
        const formatted = formatResolution1(db, expand);
        return { content: [{ type: "text", text: formatted }] };
      }

      const res = resolution !== undefined ? resolution : 0;

      if (res === 3) {
        // Atom-level search
        const results = await hybridSearchAtoms(db, query, { project, type, limit: limit || 5, files });

        if (results.length === 0 && !include_threads) {
          return { content: [{ type: "text", text: `No knowledge found for: "${query}"` }] };
        }

        let output = "";

        if (results.length > 0) {
          // Track access
          for (const r of results) {
            trackAccess(db, r.id, "server");
          }

          const formatted = formatResolution3(results);
          const threadIds = [...new Set(results.map(r => r.source_thread_id).filter(Boolean))];
          let footer = "";
          if (threadIds.length > 0) {
            footer = `\n\nThread IDs for expansion: ${threadIds.join(", ")}`;
          }

          output = `Found ${results.length} atoms for "${query}":\n\n${formatted}${footer}`;
        }

        // Also search raw turns if requested
        if (include_threads) {
          const threads = await hybridSearchTurns(db, query, { project, limit: limit || 5, files });
          if (threads.length > 0) {
            output += `\n\n=== Thread Matches (${threads.length}) ===\n\n`;
            output += formatResolution2(db, threads);
          }
        }

        if (!output) {
          return { content: [{ type: "text", text: `No results found for: "${query}"` }] };
        }

        return { content: [{ type: "text", text: output }] };
      }

      if (res === 2) {
        // Thread-level search - key exchanges
        const threads = await hybridSearchTurns(db, query, { project, limit: limit || 5, files });

        if (threads.length === 0) {
          return { content: [{ type: "text", text: `No threads found for: "${query}"` }] };
        }

        const formatted = formatResolution2(db, threads);
        return {
          content: [{
            type: "text",
            text: `Found ${threads.length} threads for "${query}":\n\n${formatted}\n\nUse expand parameter with a thread_id for full content.`
          }]
        };
      }

      if (res === 1) {
        // Full thread content
        const threads = await hybridSearchTurns(db, query, { project, limit: limit || 3, files });

        if (threads.length === 0) {
          return { content: [{ type: "text", text: `No threads found for: "${query}"` }] };
        }

        let output = "";
        for (const t of threads) {
          output += formatResolution1(db, t.thread_id) + "\n\n---\n\n";
          trackAccess(db, null, t.thread_id);
        }
        return {
          content: [{
            type: "text",
            text: `Found ${threads.length} threads for "${query}":\n\n${output}`
          }]
        };
      }

      if (res === 0) {
        // Raw turn search - individual turns, not grouped by thread
        const turns = await hybridSearchRawTurns(db, query, { project, limit: limit || 10, files });

        if (turns.length === 0) {
          return { content: [{ type: "text", text: `No raw turns found for: "${query}"` }] };
        }

        const formatted = formatResolution0(turns);
        return {
          content: [{
            type: "text",
            text: `Found ${turns.length} raw turns for "${query}":\n\n${formatted}`
          }]
        };
      }

      return { content: [{ type: "text", text: "Invalid resolution. Use 0, 1, 2, or 3." }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Search error: ${err.message}` }], isError: true };
    }
  }
);

// ── Tool 2: save_knowledge ── DISABLED 2026-04-30 (atoms removed) ──────────

false && server.tool(
  "save_knowledge",
  "Save knowledge with auto-dedup. Include reasoning for decisions.",
  {
    content: z.string().describe("Knowledge to save"),
    type: z.enum(KNOWLEDGE_TYPES).describe("Knowledge type"),
    scope: z.enum(["project", "global"]).optional().describe("project or global (auto-detected)"),
    project: z.string().optional().describe("Project name (auto-detected)"),
  },
  async ({ content, type, scope, project }) => {
    try {
      if (SQLITE_ONLY) {
        return { content: [{ type: "text", text: "Atom saving is disabled (SQLITE_ONLY mode). No embeddings or knowledge atoms will be written." }] };
      }
      if (content.length < 15) {
        return { content: [{ type: "text", text: "Content too short (min 15 chars). Not saved." }] };
      }

      const detectedScope = scope || detectScope(content);
      const tags = enrichConcepts(content);
      const decayRate = TYPE_CONFIG[type]?.decay_rate || 0.30;

      // Generate embedding synchronously
      let embedding = null;
      try {
        embedding = await generateQueryEmbedding(content);
      } catch (err) {
        console.error(`[memory] Embedding failed for save: ${err.message}`);
      }

      // Dedup
      const dedup = cosineDedup(db, content, embedding);

      if (dedup.action === "reinforce") {
        const before = db.prepare("SELECT confidence FROM knowledge WHERE id = ?").get(dedup.existingId);
        db.prepare(`
          UPDATE knowledge SET
            reinforcement_count = reinforcement_count + 1,
            confidence = MIN(1.0, confidence + 0.05),
            last_reinforced_at = datetime('now'),
            updated_at = datetime('now')
          WHERE id = ?
        `).run(dedup.existingId);
        const after = db.prepare("SELECT confidence FROM knowledge WHERE id = ?").get(dedup.existingId);
        const existingSnippet = dedup.existingContent ? truncate(dedup.existingContent, 120) : "";
        const sim = dedup.distance != null ? (1 - dedup.distance).toFixed(2) : "exact";
        return {
          content: [{ type: "text", text: `Reinforced atom #${dedup.existingId} (similarity: ${sim}). Existing: "${existingSnippet}" Confidence: ${before?.confidence?.toFixed(2) || "?"} -> ${after?.confidence?.toFixed(2) || "?"}.` }]
        };
      }

      // Create new atom
      const proj = detectedScope === "global" ? null : project;

      // Resolve git context from project hash
      let gitCommitHash = null;
      let gitProjectDir = null;
      if (proj) {
        const resolved = resolveProjectDir(proj);
        if (resolved) {
          gitProjectDir = resolved;
          try {
            gitCommitHash = execFileSync('git', ['-C', resolved, 'rev-parse', 'HEAD'],
              { encoding: 'utf8', timeout: 3000 }).trim();
          } catch { /* not git or failed */ }
        }
      }

      const result = db.prepare(`
        INSERT INTO knowledge (content, type, scope, project, tags, source_type, confidence, decay_rate, git_commit_hash, git_project_dir)
        VALUES (?, ?, ?, ?, ?, 'model_initiated', 0.80, ?, ?, ?)
      `).run(content, type, detectedScope, proj, tags, decayRate, gitCommitHash, gitProjectDir);

      const newId = Number(result.lastInsertRowid);

      // Store embedding
      if (embedding) {
        try {
          db.prepare(`
            INSERT OR REPLACE INTO knowledge_embeddings (atom_id, embedding)
            VALUES (CAST(? AS INTEGER), ?)
          `).run(newId, serializeEmbedding(embedding));
        } catch (err) {
          console.error(`[memory] Embedding store failed: ${err.message}`);
        }
      }

      const nearestInfo = dedup.nearest
        ? ` Nearest: #${dedup.nearest.id} (similarity: ${(1 - dedup.nearest.distance).toFixed(2)}) "${truncate(dedup.nearest.content, 80)}"`
        : "";
      return {
        content: [{ type: "text", text: `Saved atom #${newId} [${type}] (${detectedScope}).${nearestInfo}` }]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Save error: ${err.message}` }], isError: true };
    }
  }
);

// ── Tool 3: memory_manage ── DISABLED 2026-04-30 (atoms removed) ───────────

false && server.tool(
  "memory_manage",
  "Manage memory: feedback signals, admin operations, ingestion. Actions: feedback, batch_feedback, list, view, delete, edit, recent_extractions, reextract, archive_project, purge_archived, summary, stale, low_confidence, most_used, disk_usage, ingest_sessions.",
  {
    action: z.enum(["feedback", "batch_feedback", "list", "view", "delete", "edit", "recent_extractions", "reextract", "archive_project", "purge_archived", "summary", "stale", "low_confidence", "most_used", "disk_usage", "ingest_sessions"]).describe("Action to perform"),
    atom_id: z.number().optional().describe("Atom ID (for feedback/view/delete/edit)"),
    signal: z.enum(["confirmed", "corrected", "rejected", "helpful", "applied", "ignored", "contradicted", "task_success", "task_failure", "stale"]).optional().describe("Feedback signal"),
    correction: z.string().optional().describe("New content (if signal=corrected)"),
    outcomes: z.array(z.object({
      atom_id: z.number(),
      signal: z.enum(["confirmed", "corrected", "rejected", "helpful", "applied", "ignored", "contradicted", "task_success", "task_failure", "stale"]),
      detail: z.string().optional(),
    })).optional().describe("Batch outcomes array (for batch_feedback)"),
    content: z.string().optional().describe("New content (for edit)"),
    limit: z.number().optional().default(20).describe("Result limit"),
    type: z.string().optional().describe("Type filter (for list)"),
    thread_id: z.string().optional().describe("For reextract"),
    project: z.string().optional().describe("For archive_project"),
  },
  async ({ action, atom_id, signal, correction, outcomes, content, limit, type, thread_id, project }) => {
    try {
      // ── Feedback actions ──────────────────────────────────────────────
      if (action === "batch_feedback") {
        if (!outcomes || outcomes.length === 0) {
          return { content: [{ type: "text", text: "outcomes array required for batch_feedback." }] };
        }
        const deltas = {
          confirmed: 0.15, helpful: 0.10,
          applied: 0.02, ignored: -0.01, contradicted: -0.10,
          task_success: 0.05, task_failure: -0.08, stale: -0.15,
        };

        const updateConf = db.prepare(`
          UPDATE knowledge SET confidence = MAX(0, MIN(1.0, confidence + ?)), updated_at = datetime('now')
          WHERE id = ? AND status = 'active'
        `);

        let updated = 0;
        for (const o of outcomes) {
          if (o.signal === "corrected" || o.signal === "rejected") {
            const atom = db.prepare("SELECT * FROM knowledge WHERE id = ?").get(o.atom_id);
            if (!atom) continue;
            if (o.signal === "rejected") {
              db.prepare("UPDATE knowledge SET status = 'archived', updated_at = datetime('now') WHERE id = ?").run(o.atom_id);
              updated++;
            }
            continue;
          }
          const delta = deltas[o.signal] || 0;
          if (delta !== 0) {
            updateConf.run(delta, o.atom_id);
            updated++;
          }
        }

        return { content: [{ type: "text", text: `Recorded ${outcomes.length} outcomes, updated ${updated} atoms.` }] };
      }

      if (action === "feedback") {
        if (!atom_id || !signal) {
          return { content: [{ type: "text", text: "atom_id and signal required for feedback." }] };
        }

        const atom = db.prepare("SELECT * FROM knowledge WHERE id = ?").get(atom_id);
        if (!atom) {
          return { content: [{ type: "text", text: `Atom #${atom_id} not found.` }] };
        }

        if (signal === "rejected") {
          db.prepare("UPDATE knowledge SET status = 'archived', updated_at = datetime('now') WHERE id = ?").run(atom_id);
          return { content: [{ type: "text", text: `Atom #${atom_id} archived (rejected).` }] };
        }

        if (signal === "corrected" && correction) {
          const tags = enrichConcepts(correction);
          const decayRate = TYPE_CONFIG[atom.type]?.decay_rate || 0.30;
          let embedding = null;
          try { embedding = await generateQueryEmbedding(correction); } catch { /* graceful */ }

          const result = db.prepare(`
            INSERT INTO knowledge (content, type, scope, project, tags, source_type, confidence, decay_rate)
            VALUES (?, ?, ?, ?, ?, 'user_explicit', 0.95, ?)
          `).run(correction, atom.type, atom.scope, atom.project, tags, decayRate);

          const newId = Number(result.lastInsertRowid);

          if (embedding) {
            try {
              db.prepare(`
                INSERT OR REPLACE INTO knowledge_embeddings (atom_id, embedding)
                VALUES (CAST(? AS INTEGER), ?)
              `).run(newId, serializeEmbedding(embedding));
            } catch { /* graceful */ }
          }

          db.prepare(`
            UPDATE knowledge SET status = 'superseded', superseded_by = ?, confidence = 0, updated_at = datetime('now')
            WHERE id = ?
          `).run(newId, atom_id);

          try {
            db.prepare("DELETE FROM knowledge_embeddings WHERE atom_id = ?").run(atom_id);
          } catch { /* vec0 might not support this, graceful */ }

          return { content: [{ type: "text", text: `Atom #${atom_id} corrected. New atom #${newId} created.` }] };
        }

        const deltas = {
          confirmed: 0.15, helpful: 0.10,
          applied: 0.02, ignored: -0.01, contradicted: -0.10,
          task_success: 0.05, task_failure: -0.08, stale: -0.15,
        };
        const delta = deltas[signal] || 0;
        const newConf = Math.min(1.0, Math.max(0, (atom.confidence || 0.5) + delta));
        db.prepare(`
          UPDATE knowledge SET confidence = ?, last_accessed_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ?
        `).run(newConf, atom_id);

        return { content: [{ type: "text", text: `Atom #${atom_id} ${signal}. Confidence: ${newConf.toFixed(2)}` }] };
      }

      // ── Admin actions ─────────────────────────────────────────────────
      if (action === "list") {
        let sql = "SELECT id, type, content, confidence, access_count, created_at, updated_at FROM knowledge WHERE status = 'active'";
        const params = [];
        if (type) {
          sql += " AND type = ?";
          params.push(type);
        }
        sql += " ORDER BY updated_at DESC LIMIT ?";
        params.push(limit || 20);

        const atoms = db.prepare(sql).all(...params);
        const formatted = atoms.map(a =>
          `[#${a.id}] [${a.type}] (conf:${(a.confidence || 0).toFixed(2)}, acc:${a.access_count}, ${a.created_at}) ${truncate(a.content, 100)}`
        ).join("\n");

        return { content: [{ type: "text", text: atoms.length > 0 ? formatted : "No atoms found." }] };
      }

      if (action === "view") {
        if (!atom_id) return { content: [{ type: "text", text: "atom_id required for view." }] };
        const atom = db.prepare("SELECT * FROM knowledge WHERE id = ?").get(atom_id);
        if (!atom) return { content: [{ type: "text", text: `Atom #${atom_id} not found.` }] };

        const fields = [
          `ID: ${atom.id}`,
          `Type: ${atom.type}`,
          `Status: ${atom.status}`,
          `Scope: ${atom.scope}`,
          `Project: ${atom.project || "none"}`,
          `Confidence: ${(atom.confidence || 0).toFixed(2)}`,
          `Access Count: ${atom.access_count}`,
          `Decay Rate: ${atom.decay_rate}`,
          `Impasse: ${atom.impasse_severity}`,
          `Source: ${atom.source_type}`,
          `Source Thread: ${atom.source_thread_id || "none"}`,
          `Created: ${atom.created_at}`,
          `Updated: ${atom.updated_at}`,
          `Tags: ${atom.tags || "none"}`,
          `Contradiction: ${atom.contradiction_note || "none"}`,
          `Metadata: ${atom.metadata || "none"}`,
          ``,
          `Content: ${atom.content}`,
        ];

        return { content: [{ type: "text", text: fields.join("\n") }] };
      }

      if (action === "delete") {
        if (!atom_id) return { content: [{ type: "text", text: "atom_id required for delete." }] };
        db.prepare("UPDATE knowledge SET status = 'archived', updated_at = datetime('now') WHERE id = ?").run(atom_id);
        return { content: [{ type: "text", text: `Atom #${atom_id} archived (soft delete).` }] };
      }

      if (action === "edit") {
        if (!atom_id || !content) return { content: [{ type: "text", text: "atom_id and content required for edit." }] };

        const tags = enrichConcepts(content);
        db.prepare("UPDATE knowledge SET content = ?, tags = ?, updated_at = datetime('now') WHERE id = ?")
          .run(content, tags, atom_id);

        let embedding = null;
        try { embedding = await generateQueryEmbedding(content); } catch { /* graceful */ }
        if (embedding) {
          try {
            db.prepare(`
              INSERT OR REPLACE INTO knowledge_embeddings (atom_id, embedding)
              VALUES (CAST(? AS INTEGER), ?)
            `).run(atom_id, serializeEmbedding(embedding));
          } catch { /* graceful */ }
        }

        return { content: [{ type: "text", text: `Atom #${atom_id} updated and re-embedded.` }] };
      }

      if (action === "recent_extractions") {
        const recent = db.prepare(`
          SELECT id, content, type, source_thread_id, created_at
          FROM knowledge WHERE source_type = 'llm_extracted' AND status = 'active'
          ORDER BY created_at DESC LIMIT ?
        `).all(limit || 20);

        const formatted = recent.map(r =>
          `[#${r.id}] [${r.type}] (thread:${r.source_thread_id || "?"}, ${r.created_at})\n  ${truncate(r.content, 150)}`
        ).join("\n\n");

        return { content: [{ type: "text", text: recent.length > 0 ? formatted : "No extractions found." }] };
      }

      if (action === "reextract") {
        return { content: [{ type: "text", text: "Re-extraction is permanently disabled. Atoms are user-approved only via save_knowledge." }] };
      }

      if (action === "archive_project") {
        if (!project) return { content: [{ type: "text", text: "project required for archive_project." }] };
        const result = db.prepare("UPDATE knowledge SET status = 'archived' WHERE project = ? AND status = 'active'").run(project);
        return { content: [{ type: "text", text: `Archived ${result.changes} atoms for project "${project}".` }] };
      }

      if (action === "purge_archived") {
        const count = db.prepare("SELECT COUNT(*) as c FROM knowledge WHERE status IN ('archived', 'superseded')").get().c;
        try {
          db.prepare(`
            DELETE FROM knowledge_embeddings WHERE atom_id IN (
              SELECT id FROM knowledge WHERE status IN ('archived', 'superseded')
            )
          `).run();
        } catch { /* vec0 might not support subquery delete */ }
        db.prepare("DELETE FROM knowledge WHERE status IN ('archived', 'superseded')").run();
        return { content: [{ type: "text", text: `Purged ${count} archived/superseded atoms permanently.` }] };
      }

      if (action === "summary") {
        const atomCount = db.prepare("SELECT COUNT(*) as c FROM knowledge WHERE status = 'active'").get().c;
        const archivedCount = db.prepare("SELECT COUNT(*) as c FROM knowledge WHERE status IN ('archived','superseded')").get().c;
        const threadCount = db.prepare("SELECT COUNT(*) as c FROM threads").get().c;
        const turnCount = db.prepare("SELECT COUNT(*) as c FROM turns").get().c;
        const pendingJobs = db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status = 'pending'").get().c;
        const types = db.prepare("SELECT type, COUNT(*) as c FROM knowledge WHERE status = 'active' GROUP BY type ORDER BY c DESC").all();
        const dbSize = existsSync(DB_PATH) ? (statSync(DB_PATH).size / 1024 / 1024).toFixed(2) + " MB" : "N/A";
        const embeddingCount = (() => { try { return db.prepare("SELECT COUNT(*) as c FROM knowledge_embeddings").get().c; } catch { return 0; } })();
        const repeatEventCount = (() => { try { return db.prepare("SELECT COUNT(*) as c FROM repeat_events WHERE resolved = 0").get().c; } catch { return 0; } })();

        return {
          content: [{
            type: "text",
            text: [
              `Active Atoms: ${atomCount} | Archived/Superseded: ${archivedCount}`,
              `Threads: ${threadCount} | Turns: ${turnCount}`,
              `Embeddings: ${embeddingCount}`,
              `Types: ${types.map(t => `${t.type}(${t.c})`).join(", ") || "none"}`,
              `Pending Jobs: ${pendingJobs}`,
              `Repeat Events (unresolved): ${repeatEventCount}`,
              `DB Size: ${dbSize}`,
            ].join("\n"),
          }],
        };
      }

      if (action === "stale") {
        const stale = db.prepare(`
          SELECT id, content, type, confidence, last_accessed_at, decay_rate
          FROM knowledge WHERE status = 'active'
          AND COALESCE(last_accessed_at, created_at) < datetime('now', '-30 days')
          ORDER BY confidence ASC LIMIT 20
        `).all();

        const formatted = stale.map(s =>
          `#${s.id} [${s.type}] (${(s.confidence || 0).toFixed(2)}) ${truncate(s.content, 80)}`
        ).join("\n");

        return { content: [{ type: "text", text: stale.length > 0 ? `Stale atoms (30+ days):\n${formatted}` : "No stale atoms." }] };
      }

      if (action === "low_confidence") {
        const low = db.prepare(`
          SELECT id, content, type, confidence
          FROM knowledge WHERE status = 'active' AND confidence < 0.40
          ORDER BY confidence ASC LIMIT 20
        `).all();

        const formatted = low.map(s =>
          `#${s.id} [${s.type}] (${(s.confidence || 0).toFixed(2)}) ${truncate(s.content, 80)}`
        ).join("\n");

        return { content: [{ type: "text", text: low.length > 0 ? `Low confidence atoms:\n${formatted}` : "No low confidence atoms." }] };
      }

      if (action === "most_used") {
        const used = db.prepare(`
          SELECT id, content, type, confidence, access_count
          FROM knowledge WHERE status = 'active'
          ORDER BY access_count DESC LIMIT 10
        `).all();

        const formatted = used.map(s =>
          `#${s.id} [${s.type}] accessed: ${s.access_count} (${(s.confidence || 0).toFixed(2)}) ${truncate(s.content, 80)}`
        ).join("\n");

        return { content: [{ type: "text", text: used.length > 0 ? `Most used atoms:\n${formatted}` : "No atoms yet." }] };
      }

      if (action === "disk_usage") {
        const dbSizeBytes = existsSync(DB_PATH) ? statSync(DB_PATH).size : 0;
        const snapshotSize = (() => {
          try {
            return readdirSync(SNAPSHOTS_DIR).reduce((sum, f) => {
              try { return sum + statSync(join(SNAPSHOTS_DIR, f)).size; } catch { return sum; }
            }, 0);
          } catch { return 0; }
        })();
        const embCount = (() => { try { return db.prepare("SELECT COUNT(*) as c FROM knowledge_embeddings").get().c; } catch { return 0; } })();
        const turnEmbCount = (() => { try { return db.prepare("SELECT COUNT(*) as c FROM turn_embeddings").get().c; } catch { return 0; } })();

        return {
          content: [{
            type: "text",
            text: [
              `DB: ${(dbSizeBytes / 1024 / 1024).toFixed(2)} MB`,
              `Snapshots: ${(snapshotSize / 1024 / 1024).toFixed(2)} MB`,
              `Knowledge embeddings: ${embCount}`,
              `Turn embeddings: ${turnEmbCount}`,
            ].join("\n"),
          }],
        };
      }

      // ── Ingest action (removed) ──────────────────────────────────────
      if (action === "ingest_sessions") {
        return {
          content: [{
            type: "text",
            text: "The ingest_sessions action has been removed. Session ingestion is now handled automatically by the pre-compact hook and worker.",
          }],
        };
      }

      return { content: [{ type: "text", text: "Unknown action." }] };
    } catch (err) {
      return { content: [{ type: "text", text: `memory_manage error: ${err.message}` }], isError: true };
    }
  }
);

// ── MemoryThreads: doc ingestion ────────────────────────────────────────────

function fetchUrlMT(url) {
  return new Promise((resolve, reject) => {
    const getter = url.startsWith("https") ? httpsGet : httpGet;
    getter(url, { headers: { "User-Agent": "memorythreads/1.0" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchUrlMT(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

server.tool(
  "ingest_doc",
  "Ingest a reference document (URL, llms.txt, or local file path) into MemoryThreads. Searchable via search_docs and recall_context.",
  {
    source: z.string().describe("URL or absolute file path"),
    tags: z.string().optional().describe("Comma-separated tags"),
    title: z.string().optional().describe("Override title (default: first H1 or basename)"),
  },
  async ({ source, tags, title }) => {
    try {
      let content;
      if (source.startsWith("http://") || source.startsWith("https://")) {
        content = await fetchUrlMT(source);
      } else {
        content = readFileSync(source, "utf-8");
      }
      const finalTitle = (title || (content.split("\n")[0] || "").trim().replace(/^#\s*/, "") || basename(source, ".md")).slice(0, 200);
      const finalTags = tags || null;
      const existing = db.prepare("SELECT id FROM docs WHERE source = ?").get(source);
      let id;
      if (existing) {
        db.prepare("UPDATE docs SET title=?, content=?, tags=?, updated_at=datetime('now') WHERE id=?")
          .run(finalTitle, content, finalTags, existing.id);
        id = existing.id;
      } else {
        const r = db.prepare("INSERT INTO docs (title, content, tags, source) VALUES (?, ?, ?, ?)")
          .run(finalTitle, content, finalTags, source);
        id = Number(r.lastInsertRowid);
      }
      return { content: [{ type: "text", text: `Ingested doc #${id} "${finalTitle}" (${content.length} chars, tags: ${finalTags || "none"})` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `ingest_doc error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "search_docs",
  "FTS5 search over ingested MemoryThreads documentation. Supports AND/OR/NOT/'phrase'/prefix*",
  { query: z.string(), limit: z.number().optional().default(10) },
  async ({ query, limit }) => {
    try {
      const rows = db.prepare(`
        SELECT d.id, d.title, d.tags, d.source, substr(d.content, 1, 300) AS preview
        FROM docs_fts f JOIN docs d ON f.rowid = d.id
        WHERE docs_fts MATCH ? ORDER BY rank LIMIT ?
      `).all(query, limit);
      if (!rows.length) return { content: [{ type: "text", text: `No docs matching: ${query}` }] };
      const out = rows.map(r => `[#${r.id}] ${r.title} ${r.tags ? `(${r.tags})` : ""}\n  ${r.preview.replace(/\n/g, " ")}...`).join("\n\n");
      return { content: [{ type: "text", text: out }] };
    } catch (err) {
      return { content: [{ type: "text", text: `search_docs error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "list_docs",
  "List all ingested MemoryThreads docs with sizes and tags.",
  {},
  async () => {
    const rows = db.prepare("SELECT id, title, tags, source, length(content) AS size, created_at FROM docs ORDER BY id").all();
    if (!rows.length) return { content: [{ type: "text", text: "No docs in database." }] };
    const out = rows.map(r => `[#${r.id}] ${r.title} | ${r.size} chars | tags: ${r.tags || "none"} | ${r.source}`).join("\n");
    return { content: [{ type: "text", text: out }] };
  }
);

server.tool(
  "delete_doc",
  "Delete an ingested doc by id.",
  { id: z.number() },
  async ({ id }) => {
    const row = db.prepare("SELECT title FROM docs WHERE id = ?").get(id);
    if (!row) return { content: [{ type: "text", text: `No doc with id=${id}` }] };
    db.prepare("DELETE FROM docs WHERE id = ?").run(id);
    return { content: [{ type: "text", text: `Deleted doc #${id} "${row.title}"` }] };
  }
);

function projectHash(projectPath) {
  return createHash("sha256").update(projectPath || "unknown").digest("hex").slice(0, 16);
}

function resolveThreadForSession(sessionId) {
  if (!sessionId) return null;
  return db.prepare(`
    SELECT id, canonical_thread_id, source_kind, source_session_id
    FROM threads
    WHERE source_session_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(sessionId) || db.prepare(`
    SELECT id, canonical_thread_id, source_kind, source_session_id
    FROM threads
    WHERE source_file LIKE ? OR source_file LIKE ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(`%/${sessionId}.jsonl`, `%-${sessionId}.jsonl`) || null;
}

function ensurePlaceholderThread(threadId, sessionId, projectPath, sourceKind) {
  const existing = db.prepare("SELECT id FROM threads WHERE id = ?").get(threadId);
  if (existing) return;
  const name = basename(projectPath || "unknown");
  const project = projectHash(projectPath || "unknown");
  db.prepare(`
    INSERT OR IGNORE INTO threads
      (id, project, project_name, turn_count, timestamp_start, timestamp_end, source_file, file_mtime, source_kind, source_session_id, canonical_thread_id)
    VALUES (?, ?, ?, 0, NULL, NULL, ?, 0, ?, ?, ?)
  `).run(
    threadId,
    project,
    name,
    `${projectPath || "unknown"}/${sessionId || threadId}.jsonl`,
    sourceKind || "unknown",
    sessionId || null,
    threadId
  );
}

// ── MemoryThreads: thread bookmarks ─────────────────────────────────────────

server.tool(
  "save_thread",
  "Bookmark the current native session as a named MemoryThread.",
  {
    name: z.string().describe("Bookmark name (must be unique)"),
    session_id: z.string().describe("Native session id or JSONL filename stem"),
    project_path: z.string().describe("Project cwd"),
    note: z.string().optional().describe("Optional free-text note"),
    app: z.string().optional().describe("App name, usually claude or codex"),
    source_kind: z.string().optional().describe("Source kind, usually claude or codex"),
  },
  async ({ name, session_id, project_path, note, app, source_kind }) => {
    try {
      const t = resolveThreadForSession(session_id);
      const threadId = t?.canonical_thread_id || t?.id
        || createHash("sha256").update(`${project_path || ""}\n${session_id}`).digest("hex").slice(0, 16);
      ensurePlaceholderThread(threadId, session_id, project_path, source_kind || t?.source_kind || app || "unknown");
      db.prepare(`
        INSERT OR REPLACE INTO saved_threads (name, thread_id, session_id, project_path, note, saved_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
      `).run(name, threadId, session_id, project_path, note || null);
      if (app && project_path) {
        setActiveCanonicalThread(db, {
          app,
          cwd: project_path,
          canonicalThreadId: threadId,
          savedName: name,
          sourceSessionId: session_id,
        });
      }
      return { content: [{ type: "text", text: `Saved MemoryThread "${name}" for session ${session_id} in ${project_path}. Canonical thread: ${threadId}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `save_thread error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "list_threads",
  "List saved MemoryThread bookmarks ordered by last activity.",
  {},
  async () => {
    const rows = db.prepare(`
      SELECT s.name, s.thread_id, s.session_id, s.project_path, s.note, s.saved_at, s.last_resumed_at,
             t.source_kind, t.source_session_id, t.canonical_thread_id, t.turn_count, t.timestamp_end
      FROM saved_threads s
      LEFT JOIN threads t ON t.id = s.thread_id
      ORDER BY COALESCE(s.last_resumed_at, s.saved_at) DESC
    `).all();
    if (!rows.length) return { content: [{ type: "text", text: "No saved MemoryThreads. Use save_thread or `/mt-save <name>` to bookmark." }] };
    const out = rows.map(r =>
      `${r.name}\n  canonical: ${r.thread_id}\n  source: ${r.source_kind || "unknown"} ${r.source_session_id || r.session_id}\n  project: ${r.project_path}\n  turns: ${r.turn_count || 0}\n  saved: ${r.saved_at}${r.last_resumed_at ? ` | last resumed: ${r.last_resumed_at}` : ""}${r.note ? `\n  note: ${r.note}` : ""}`
    ).join("\n\n");
    return { content: [{ type: "text", text: out }] };
  }
);

server.tool(
  "activate_thread",
  "Select a saved or canonical MemoryThread for autonomous hook context in this app and cwd.",
  {
    name_or_id: z.string().describe("Saved name or canonical thread id"),
    app: z.string().optional().default("codex").describe("App name, usually codex or claude"),
    cwd: z.string().describe("Project cwd where the thread should be active"),
  },
  async ({ name_or_id, app, cwd }) => {
    try {
      const saved = db.prepare(`
        SELECT s.name, s.thread_id, s.session_id, t.canonical_thread_id
        FROM saved_threads s
        LEFT JOIN threads t ON t.id = s.thread_id
        WHERE s.name = ?
      `).get(name_or_id);
      const direct = saved ? null : db.prepare(`
        SELECT id, canonical_thread_id, source_session_id
        FROM threads
        WHERE id = ? OR canonical_thread_id = ?
        ORDER BY created_at DESC
        LIMIT 1
      `).get(name_or_id, name_or_id);
      const canonicalThreadId = saved?.canonical_thread_id || saved?.thread_id || direct?.canonical_thread_id || direct?.id;
      if (!canonicalThreadId) {
        return { content: [{ type: "text", text: `No saved or canonical MemoryThread named "${name_or_id}"` }], isError: true };
      }
      setActiveCanonicalThread(db, {
        app,
        cwd,
        canonicalThreadId,
        savedName: saved?.name || null,
        sourceSessionId: saved?.session_id || direct?.source_session_id || null,
      });
      if (saved?.name) {
        db.prepare("UPDATE saved_threads SET last_resumed_at = datetime('now') WHERE name = ?").run(saved.name);
      }
      return { content: [{ type: "text", text: `Activated MemoryThread ${canonicalThreadId} for ${app} in ${cwd}.` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `activate_thread error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "delete_thread",
  "Delete a saved MemoryThread bookmark by name.",
  { name: z.string() },
  async ({ name }) => {
    const row = db.prepare("SELECT name FROM saved_threads WHERE name = ?").get(name);
    if (!row) return { content: [{ type: "text", text: `No saved MemoryThread named "${name}"` }] };
    db.prepare("DELETE FROM saved_threads WHERE name = ?").run(name);
    return { content: [{ type: "text", text: `Deleted MemoryThread "${name}"` }] };
  }
);

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
