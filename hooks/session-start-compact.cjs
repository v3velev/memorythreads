const path = require("path");
const os = require("os");
const Database = require("better-sqlite3");
const { buildMemoryContext } = require("./user-prompt-submit.cjs");

const SERVER_DIR = path.join(os.homedir(), ".claude", "memory-server");
const DB_PATH = path.join(SERVER_DIR, "data", "memory.db");

function readStdin() {
  return new Promise(resolve => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
  });
}

async function main() {
  try {
    const raw = await readStdin();
    const input = raw.trim() ? JSON.parse(raw) : {};
    const db = new Database(DB_PATH, { timeout: 1000 });
    const output = buildMemoryContext(db, input, { forceRecovery: true });
    db.close();
    if (output) process.stdout.write(output + "\n");
  } catch {}
}

if (require.main === module) {
  main();
}
