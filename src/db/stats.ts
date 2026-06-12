import {
  getConnection,
  resolveShards,
  findSingleFile,
} from "../db/manager.js";
import { decodeMessageContent } from "../db/codec.js";
import { loadContactMap } from "../db/query-contacts.js";
import { getShards } from "./query-messages.js";
import {
  md5,
  findMsgTable,
  extractWords,
} from "./message-parser.js";

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
        const aggRows = db.exec(
          `SELECT COUNT(*) AS cnt, MIN(create_time) AS min_t, MAX(create_time) AS max_t FROM "${tableName}"`
        );
        if (aggRows.length > 0 && aggRows[0].values.length > 0) {
          const cnt = Number(aggRows[0].values[0][0]);
          const minT = Number(aggRows[0].values[0][1]);
          const maxT = Number(aggRows[0].values[0][2]);
          totalMessages += cnt;
          talkerCounts[tableName] = (talkerCounts[tableName] || 0) + cnt;
          if (minT && minT < earliest) earliest = minT;
          if (maxT && maxT > latest) latest = maxT;
        }

        const typeRows = db.exec(
          `SELECT (local_type & 0xFFFF) AS mt, COUNT(*) AS c FROM "${tableName}" GROUP BY mt`
        );
        if (typeRows.length > 0) {
          for (const r of typeRows[0].values) {
            typeCounts[Number(r[0])] = (typeCounts[Number(r[0])] || 0) + Number(r[1]);
          }
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

export interface ChatStats {
  talker: string;
  nickname: string;
  isGroup: boolean;
  totalMessages: number;
  myMessages: number;
  theirMessages: number;
  firstMessage: string | null;
  lastMessage: string | null;
  typeDistribution: { type: number; label: string; count: number }[];
  hourlyActivity: number[];
  dailyActivity: { date: string; count: number }[];
  weekHourHeatmap: number[][];
  avgDaily: number;
  totalDays: number;
  topWords: { word: string; count: number }[];
  topSenders: { sender: string; nickname: string; count: number }[];
  replyStats: {
    myAvgReplyMin: number;
    theirAvgReplyMin: number;
    myReplies: number;
    theirReplies: number;
  };
}

export async function getChatStats(
  dataDir: string,
  talker: string
): Promise<ChatStats | null> {
  const shards = await getShards(dataDir);
  const start = new Date(2010, 0, 1);
  const end = new Date();
  const targets = resolveShards(shards, start, end, talker);
  if (targets.length === 0) return null;

  let totalMessages = 0;
  let myMessages = 0;
  let theirMessages = 0;
  let firstTime = Infinity;
  let lastTime = 0;
  const typeCounts: Record<number, number> = {};
  const hourlyActivity = new Array(24).fill(0);
  const dailyActivity: Record<string, number> = {};
  const weekHourHeatmap: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const wordCounts: Record<string, number> = {};
  const senderCounts: Record<string, number> = {};

  const typeLabels: Record<number, string> = {
    1: "文本", 3: "图片", 34: "语音", 43: "视频",
    47: "表情", 48: "位置", 49: "应用", 10000: "系统", 10002: "撤回",
  };

  const replyIntervals: { myReplyTime: number; theirReplyTime: number }[] = [];
  let lastTimeBySender: Record<string, number> = {};
  let prevSender = "";

  for (const target of targets) {
    const db = await getConnection(target.filePath);
    const tableName = findMsgTable(db, talker, target.talkerId);
    if (!tableName) continue;

    const countRow = db.exec(`SELECT COUNT(*) FROM "${tableName}"`);
    if (countRow.length > 0) totalMessages += Number(countRow[0].values[0][0]);

    const senderRow = db.exec(
      `SELECT (local_type & 0xFFFF) AS mt, COUNT(*) AS c FROM "${tableName}" GROUP BY mt ORDER BY c DESC`
    );
    if (senderRow.length > 0) {
      for (const r of senderRow[0].values) {
        const mt = Number(r[0]);
        typeCounts[mt] = (typeCounts[mt] || 0) + Number(r[1]);
      }
    }

    const timeRow = db.exec(`SELECT MIN(create_time), MAX(create_time) FROM "${tableName}"`);
    if (timeRow.length > 0 && timeRow[0].values.length > 0) {
      const minT = Number(timeRow[0].values[0][0]);
      const maxT = Number(timeRow[0].values[0][1]);
      if (minT && minT < firstTime) firstTime = minT;
      if (maxT && maxT > lastTime) lastTime = maxT;
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

    const weekHourRows = db.exec(
      `SELECT CAST(strftime('%w', create_time, 'unixepoch', 'localtime') AS INTEGER) AS wd, CAST(strftime('%H', create_time, 'unixepoch', 'localtime') AS INTEGER) AS hr, COUNT(*) AS c FROM "${tableName}" GROUP BY wd, hr`
    );
    if (weekHourRows.length > 0) {
      for (const r of weekHourRows[0].values) {
        weekHourHeatmap[Number(r[0])][Number(r[1])] += Number(r[2]);
      }
    }

    const myCount = db.exec(
      `SELECT COUNT(*) FROM "${tableName}" WHERE status = 2`
    );
    if (myCount.length > 0) myMessages += Number(myCount[0].values[0][0]);

    const theirCount = db.exec(
      `SELECT COUNT(*) FROM "${tableName}" WHERE status != 2`
    );
    if (theirCount.length > 0) theirMessages += Number(theirCount[0].values[0][0]);

    const isGroup = talker.endsWith("@chatroom");
    if (isGroup) {
      const senderRows = db.exec(
        `SELECT message_content, status FROM "${tableName}" LIMIT 50000`
      );
      if (senderRows.length > 0) {
        for (const r of senderRows[0].values) {
          const raw = r[0];
          const status = Number(r[1]);
          let text = "";
          if (raw instanceof Uint8Array || Buffer.isBuffer(raw)) {
            text = await decodeMessageContent(Buffer.from(raw));
          } else if (raw != null) {
            text = String(raw);
          }
          if (!text) continue;
          if (status === 2) continue;
          const split = text.split(":\n", 2);
          if (split.length === 2) {
            const snd = split[0];
            if (snd && snd.length < 60 && /^[\w@.]+$/.test(snd)) {
              senderCounts[snd] = (senderCounts[snd] || 0) + 1;
            }
          }
        }
      }
    }

    const textRows = db.exec(
      `SELECT message_content FROM "${tableName}" WHERE (local_type & 0xFFFF) = 1 ORDER BY create_time DESC LIMIT 500`
    );
    if (textRows.length > 0) {
      for (const r of textRows[0].values) {
        const text = String(r[0]);
        for (const w of extractWords(text)) {
          wordCounts[w] = (wordCounts[w] || 0) + 1;
        }
      }
    }

    const replyRows = db.exec(
      `SELECT status, create_time FROM "${tableName}" WHERE (local_type & 0xFFFF) IN (1,3,34,43,47,49) ORDER BY create_time ASC`
    );
    if (replyRows.length > 0) {
      for (const r of replyRows[0].values) {
        const isSelf = Number(r[0]) === 2;
        const time = Number(r[1]);
        const sender = isSelf ? "self" : "other";
        if (prevSender && prevSender !== sender && lastTimeBySender[prevSender]) {
          const interval = time - lastTimeBySender[prevSender];
          if (interval > 0 && interval < 3600) {
            replyIntervals.push({
              myReplyTime: isSelf ? interval : 0,
              theirReplyTime: !isSelf ? interval : 0,
            });
          }
        }
        lastTimeBySender[sender] = time;
        prevSender = sender;
      }
    }
  }

  const typeDistribution = Object.entries(typeCounts)
    .map(([t, c]) => ({ type: Number(t), label: typeLabels[Number(t)] || `类型${t}`, count: c }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const dailyArray = Object.entries(dailyActivity)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count }));

  const totalDays = dailyArray.length || 1;
  const avgDaily = Math.round(totalMessages / totalDays);

  const topWords = Object.entries(wordCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 80)
    .map(([word, count]) => ({ word, count }));

  let myReplySum = 0;
  let myReplyCount = 0;
  let theirReplySum = 0;
  let theirReplyCount = 0;
  for (const ri of replyIntervals) {
    if (ri.myReplyTime > 0) { myReplySum += ri.myReplyTime; myReplyCount++; }
    if (ri.theirReplyTime > 0) { theirReplySum += ri.theirReplyTime; theirReplyCount++; }
  }

  const map = await loadContactMap(dataDir, [talker]);
  const contactInfo = map.get(talker);

  const isGroup = talker.endsWith("@chatroom");
  const topSendersRaw = Object.entries(senderCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([sender, count]) => ({ sender, nickname: "", count }));

  if (topSendersRaw.length > 0) {
    const wxids = topSendersRaw.map(s => s.sender);
    const senderMap = await loadContactMap(dataDir, wxids);
    for (const s of topSendersRaw) {
      const info = senderMap.get(s.sender);
      if (info) s.nickname = info.remark || info.nickname || s.sender;
    }
  }

  return {
    talker,
    nickname: contactInfo?.remark || contactInfo?.nickname || talker,
    isGroup,
    totalMessages,
    myMessages,
    theirMessages,
    firstMessage: firstTime === Infinity ? null : new Date(firstTime * 1000).toISOString(),
    lastMessage: lastTime === 0 ? null : new Date(lastTime * 1000).toISOString(),
    typeDistribution,
    hourlyActivity,
    dailyActivity: dailyArray,
    weekHourHeatmap,
    avgDaily,
    totalDays,
    topWords,
    topSenders: topSendersRaw,
    replyStats: {
      myAvgReplyMin: myReplyCount > 0 ? Math.round((myReplySum / myReplyCount) / 60) : 0,
      theirAvgReplyMin: theirReplyCount > 0 ? Math.round((theirReplySum / theirReplyCount) / 60) : 0,
      myReplies: myReplyCount,
      theirReplies: theirReplyCount,
    },
  };
}

export async function getKeywordTrend(
  dataDir: string,
  keyword: string
): Promise<{ month: string; count: number }[]> {
  if (!keyword) return [];
  const shards = await getShards(dataDir);
  const monthCounts: Record<string, number> = {};

  for (const shard of shards) {
    const db = await getConnection(shard.filePath);
    const tables = db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'"
    );
    if (!tables.length) continue;

    for (const t of tables[0].values) {
      const tableName = String(t[0]);
      try {
        const rows = db.exec(
          `SELECT create_time, message_content FROM "${tableName}" WHERE message_content LIKE ?`,
          [`%${keyword}%`]
        );
        if (!rows.length) continue;
        for (const r of rows[0].values) {
          const ts = Number(r[0]) * 1000;
          const d = new Date(ts);
          const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
          monthCounts[month] = (monthCounts[month] || 0) + 1;
        }
      } catch { /* ignore */ }
    }
  }

  return Object.entries(monthCounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, count]) => ({ month, count }));
}
