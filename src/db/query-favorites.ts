import { getConnection, findSingleFile } from "./manager.js";

export interface WxFavorite {
  localId: number;
  serverId: number;
  type: number;
  updateTime: string;
  fromUser: string;
  realChatName: string;
  summary: string;
  title: string;
  desc: string;
  linkUrl: string;
  thumbUrl: string;
  rawContent: string;
}

const TYPE_LABELS: Record<number, string> = {
  1: "文本",
  2: "图片",
  3: "语音",
  4: "视频",
  5: "链接",
  6: "位置",
  8: "视频号",
  14: "图文/合并转发",
  16: "文件",
  18: "小程序",
  19: "聊天记录",
  20: "音乐",
};

export function getFavoriteTypeLabel(type: number): string {
  return TYPE_LABELS[type] || `类型${type}`;
}

interface FavParsed {
  summary: string;
  title: string;
  desc: string;
  linkUrl: string;
  thumbUrl: string;
}

function firstMatch(s: string, re: RegExp): string {
  const m = s.match(re);
  return m ? (m[1] || m[2] || "") : "";
}

function extractFavInfo(content: string, type: number): FavParsed {
  const result: FavParsed = { summary: "", title: "", desc: "", linkUrl: "", thumbUrl: "" };

  const title = decodeXmlEntities(firstMatch(content, /<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/));
  const desc = decodeXmlEntities(firstMatch(content, /<desc>([\s\S]*?)<\/desc>/));
  const datatitle = decodeXmlEntities(firstMatch(content, /<datatitle><!\[CDATA\[(.*?)\]\]><\/datatitle>|<datatitle>(.*?)<\/datatitle>/));
  const datadesc = decodeXmlEntities(firstMatch(content, /<datadesc><!\[CDATA\[(.*?)\]\]><\/datadesc>|<datadesc>(.*?)<\/datadesc>/));
  const linkUrl = decodeXmlEntities(firstMatch(content, /<link>([\s\S]*?)<\/link>/));
  const httpThumb = (content.match(/https?:\/\/[^\s<"]+\.(jpg|jpeg|png|gif|webp)/i) || [])[0] || "";

  result.title = title || datatitle;
  result.desc = desc || datadesc;
  result.linkUrl = linkUrl;
  result.thumbUrl = httpThumb;

  switch (type) {
    case 1:
      result.summary = desc.substring(0, 300) || "[文本]";
      break;
    case 2:
      result.summary = "[图片]";
      break;
    case 5:
      result.summary = result.title || "[链接]";
      result.desc = result.desc || "";
      break;
    case 14: {
      const descs: string[] = [];
      const re = /<desc>([\s\S]*?)<\/desc>/g;
      let m;
      while ((m = re.exec(content)) !== null) {
        const t = decodeXmlEntities(m[1]).trim();
        if (t) descs.push(t.substring(0, 80));
      }
      result.summary = descs.length ? descs.join(" / ") : "[图文]";
      break;
    }
    case 8:
      result.summary = result.title || "[视频]";
      break;
    case 16:
      result.summary = result.title || "[文件]";
      break;
    default: {
      const label = TYPE_LABELS[type];
      result.summary = label ? `[${label}]` : "[收藏]";
    }
  }

  return result;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x0A;/g, "\n")
    .replace(/&#x0D;/g, "\r")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export async function getWxFavorites(
  dataDir: string,
  type?: number,
  limit = 100,
  offset = 0
): Promise<{ total: number; items: WxFavorite[] }> {
  const dbPath = findSingleFile(dataDir, "favorite");
  if (!dbPath) return { total: 0, items: [] };

  const db = await getConnection(dbPath);

  let countSql = "SELECT COUNT(*) FROM fav_db_item";
  let sql = "SELECT local_id, server_id, type, update_time, content, fromusr, realchatname FROM fav_db_item";
  const params: unknown[] = [];

  if (type !== undefined) {
    countSql += " WHERE type = ?";
    sql += " WHERE type = ?";
    params.push(type);
  }

  const countResult = db.exec(countSql, params);
  const total = countResult.length > 0 ? Number(countResult[0].values[0][0]) : 0;

  sql += " ORDER BY update_time DESC LIMIT ? OFFSET ?";
  const queryParams = [...params, limit, offset];

  const rows = db.exec(sql, queryParams);
  if (rows.length === 0) return { total, items: [] };

  const items: WxFavorite[] = rows[0].values.map((row: unknown[]) => {
    const raw = String(row[4] || "");
    const favType = Number(row[2]);
    const info = extractFavInfo(raw, favType);
    return {
      localId: Number(row[0]),
      serverId: Number(row[1]),
      type: favType,
      updateTime: new Date(Number(row[3]) * 1000).toISOString(),
      fromUser: String(row[5] || ""),
      realChatName: String(row[6] || ""),
      summary: info.summary,
      title: info.title,
      desc: info.desc,
      linkUrl: info.linkUrl,
      thumbUrl: info.thumbUrl,
      rawContent: raw,
    };
  });

  return { total, items };
}
