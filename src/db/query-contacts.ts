import { getConnection, findSingleFile } from "../db/manager.js";
import type { Contact, Session } from "../db/models.js";
import type { Database } from "sql.js";

export async function getContacts(
  dataDir: string,
  keyword?: string,
  limit = 200,
  offset = 0
): Promise<Contact[]> {
  const dbPath = findSingleFile(dataDir, "contact");
  if (!dbPath) throw new Error("Contact database not found in " + dataDir);

  const db = await getConnection(dbPath);

  const tableInfo = findContactTable(db);
  if (!tableInfo) throw new Error("Could not identify contact table structure");

  let sql: string;
  let params: unknown[] = [];

  if (tableInfo.version === "v4") {
    sql = `SELECT username, local_type, alias, remark, nick_name,
            COALESCE(small_head_url,'') as small_head_url,
            COALESCE(big_head_url,'') as big_head_url
           FROM contact`;
    if (keyword) {
      sql += ` WHERE username LIKE ? OR alias LIKE ? OR remark LIKE ? OR nick_name LIKE ?`;
      params = [`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`];
    }
  } else {
    sql = `SELECT UserName, 0 as local_type, Alias, Remark, NickName,
            COALESCE(SmallHeadImgUrl,'') as small_head_url,
            COALESCE(BigHeadImgUrl,'') as big_head_url
           FROM Contact`;
    if (keyword) {
      sql += ` WHERE UserName LIKE ? OR Alias LIKE ? OR Remark LIKE ? OR NickName LIKE ?`;
      params = [`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`];
    }
  }

  sql += ` ORDER BY username LIMIT ${limit} OFFSET ${offset}`;

  const rows = db.exec(sql, params);
  if (rows.length === 0) return [];

  return rows[0].values.map((row: unknown[]) => ({
    username: String(row[0]),
    localType: Number(row[1]),
    alias: String(row[2] || ""),
    remark: String(row[3] || ""),
    nickname: String(row[4] || ""),
    smallHeadUrl: String(row[5] || ""),
    bigHeadUrl: String(row[6] || ""),
  }));
}

function findContactTable(
  db: Database
): { version: "v4" | "v3"; table: string } | null {
  const rows = db.exec(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('contact','Contact')"
  );
  if (rows.length === 0) return null;

  const tables = rows[0].values.flat().map(String);
  if (tables.includes("contact")) return { version: "v4", table: "contact" };
  if (tables.includes("Contact")) return { version: "v3", table: "Contact" };
  return null;
}

const SYSTEM_ACCOUNTS = new Set([
  "brandsessionholder",
  "brandservicesessionholder",
  "newsapp",
  "weixin",
  "filehelper",
  "floatbottle",
  "medianote",
  "fmessage",
]);

function isSystemAccount(username: string): boolean {
  return SYSTEM_ACCOUNTS.has(username) || username.startsWith("gh_");
}

export async function getSessions(
  dataDir: string,
  keyword?: string,
  limit = 100,
  offset = 0
): Promise<Session[]> {
  const dbPath = findSingleFile(dataDir, "session");
  if (!dbPath) throw new Error("Session database not found in " + dataDir);

  const db = await getConnection(dbPath);

  const tableInfo = findSessionTable(db);
  if (!tableInfo) throw new Error("Could not identify session table structure");

  let sql: string;
  let params: unknown[] = [];

  if (tableInfo.version === "v4") {
    sql = `SELECT username, summary as last_message, last_timestamp,
            unread_count, is_hidden, sort_timestamp
           FROM SessionTable
           WHERE is_hidden = 0`;
    if (keyword) {
      sql += ` AND (username LIKE ? OR summary LIKE ?)`;
      params = [`%${keyword}%`, `%${keyword}%`];
    }
    sql += ` ORDER BY sort_timestamp DESC`;
  } else {
    sql = `SELECT strUsrName, strContent as last_message, nTime as last_timestamp,
            0 as unread_count, 0 as is_hidden
           FROM Session`;
    if (keyword) {
      sql += ` WHERE strUsrName LIKE ?`;
      params = [`%${keyword}%`];
    }
    sql += ` ORDER BY nTime DESC`;
  }

  sql += ` LIMIT ${Math.min(limit * 3, 500)} OFFSET ${offset}`;

  const rows = db.exec(sql, params);
  if (rows.length === 0) return [];

  const usernames = rows[0].values.map((row: unknown[]) => String(row[0]));
  const contactMap = await loadContactMap(dataDir, usernames);

  const allResults = rows[0].values.map((row: unknown[]) => {
    const username = String(row[0]);
    const contact = contactMap.get(username);
    const isSystem = isSystemAccount(username);
    return {
      username,
      nickname: contact?.nickname || "",
      remark: contact?.remark || "",
      alias: contact?.alias || "",
      smallHeadUrl: contact?.smallHeadUrl || "",
      bigHeadUrl: contact?.bigHeadUrl || "",
      lastMessage: row[1] ? String(row[1]) : undefined,
      lastTime: row[2] ? new Date(Number(row[2]) * 1000).toISOString() : undefined,
      unreadCount: Number(row[3]) || 0,
      isHidden: isSystem || Number(row[4]) === 1,
    };
  });

  let filtered = allResults.filter(s => !s.isHidden);

  if (keyword) {
    const kw = keyword.toLowerCase();
    filtered = filtered.filter(s => {
      const nickname = (s.nickname || "").toLowerCase();
      const remark = (s.remark || "").toLowerCase();
      return nickname.includes(kw) || remark.includes(kw) ||
        s.username.toLowerCase().includes(kw) || (s.lastMessage || "").toLowerCase().includes(kw);
    });
  }

  return filtered;
}

