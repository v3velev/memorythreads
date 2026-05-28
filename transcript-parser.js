import { createReadStream } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";

const ERROR_WORDS = ["error", "fail", "failed", "exception", "traceback", "panic"];

export async function parseJSONL(filePath) {
  const records = [];
  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      continue;
    }
  }

  return records;
}

function fileStem(filePath) {
  const base = basename(filePath);
  return base.endsWith(".jsonl") ? base.slice(0, base.length - ".jsonl".length) : base;
}

function stripSnapshotPrefix(stem) {
  const firstDash = stem.indexOf("-");
  if (firstDash <= 0) return stem;
  const prefix = stem.slice(0, firstDash);
  for (const ch of prefix) {
    if (ch < "0" || ch > "9") return stem;
  }
  return stem.slice(firstDash + 1);
}

function textFromBlocks(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (typeof block.text === "string") {
      parts.push(block.text);
    } else if (typeof block.content === "string") {
      parts.push(block.content);
    }
  }
  return parts.join("\n");
}

function claudeTextContent(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

function countClaudeToolUseBlocks(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return 0;
  let count = 0;
  for (const block of content) {
    if (block?.type === "tool_use") count++;
  }
  return count;
}

function extractClaudeToolUses(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  const toolUses = [];
  for (const block of content) {
    if (block?.type !== "tool_use") continue;
    toolUses.push({
      name: block.name || "unknown",
      input: JSON.stringify(block.input || {}),
    });
  }
  return toolUses;
}

function textHasError(text) {
  const lower = String(text || "").toLowerCase();
  for (const word of ERROR_WORDS) {
    if (lower.includes(word)) return true;
  }
  return false;
}

function hasClaudeToolResultError(records, startIdx) {
  for (let i = startIdx + 1; i < records.length; i++) {
    const record = records[i];
    if (record.type === "assistant") break;
    if (record.type !== "user") continue;

    const content = record.message?.content;
    if (!Array.isArray(content)) return false;
    for (const block of content) {
      if (block?.type !== "tool_result") continue;
      if (block.is_error) return true;
      if (textHasError(block.content)) return true;
    }
    return false;
  }
  return false;
}

function pairClaudeIntoTurns(records) {
  const textMessages = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.type === "user") {
      textMessages.push({
        role: "user",
        uuid: record.uuid,
        content: claudeTextContent(record.message),
        timestamp: record.timestamp,
      });
    } else if (record.type === "assistant") {
      textMessages.push({
        role: "assistant",
        uuid: record.uuid,
        content: claudeTextContent(record.message),
        timestamp: record.timestamp,
        toolCalls: countClaudeToolUseBlocks(record.message),
        hasError: hasClaudeToolResultError(records, i),
        toolUses: extractClaudeToolUses(record.message),
      });
    }
  }

  const turns = [];
  let turnNum = 1;
  let i = 0;
  while (i < textMessages.length) {
    const turn = { turn_number: turnNum };
    const current = textMessages[i];

    if (current.role === "user") {
      turn.user_content = current.content;
      turn.user_uuid = current.uuid;
      turn.timestamp = current.timestamp;
      i++;

      if (i < textMessages.length && textMessages[i].role === "assistant") {
        const assistant = textMessages[i];
        turn.assistant_content = assistant.content;
        turn.assistant_uuid = assistant.uuid;
        turn.tool_calls_count = assistant.toolCalls || 0;
        turn.has_error = assistant.hasError ? 1 : 0;
        turn.tool_uses = assistant.toolUses || [];
        if (!turn.timestamp) turn.timestamp = assistant.timestamp;
        i++;
      }
    } else {
      turn.assistant_content = current.content;
      turn.assistant_uuid = current.uuid;
      turn.tool_calls_count = current.toolCalls || 0;
      turn.has_error = current.hasError ? 1 : 0;
      turn.tool_uses = current.toolUses || [];
      turn.timestamp = current.timestamp;
      i++;
    }

    if ((turn.user_content || "").trim() || (turn.assistant_content || "").trim()) {
      turns.push(turn);
      turnNum++;
    }
  }

  return turns;
}

function isCodexRecord(record) {
  if (record?.type === "session_meta" || record?.type === "response_item" || record?.type === "event_msg") {
    return true;
  }
  return false;
}

function isHostInjectedCodexUserText(text) {
  const trimmed = String(text || "").trimStart();
  if (trimmed.startsWith("# AGENTS.md instructions for ")) return true;
  if (trimmed.startsWith("<environment_context>")) return true;
  return false;
}

function addAssistantText(turn, text) {
  const cleaned = String(text || "").trim();
  if (!cleaned) return;
  if (turn.assistant_content) {
    turn.assistant_content += "\n\n" + cleaned;
  } else {
    turn.assistant_content = cleaned;
  }
}

function finalizeCodexTurn(turns, turn) {
  if (!turn) return null;
  if ((turn.user_content || "").trim() || (turn.assistant_content || "").trim()) {
    turn.turn_number = turns.length + 1;
    turns.push(turn);
  }
  return null;
}

