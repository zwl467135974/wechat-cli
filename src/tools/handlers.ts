import { getSessions, getContacts, getChatRoomMembers } from "../db/query-contacts.js";
import { getMessages, searchMessages } from "../db/query-messages.js";
import { getGlobalStats, getChatStats } from "../db/stats.js";
import { closeAll } from "../db/manager.js";
import { getConfig } from "../config.js";
import { execPython } from "../python/runner.js";

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

      case "get_stats": {
        const stats = await getGlobalStats(config.dataDir);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(stats, null, 2),
            },
          ],
        };
      }

      case "get_chat_stats": {
        const { talker } = args as { talker: string };
        const chatStats = await getChatStats(config.dataDir, talker);
        if (!chatStats) {
          return { content: [{ type: "text", text: "No data found for this conversation." }] };
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(chatStats, null, 2),
            },
          ],
        };
      }

      case "get_chatroom_members": {
        const { chatroom } = args as { chatroom: string };
        const members = await getChatRoomMembers(config.dataDir, chatroom);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(members, null, 2),
            },
          ],
        };
      }

      case "export_chat": {
        const { talker, format } = args as {
          talker: string;
          format?: string;
        };
        const messages = await getMessages(config.dataDir, talker, {
          limit: 10000,
          reverse: true,
        });
        if ((format || "json") === "json") {
          return {
            content: [{ type: "text", text: JSON.stringify(messages, null, 2) }],
          };
        }
        const lines = messages.map(m => {
          const t = new Date(m.time).toLocaleString("zh-CN");
          const sender = m.sender || m.talker;
          return `[${t}] ${sender}: ${m.content}`;
        });
        return {
          content: [{ type: "text", text: lines.join("\n") }],
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