export async function loadContactMap(
  dataDir: string,
  usernames: string[]
): Promise<Map<string, { nickname: string; remark: string; alias: string; smallHeadUrl: string; bigHeadUrl: string }>> {
  const map = new Map();
  try {
    const contactPath = findSingleFile(dataDir, "contact");
    if (!contactPath) return map;
    const db = await getConnection(contactPath);
    const placeholders = usernames.map(() => "?").join(",");
    const rows = db.exec(
      `SELECT username, nick_name, remark, alias, COALESCE(small_head_url,''), COALESCE(big_head_url,'')
       FROM contact WHERE username IN (${placeholders})`,
      usernames
    );
    if (rows.length > 0) {
      for (const row of rows[0].values) {
        map.set(String(row[0]), {
          nickname: String(row[1] || ""),
          remark: String(row[2] || ""),
          alias: String(row[3] || ""),
          smallHeadUrl: String(row[4] || ""),
          bigHeadUrl: String(row[5] || ""),
        });
      }
    }
  } catch {
    // contact lookup is best-effort
  }
  return map;
}

function findSessionTable(
  db: Database
): { version: "v4" | "v3"; table: string } | null {
  const rows = db.exec(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('SessionTable','Session')"
  );
  if (rows.length === 0) return null;

  const tables = rows[0].values.flat().map(String);
  if (tables.includes("SessionTable")) return { version: "v4", table: "SessionTable" };
  if (tables.includes("Session")) return { version: "v3", table: "Session" };
  return null;
}

export interface ChatRoomMember {
  wxid: string;
  nickname: string;
  smallHeadUrl: string;
}

export async function getChatRoomMembers(
  dataDir: string,
  chatroomUsername: string
): Promise<ChatRoomMember[]> {
  const contactPath = findSingleFile(dataDir, "contact");
  if (!contactPath) return [];

  const db = await getConnection(contactPath);

  const row = db.exec(
    "SELECT ext_buffer FROM chat_room WHERE username = ?",
    [chatroomUsername]
  );
  if (row.length === 0 || row[0].values.length === 0) return [];

  const extBuffer = row[0].values[0][0];
  if (!extBuffer) return [];

  const data = Buffer.isBuffer(extBuffer) ? extBuffer : Buffer.from(extBuffer as Uint8Array);
  const members = parseChatRoomExtBuffer(data);

  if (members.length === 0) return [];

  const wxids = members.map(m => m.wxid);
  const contactMap = await loadContactMap(dataDir, wxids);

  return members.map(m => {
    const info = contactMap.get(m.wxid);
    return {
      wxid: m.wxid,
      nickname: m.nickname || info?.remark || info?.nickname || m.wxid,
      smallHeadUrl: info?.smallHeadUrl || "",
    };
  });
}

function parseChatRoomExtBuffer(data: Buffer): Array<{ wxid: string; nickname: string }> {
  const members: Array<{ wxid: string; nickname: string }> = [];
  let offset = 0;

  while (offset < data.length) {
    const byte = data[offset];
    if (byte === undefined) break;
    const wireType = byte & 0x07;
    const fieldNum = byte >> 3;
    offset++;

    if (wireType === 2) {
      const lenInfo = readVarintFromBuf(data, offset);
      offset += lenInfo.size;
      if (offset + lenInfo.value > data.length) break;
      const fieldData = data.subarray(offset, offset + lenInfo.value);
      offset += lenInfo.value;

      if (fieldNum === 1) {
        const member = parseMemberEntry(fieldData);
        if (member.wxid) members.push(member);
      }
    } else if (wireType === 0) {
      const v = readVarintFromBuf(data, offset);
      offset += v.size;
    } else if (wireType === 1) {
      offset += 8;
    } else if (wireType === 5) {
      offset += 4;
    } else {
      break;
    }
  }

  return members;
}

function parseMemberEntry(data: Buffer): { wxid: string; nickname: string } {
  let wxid = "";
  let nickname = "";
  let offset = 0;

  while (offset < data.length) {
    const byte = data[offset];
    if (byte === undefined) break;
    const wireType = byte & 0x07;
    const fieldNum = byte >> 3;
    offset++;

    if (wireType === 2) {
      const lenInfo = readVarintFromBuf(data, offset);
      offset += lenInfo.size;
      if (offset + lenInfo.value > data.length) break;
      const fieldData = data.subarray(offset, offset + lenInfo.value);
      offset += lenInfo.value;
      const text = fieldData.toString("utf-8");

      if (fieldNum === 1) wxid = text;
      else if (fieldNum === 2) nickname = text;
    } else if (wireType === 0) {
      const v = readVarintFromBuf(data, offset);
      offset += v.size;
    } else if (wireType === 1) {
      offset += 8;
    } else if (wireType === 5) {
      offset += 4;
    } else {
      break;
    }
  }

  return { wxid, nickname };
}

function readVarintFromBuf(data: Buffer, offset: number): { value: number; size: number } {
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
