import path from "node:path";
import crypto from "node:crypto";
import { decodeMessageContent } from "../db/codec.js";
import { loadContactMap } from "../db/query-contacts.js";
import { getConfig } from "../config.js";
import { findRecalledMessage } from "./recall-store.js";
import type { Message } from "../db/models.js";
import type { Database } from "sql.js";

export function md5(input: string): string {
  return crypto.createHash("md5").update(input).digest("hex");
}

export function findMsgTable(
  db: Database,
  talker: string,
  talkerId: number | null
): string | null {
  const talkerMd5 = md5(talker);
  const directTable = `Msg_${talkerMd5}`;
  if (tableExists(db, directTable)) return directTable;
  return null;
}

export function tableExists(db: Database, name: string): boolean {
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

export function listMsgTables(db: Database): string[] {
  const rows = db.exec(
    "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'Msg_%' OR name LIKE 'MSG%' OR name LIKE 'msg%')"
  );
  if (rows.length === 0) return [];
  return rows[0].values.flat().map(String);
}

export async function parseMessageRow(
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
  const source = row[6];
  let sender = "";
  let isSelf = status === 2;
  let content = rawText;

  if (isChatRoom && rawText) {
    const colonIdx = rawText.indexOf(":\n");
    if (colonIdx > 0 && colonIdx < 60) {
      sender = rawText.substring(0, colonIdx);
      content = rawText.substring(colonIdx + 2);
    } else if (localType !== 10000) {
      if (source && typeof source === "string" && source.startsWith("wxid_")) {
        sender = source;
      }
    }
  } else {
    sender = isSelf ? "" : defaultTalker;
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

  if (localType === 10000) {
    content = extractSystemMessage(content);
  } else if (localType === 10002) {
    content = extractRevokeMessage(content);
  }

  let subMessages: string[] | undefined;
  let referSeq: number | undefined;
  if (localType === 49 && content.includes("<")) {
    const appResult = extractAppMessage(content);
    content = appResult.content;
    appType = appResult.appType;
    appUrl = appResult.appUrl;
    appThumbUrl = appResult.appThumbUrl;
    referContent = appResult.referContent;
    referSender = appResult.referSender;
    referSeq = appResult.referSeq;
    subMessages = appResult.subMessages;
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

  let revokedOriginal: string | undefined;
  if (localType === 10002) {
    const isoTime = new Date(createTime * 1000).toISOString();
    const recalled = findRecalledMessage(defaultTalker, seq, isoTime);
    if (recalled) {
      revokedOriginal = recalled.content;
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
    referSeq,
    locationLabel,
    locationPoiName,
    voiceDuration,
    voiceText,
    revokedOriginal,
    subMessages,
  };
}

let selfAvatarCache: string | undefined;

export function clearSelfCache() {
  selfAvatarCache = undefined;
}

export function getSelfAvatar() { return selfAvatarCache; }

export async function resolveSenderNames(dataDir: string, messages: Message[]): Promise<void> {
  const config = getConfig();
  const wxids = new Set<string>();
  for (const m of messages) {
    if (m.sender && m.sender.startsWith("wxid_")) wxids.add(m.sender);
  }
  if (config.selfWxid) wxids.add(config.selfWxid);
  if (wxids.size === 0) return;

  const map = await loadContactMap(dataDir, [...wxids]);
  if (config.selfWxid && !selfAvatarCache) {
    selfAvatarCache = map.get(config.selfWxid)?.smallHeadUrl;
  }

  for (const m of messages) {
    if (m.sender && map.has(m.sender)) {
      const c = map.get(m.sender)!;
      m.senderAvatar = c.smallHeadUrl || undefined;
      if (!m.isSelf) {
        m.sender = c.remark || c.nickname || m.sender;
      }
    }
    if (m.isSelf && !m.senderAvatar && selfAvatarCache) {
      m.senderAvatar = selfAvatarCache;
    }
  }
  console.log(`[DEBUG] selfWxid=${config.selfWxid} selfAvatar=${!!selfAvatarCache}`);
}

export function getMediaTypeLabel(localType: number): string {
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

function extractRevokeMessage(content: string): string {
  if (!content.includes("<")) return content;
  const cdata = content.match(/<!\[CDATA\[(.*?)\]\]>/);
  const label = cdata ? cdata[1].trim() : content;
  return label;
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

export interface AppMessageResult {
  content: string;
  appType?: number;
  appUrl?: string;
  appThumbUrl?: string;
  referContent?: string;
  referSender?: string;
  referSeq?: number;
  subMessages?: string[];
}

export function extractAppMessage(raw: string): AppMessageResult {
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
    const refSeqMatch = refBlock.match(/<svrid>(\d+)<\/svrid>/);
    result.referContent = refContentMatch ? refContentMatch[1].trim() : "";
    result.referSender = refSenderMatch ? refSenderMatch[1].trim() : "";
    result.referSeq = refSeqMatch ? Number(refSeqMatch[1]) : undefined;
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

  if (result.appType === 19) {
    const desMatch = raw.match(/<des>([\s\S]*?)<\/des>/);
    const desLines: string[] = desMatch
      ? desMatch[1].replace(/&amp;#x20;/g, " ").replace(/&amp;#x0A;/g, "\n").split("\n").map(s => s.trim()).filter(Boolean)
      : [];

    const parseDataItem = (block: string, idx: number): string => {
      const nameMatch = block.match(/<sourcename>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/sourcename>/);
      const timeMatch = block.match(/<sourcetime>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/sourcetime>/);
      const descMatch = block.match(/<datadesc>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/datadesc>/);
      const typeMatch = block.match(/datatype="(\d+)"/);
      const name = nameMatch ? nameMatch[1].trim() : "";
      let time = timeMatch ? timeMatch[1].trim() : "";
      time = time.replace(/&#x20;/g, " ").replace(/&#x0A;/g, "");
      const dt = typeMatch?.[1];
      let desc: string;
      if (descMatch && descMatch[1].trim()) {
        desc = descMatch[1].trim();
      } else if (desLines[idx]) {
        desc = desLines[idx].replace(/^[^:]+:\s*/, "");
      } else {
        desc = dt === "2" ? "[图片]" : dt === "3" ? "[视频]" : dt === "4" ? "[视频]" : dt === "5" ? "[文件]" : "[消息]";
      }
      return `${name}${time ? ` (${time})` : ""}: ${desc}`;
    };

    const recordMatch = raw.match(/<recorditem><!\[CDATA\[([\s\S]*?)\]\]><\/recorditem>/);
    if (recordMatch) {
      const recordXml = recordMatch[1];
      const dataItems = recordXml.match(/<dataitem[\s\S]*?<\/dataitem>/g);
      if (dataItems && dataItems.length > 0) {
        result.content = `[合并转发] ${title} (${dataItems.length}条)`;
        result.subMessages = dataItems.map((block, idx) => parseDataItem(block, idx));
        return result;
      }
    }
    const dataListMatch = raw.match(/<datalist\s+count="(\d+)">([\s\S]*?)<\/datalist>/);
    if (dataListMatch) {
      const count = Number(dataListMatch[1]);
      const dataItems = dataListMatch[2].match(/<dataitem[\s\S]*?<\/dataitem>/g);
      if (dataItems && dataItems.length > 0) {
        result.content = `[合并转发] ${title} (${count}条)`;
        result.subMessages = dataItems.map((block, idx) => parseDataItem(block, idx));
        return result;
      }
    }
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
    result.subMessages = subAppmsgs.map((block, i) => {
      const tMatch = block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
      return `${i + 1}. ${tMatch ? tMatch[1].trim() : "..."}`;
    });
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

export function readVarint(
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

export const MSG_TYPES: Record<number, string> = {
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

export const STOP_WORDS = new Set([
  "的","了","在","是","我","你","他","她","它","们","这","那","有","不","就","也","都","要",
  "会","对","说","和","与","或","但","而","如果","因为","所以","可以","没","什么","一个","这个",
  "那个","吗","吧","啊","呢","哦","嗯","哈","呀","嘛","啦","哎","嘿","哦","噢","喔","诶","喂",
  "好","行","是","能","把","被","让","给","从","到","用","为","着","过","地","得","很","还",
  "去","来","又","再","才","已","更","最","比","跟","等","做","看","想","去","来","吃","买",
  "个","一","二","三","两","几","多","少","大","小","上","下","中","前","后","里","外","时",
  "然后","这样","那样","自己","现在","今天","明天","昨天","怎么","这么","那么","其实","觉得",
  "应该","知道","时候","东西","地方","可以","已经","可能","可是","但是","而且","或者","不过",
]);

export function extractWords(text: string): string[] {
  const cleaned = text.replace(/[\s\n\r]+/g, " ").trim();
  if (!cleaned) return [];
  const words: string[] = [];
  const segs = cleaned.split(/[\s,，。！？!?;；：:、~\-—""''「」【】()\(\)\[\]{}<>《》·…]+/);
  for (const seg of segs) {
    if (seg.length < 2 || seg.length > 8) continue;
    if (/^[\d.]+$/.test(seg)) continue;
    if (STOP_WORDS.has(seg)) continue;
    if (/^[\x00-\x7F]+$/.test(seg) && seg.length < 3) continue;
    words.push(seg);
  }
  return words;
}
