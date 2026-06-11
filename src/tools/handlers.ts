import { getSessions, getContacts } from "../db/query-contacts.js";
import {
  getMessages,
  searchMessages,
} from "../db/query-messages.js";
import { closeAll } from "../db/manager.js";
import { getConfig } from "../config.js";
import { execPython } from "../python/runner.js";

export const toolDefinitions = [
  {
    name: "decrypt_database",
    description:
      "Decrypt WeChat encrypted database files using the provided key. " +
      "Scans the WeChat data directory for .db files, decrypts them using sqlcipher, " +
      "and saves the decrypted copies to the data directory. " +
      "Requires the WeChat DB key (64-char hex string) and the source WeChat data path.",
    inputSchema: {
      type: "object" as const,
      properties: {
        src_path: {
          type: "string",
          description:
            "Path to WeChat data directory (the folder containing db_storage/)",
        },
        key: {
          type: "string",
          description:
            "WeChat database key (64-char hex string). Use extract_db_key tool to obtain it.",
        },
        out_dir: {
          type: "string",
          description:
            "Output directory for decrypted files. Defaults to 'data'.",
        },
      },
      required: ["src_path", "key"],
    },
  },
  {
    name: "extract_db_key",
    description:
      "Extract the WeChat database encryption key by hooking the running WeChat process. " +
      "This will restart WeChat if it's already running, load the wx_key DLL to hook the process, " +
      "and wait for the user to login. Returns the 64-char hex key on success. " +
      "REQUIRES: WeChat installed on the system and the wx_key.dll available.",
    inputSchema: {
      type: "object" as const,
      properties: {
        dll_path: {
          type: "string",
          description:
            "Path to wx_key.dll. If not provided, will try default locations.",
        },
        wechat_path: {
          type: "string",
          description:
            "Path to WeChat executable (Weixin.exe). If not provided, will auto-detect.",
        },
      },
      required: [],
    },
  },
  {
    name: "list_sessions",
    description:
      "List all WeChat chat sessions (conversations). Returns session list with username, nickname, remark, etc.",
    inputSchema: {
      type: "object" as const,
      properties: {
        keyword: {
          type: "string",
          description: "Filter sessions by keyword (matches username/nickname/remark)",
        },
        limit: {
          type: "number",
          description: "Max number of sessions to return (default 100)",
        },
        offset: {
          type: "number",
          description: "Offset for pagination (default 0)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_messages",
    description:
      "Get chat messages from a specific conversation (session). " +
      "Provide the talker's username (wxid) to retrieve messages. " +
      "Supports keyword filtering and pagination.",
    inputSchema: {
      type: "object" as const,
      properties: {
        talker_id: {
          type: "string",
          description:
            "The talker's username/wxid (e.g., 'wxid_xxx' for personal chat, 'xxx@chatroom' for group)",
        },
        keyword: {
          type: "string",
          description: "Filter messages by keyword",
        },
        limit: {
          type: "number",
          description: "Max number of messages to return (default 50)",
        },
        offset: {
          type: "number",
          description: "Offset for pagination (default 0)",
        },
        reverse: {
          type: "boolean",
          description: "If true, return messages in reverse order (newest first)",
        },
      },
      required: ["talker_id"],
    },
  },
  {
    name: "search_messages",
    description:
      "Search messages across ALL conversations globally by keyword. " +
      "Returns matching messages from all sessions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        keyword: {
          type: "string",
          description: "Search keyword",
        },
        limit: {
          type: "number",
          description: "Max number of results (default 50)",
        },
        offset: {
          type: "number",
          description: "Offset for pagination (default 0)",
        },
      },
      required: ["keyword"],
    },
  },
  {
    name: "get_contacts",
    description:
      "Get WeChat contacts list. Returns contact info including username, nickname, remark, alias, etc.",
    inputSchema: {
      type: "object" as const,
      properties: {
        keyword: {
          type: "string",
          description: "Filter contacts by keyword (matches username/alias/remark/nickname)",
        },
        limit: {
          type: "number",
          description: "Max number of contacts to return (default 200)",
        },
        offset: {
          type: "number",
          description: "Offset for pagination (default 0)",
        },
      },
      required: [],
    },
  },
];

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const config = getConfig();

  try {
    switch (name) {
      case "decrypt_database": {
        const { src_path, key, out_dir } = args as {
          src_path?: string;
          key?: string;
          out_dir?: string;
        };
        const outputDir = out_dir || config.dataDir;
        const dbDir = src_path || config.wechatDbSrcPath;
        const result = await execPython("decrypt_db_v2.py", {
          db_dir: dbDir,
          out_dir: outputDir,
          ...(key ? { key } : {}),
        });
        closeAll();
        return {
          content: [{ type: "text", text: result }],
        };
      }

      case "extract_db_key": {
        const { dll_path, wechat_path } = args as {
          dll_path?: string;
          wechat_path?: string;
        };
        const result = await execPython("extract_key_v3.py", {
          ...(dll_path ? { dll_path } : {}),
          ...(wechat_path ? { wechat_path } : {}),
        });
        return {
          content: [{ type: "text", text: result }],
        };
      }

      case "list_sessions": {
        const { keyword, limit, offset } = args as {
          keyword?: string;
          limit?: number;
          offset?: number;
        };
        const sessions = await getSessions(
          config.dataDir,
          keyword,
          limit ?? 100,
          offset ?? 0
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(sessions, null, 2),
            },
          ],
        };
      }

      case "get_messages": {
        const { talker_id, keyword, limit, offset, reverse } = args as {
          talker_id: string;
          keyword?: string;
          limit?: number;
          offset?: number;
          reverse?: boolean;
        };
        const messages = await getMessages(config.dataDir, talker_id, {
          keyword,
          limit: limit ?? 50,
          offset: offset ?? 0,
          reverse,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(messages, null, 2),
            },
          ],
        };
      }

      case "search_messages": {
        const { keyword, limit, offset } = args as {
          keyword: string;
          limit?: number;
          offset?: number;
        };
        const results = await searchMessages(
          config.dataDir,
          keyword,
          limit ?? 50,
          offset ?? 0
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(results, null, 2),
            },
          ],
        };
      }

      case "get_contacts": {
        const { keyword, limit, offset } = args as {
          keyword?: string;
          limit?: number;
          offset?: number;
        };
        const contacts = await getContacts(
          config.dataDir,
          keyword,
          limit ?? 200,
          offset ?? 0
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(contacts, null, 2),
            },
          ],
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
        };
    }
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
    };
  }
}
