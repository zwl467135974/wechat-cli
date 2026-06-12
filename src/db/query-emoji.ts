import { Database } from "sql.js";
import { getShards } from "./query-messages.js";
import { getConnection } from "./manager.js";
import { listMsgTables } from "./message-parser.js";
import { md5 } from "./query-messages.js";
import { decodeMessageContent } from "./codec.js";

export interface EmojiItem {
  url: string;
  md5: string;
  source: "cdn" | "thumb" | "local";
  talker: string;
  createTime: number;
  count: number;
}

export async function getEmojis(
  dataDir: string,
  limit = 200,
  offset = 0
): Promise<{ total: number; items: EmojiItem[] }> {
  const shards = await getShards(dataDir);
  const emojiMap = new Map<string, EmojiItem>();

  for (const shard of shards) {
    const db = await getConnection(shard.filePath);
    const tables = listMsgTables(db);

    const talkerReverse = new Map<string, string>();
    try {
      const n2i = db.exec("SELECT user_name FROM Name2Id");
      if (n2i.length > 0) {
        for (const r of n2i[0].values) {
          const name = String(r[0]);
          talkerReverse.set(`Msg_${md5(name)}`, name);
        }
      }
    } catch { /* ignore */ }

    for (const tableName of tables) {
      const talker = talkerReverse.get(tableName) || tableName;
      await extractEmojisFromTable(db, tableName, talker, emojiMap);
    }
  }

  const all = [...emojiMap.values()];
  all.sort((a, b) => b.count - a.count || b.createTime - a.createTime);
  const total = all.length;
  const items = all.slice(offset, offset + limit);
  return { total, items };
}

async function extractEmojisFromTable(
  db: Database,
  tableName: string,
  talker: string,
  emojiMap: Map<string, EmojiItem>
): Promise<void> {
  try {
    const rows = db.exec(
      `SELECT message_content, create_time FROM "${tableName}" WHERE (local_type & 0xFFFF) = 47`
    );
    if (!rows.length) return;

    for (const row of rows[0].values) {
      const raw = row[0];
      const createTime = Number(row[1]) * 1000;

      let content: string;
      if (raw instanceof Uint8Array || Buffer.isBuffer(raw)) {
        content = await decodeMessageContent(Buffer.from(raw));
      } else {
        content = String(raw || "");
      }

      let url = "";
      let source: EmojiItem["source"] = "local";
      let emojiMd5 = "";

      const cdnMatch = content.match(/cdnurl\s*=\s*"([^"]+)"/);
      if (cdnMatch) {
        url = decodeURIComponent(cdnMatch[1]).replace(/&amp;/g, "&");
        source = "cdn";
      }

      if (!url) {
        const thumbMatch = content.match(/thumburl\s*=\s*"([^"]+)"/);
        if (thumbMatch) {
          url = decodeURIComponent(thumbMatch[1]).replace(/&amp;/g, "&");
          source = "thumb";
        }
      }

      const md5Match = content.match(/md5\s*=\s*"([0-9a-f]{32})"/i);
      if (md5Match) {
        emojiMd5 = md5Match[1];
      }

      if (!url && !emojiMd5) continue;

      const key = emojiMd5 || url;
      const existing = emojiMap.get(key);
      if (existing) {
        existing.count++;
        if (createTime > existing.createTime) {
          existing.createTime = createTime;
        }
      } else {
        emojiMap.set(key, {
          url: url || `emoji://${emojiMd5}`,
          md5: emojiMd5,
          source,
          talker,
          createTime,
          count: 1,
        });
      }
    }
  } catch {
    // ignore
  }
}
