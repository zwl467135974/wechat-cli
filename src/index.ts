import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { serve } from "@hono/node-server";
import { spawn } from "node:child_process";
import { z } from "zod";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initConfig } from "./config.js";
import { handleToolCall } from "./tools/handlers.js";
import { app } from "./server/api.js";
import { closeAll } from "./db/manager.js";
import { clearShardCache } from "./db/query-messages.js";
import { execPython } from "./python/runner.js";
import { getConfig } from "./config.js";
import fs from "node:fs";

declare global {
  // eslint-disable-next-line no-var
  var __wechatLastRefresh: string | undefined;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PYTHON_DIR = path.resolve(__dirname, "../python");

function runDecrypt(dbDir: string, outDir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(PYTHON_DIR, "decrypt_db_v2.py");
    const proc = spawn("python", [scriptPath, "--db-dir", dbDir, "--out-dir", outDir], {
      cwd: PYTHON_DIR,
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: unknown) => { stdout += String(d); });
    proc.stderr.on("data", (d: unknown) => { stderr += String(d); });
    proc.on("close", (code: number | null) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr || stdout));
    });
    proc.on("error", (err: Error) => reject(err));
  });
}

function createMcpServer() {
  const server = new McpServer({
    name: "wechat-cli",
    version: "1.0.0",
  });

  server.tool(
    "decrypt_database",
    "Decrypt WeChat encrypted database files. " +
      "Extracts keys from running WeChat process memory (SQLCipher 4) and decrypts all .db files. " +
      "Requires WeChat to be running.",
    {
      out_dir: z
        .string()
        .optional()
        .describe("Output directory for decrypted files. Defaults to 'decrypted'."),
    },
    async (args) => handleToolCall("decrypt_database", args)
  );

  server.tool(
    "extract_db_key",
    "Extract WeChat database encryption keys from the running WeChat process memory (SQLCipher 4). " +
      "Scans process memory for x'<key><salt>' patterns and validates via HMAC-SHA512. " +
      "Requires WeChat to be running.",
    {},
    async (args) => handleToolCall("extract_db_key", args)
  );

  server.tool(
    "list_sessions",
    "List all WeChat chat sessions (conversations). Returns session list with username, nickname, remark, etc.",
    {
      keyword: z
        .string()
        .optional()
        .describe("Filter sessions by keyword"),
      limit: z
        .number()
        .optional()
        .describe("Max number of sessions (default 100)"),
      offset: z.number().optional().describe("Offset for pagination"),
    },
    async (args) => handleToolCall("list_sessions", args)
  );

  server.tool(
    "get_messages",
    "Get chat messages from a specific conversation. Provide the talker's username (wxid) to retrieve messages.",
    {
      talker_id: z
        .string()
        .describe("The talker's username/wxid"),
      keyword: z.string().optional().describe("Filter messages by keyword"),
      limit: z.number().optional().describe("Max messages (default 50)"),
      offset: z.number().optional().describe("Offset for pagination"),
      reverse: z
        .boolean()
        .optional()
        .describe("Return newest first if true"),
    },
    async (args) => handleToolCall("get_messages", args)
  );

  server.tool(
    "search_messages",
    "Search messages across ALL conversations globally by keyword.",
    {
      keyword: z.string().describe("Search keyword"),
      limit: z.number().optional().describe("Max results (default 50)"),
      offset: z.number().optional().describe("Offset for pagination"),
    },
    async (args) => handleToolCall("search_messages", args)
  );

  server.tool(
    "get_contacts",
    "Get WeChat contacts list. Returns contact info including username, nickname, remark, alias.",
    {
      keyword: z.string().optional().describe("Filter contacts by keyword"),
      limit: z.number().optional().describe("Max contacts (default 200)"),
      offset: z.number().optional().describe("Offset for pagination"),
    },
    async (args) => handleToolCall("get_contacts", args)
  );

  return server;
}

async function startMcpMode() {
  initConfig();
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on("SIGINT", () => {
    closeAll();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    closeAll();
    process.exit(0);
  });
}

async function startWebMode() {
  const port = Number(process.env.PORT) || 5200;
  const dataDir = process.env.DATA_DIR || "decrypted";
  const pythonPath = process.env.PYTHON_PATH || "python";
  const autoRefreshMs = Number(process.env.AUTO_REFRESH_MS) || 60000;

  initConfig({
    dataDir,
    pythonPath,
    wechatDbSrcPath: process.env.WECHAT_DB_SRC_PATH || "D:\\weixinDoc\\xwechat_files\\wxid_oofdngwmbpok21_1562\\db_storage",
    wechatDbKey: process.env.WECHAT_DB_KEY || "",
    wechatPath: process.env.WECHAT_PATH || "D:\\Weixin\\Weixin.exe",
    wechatDataPath: process.env.WECHAT_DATA_PATH || "",
    imageKey: process.env.IMAGE_KEY || "",
    xorKey: process.env.XOR_KEY || "",
  });

  serve(
    {
      fetch: app.fetch,
      port,
    },
    (info) => {
      console.log(`WeChat CLI Web UI running at http://localhost:${info.port}`);
      console.log(`Data directory: ${dataDir}`);
      console.log(`Auto refresh: every ${autoRefreshMs / 1000}s`);
    }
  );

  if (autoRefreshMs > 0) {
    setInterval(async () => {
      try {
        closeAll();
        clearShardCache();
        const cfg = getConfig();
        const absOutDir = path.resolve(cfg.dataDir);
        if (!fs.existsSync(absOutDir)) fs.mkdirSync(absOutDir, { recursive: true });
        await runDecrypt(cfg.wechatDbSrcPath, absOutDir);
        const ts = new Date().toISOString();
        globalThis.__wechatLastRefresh = ts;
        console.log(`[${ts}] Auto refresh completed`);
      } catch (e) {
        console.error(`[${new Date().toISOString()}] Auto refresh failed:`, e instanceof Error ? e.message : e);
      }
    }, autoRefreshMs);
  }

  process.on("SIGINT", () => {
    closeAll();
    process.exit(0);
  });
}

const mode = process.argv[2] || "mcp";

if (mode === "web" || mode === "--web") {
  startWebMode().catch(console.error);
} else {
  startMcpMode().catch(console.error);
}
