import { getShards } from "./query-messages.js";
import { getConnection } from "./manager.js";
import { listMsgTables, parseMessageRow } from "./message-parser.js";
import { md5 } from "./query-messages.js";
import type { Message } from "./models.js";

export interface MediaItem {
  type: "image" | "video" | "file";
  talker: string;
  talkerName: string;
  sender: string;
  time: string;
  content: string;
  mediaPath: string;
  fileName: string;
}

function getFileTitle(content: string): string {
  const m = content.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/);
  return m ? (m[1] || m[2] || "").trim() : "";
}

export async function getMediaFiles(
  dataDir: string,
  type: "image" | "video" | "file" | "all" = "all",
  limit = 100,
  offset = 0
): Promise<{ total: number; items: MediaItem[] }> {
  const shards = await getShards(dataDir);
  const allMsgs: Message[] = [];

  for (const shard of shards) {
    const db = await getConnection(shard.filePath);
    const tables = listMsgTables(db);
    const talkerReverse = new Map<string, string>();
    try {
      const n2i = db.exec("SELECT user_name FROM Name2Id");
      if (n2i.length > 0) {
        for (const r of n2i[0].values) {
          talkerReverse.set(`Msg_${md5(String(r[0]))}`, String(r[0]));
        }
      }
    } catch { /* ignore */ }

    for (const tableName of tables) {
      const talker = talkerReverse.get(tableName) || tableName;
      const typeConds: string[] = [];
      if (type === "image" || type === "all") typeConds.push("(local_type & 0xFFFF) = 3");
      if (type === "video" || type === "all") typeConds.push("(local_type & 0xFFFF) = 43");
      if (type === "file" || type === "all") typeConds.push("(local_type & 0xFFFF) = 49");
      if (!typeConds.length) continue;

      const sql = `SELECT sort_seq, create_time, local_type, message_content, compress_content, status, source, packed_info_data
                   FROM "${tableName}" WHERE ${typeConds.join(" OR ")}
                   ORDER BY create_time DESC LIMIT 5000`;
      try {
        const rows = db.exec(sql);
        if (!rows.length) continue;
        const msgs = await Promise.all(rows[0].values.map((r: unknown[]) => parseMessageRow(r, talker)));
        allMsgs.push(...msgs);
      } catch { /* ignore */ }
    }
  }

  const filtered = allMsgs.filter(m => {
    if (type === "image") return m.type === 3;
    if (type === "video") return m.type === 43;
    if (type === "file") return m.type === 49 && m.appType === 6;
    return m.type === 3 || m.type === 43 || (m.type === 49 && m.appType === 6);
  });

  filtered.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

  const items: MediaItem[] = filtered.map(m => ({
    type: m.type === 3 ? "image" : m.type === 43 ? "video" : "file",
    talker: m.talker,
    talkerName: "",
    sender: m.sender || "",
    time: m.time,
    content: m.content,
    mediaPath: m.mediaPath || "",
    fileName: m.type === 49 ? getFileTitle(m.content) : "",
  }));

  return { total: items.length, items: items.slice(offset, offset + limit) };
}
