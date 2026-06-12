import crypto from "node:crypto";
import {
  getConnection,
  buildShardIndex,
  resolveShards,
} from "../db/manager.js";
import type { Message } from "../db/models.js";
import type { Database } from "sql.js";
import {
  findMsgTable,
  listMsgTables,
  parseMessageRow,
  resolveSenderNames,
  md5,
} from "./message-parser.js";
import { saveMessages } from "./recall-store.js";
import { loadContactMap } from "./query-contacts.js";

let shardCache: Map<string, ReturnType<typeof buildShardIndex>> = new Map();

export function clearShardCache() {
  shardCache.clear();
}

export async function getShards(dataDir: string) {
  if (!shardCache.has(dataDir)) {
    shardCache.set(dataDir, buildShardIndex(dataDir));
  }
  return shardCache.get(dataDir)!;
}

export async function getMessages(
  dataDir: string,
  talker: string,
  options: {
    keyword?: string;
    limit?: number;
    offset?: number;
    reverse?: boolean;
    startTime?: number;
    endTime?: number;
  } = {}
): Promise<Message[]> {
  const { keyword, limit = 50, offset = 0, reverse = true, startTime, endTime } = options;
  const shards = await getShards(dataDir);
  const start = new Date(2010, 0, 1);
  const end = new Date();
  const targets = resolveShards(shards, start, end, talker);

  if (targets.length === 0) return [];

  const allMessages: Message[] = [];
  const fetchLimit = targets.length > 1 ? limit + offset : limit;
  const fetchOffset = targets.length > 1 ? 0 : offset;

  for (const target of targets) {
    const db = await getConnection(target.filePath);
    const tableName = findMsgTable(db, talker, target.talkerId);
    if (!tableName) continue;

    const msgs = await queryMessages(
      db,
      tableName,
      talker,
      target.talkerId,
      keyword,
      fetchLimit,
      fetchOffset,
      reverse,
      startTime,
      endTime
    );
    allMessages.push(...msgs);
  }

  allMessages.sort((a, b) => a.seq - b.seq);

  if (targets.length > 1) {
    const start = reverse ? Math.max(0, allMessages.length - limit - offset) : offset;
    const result = allMessages.slice(start, start + limit);
    await resolveSenderNames(dataDir, result);
    saveMessages(talker, result);
    return result;
  }

  const result = allMessages;
  await resolveSenderNames(dataDir, result);
  saveMessages(talker, result);
  return result;
}

export async function searchMessages(
  dataDir: string,
  keyword: string,
  limit = 50,
  offset = 0,
  filters?: {
    talker?: string;
    sender?: string;
    msgType?: number;
    startTime?: number;
    endTime?: number;
    useRegex?: boolean;
  }
): Promise<Message[]> {
  const shards = await getShards(dataDir);
  const allMessages: Message[] = [];

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
      if (filters?.talker && talker !== filters.talker) continue;

      const msgs = await searchInTableAdvanced(
        db,
        tableName,
        keyword,
        talker,
        limit + offset,
        0,
        filters
      );
      allMessages.push(...msgs);
    }
  }

  allMessages.sort((a, b) => b.seq - a.seq);
  const result = allMessages.slice(offset, offset + limit);
  await resolveSenderNames(dataDir, result);
  return result;
}

async function queryMessages(
  db: Database,
  tableName: string,
  talker: string,
  talkerId: number | null,
  keyword: string | undefined,
  limit: number,
  offset: number,
  reverse: boolean,
  startTime?: number,
  endTime?: number
): Promise<Message[]> {
  const order = reverse ? "DESC" : "ASC";
  const where = buildWhereClause(keyword, startTime, endTime);

  const sql = `SELECT sort_seq, create_time, local_type, message_content, compress_content, status, source, packed_info_data
         FROM "${tableName}" ${where.clause}
         ORDER BY sort_seq ${order}
         LIMIT ? OFFSET ?`;

  try {
    const rows = db.exec(sql, [...where.params, limit, offset]);
    if (rows.length === 0) return [];

    const messages = await Promise.all(rows[0].values.map((row: unknown[]) =>
      parseMessageRow(row, talker)
    ));
    if (reverse) messages.reverse();
    return messages;
  } catch {
    return [];
  }
}

