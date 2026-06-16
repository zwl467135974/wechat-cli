import { getSessions, getContacts, getChatRoomMembers } from "../db/query-contacts.js";
import { getMessages, searchMessages, getTimeline } from "../db/query-messages.js";
import { getGlobalStats, getChatStats, getKeywordTrend, getYearTopWords } from "../db/stats.js";
import { closeAll } from "../db/manager.js";
import { decryptAllDatabases } from "../db/db-decrypt.js";
import { extractDbKeys } from "../db/key-extractor.js";
import { getConfig } from "../config.js";
import { doRefresh } from "../server/refresh.js";
import { buildExportHtml, buildYearReport } from "../server/api.js";
import { getEmojis } from "../db/query-emoji.js";
import type { EmojiItem } from "../db/query-emoji.js";
import type { Message } from "../db/models.js";
import fs from "node:fs";
import path from "node:path";

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const config = getConfig();

  try {
    switch (name) {
      case "decrypt_database": {
        const { out_dir } = args as { out_dir?: string };
        const outputDir = out_dir || config.dataDir;
        const dbDir = config.wechatDbSrcPath;
        if (!dbDir) {
          return { content: [{ type: "text", text: "未配置微信数据库路径" }] };
        }
        const result = decryptAllDatabases(dbDir, outputDir);
        closeAll();
        return {
          content: [{ type: "text", text: `解密完成: ${result.success} 成功, ${result.failed} 失败, ${result.skipped} 跳过\n\n${result.details.join("\n")}` }],
        };
      }

      case "extract_db_key": {
        const dbDir = config.wechatDbSrcPath;
        if (!dbDir) {
          return { content: [{ type: "text", text: "未配置微信数据库路径" }] };
        }
        const result = extractDbKeys(dbDir);
        const keysFile = path.join(process.cwd(), "python", "all_keys.json");
        fs.mkdirSync(path.dirname(keysFile), { recursive: true });
        fs.writeFileSync(keysFile, JSON.stringify(result.keys, null, 2));
        return {
          content: [{ type: "text", text: result.details.join("\n") }],
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
        const { talker_id, keyword, limit, offset, reverse, start_time, end_time } = args as {
          talker_id: string;
          keyword?: string;
          limit?: number;
          offset?: number;
          reverse?: boolean;
          start_time?: number;
          end_time?: number;
        };
        const messages = await getMessages(config.dataDir, talker_id, {
          keyword,
          limit: limit ?? 50,
          offset: offset ?? 0,
          reverse,
          startTime: start_time,
          endTime: end_time,
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
        const { keyword, limit, offset, talker, sender, msg_type, start_time, end_time, use_regex } = args as {
          keyword: string;
          limit?: number;
          offset?: number;
          talker?: string;
          sender?: string;
          msg_type?: number;
          start_time?: number;
          end_time?: number;
          use_regex?: boolean;
        };
        const results = await searchMessages(
          config.dataDir,
          keyword,
          limit ?? 50,
          offset ?? 0,
          {
            talker,
            sender,
            msgType: msg_type,
            startTime: start_time,
            endTime: end_time,
            useRegex: use_regex,
          }
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
        const { talker, format, limit } = args as {
          talker: string;
          format?: string;
          limit?: number;
        };
        const messages: Message[] = await getMessages(config.dataDir, talker, {
          limit: limit ?? 10000,
          offset: 0,
          reverse: true,
        });
        const fmt = format || "json";
        if (fmt === "json") {
          return {
            content: [{ type: "text", text: JSON.stringify(messages, null, 2) }],
          };
        }
        if (fmt === "html") {
          return {
            content: [{ type: "text", text: buildExportHtml(talker, messages) }],
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

      case "get_timeline": {
        const { date, limit } = args as { date: string; limit?: number };
        const messages = await getTimeline(config.dataDir, date, limit ?? 200);
        return {
          content: [{ type: "text", text: JSON.stringify(messages, null, 2) }],
        };
      }

      case "get_keyword_trend": {
        const { keyword } = args as { keyword: string };
        const trend = await getKeywordTrend(config.dataDir, keyword);
        return {
          content: [{ type: "text", text: JSON.stringify(trend, null, 2) }],
        };
      }

      case "get_year_report": {
        const { year: yearArg } = args as { year?: number };
        const year = yearArg || new Date().getFullYear();
        const stats = await getGlobalStats(config.dataDir);
        const emojis = await getEmojis(config.dataDir, 10, 0);
        const topWords = await getYearTopWords(config.dataDir, year);
        const report = buildYearReport(stats, year, emojis.items as EmojiItem[], topWords);
        return {
          content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
        };
      }

      case "refresh_data": {
        const result = await doRefresh();
        if (result.ok) {
          return {
            content: [{ type: "text", text: `刷新成功，完成时间: ${globalThis.__wechatLastRefresh}` }],
          };
        }
        return {
          content: [{ type: "text", text: `刷新失败: ${result.error}` }],
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
