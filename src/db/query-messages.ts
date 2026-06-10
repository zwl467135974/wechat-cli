import path from "node:path";
import crypto from "node:crypto";
import {
  getConnection,
  buildShardIndex,
  resolveShards,
  findSingleFile,
} from "../db/manager.js";
import { decodeMessageContent } from "../db/codec.js";
import { loadContactMap } from "../db/query-contacts.js";
import type { Message } from "../db/models.js";
import type { Database } from "sql.js";

const MSG_TYPES: Record<number, string> = {
  1: "text",
  3: "image",
  34: "voice",
  43: "video",
  47: "emoji",
  48: "location",
  49: "app",
  10000: "system",
  10002: "revoke",
};

let shardCache: Map<string, ReturnType<typeof buildShardIndex>> = new Map();

export function clearShardCache() {
  shardCache.clear();
}

async function getShards(dataDir: string) {
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
  } = {}
): Promise<Message[]> {
  const { keyword, limit = 50, offset = 0, reverse = true } = options;
  const shards = await getShards(dataDir);
  const start = new Date(2010, 0, 1);
  const end = new Date();
  const targets = resolveShards(shards, start, end, talker);

  if (targets.length === 0) return [];

  const allMessages: Message[] = [];

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
      limit,
      offset,
      reverse
    );
    allMessages.push(...msgs);
  }

  allMessages.sort((a, b) => a.seq - b.seq);

  const result = allMessages.slice(0, limit);
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

    for (const tableName of tables) {
      const msgs = await searchInTable(
        db,
        tableName,
        keyword,
        limit,
        offset
      );
      allMessages.push(...msgs);
    }
  }

  allMessages.sort((a, b) => a.seq - b.seq);
  const result = allMessages.slice(0, limit);
  await resolveSenderNames(dataDir, result);
  return result;
}

function findMsgTable(
  db: Database,
  talker: string,
  talkerId: number | null
): string | null {
  const talkerMd5 = md5(talker);
  const directTable = `Msg_${talkerMd5}`;
  if (tableExists(db, directTable)) return directTable;

  const tables = listMsgTables(db);
  return tables.length > 0 ? tables[0] : null;
}

