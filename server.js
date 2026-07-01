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
const DB_PATH = process.env.MEMORY_DB_PATH || join(SERVER_DIR, "data", "memory.db");
const PROJECTS_DIR = join(HOME, ".claude", "projects");
const SNAPSHOTS_DIR = join(SERVER_DIR, "snapshots");
const WORKER_PID_FILE = join(SERVER_DIR, "worker.pid");
const ENV_PATH = join(SERVER_DIR, ".env");

mkdirSync(join(SERVER_DIR, "data"), { recursive: true });
mkdirSync(join(SERVER_DIR, "logs"), { recursive: true });
mkdirSync(SNAPSHOTS_DIR, { recursive: true });

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
// SQLITE_ONLY disables all OpenAI embedding calls.
// Search falls back to BM25/FTS only.
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

// ── Hybrid Search Pipeline ──────────────────────────────────────────────────

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
  "Hybrid BM25+vector search over conversation turns. Supports OR operator and \"quoted phrases\". resolution: 0=raw turns, 2=exchanges, 1=full threads.",
  {
    query: z.string().describe("Search topic or question"),
    resolution: z.number().optional().default(0).describe("0=raw turns (default), 1=full threads, 2=exchanges"),
    project: z.string().optional().describe("Project filter ('*' for all)"),
    limit: z.number().optional().default(5).describe("Max results (default 5)"),
    expand: z.string().optional().describe("Thread ID for full content"),
    files: z.array(z.string()).optional().describe("Active file paths for context"),
    include_threads: z.boolean().optional().describe("Also search raw turns"),
  },
  async ({ query, resolution, project, limit, expand, files, include_threads }) => {
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

      return { content: [{ type: "text", text: "Invalid resolution. Use 0, 1, or 2." }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Search error: ${err.message}` }], isError: true };
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
