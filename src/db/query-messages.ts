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
      reverse
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
        limit,
        offset
      );
      allMessages.push(...msgs);
    }
  }

  allMessages.sort((a, b) => b.seq - a.seq);
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

  return null;
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
  const order = reverse ? "DESC" : "ASC";
  const where = buildWhereClause(keyword);

  const sql = `SELECT sort_seq, create_time, local_type, message_content, compress_content, status, source, packed_info_data
         FROM "${tableName}" ${where.clause}
         ORDER BY sort_seq ${order}
         LIMIT ${limit} OFFSET ${offset}`;

  try {
    const rows = db.exec(sql, where.params);
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
  keyword: string | undefined
): { clause: string; params: unknown[] } {
  if (!keyword) {
    return { clause: "", params: [] };
  }

  return {
    clause: "WHERE message_content LIKE ?",
    params: [`%${keyword}%`],
  };
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
               LIMIT ${limit} OFFSET ${offset}`;

  try {
    const rows = db.exec(sql, [`%${keyword}%`]);
    if (rows.length === 0) return [];

    return await Promise.all(rows[0].values.map((row: unknown[]) =>
      parseMessageRow(row, talker)
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
  const packedInfoRaw = row[7];

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

  let emojiUrl: string | undefined;
  let appType: number | undefined;
  let appUrl: string | undefined;
  let appThumbUrl: string | undefined;
  let referContent: string | undefined;
  let referSender: string | undefined;
  let locationLabel: string | undefined;
  let locationPoiName: string | undefined;
  let voiceDuration: number | undefined;
  let voiceText: string | undefined;

  if (!content || content.length === 0 || (content.charCodeAt(0) < 0x20)) {
    content = getMediaTypeLabel(localType);
  } else if (localType === 3 || localType === 43) {
    content = getMediaTypeLabel(localType);
  } else if (localType === 47) {
    const cdnMatch = content.match(/cdnurl\s*=\s*"([^"]+)"/);
    if (cdnMatch) {
      emojiUrl = decodeURIComponent(cdnMatch[1]).replace(/&amp;/g, "&");
    }
    if (!emojiUrl) {
      const thumbMatch = content.match(/thumburl\s*=\s*"([^"]+)"/);
      if (thumbMatch) {
        emojiUrl = decodeURIComponent(thumbMatch[1]).replace(/&amp;/g, "&");
      }
    }
    if (!emojiUrl) {
      const md5Match = content.match(/md5\s*=\s*"([0-9a-f]{32})"/i);
      if (md5Match) {
        emojiUrl = `emoji://${md5Match[1]}`;
      }
    }
    content = "[表情]";
  } else if (localType === 34) {
    const durMatch = content.match(/voicelength="(\d+)"/);
    voiceDuration = durMatch ? Math.round(parseInt(durMatch[1]) / 1000) : undefined;
    content = "[语音]";
  } else if (localType === 48) {
    const locMatch = content.match(/label="([^"]+)"/);
    const poiMatch = content.match(/poiname="([^"]+)"/);
    locationLabel = locMatch ? locMatch[1] : "";
    locationPoiName = poiMatch ? poiMatch[1] : "";
    content = locationPoiName || locationLabel || "[位置]";
  }

  if (!content && localType !== 1 && localType !== 10000 && localType !== 10002) {
    content = getMediaTypeLabel(localType);
  }

  if (localType === 10000 || localType === 10002) {
    content = extractSystemMessage(content);
  }

  if (localType === 49 && content.includes("<")) {
    const appResult = extractAppMessage(content);
    content = appResult.content;
    appType = appResult.appType;
    appUrl = appResult.appUrl;
    appThumbUrl = appResult.appThumbUrl;
    referContent = appResult.referContent;
    referSender = appResult.referSender;
  }

  let mediaPath: string | undefined;
  const packedSource = (packedInfoRaw instanceof Uint8Array || Buffer.isBuffer(packedInfoRaw))
    ? Buffer.from(packedInfoRaw)
    : (compressContent instanceof Uint8Array || Buffer.isBuffer(compressContent))
      ? Buffer.from(compressContent)
      : undefined;
  if (packedSource) {
    if (localType === 34) {
      voiceText = extractVoiceTranscription(packedSource);
      if (voiceText) content = voiceText;
    }
    const packedInfo = parsePackedInfo(packedSource);
    if (packedInfo) {
      if (localType === 3 && (packedInfo.imageMd5 || packedInfo.videoMd5)) {
        const talkerMd5 = md5(defaultTalker);
        const date = new Date(createTime * 1000);
        const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
        mediaPath = path.join("msg", "attach", talkerMd5, month, "Img", packedInfo.imageMd5 || packedInfo.videoMd5 || "");
      } else if (localType === 43 && (packedInfo.imageMd5 || packedInfo.videoMd5)) {
        const date = new Date(createTime * 1000);
        const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
        mediaPath = path.join("msg", "video", month, packedInfo.videoMd5 || packedInfo.imageMd5 || "");
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
    emojiUrl,
    appType,
    appUrl,
    appThumbUrl,
    referContent,
    referSender,
    locationLabel,
    locationPoiName,
    voiceDuration,
    voiceText,
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

function extractVoiceTranscription(data: Buffer): string | undefined {
  try {
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

        if (fieldNum === 5 && fieldData.length > 4) {
          let off = 0;
          while (off < fieldData.length) {
            const b = fieldData[off]; if (b === undefined) break;
            const fn = b >> 3;
            const wt = b & 0x07;
            off++;
            if (wt === 2) {
              const innerLen = readVarint(fieldData, off);
              if (innerLen.value < 0 || off + innerLen.size + innerLen.value > fieldData.length) break;
              const inner = fieldData.subarray(off + innerLen.size, off + innerLen.size + innerLen.value);
              off += innerLen.size + innerLen.value;
              if (fn === 2) {
                const text = inner.toString("utf-8");
                if (text.length > 1) return text;
              }
            } else if (wt === 0) {
              const v = readVarint(fieldData, off);
              off += v.size;
            } else if (wt === 1) { off += 8; }
            else if (wt === 5) { off += 4; }
            else break;
          }
        }
      } else if (wireType === 0) {
        const v = readVarint(data, offset);
        offset += v.size;
      } else if (wireType === 1) { offset += 8; }
      else if (wireType === 5) { offset += 4; }
      else break;
    }
  } catch { /* ignore */ }
  return undefined;
}

interface AppMessageResult {
  content: string;
  appType?: number;
  appUrl?: string;
  appThumbUrl?: string;
  referContent?: string;
  referSender?: string;
}

function extractAppMessage(raw: string): AppMessageResult {
  const result: AppMessageResult = { content: raw };

  const typeMatch = raw.match(/<type>(\d+)<\/type>/);
  result.appType = typeMatch ? Number(typeMatch[1]) : undefined;

  const titleMatch = raw.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
  if (!titleMatch) return result;
  const title = titleMatch[1];

  const urlMatch = raw.match(/<url>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/url>/);
  if (urlMatch) {
    result.appUrl = decodeURIComponent(urlMatch[1]).replace(/&amp;/g, "&");
    if (result.appUrl.startsWith("http://mp.weixin.qq.com")) {
      result.appUrl = result.appUrl.replace("http://", "https://");
    }
  }

  const thumbMatch = raw.match(/<thumburl>(?:<!\[CDATA\[)?(https?:\/\/[^\s<\]]+)/);
  const coverMatch = raw.match(/<cover>(?:<!\[CDATA\[)?(https?:\/\/[^\s<\]]+)/);
  result.appThumbUrl = thumbMatch?.[1] || coverMatch?.[1] || undefined;

  const referMatch = raw.match(/<refermsg>([\s\S]*?)<\/refermsg>/);
  if (referMatch) {
    const refBlock = referMatch[1];
    const refContentMatch = refBlock.match(/<content>([\s\S]*?)<\/content>/);
    const refSenderMatch = refBlock.match(/<displayname>([\s\S]*?)<\/displayname>/);
    result.referContent = refContentMatch ? refContentMatch[1].trim() : "";
    result.referSender = refSenderMatch ? refSenderMatch[1].trim() : "";
  }

  if (result.appType === 57) {
    const ref = result.referContent || "";
    const sender = result.referSender || "";
    result.content = title;
    if (ref) {
      result.content += `\n▎回复 ${sender}: ${ref.substring(0, 100)}${ref.length > 100 ? "..." : ""}`;
    }
    return result;
  }

  const appInfoMatch = raw.match(/<appinfo>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<\/appinfo>/);
  const subAppmsgs = raw.match(/<appmsg[\s\S]*?<\/appmsg>/g);
  if (appInfoMatch && subAppmsgs && subAppmsgs.length > 1) {
    const items = subAppmsgs.slice(0, 10).map((block, i) => {
      const tMatch = block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
      return `${i + 1}. ${tMatch ? tMatch[1].trim() : "..."}`;
    });
    const header = appInfoMatch[1].trim();
    result.content = `[合并转发] ${header} (${subAppmsgs.length}条)\n${items.join("\n")}`;
    return result;
  }

  const descMatch = raw.match(/<des>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/des>/);
  const desc = descMatch && descMatch[1] ? descMatch[1].trim() : "";

  const typeLabels: Record<number, string> = {
    5: "", 6: "[文件]", 8: "[动画表情]", 17: "[实时位置]",
    21: "[名片]", 33: "[小程序]", 36: "[小程序]",
    57: "", 62: "[视频号]", 63: "[视频号直播]", 76: "[视频号视频]",
    87: "[群公告]", 88: "[红包]", 95: "[投票]", 109: "[游戏]",
  };

  const prefix = typeLabels[result.appType || 0] || "";
  if (desc && desc.length < 200) {
    result.content = `${prefix}${title}\n${desc}`;
  } else {
    result.content = prefix ? `${prefix} ${title}` : title;
  }

  return result;
}

interface PackedInfo {
  imageMd5?: string;
  videoMd5?: string;
}

function parsePackedInfo(data: Buffer): PackedInfo | null {
  try {
    const result: PackedInfo = {};
    extractHexIds(data, result);
    if (result.imageMd5 || result.videoMd5) return result;
    return null;
  } catch {
    return null;
  }
}

function extractHexIds(data: Buffer, result: PackedInfo): void {
  let offset = 0;
  while (offset < data.length) {
    const byte = data[offset];
    if (byte === undefined) break;
    const wireType = byte & 0x07;
    offset++;

    if (wireType === 2) {
      const len = readVarint(data, offset);
      if (len.value < 0 || offset + len.size + len.value > data.length) break;
      const fieldData = data.subarray(offset + len.size, offset + len.size + len.value);
      offset += len.size + len.value;

      const text = fieldData.toString("utf-8");
      if (/^[0-9a-f]{32}$/i.test(text)) {
        if (!result.imageMd5) {
          result.imageMd5 = text;
        } else if (!result.videoMd5) {
          result.videoMd5 = text;
        }
      } else if (fieldData.length > 2) {
        extractHexIds(fieldData, result);
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

export interface GlobalStats {
  totalMessages: number;
  totalContacts: number;
  totalSessions: number;
  totalChatrooms: number;
  typeDistribution: { type: number; label: string; count: number }[];
  topContacts: { username: string; nickname: string; count: number }[];
  hourlyActivity: number[];
  dailyActivity: { date: string; count: number }[];
  dateRange: { earliest: string; latest: string };
}

export async function getGlobalStats(dataDir: string): Promise<GlobalStats> {
  const shards = await getShards(dataDir);
  let totalMessages = 0;
  const typeCounts: Record<number, number> = {};
  const talkerCounts: Record<string, number> = {};
  const hourlyActivity = new Array(24).fill(0);
  const dailyActivity: Record<string, number> = {};
  let earliest = Infinity;
  let latest = 0;

  const typeLabels: Record<number, string> = {
    1: "文本", 3: "图片", 34: "语音", 43: "视频",
    47: "表情", 48: "位置", 49: "应用", 10000: "系统", 10002: "撤回",
  };

  for (const shard of shards) {
    const db = await getConnection(shard.filePath);
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'");

    if (tables.length === 0) continue;

    const talkerReverse = new Map<string, string>();
      try {
        const n2i = db.exec("SELECT user_name, is_session FROM Name2Id");
        if (n2i.length > 0) {
          for (const r of n2i[0].values) {
            talkerReverse.set(String(r[1]), String(r[0]));
          }
        }
      } catch { /* ignore */ }

    for (const tRow of tables[0].values) {
      const tableName = String(tRow[0]);
      try {
        const countRow = db.exec(`SELECT COUNT(*) FROM "${tableName}"`);
        if (countRow.length > 0) {
          totalMessages += Number(countRow[0].values[0][0]);
        }

        const typeRows = db.exec(
          `SELECT (local_type & 0xFFFF) AS mt, COUNT(*) AS c FROM "${tableName}" GROUP BY mt ORDER BY c DESC`
        );
        if (typeRows.length > 0) {
          for (const r of typeRows[0].values) {
            const mt = Number(r[0]);
            typeCounts[mt] = (typeCounts[mt] || 0) + Number(r[1]);
          }
        }

        const talkerRow = db.exec(
          `SELECT MIN(create_time), MAX(create_time) FROM "${tableName}"`
        );
        if (talkerRow.length > 0 && talkerRow[0].values.length > 0) {
          const minT = Number(talkerRow[0].values[0][0]);
          const maxT = Number(talkerRow[0].values[0][1]);
          if (minT && minT < earliest) earliest = minT;
          if (maxT && maxT > latest) latest = maxT;
        }

        const hourlyRows = db.exec(
          `SELECT CAST(strftime('%H', create_time, 'unixepoch', 'localtime') AS INTEGER) AS hr, COUNT(*) AS c FROM "${tableName}" GROUP BY hr`
        );
        if (hourlyRows.length > 0) {
          for (const r of hourlyRows[0].values) {
            hourlyActivity[Number(r[0])] += Number(r[1]);
          }
        }

        const dailyRows = db.exec(
          `SELECT strftime('%Y-%m-%d', create_time, 'unixepoch', 'localtime') AS d, COUNT(*) AS c FROM "${tableName}" GROUP BY d ORDER BY d`
        );
        if (dailyRows.length > 0) {
          for (const r of dailyRows[0].values) {
            const d = String(r[0]);
            dailyActivity[d] = (dailyActivity[d] || 0) + Number(r[1]);
          }
        }

        const tcRow = db.exec(`SELECT COUNT(*) FROM "${tableName}"`);
        if (tcRow.length > 0) {
          talkerCounts[tableName] = (talkerCounts[tableName] || 0) + Number(tcRow[0].values[0][0]);
        }
      } catch {
        // skip unreadable tables
      }
    }
  }

  const sessionDbPath = findSingleFile(dataDir, "session");
  let totalSessions = 0;
  let totalChatrooms = 0;
  if (sessionDbPath) {
    try {
      const sdb = await getConnection(sessionDbPath);
      const sr = sdb.exec("SELECT COUNT(*) FROM SessionTable WHERE is_hidden = 0");
      if (sr.length > 0) totalSessions = Number(sr[0].values[0][0]);
      const cr = sdb.exec("SELECT COUNT(*) FROM SessionTable WHERE is_hidden = 0 AND username LIKE '%@chatroom'");
      if (cr.length > 0) totalChatrooms = Number(cr[0].values[0][0]);
    } catch { /* ignore */ }
  }

  const contactDbPath = findSingleFile(dataDir, "contact");
  let totalContacts = 0;
  if (contactDbPath) {
    try {
      const cdb = await getConnection(contactDbPath);
      let cr = cdb.exec("SELECT COUNT(*) FROM contact");
      if (!cr.length) cr = cdb.exec("SELECT COUNT(*) FROM Contact");
      if (cr.length > 0) totalContacts = Number(cr[0].values[0][0]);
    } catch { /* ignore */ }
  }

  const typeDistribution = Object.entries(typeCounts)
    .map(([t, c]) => ({ type: Number(t), label: typeLabels[Number(t)] || `类型${t}`, count: c }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const topContactList = Object.entries(talkerCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([tableName, count]) => ({ username: tableName, nickname: "", count }));

  if (topContactList.length > 0) {
    const sessionDbPath = findSingleFile(dataDir, "session");
    const talkerToTable = new Map<string, string>();
    if (sessionDbPath) {
      try {
        const sdb = await getConnection(sessionDbPath);
        const sRows = sdb.exec("SELECT username FROM SessionTable WHERE is_hidden = 0");
        if (sRows.length > 0) {
          for (const r of sRows[0].values) {
            const uname = String(r[0]);
            talkerToTable.set(`Msg_${md5(uname)}`, uname);
          }
        }
      } catch { /* ignore */ }
    }
    const wxids = [];
    for (const c of topContactList) {
      const resolved = talkerToTable.get(c.username);
      if (resolved) {
        c.username = resolved;
        wxids.push(resolved);
      }
    }
    if (wxids.length > 0) {
      const map = await loadContactMap(dataDir, wxids);
      for (const c of topContactList) {
        if (talkerToTable.has(`Msg_${md5(c.username)}`)) {
          const info = map.get(c.username);
          if (info) c.nickname = info.remark || info.nickname || c.username;
        }
      }
    }
  }

  const dailyArray = Object.entries(dailyActivity)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count }));

  return {
    totalMessages,
    totalContacts,
    totalSessions,
    totalChatrooms,
    typeDistribution,
    topContacts: topContactList,
    hourlyActivity,
    dailyActivity: dailyArray,
    dateRange: {
      earliest: earliest === Infinity ? "" : new Date(earliest * 1000).toISOString(),
      latest: latest === 0 ? "" : new Date(latest * 1000).toISOString(),
    },
  };
}