function buildWhereClause(
  keyword: string | undefined,
  startTime?: number,
  endTime?: number
): { clause: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (keyword) {
    conditions.push("message_content LIKE ?");
    params.push(`%${keyword}%`);
  }
  if (startTime) {
    conditions.push("create_time >= ?");
    params.push(startTime);
  }
  if (endTime) {
    conditions.push("create_time <= ?");
    params.push(endTime);
  }

  if (conditions.length === 0) {
    return { clause: "", params: [] };
  }

  return { clause: `WHERE ${conditions.join(" AND ")}`, params };
}

async function searchInTable(
  db: Database,
  tableName: string,
  keyword: string,
  talker: string,
  limit: number,
  offset: number
): Promise<Message[]> {
  const sql = `SELECT sort_seq, create_time, local_type, message_content, compress_content, status, source, packed_info_data
               FROM "${tableName}"
               WHERE message_content LIKE ?
               ORDER BY sort_seq ASC
               LIMIT ? OFFSET ?`;

  try {
    const rows = db.exec(sql, [`%${keyword}%`, limit, offset]);
    if (rows.length === 0) return [];

    return await Promise.all(rows[0].values.map((row: unknown[]) =>
      parseMessageRow(row, talker)
    ));
  } catch {
    return [];
  }
}

async function searchInTableAdvanced(
  db: Database,
  tableName: string,
  keyword: string,
  talker: string,
  limit: number,
  offset: number,
  filters?: {
    sender?: string;
    msgType?: number;
    startTime?: number;
    endTime?: number;
    useRegex?: boolean;
  }
): Promise<Message[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (keyword) {
    if (filters?.useRegex) {
      conditions.push("message_content REGEXP ?");
      params.push(keyword);
    } else {
      conditions.push("message_content LIKE ?");
      params.push(`%${keyword}%`);
    }
  }
  if (filters?.msgType !== undefined) {
    conditions.push("(local_type & 0xFFFF) = ?");
    params.push(filters.msgType);
  }
  if (filters?.startTime) {
    conditions.push("create_time >= ?");
    params.push(filters.startTime);
  }
  if (filters?.endTime) {
    conditions.push("create_time <= ?");
    params.push(filters.endTime);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const sql = `SELECT sort_seq, create_time, local_type, message_content, compress_content, status, source, packed_info_data
               FROM "${tableName}"
               ${where}
               ORDER BY sort_seq ASC
               LIMIT ? OFFSET ?`;

  try {
    const rows = db.exec(sql, [...params, limit, offset]);
    if (rows.length === 0) return [];

    const msgs = await Promise.all(rows[0].values.map((row: unknown[]) =>
      parseMessageRow(row, talker)
    ));

    if (filters?.sender) {
      return msgs.filter(m => {
        const s = (m.sender || "").toLowerCase();
        return s.includes(filters.sender!.toLowerCase());
      });
    }
    return msgs;
  } catch {
    return [];
  }
}

export { md5 };

export async function getTimeline(
  dataDir: string,
  date: string,
  limit = 200
): Promise<(Message & { talkerName?: string })[]> {
  const shards = await getShards(dataDir);
  const startTs = Math.floor(new Date(date + "T00:00:00").getTime() / 1000);
  const endTs = Math.floor(new Date(date + "T23:59:59").getTime() / 1000);
  const all: (Message & { talkerName?: string })[] = [];

  for (const shard of shards) {
    const db = await getConnection(shard.filePath);
    const tables = listMsgTables(db);
    for (const table of tables) {
      try {
        const rows = db.exec(
          `SELECT sort_seq, create_time, local_type, message_content, compress_content, status, source, packed_info_data
           FROM "${table}"
           WHERE create_time >= ? AND create_time <= ?
           ORDER BY create_time ASC
           LIMIT ?`,
          [startTs, endTs, limit]
        );
        if (!rows.length || !rows[0].values.length) continue;
        const talkers = [...shard.talkerMap.entries()];
        const tableIdx = parseInt(table.replace(/^msg/i, "").replace("_", ""));
        const entry = talkers.find(([, idx]) => idx === tableIdx);
        const talker = entry ? entry[0] : table;
        for (const row of rows[0].values) {
          const msg = await parseMessageRow(row as unknown[], talker);
          msg.talker = talker;
          all.push(msg);
        }
      } catch { /* skip broken tables */ }
    }
  }

  all.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  const result = all.slice(0, limit);
  await resolveSenderNames(dataDir, result);

  const contactMap = await loadContactMap(dataDir, [...new Set(result.map(m => m.talker))]);
  for (const msg of result) {
    const c = contactMap.get(msg.talker);
    if (c) msg.talkerName = c.nickname || c.remark || msg.talker;
  }

  return result;
}
