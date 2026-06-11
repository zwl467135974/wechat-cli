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
    return result;
  }

  const result = allMessages;
  await resolveSenderNames(dataDir, result);
  return result;
}

export async function searchMessages(
  dataDir: string,
  keyword: string,
  limit = 50,
  offset = 0
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
      const msgs = await searchInTable(
        db,
        tableName,
        keyword,
        talker,
        limit + offset,
        0
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

export { md5 };