function tableExists(db: Database, name: string): boolean {
  try {
    const rows = db.exec(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`,
      [name]
    );
    return rows.length > 0 && rows[0].values.length > 0;
  } catch {
    return false;
  }
}

function listMsgTables(db: Database): string[] {
  const rows = db.exec(
    "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'Msg_%' OR name LIKE 'MSG%' OR name LIKE 'msg%')"
  );
  if (rows.length === 0) return [];
  return rows[0].values.flat().map(String);
}

async function queryMessages(
  db: Database,
  tableName: string,
  talker: string,
  talkerId: number | null,
  keyword: string | undefined,
  limit: number,
  offset: number,
  reverse: boolean
): Promise<Message[]> {
  let sql: string;
  let params: unknown[] = [];

  const order = reverse ? "DESC" : "ASC";
  const where = buildWhereClause(talker, talkerId, keyword, tableName);
  params = where.params;

  sql = `SELECT sort_seq, create_time, local_type, message_content, compress_content, status, source
         FROM "${tableName}" ${where.clause}
         ORDER BY sort_seq ${order}
         LIMIT ${limit} OFFSET ${offset}`;

  try {
    const rows = db.exec(sql, params);
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
  talker: string,
  talkerId: number | null,
  keyword: string | undefined,
  tableName: string
): { clause: string; params: unknown[]; hasTalkerFilter: boolean } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (keyword) {
    conditions.push("message_content LIKE ?");
    params.push(`%${keyword}%`);
  }

  if (conditions.length === 0) {
    return { clause: "", params: [], hasTalkerFilter: false };
  }

  return {
    clause: "WHERE " + conditions.join(" AND "),
    params,
    hasTalkerFilter: false,
  };
}

async function searchInTable(
  db: Database,
  tableName: string,
  keyword: string,
  limit: number,
  offset: number
): Promise<Message[]> {
  const sql = `SELECT sort_seq, create_time, local_type, message_content, compress_content, status, source
               FROM "${tableName}"
               WHERE message_content LIKE ?
               ORDER BY sort_seq ASC
               LIMIT ${limit} OFFSET ${offset}`;

  try {
    const rows = db.exec(sql, [`%${keyword}%`]);
    if (rows.length === 0) return [];

    return await Promise.all(rows[0].values.map((row: unknown[]) =>
      parseMessageRow(row, "unknown")
    ));
  } catch {
    return [];
  }
}

async function parseMessageRow(
  row: unknown[],
  defaultTalker: string
): Promise<Message> {
  const seq = Number(row[0]) || 0;
  const createTime = Number(row[1]) || 0;
  const localTypeRaw = Number(row[2]) || 0;
  const localType = localTypeRaw & 0xFFFF;
  const rawContent = row[3];
  const compressContent = row[4];
  const status = Number(row[5]) || 0;

  let rawText = "";
  if (rawContent instanceof Uint8Array || Buffer.isBuffer(rawContent)) {
    rawText = await decodeMessageContent(Buffer.from(rawContent));
  } else if (rawContent != null) {
    rawText = String(rawContent);
  }

  const isChatRoom = defaultTalker.endsWith("@chatroom");
  let sender = "";
  let isSelf = status === 2;
  let content = rawText;

  if (isChatRoom && rawText) {
    const split = rawText.split(":\n", 2);
    if (split.length === 2) {
      sender = split[0];
      content = split[1];
      isSelf = false;
    } else if (localType !== 10000) {
      isSelf = true;
    }
  } else {
    sender = defaultTalker;
  }

  if (!content || content.length === 0 || (content.charCodeAt(0) < 0x20)) {
    content = getMediaTypeLabel(localType);
  } else if (localType === 3 || localType === 43) {
    content = getMediaTypeLabel(localType);
  } else if (localType === 47) {
    content = "[表情]";
  } else if (localType === 34) {
    content = "[语音]";
  }

  if (!content && localType !== 1 && localType !== 10000 && localType !== 10002) {
    content = getMediaTypeLabel(localType);
  }

  if (localType === 10000 || localType === 10002) {
    content = extractSystemMessage(content);
  }

  if (localType === 49 && content.includes("<")) {
    content = extractAppMessage(content);
  }

  let mediaPath: string | undefined;
  if (compressContent instanceof Uint8Array || Buffer.isBuffer(compressContent)) {
    const packedInfo = parsePackedInfo(Buffer.from(compressContent));
    if (packedInfo) {
      if (localType === 3 && packedInfo.imageMd5) {
        const talkerMd5 = md5(defaultTalker);
        const date = new Date(createTime * 1000);
        const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
        mediaPath = path.join("msg", "attach", talkerMd5, month, "Img", packedInfo.imageMd5);
      } else if (localType === 43 && packedInfo.videoMd5) {
        const date = new Date(createTime * 1000);
        const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
        mediaPath = path.join("msg", "video", month, packedInfo.videoMd5);
      }
    }
  }

  return {
    seq,
    time: new Date(createTime * 1000).toISOString(),
    talker: defaultTalker,
    sender,
    isSelf,
    isChatRoom,
    type: localType,
    content,
    mediaPath,
  };
}

async function resolveSenderNames(dataDir: string, messages: Message[]): Promise<void> {
  const wxids = new Set<string>();
  for (const m of messages) {
    if (m.sender && m.sender.startsWith("wxid_")) wxids.add(m.sender);
  }
  if (wxids.size === 0) return;

  const map = await loadContactMap(dataDir, [...wxids]);
  for (const m of messages) {
    if (m.sender && map.has(m.sender)) {
      const c = map.get(m.sender)!;
      m.sender = c.remark || c.nickname || m.sender;
    }
  }
}

function getMediaTypeLabel(localType: number): string {
  const labels: Record<number, string> = {
    3: "[图片]",
    34: "[语音]",
    43: "[视频]",
    47: "[表情]",
    48: "[位置]",
    49: "[文件]",
  };
  return labels[localType] || `[消息类型:${localType}]`;
}

function extractSystemMessage(content: string): string {
  if (!content.includes("<")) return content;
  const revokemsg = content.match(/<content>([\s\S]*?)<\/content>/);
  if (revokemsg) return revokemsg[1];
  return content;
}

function extractAppMessage(content: string): string {
  const titleMatch = content.match(/<title>([\s\S]*?)<\/title>/);
  if (!titleMatch) return content;
  const title = titleMatch[1];
  const descMatch = content.match(/<des>([\s\S]*?)<\/des>/);
  const desc = descMatch && descMatch[1] ? descMatch[1].trim() : "";
  if (desc) return `${title}\n${desc}`;
  return title;
}

interface PackedInfo {
  imageMd5?: string;
  videoMd5?: string;
}

function parsePackedInfo(data: Buffer): PackedInfo | null {
  try {
    const result: PackedInfo = {};
    // Simple protobuf-like field extraction
    let offset = 0;
    while (offset < data.length) {
      const byte = data[offset];
      if (byte === undefined) break;
      const fieldNum = byte >> 3;
      const wireType = byte & 0x07;
      offset++;

      if (wireType === 2) {
        const len = readVarint(data, offset);
        if (len.value < 0 || offset + len.size + len.value > data.length) break;
        const fieldData = data.subarray(offset + len.size, offset + len.size + len.value);
        offset += len.size + len.value;

        if (fieldNum === 1 && fieldData.length > 0) {
          result.imageMd5 = extractMd5FromProto(fieldData);
        } else if (fieldNum === 2 && fieldData.length > 0) {
          result.videoMd5 = extractMd5FromProto(fieldData);
        }
      } else if (wireType === 0) {
        const v = readVarint(data, offset);
        offset += v.size;
      } else if (wireType === 1) {
        offset += 8;
      } else if (wireType === 5) {
        offset += 4;
      } else {
        break;
      }
    }
    if (result.imageMd5 || result.videoMd5) return result;
    return null;
  } catch {
    return null;
  }
}

function extractMd5FromProto(data: Buffer): string | undefined {
  let offset = 0;
  while (offset < data.length) {
    const byte = data[offset];
    if (byte === undefined) break;
    const fieldNum = byte >> 3;
    const wireType = byte & 0x07;
    offset++;

    if (wireType === 2) {
      const len = readVarint(data, offset);
      if (len.value < 0 || offset + len.size + len.value > data.length) break;
      const fieldData = data.subarray(offset + len.size, offset + len.size + len.value);
      offset += len.size + len.value;

      // md5 field is typically a 32-byte string
      if (fieldData.length === 32 || fieldData.length === 16) {
        const str = fieldData.toString("utf-8");
        if (/^[0-9a-f]{32}$/i.test(str)) return str;
        if (fieldData.length === 16) return fieldData.toString("hex");
      }
    } else if (wireType === 0) {
      const v = readVarint(data, offset);
      offset += v.size;
    } else if (wireType === 1) {
      offset += 8;
    } else if (wireType === 5) {
      offset += 4;
    } else {
      break;
    }
  }
  return undefined;
}

function readVarint(
  data: Buffer,
  offset: number
): { value: number; size: number } {
  let result = 0;
  let shift = 0;
  let size = 0;

  while (offset < data.length) {
    const byte = data[offset];
    if (byte === undefined) break;
    size++;
    result |= (byte & 0x7f) << shift;
    offset++;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }

  return { value: result, size };
}

function md5(input: string): string {
  return crypto.createHash("md5").update(input).digest("hex");
}
