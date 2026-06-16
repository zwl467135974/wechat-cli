import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { serve } from "@hono/node-server";
import { z } from "zod";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initConfig, getConfig } from "./config.js";
import { handleToolCall } from "./tools/handlers.js";
import { app } from "./server/api.js";
import { closeAll } from "./db/manager.js";
import { doRefresh } from "./server/refresh.js";

function createMcpServer() {
  const server = new McpServer({
    name: "wechat-cli",
    version: "1.0.0",
  });

  server.tool(
    "decrypt_database",
    "解密微信数据库。从运行中的微信进程提取密钥并解密所有 .db 文件。需要微信正在运行。",
    {
      out_dir: z
        .string()
        .optional()
        .describe("解密文件输出目录，默认 'data'"),
    },
    async (args) => handleToolCall("decrypt_database", args)
  );

  server.tool(
    "extract_db_key",
    "从运行中的微信进程内存中提取数据库加密密钥。需要微信正在运行。",
    {},
    async (args) => handleToolCall("extract_db_key", args)
  );

  server.tool(
    "list_sessions",
    "列出所有聊天会话，返回用户名、昵称、备注等信息。",
    {
      keyword: z
        .string()
        .optional()
        .describe("按关键词过滤会话"),
      limit: z
        .number()
        .optional()
        .describe("最大返回数量（默认 100）"),
      offset: z.number().optional().describe("分页偏移量"),
    },
    async (args) => handleToolCall("list_sessions", args)
  );

  server.tool(
    "get_messages",
    "获取指定会话的聊天消息。支持关键词过滤和分页。",
    {
      talker_id: z
        .string()
        .describe("对方的用户名/wxid"),
      keyword: z.string().optional().describe("按关键词过滤消息"),
      limit: z.number().optional().describe("最大返回数量（默认 50）"),
      offset: z.number().optional().describe("分页偏移量"),
      reverse: z
        .boolean()
        .optional()
        .describe("是否按时间倒序（默认 true）"),
      start_time: z.number().optional().describe("开始时间（Unix 时间戳）"),
      end_time: z.number().optional().describe("结束时间（Unix 时间戳）"),
    },
    async (args) => handleToolCall("get_messages", args)
  );

  server.tool(
    "search_messages",
    "在所有会话中全局搜索消息。支持按发送者、消息类型、时间范围过滤，支持正则表达式。",
    {
      keyword: z.string().describe("搜索关键词"),
      limit: z.number().optional().describe("最大返回数量（默认 50）"),
      offset: z.number().optional().describe("分页偏移量"),
      talker: z.string().optional().describe("按会话过滤（用户名/wxid）"),
      sender: z.string().optional().describe("按发送者过滤"),
      msg_type: z.number().optional().describe("按消息类型过滤（1=文本 3=图片 34=语音 43=视频 47=表情 49=应用 10000=系统）"),
      start_time: z.number().optional().describe("开始时间（Unix 时间戳）"),
      end_time: z.number().optional().describe("结束时间（Unix 时间戳）"),
      use_regex: z.boolean().optional().describe("是否使用正则表达式搜索（默认 false）"),
    },
    async (args) => handleToolCall("search_messages", args)
  );

  server.tool(
    "get_contacts",
    "获取微信联系人列表，包括用户名、昵称、备注、别名等信息。",
    {
      keyword: z.string().optional().describe("按关键词过滤联系人"),
      limit: z.number().optional().describe("最大返回数量（默认 200）"),
      offset: z.number().optional().describe("分页偏移量"),
    },
    async (args) => handleToolCall("get_contacts", args)
  );

  server.tool(
    "get_stats",
    "获取全局聊天统计，包括总消息数、会话数、消息类型分布、TOP20 活跃会话、24小时活跃度、30天趋势。",
    {},
    async (args) => handleToolCall("get_stats", args)
  );

  server.tool(
    "get_chat_stats",
    "获取单个会话的详细统计，包括消息数、类型分布、活跃度、高频词、群成员排行、回复速度分析。",
    {
      talker: z
        .string()
        .describe("对方的用户名/wxid（如 'wxid_xxx' 或 'xxx@chatroom'）"),
    },
    async (args) => handleToolCall("get_chat_stats", args)
  );

  server.tool(
    "get_chatroom_members",
    "获取微信群聊成员列表，返回成员的 wxid 和昵称。",
    {
      chatroom: z
        .string()
        .describe("群聊用户名（如 xxx@chatroom）"),
    },
    async (args) => handleToolCall("get_chatroom_members", args)
  );

  server.tool(
    "export_chat",
    "导出指定会话的聊天记录，支持 JSON、TXT 或 HTML 格式。",
    {
      talker: z
        .string()
        .describe("对方的用户名/wxid"),
      format: z
        .enum(["json", "txt", "html"])
        .optional()
        .describe("导出格式：json、txt 或 html（默认 json）"),
      limit: z
        .number()
        .optional()
        .describe("导出消息数量上限（默认 10000）"),
    },
    async (args) => handleToolCall("export_chat", args)
  );

  server.tool(
    "get_timeline",
    "获取指定日期的消息时间线，跨所有会话按时间排列。用于回顾某一天的所有聊天动态。",
    {
      date: z.string().describe("日期，格式 YYYY-MM-DD"),
      limit: z.number().optional().describe("最大返回数量（默认 200）"),
    },
    async (args) => handleToolCall("get_timeline", args)
  );

  server.tool(
    "get_keyword_trend",
    "分析关键词在不同时间段的出现频率趋势，返回按月统计的出现次数。",
    {
      keyword: z.string().describe("要分析的关键词"),
    },
    async (args) => handleToolCall("get_keyword_trend", args)
  );

  server.tool(
    "get_year_report",
    "生成年度聊天报告，包括总消息数、活跃天数、最活跃时段、最长连续聊天、Top联系人、消息类型分布、月度趋势、高频词和表情包。",
    {
      year: z.number().optional().describe("年份（默认当前年份）"),
    },
    async (args) => handleToolCall("get_year_report", args)
  );

  server.tool(
    "refresh_data",
    "重新解密微信数据库，刷新聊天数据。用于获取最新消息。",
    {},
    async (args) => handleToolCall("refresh_data", args)
  );

  return server;
}

async function startMcpMode() {
  initConfig({
    dataDir: process.env.DATA_DIR || "decrypted",
    pythonPath: process.env.PYTHON_PATH || "python",
    wechatDbSrcPath: process.env.WECHAT_DB_SRC_PATH,
    wechatDbKey: process.env.WECHAT_DB_KEY,
    wechatPath: process.env.WECHAT_PATH,
    wechatDataPath: process.env.WECHAT_DATA_PATH,
    imageKey: process.env.IMAGE_KEY,
    xorKey: process.env.XOR_KEY,
  });
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
    wechatDbSrcPath: process.env.WECHAT_DB_SRC_PATH,
    wechatDbKey: process.env.WECHAT_DB_KEY,
    wechatPath: process.env.WECHAT_PATH,
    wechatDataPath: process.env.WECHAT_DATA_PATH,
    imageKey: process.env.IMAGE_KEY,
    xorKey: process.env.XOR_KEY,
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
      await doRefresh();
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