function parseCodexRecords(records, filePath) {
  let sourceSessionId = null;
  let cwd = null;
  const messages = [];
  const compactMarkers = [];
  const turns = [];
  let currentTurn = null;

  for (const record of records) {
    if (record.type === "session_meta") {
      sourceSessionId = record.payload?.id || sourceSessionId;
      cwd = record.payload?.cwd || cwd;
      continue;
    }

    if (record.type === "compacted") {
      compactMarkers.push({
        timestamp: record.timestamp || null,
        source: "compacted",
      });
      continue;
    }

    const payload = record.payload || {};
    if (payload.type === "context_compacted") {
      compactMarkers.push({
        timestamp: record.timestamp || null,
        source: "context_compacted",
      });
      continue;
    }

    if (record.type !== "response_item") continue;

    if (payload.type === "function_call") {
      if (currentTurn) currentTurn.tool_calls_count = (currentTurn.tool_calls_count || 0) + 1;
      continue;
    }

    if (payload.type === "function_call_output") {
      if (currentTurn && textHasError(payload.output || payload.content || "")) {
        currentTurn.has_error = 1;
      }
      continue;
    }

    if (payload.type !== "message") continue;
    const role = payload.role;
    const text = textFromBlocks(payload.content);
    if (!text.trim()) continue;

    messages.push({
      role,
      timestamp: record.timestamp || null,
      phase: payload.phase || null,
      content: text,
    });

    if (role === "developer") continue;

    if (role === "user") {
      if (isHostInjectedCodexUserText(text)) continue;

      if (currentTurn && !currentTurn.assistant_content) {
        currentTurn.user_content = [currentTurn.user_content, text].filter(Boolean).join("\n\n");
        if (!currentTurn.timestamp) currentTurn.timestamp = record.timestamp || null;
        continue;
      }

      currentTurn = finalizeCodexTurn(turns, currentTurn);
      currentTurn = {
        user_content: text,
        user_uuid: payload.id || null,
        timestamp: record.timestamp || null,
        tool_calls_count: 0,
        has_error: 0,
        tool_uses: [],
      };
      continue;
    }

    if (role === "assistant") {
      if (!currentTurn) {
        currentTurn = {
          assistant_uuid: payload.id || null,
          timestamp: record.timestamp || null,
          tool_calls_count: 0,
          has_error: 0,
          tool_uses: [],
        };
      }
      addAssistantText(currentTurn, text);
      currentTurn.assistant_uuid = currentTurn.assistant_uuid || payload.id || null;
      currentTurn.timestamp = currentTurn.timestamp || record.timestamp || null;
    }
  }

  finalizeCodexTurn(turns, currentTurn);

  return {
    sourceKind: "codex",
    sourceSessionId: sourceSessionId || stripSnapshotPrefix(fileStem(filePath)),
    cwd,
    messages,
    turns,
    summaries: [],
    compactMarkers,
    rawMessages: records,
  };
}

function parseClaudeRecords(records, filePath) {
  const summaries = [];
  const compactMarkers = [];

  for (const record of records) {
    if (record.type === "summary" && record.summary) {
      summaries.push({
        leafUuid: record.leafUuid || null,
        summary: record.summary,
      });
    }
    if (record.type === "summary" || record.type === "compact" || record.type === "compaction") {
      compactMarkers.push({
        timestamp: record.timestamp || null,
        source: record.type,
      });
    }
  }

  return {
    sourceKind: "claude",
    sourceSessionId: stripSnapshotPrefix(fileStem(filePath)),
    cwd: records.find(record => record.cwd)?.cwd || null,
    messages: [],
    turns: pairClaudeIntoTurns(records),
    summaries,
    compactMarkers,
    rawMessages: records,
  };
}

export function detectSourceKind(records, filePath) {
  for (const record of records) {
    if (isCodexRecord(record)) return "codex";
  }
  for (const record of records) {
    if (record?.type === "user" || record?.type === "assistant") return "claude";
  }
  const path = String(filePath || "");
  if (path.includes("/.codex/sessions/")) return "codex";
  if (path.includes("/.claude/projects/") || path.includes("/snapshots/")) return "claude";
  return "unknown";
}

export async function parseTranscript(filePath) {
  const records = await parseJSONL(filePath);
  const sourceKind = detectSourceKind(records, filePath);

  if (sourceKind === "codex") return parseCodexRecords(records, filePath);
  if (sourceKind === "claude") return parseClaudeRecords(records, filePath);

  return {
    sourceKind: "unknown",
    sourceSessionId: stripSnapshotPrefix(fileStem(filePath)),
    cwd: null,
    messages: [],
    turns: pairClaudeIntoTurns(records),
    summaries: [],
    compactMarkers: [],
    rawMessages: records,
  };
}

export function generateSourceThreadId(sourceKind, sourceSessionId, filePath, turns) {
  if ((sourceKind === "codex" || sourceKind === "claude") && sourceSessionId) {
    return createHash("sha256")
      .update([sourceKind, sourceSessionId].join("\n"))
      .digest("hex")
      .slice(0, 16);
  }

  const content = (turns || []).slice(0, 3).map(turn =>
    (turn.user_content || "") + (turn.assistant_content || "")
  ).join("\n");
  const firstTimestamp = turns?.[0]?.timestamp || "";
  const hashInput = [content, basename(filePath), firstTimestamp].join("\n");
  return createHash("sha256").update(hashInput).digest("hex").slice(0, 16);
}
