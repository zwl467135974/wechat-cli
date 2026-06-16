import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import { getSessions, getContacts, getChatRoomMembers } from "../db/query-contacts.js";
import {
  getMessages,
  searchMessages,
  clearShardCache,
} from "../db/query-messages.js";
import { getGlobalStats, getChatStats, getKeywordTrend, getYearTopWords, getGroupMonthlyRanking } from "../db/stats.js";
import { closeAll, findFilesByType } from "../db/manager.js";
import { execPython } from "../python/runner.js";
import { getConfig, saveEnvFile } from "../config.js";
import {
  resolveImagePath,
  resolveVideoPath,
  decryptImage,
  scanImageKey,
  getImageKeyStatus,
  detectMime,
  isWxgf,
  convertWxgfToJpg,
} from "./image.js";
import { doRefresh } from "./refresh.js";
import { callAi, isAiEnabled, extractAiJson } from "./ai.js";
import { addBookmark, removeBookmark, getBookmarks, isBookmarked } from "../db/bookmark-store.js";
import { getWxFavorites, getFavoriteTypeLabel } from "../db/query-favorites.js";
import { getEmojis } from "../db/query-emoji.js";
import { getMediaFiles } from "../db/query-media.js";
import type { EmojiItem } from "../db/query-emoji.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = new Hono();

app.use("*", cors());

const AUTH_TOKEN = process.env.AUTH_TOKEN || "";

app.use("/api/*", async (c, next) => {
  if (!AUTH_TOKEN) return await next();
  const token = c.req.header("Authorization")?.replace("Bearer ", "") || c.req.query("token") || "";
  if (token !== AUTH_TOKEN) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});

app.get("/api/health", (c) => c.json({ status: "ok" }));

app.get("/api/last-refresh", (c) => {
  return c.json({ lastRefresh: globalThis.__wechatLastRefresh || null });
});

app.post("/api/refresh", async (c) => {
  const result = await doRefresh();
  if (result.ok) {
    return c.json({ success: true, lastRefresh: globalThis.__wechatLastRefresh });
  }
  return c.json({ success: false, error: result.error }, 500);
});

app.get("/api/status", (c) => {
  const config = getConfig();
  const dataDir = config.dataDir;
  const hasData = fs.existsSync(dataDir);
  let dbCount = 0;
  let tables: string[] = [];

  if (hasData) {
    try {
      const msgFiles = findFilesByType(dataDir, "message");
      const contactFiles = findFilesByType(dataDir, "contact");
      const sessionFiles = findFilesByType(dataDir, "session");
      dbCount = msgFiles.length + contactFiles.length + sessionFiles.length;
      tables = [
        ...msgFiles.map((f) => path.basename(f)),
        ...contactFiles.map((f) => path.basename(f)),
        ...sessionFiles.map((f) => path.basename(f)),
      ];
    } catch {
      // ignore
    }
  }

  return c.json({
    dataDir: path.resolve(dataDir),
    hasData,
    dbCount,
    tables,
    wechatPath: config.wechatPath || "not configured",
    wechatDbSrcPath: config.wechatDbSrcPath || "not configured",
    hasImageKey: !!config.imageKey,
    selfWxid: config.selfWxid || "",
    aiEnabled: isAiEnabled(),
    aiApiUrl: config.aiApiUrl || "",
    aiModel: config.aiModel || "",
    hasAiKey: !!config.aiApiKey,
  });
});

app.post("/api/save-config", async (c) => {
  const body = await c.req.json();
  const mapping: Record<string, string> = {};
  if (body.wechatDbSrcPath) mapping.WECHAT_DB_SRC_PATH = body.wechatDbSrcPath;
  if (body.wechatPath) mapping.WECHAT_PATH = body.wechatPath;
  if (body.wechatDbKey) mapping.WECHAT_DB_KEY = body.wechatDbKey;
  if (body.imageKey) mapping.IMAGE_KEY = body.imageKey;
  if (body.xorKey) mapping.XOR_KEY = body.xorKey;
  if (body.selfWxid) mapping.SELF_WXID = body.selfWxid;
  if (body.aiEnabled !== undefined) mapping.AI_ENABLED = body.aiEnabled ? "true" : "false";
  if (body.aiApiUrl !== undefined) mapping.AI_API_URL = body.aiApiUrl;
  if (body.aiApiKey !== undefined) mapping.AI_API_KEY = body.aiApiKey;
  if (body.aiModel !== undefined) mapping.AI_MODEL = body.aiModel;
  saveEnvFile(mapping);
  const config = getConfig();
  if (body.wechatDbSrcPath) config.wechatDbSrcPath = body.wechatDbSrcPath;
  if (body.wechatPath) config.wechatPath = body.wechatPath;
  if (body.wechatDbKey) config.wechatDbKey = body.wechatDbKey;
  if (body.imageKey) config.imageKey = body.imageKey;
  if (body.xorKey) config.xorKey = body.xorKey;
  if (body.selfWxid) config.selfWxid = body.selfWxid;
  if (body.aiEnabled !== undefined) config.aiEnabled = body.aiEnabled;
  if (body.aiApiUrl !== undefined) config.aiApiUrl = body.aiApiUrl;
  if (body.aiApiKey !== undefined) config.aiApiKey = body.aiApiKey;
  if (body.aiModel !== undefined) config.aiModel = body.aiModel;
  return c.json({ success: true });
});

app.post("/api/decrypt", async (c) => {
  const config = getConfig();
  const body = await c.req.json().catch(() => ({} as Record<string, string>));
  if (body.src_path) config.wechatDbSrcPath = body.src_path;
  if (body.key) config.wechatDbKey = body.key;
  if (!config.wechatDbSrcPath) {
    return c.json({ error: "WeChat data path not configured" }, 400);
  }
  const outDir = config.dataDir;

  const result = await execPython("decrypt_db_v2.py", {
    db_dir: config.wechatDbSrcPath,
    out_dir: outDir,
  });
  closeAll();
  clearShardCache();
  statsCache = null;
  chatStatsCache.clear();

  return c.json({ result });
});

app.post("/api/extract-key", async (c) => {
  const result = await execPython("extract_key_v3.py", {});
  return c.json({ result });
});

app.get("/api/sessions", async (c) => {
  const config = getConfig();
  const keyword = c.req.query("keyword");
  const limit = Number(c.req.query("limit")) || 100;
  const offset = Number(c.req.query("offset")) || 0;

  const sessions = await getSessions(config.dataDir, keyword, limit, offset);
  return c.json(sessions);
});

app.get("/api/contacts", async (c) => {
  const config = getConfig();
  const keyword = c.req.query("keyword");
  const limit = Number(c.req.query("limit")) || 200;
  const offset = Number(c.req.query("offset")) || 0;
  const contacts = await getContacts(config.dataDir, keyword, limit, offset);
  return c.json(contacts);
});

app.get("/api/contact-detail", async (c) => {
  const config = getConfig();
  const username = c.req.query("username");
  if (!username) return c.json({ error: "username required" }, 400);
  const contacts = await getContacts(config.dataDir, username, 1, 0);
  const contact = contacts.find(ct => ct.username === username);
  if (!contact) return c.json({ error: "not found" }, 404);

  let msgCount = 0;
  let firstMsg: string | null = null;
  let lastMsg: string | null = null;
  try {
    const { getMessages } = await import("../db/query-messages.js");
    const recent = await getMessages(config.dataDir, username, { limit: 1, reverse: false });
    msgCount = await getMessages(config.dataDir, username, { limit: 1, offset: 0, reverse: true }).then(m => m.length);
    const all = await getMessages(config.dataDir, username, { limit: 1, offset: 0, reverse: false });
    if (all.length) firstMsg = all[0].time;
    const latest = await getMessages(config.dataDir, username, { limit: 1, reverse: true });
    if (latest.length) lastMsg = latest[0].time;
  } catch { /* ignore */ }

  let sharedGroups: string[] = [];
  try {
    const sessions = await getSessions(config.dataDir);
    sharedGroups = sessions
      .filter(s => s.username.endsWith("@chatroom"))
      .map(s => s.remark || s.nickname || s.username);
  } catch { /* ignore */ }

  return c.json({ ...contact, msgCount, firstMsg, lastMsg, sharedGroups });
});

app.get("/api/timeline", async (c) => {
  const config = getConfig();
  const date = c.req.query("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: "date required (YYYY-MM-DD)" }, 400);
  const limit = Number(c.req.query("limit")) || 200;
  const { getTimeline } = await import("../db/query-messages.js");
  const messages = await getTimeline(config.dataDir, date, limit);
  return c.json({ date, count: messages.length, messages });
});

app.get("/api/messages", async (c) => {
  const config = getConfig();
  const talkerId = c.req.query("talker_id");
  const keyword = c.req.query("keyword");
  const limit = Number(c.req.query("limit")) || 50;
  const offset = Number(c.req.query("offset")) || 0;
  const reverse = c.req.query("reverse") !== "false";
  const startTime = c.req.query("start_time") ? Number(c.req.query("start_time")) : undefined;
  const endTime = c.req.query("end_time") ? Number(c.req.query("end_time")) : undefined;

  if (!talkerId) {
    return c.json({ error: "talker_id is required" }, 400);
  }

  const messages = await getMessages(config.dataDir, talkerId, {
    keyword,
    limit,
    offset,
    reverse,
    startTime,
    endTime,
  });
  return c.json(messages);
});

let chatStatsCache: Map<string, { data: unknown; ts: number }> = new Map();
const CHAT_STATS_TTL = 3 * 60 * 1000;

app.get("/api/chat-stats", async (c) => {
  const config = getConfig();
  const talker = c.req.query("talker");
  if (!talker) return c.json({ error: "talker is required" }, 400);

  const cached = chatStatsCache.get(talker);
  if (cached && Date.now() - cached.ts < CHAT_STATS_TTL) {
    return c.json(cached.data);
  }

  try {
    const stats = await getChatStats(config.dataDir, talker);
    if (!stats) return c.json({ error: "No data" }, 404);
    chatStatsCache.set(talker, { data: stats, ts: Date.now() });
    return c.json(stats);
  } catch (e: unknown) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

app.get("/api/search", async (c) => {
  const config = getConfig();
  const keyword = c.req.query("keyword") || "";
  const limit = Number(c.req.query("limit")) || 50;
  const offset = Number(c.req.query("offset")) || 0;
  const filters = {
    talker: c.req.query("talker") || undefined,
    sender: c.req.query("sender") || undefined,
    msgType: c.req.query("msgType") ? Number(c.req.query("msgType")) : undefined,
    startTime: c.req.query("startTime") ? Number(c.req.query("startTime")) : undefined,
    endTime: c.req.query("endTime") ? Number(c.req.query("endTime")) : undefined,
    useRegex: c.req.query("regex") === "true",
  };

  const results = await searchMessages(config.dataDir, keyword, limit, offset, filters);
  return c.json(results);
});

let statsCache: { data: unknown; ts: number } | null = null;
const STATS_TTL = 5 * 60 * 1000;

app.get("/api/stats", async (c) => {
  if (statsCache && Date.now() - statsCache.ts < STATS_TTL) {
    return c.json(statsCache.data);
  }
  const config = getConfig();
  try {
    const stats = await getGlobalStats(config.dataDir);
    statsCache = { data: stats, ts: Date.now() };
    return c.json(stats);
  } catch (e: unknown) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

app.get("/api/keyword-trend", async (c) => {
  const keyword = c.req.query("keyword");
  if (!keyword) return c.json({ error: "keyword required" }, 400);
  const config = getConfig();
  try {
    const trend = await getKeywordTrend(config.dataDir, keyword);
    return c.json(trend);
  } catch (e: unknown) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

app.get("/api/chatroom-members", async (c) => {
  const config = getConfig();
  const chatroom = c.req.query("chatroom");
  if (!chatroom) {
    return c.json({ error: "chatroom parameter is required" }, 400);
  }
  try {
    const members = await getChatRoomMembers(config.dataDir, chatroom);
    return c.json(members);
  } catch (e: unknown) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

app.get("/api/export", async (c) => {
  const config = getConfig();
  const talker = c.req.query("talker");
  const format = c.req.query("format") || "json";

  if (!talker) {
    return c.json({ error: "talker is required" }, 400);
  }

  const messages = await getMessages(config.dataDir, talker, {
    limit: 100000,
    offset: 0,
    reverse: true,
  });

  if (format === "json") {
    return c.json(messages);
  }

  if (format === "txt") {
    const lines = messages.map(m => {
      const t = new Date(m.time).toLocaleString("zh-CN");
      const sender = m.sender || m.talker;
      return `[${t}] ${sender}: ${m.content}`;
    });
    return c.text(lines.join("\n"), 200, {
      "Content-Disposition": `attachment; filename="chat-${talker}.txt"`,
    });
  }

  if (format === "html") {
    const html = buildExportHtml(talker, messages);
    return c.html(html, 200, {
      "Content-Disposition": `attachment; filename="chat-${talker}.html"`,
    });
  }

  return c.json({ error: "unsupported format" }, 400);
});

export function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function buildExportHtml(talker: string, messages: import("../db/models.js").Message[]): string {
  const typeLabels: Record<number, string> = {
    1: "", 3: "[图片]", 34: "[语音]", 43: "[视频]",
    47: "[表情]", 48: "[位置]", 49: "[应用]", 10000: "[系统]", 10002: "[撤回]",
  };
  const rows = messages.map(m => {
    const t = new Date(m.time).toLocaleString("zh-CN");
    const sender = m.sender || m.talker;
    const cls = m.isSelf ? "self" : "other";
    const typeTag = typeLabels[m.type] || "";
    const content = escHtml(m.content);
    const prefix = typeTag && m.type !== 1 ? `${typeTag} ` : "";
    return `<div class="msg ${cls}"><span class="time">${t}</span><span class="sender">${escHtml(sender)}</span><span class="content">${prefix}${content}</span></div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>聊天记录 - ${escHtml(talker)}</title>
<style>
body{font-family:system-ui;margin:20px auto;max-width:800px;background:#f5f5f5;padding:20px}
h1{font-size:18px;color:#333;border-bottom:1px solid #ddd;padding-bottom:8px}
.msg{padding:6px 0;border-bottom:1px solid #eee;display:flex;gap:8px;font-size:14px}
.msg.self .sender{color:#3b82f6}.msg.other .sender{color:#22c55e}
.time{color:#999;min-width:140px;font-size:12px}
.sender{min-width:80px;font-weight:bold;font-size:13px}
.content{flex:1;word-break:break-all}
</style></head><body><h1>聊天记录 - ${escHtml(talker)} (${messages.length}条)</h1>${rows}</body></html>`;
}

app.get("/api/image", async (c) => {
  const mediaPath = c.req.query("path");
  const talker = c.req.query("talker");
  const seq = c.req.query("seq");

  if (!mediaPath || !talker) {
    return c.json({ error: "path and talker are required" }, 400);
  }

  const config = getConfig();
  const original = c.req.query("original") === "true";
  const datPath = resolveImagePath(config.wechatDbSrcPath, talker, mediaPath, original);

  if (!datPath) {
    return c.json({ error: "Image file not found" }, 404);
  }

  const decrypted = await decryptImage(datPath);
  if (!decrypted) {
    return c.json({ error: "Image decryption key not available", keyStatus: getImageKeyStatus() }, 503);
  }

  if (isWxgf(decrypted)) {
    const jpg = await convertWxgfToJpg(decrypted);
    if (jpg) {
      return new Response(new Uint8Array(jpg), {
        headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=3600" },
      });
    }

    if (original) {
      const thumbPath = resolveImagePath(config.wechatDbSrcPath, talker, mediaPath, false);
      if (thumbPath && thumbPath !== datPath) {
        const thumbDec = await decryptImage(thumbPath);
        if (thumbDec && !isWxgf(thumbDec)) {
          return new Response(new Uint8Array(thumbDec), {
            headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=3600" },
          });
        }
      }
    }

    return c.json({ error: "wxgf conversion failed" }, 500);
  }

  const mime = detectMime(decrypted);
  return new Response(new Uint8Array(decrypted), {
    headers: { "Content-Type": mime, "Cache-Control": "public, max-age=3600" },
  });
});

app.get("/api/emoji", async (c) => {
  const md5 = c.req.query("md5");
  if (!md5 || !/^[0-9a-f]{32}$/i.test(md5)) {
    return c.json({ error: "Invalid md5" }, 400);
  }

  const config = getConfig();
  if (!config.wechatDbSrcPath) {
    return c.json({ error: "WeChat data path not configured" }, 503);
  }
  const srcRoot = path.dirname(config.wechatDbSrcPath);
  const prefix = md5.substring(0, 2);

  const paths = [
    path.join(srcRoot, "business", "emoticon", "Persist", prefix, md5),
    path.join(srcRoot, "cache", new Date().getFullYear() + "-" + String(new Date().getMonth() + 1).padStart(2, "0"), "Emoticon", prefix, md5),
  ];

  for (const p of paths) {
    if (fs.existsSync(p)) {
      const data = fs.readFileSync(p);
      return new Response(data, {
        headers: {
          "Content-Type": "image/gif",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }
  }

  return c.json({ error: "Emoji not found" }, 404);
});

app.get("/api/video", async (c) => {
  const mediaPath = c.req.query("path");
  if (!mediaPath) {
    return c.json({ error: "path is required" }, 400);
  }
  if (mediaPath.includes("..")) {
    return c.json({ error: "Invalid path" }, 400);
  }

  const config = getConfig();
  const videoPath = resolveVideoPath(config.wechatDbSrcPath, mediaPath);

  if (!videoPath) {
    return c.json({ error: "Video file not found" }, 404);
  }

  const stat = fs.statSync(videoPath);
  const range = c.req.header("Range");

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    const chunkSize = end - start + 1;

    const stream = fs.createReadStream(videoPath, { start, end });
    return new Response(stream as any, {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": String(chunkSize),
        "Content-Type": "video/mp4",
        "Cache-Control": "public, max-age=3600",
      },
    });
  }

  const stream = fs.createReadStream(videoPath);
  return new Response(stream as any, {
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(stat.size),
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=3600",
    },
  });
});

app.get("/api/image-key", (c) => {
  return c.json(getImageKeyStatus());
});

app.get("/api/file", async (c) => {
  const mediaPath = c.req.query("path");
  if (!mediaPath) {
    return c.json({ error: "path is required" }, 400);
  }
  if (mediaPath.includes("..")) {
    return c.json({ error: "Invalid path" }, 400);
  }

  const config = getConfig();
  if (!config.wechatDbSrcPath) {
    return c.json({ error: "WeChat data path not configured" }, 503);
  }

  const srcRoot = path.dirname(config.wechatDbSrcPath);
  const fullPath = path.join(srcRoot, mediaPath);
  if (!path.resolve(fullPath).startsWith(path.resolve(srcRoot))) {
    return c.json({ error: "Forbidden" }, 403);
  }

  if (!fs.existsSync(fullPath)) {
    return c.json({ error: "File not found" }, 404);
  }

  const stat = fs.statSync(fullPath);
  if (stat.size > 500 * 1024 * 1024) {
    return c.json({ error: "File too large (max 500MB)" }, 400);
  }

  const ext = path.extname(fullPath).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".pdf": "application/pdf", ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".zip": "application/zip", ".rar": "application/x-rar-compressed",
    ".7z": "application/x-7z-compressed", ".txt": "text/plain",
    ".mp3": "audio/mpeg", ".wav": "audio/wav",
  };

  const filename = path.basename(fullPath);
  const stream = fs.createReadStream(fullPath);
  return new Response(stream as any, {
    headers: {
      "Content-Type": mimeMap[ext] || "application/octet-stream",
      "Content-Length": String(stat.size),
      "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
      "Cache-Control": "public, max-age=3600",
    },
  });
});

const WECHAT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) XWEB/14915";

function isPrivateUrl(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== "http:" && u.protocol !== "https:") return true;
    const h = u.hostname;
    if (h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0" || h === "::1") return true;
    if (/^(10|127)\./.test(h)) return true;
    if (/^192\.168\./.test(h)) return true;
    if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(h)) return true;
    if (/^169\.254\./.test(h)) return true;
    return false;
  } catch {
    return true;
  }
}

app.get("/api/article-proxy", async (c) => {
  const url = c.req.query("url");
  if (!url) return c.json({ error: "url required" }, 400);
  if (isPrivateUrl(url)) return c.json({ error: "url blocked" }, 403);

  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: {
        "User-Agent": WECHAT_UA,
        "Referer": "https://mp.weixin.qq.com/",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      redirect: "follow",
    });
  } catch {
    return c.json({ error: "fetch failed" }, 502);
  }
  if (!resp.ok) return c.json({ error: `upstream ${resp.status}` }, 502);

  let html = await resp.text();

  html = html.replace(/((?:data-src|src)\s*=\s*["'])(https?:\/\/mmbiz[^"']+)/gi, (_m, prefix: string, imgUrl: string) =>
    `${prefix}/api/img-proxy?url=${encodeURIComponent(imgUrl)}`
  );

  const inject = `<script>(function(){
function p(i){['src','data-src'].forEach(function(a){var v=i.getAttribute(a);if(v&&v.indexOf('mmbiz')>-1&&v.indexOf('img-proxy')<0){i.setAttribute(a,'/api/img-proxy?url='+encodeURIComponent(v));}});}
try{document.querySelectorAll('img').forEach(p);}catch(e){}
new MutationObserver(function(ms){ms.forEach(function(m){m.addedNodes.forEach(function(n){if(n.nodeName==='IMG'){p(n);}else if(n.querySelectorAll){try{n.querySelectorAll('img').forEach(p);}catch(e){}}});});});}).observe(document.documentElement,{childList:true,subtree:true});
})();</script>`;

  if (html.includes("</body>")) {
    html = html.replace("</body>", inject + "</body>");
  } else {
    html += inject;
  }

  return c.html(html);
});

app.get("/api/img-proxy", async (c) => {
  const url = c.req.query("url");
  if (!url) return c.json({ error: "url required" }, 400);
  if (isPrivateUrl(url)) return c.json({ error: "url blocked" }, 403);

  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: {
        "User-Agent": WECHAT_UA,
        "Referer": "https://mp.weixin.qq.com/",
        "Accept": "image/*,*/*;q=0.8",
      },
    });
  } catch {
    return c.json({ error: "fetch failed" }, 502);
  }
  if (!resp.ok) return c.json({ error: `upstream ${resp.status}` }, 502);

  const contentType = resp.headers.get("content-type") || "image/jpeg";
  const buffer = Buffer.from(await resp.arrayBuffer());
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400",
    },
  });
});

app.post("/api/scan-image-key", async (c) => {
  const result = await scanImageKey();
  if (result) {
    return c.json({ success: true, key: result.key, xor_key: result.xor_key });
  }
  return c.json({ success: false, error: "Key not found. Try viewing some images in WeChat first." });
});

app.post("/api/ai/chat", async (c) => {
  if (!isAiEnabled()) {
    return c.json({ error: "AI 功能未启用" }, 400);
  }
  try {
    const { messages } = await c.req.json();
    if (!Array.isArray(messages) || messages.length === 0) {
      return c.json({ error: "messages 不能为空" }, 400);
    }
    const result = await callAi(messages);
    return c.json({ content: result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg }, 500);
  }
});

app.get("/api/bookmarks", async (c) => {
  const talker = c.req.query("talker");
  return c.json(getBookmarks(talker || undefined));
});

app.post("/api/bookmark", async (c) => {
  const body = await c.req.json();
  if (!body.talker || !body.seq) return c.json({ error: "talker and seq required" }, 400);
  const entry = addBookmark({
    talker: body.talker,
    seq: body.seq,
    time: body.time || "",
    sender: body.sender || "",
    content: body.content || "",
    note: body.note || "",
  });
  return c.json({ success: true, bookmark: entry });
});

app.delete("/api/bookmark/:id", async (c) => {
  const id = c.req.param("id");
  const ok = removeBookmark(id);
  return c.json({ success: ok });
});

app.get("/api/wx-favorites", async (c) => {
  const config = getConfig();
  const type = c.req.query("type") ? Number(c.req.query("type")) : undefined;
  const limit = Number(c.req.query("limit")) || 100;
  const offset = Number(c.req.query("offset")) || 0;
  const result = await getWxFavorites(config.dataDir, type, limit, offset);
  return c.json(result);
});

app.get("/api/emojis", async (c) => {
  const config = getConfig();
  const limit = Number(c.req.query("limit")) || 200;
  const offset = Number(c.req.query("offset")) || 0;
  const result = await getEmojis(config.dataDir, limit, offset);
  return c.json(result);
});

app.get("/api/media", async (c) => {
  const config = getConfig();
  const type = (c.req.query("type") || "all") as "image" | "video" | "file" | "all";
  const limit = Number(c.req.query("limit")) || 100;
  const offset = Number(c.req.query("offset")) || 0;
  const result = await getMediaFiles(config.dataDir, type, limit, offset);

  const sessions = await getSessions(config.dataDir);
  const contactMap = new Map(sessions.map(s => [s.username, s.remark || s.nickname || s.alias || ""]));
  for (const item of result.items) {
    item.talkerName = contactMap.get(item.talker) || item.talker;
  }

  return c.json(result);
});

app.get("/api/year-report", async (c) => {
  try {
    const config = getConfig();
    const year = Number(c.req.query("year")) || new Date().getFullYear();
    const stats = await getGlobalStats(config.dataDir);
    const emojis = await getEmojis(config.dataDir, 10, 0);
    const topWords = await getYearTopWords(config.dataDir, year);
    const report = buildYearReport(stats, year, emojis.items, topWords);
    return c.json(report);
  } catch (e: unknown) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

const distRelativeWebDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../web"
);
const srcRelativeWebDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/web"
);
const webDir = fs.existsSync(distRelativeWebDir)
  ? distRelativeWebDir
  : srcRelativeWebDir;

app.get("/api/interaction-graph", async (c) => {
  const config = getConfig();
  const chatroom = c.req.query("chatroom");
  if (!chatroom) return c.json({ error: "chatroom required" }, 400);
  const { getMessages } = await import("../db/query-messages.js");
  const messages = await getMessages(config.dataDir, chatroom, { limit: 500, reverse: false });

  const pairs: Record<string, number> = {};
  const senderCounts: Record<string, number> = {};
  const replyPairs: Record<string, number> = {};

  for (const msg of messages) {
    const sender = msg.sender;
    if (!sender) continue;
    senderCounts[sender] = (senderCounts[sender] || 0) + 1;
    if (msg.referContent && msg.referSender && msg.referSender !== sender) {
      const key = [sender, msg.referSender].sort().join("::");
      replyPairs[key] = (replyPairs[key] || 0) + 1;
    }
  }

  const activeSenders = Object.entries(senderCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([s]) => s);

  for (const msg of messages) {
    const s1 = msg.sender;
    if (!s1 || !activeSenders.includes(s1)) continue;
    const time = new Date(msg.time).getTime();
    for (const s2 of activeSenders) {
      if (s2 <= s1) continue;
      const key = [s1, s2].sort().join("::");
      pairs[key] = (pairs[key] || 0) + 1;
    }
  }

  const edges = Object.entries(pairs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50)
    .map(([key, count]) => {
      const [source, target] = key.split("::");
      return { source, target, count, replies: replyPairs[key] || 0 };
    });

  const { loadContactMap } = await import("../db/query-contacts.js");
  const contactMap = await loadContactMap(config.dataDir, activeSenders);
  const nodes = activeSenders.map(s => {
    const c = contactMap.get(s);
    return { id: s, name: c?.nickname || c?.remark || s, messages: senderCounts[s] };
  });

  return c.json({ nodes, edges });
});

app.get("/api/group-monthly-ranking", async (c) => {
  const config = getConfig();
  const chatroom = c.req.query("chatroom");
  if (!chatroom) return c.json({ error: "chatroom required" }, 400);
  const result = await getGroupMonthlyRanking(config.dataDir, chatroom);
  return c.json(result);
});

app.get("/assets/*", serveStatic({ root: webDir }));

app.get("*", async (c) => {
  const urlPath = c.req.path;
  if (urlPath.startsWith("/api")) {
    return c.json({ error: "Not found" }, 404);
  }
  const resolved = path.resolve(webDir, urlPath === "/" ? "index.html" : urlPath);
  const normalizedWebDir = path.normalize(webDir) + path.sep;
  if (!path.normalize(resolved).startsWith(normalizedWebDir) && path.normalize(resolved) !== path.normalize(webDir)) {
    return c.json({ error: "Forbidden" }, 403);
  }
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    const content = fs.readFileSync(resolved);
    const ext = path.extname(resolved);
    const mimeTypes: Record<string, string> = {
      ".html": "text/html",
      ".css": "text/css",
      ".js": "application/javascript",
      ".json": "application/json",
      ".png": "image/png",
      ".svg": "image/svg+xml",
    };
    return new Response(content, {
      headers: { "Content-Type": mimeTypes[ext] || "application/octet-stream" },
    });
  }
  const indexContent = fs.readFileSync(path.join(webDir, "index.html"));
  return new Response(indexContent, {
    headers: { "Content-Type": "text/html" },
  });
});

export function buildYearReport(
  stats: import("../db/stats.js").GlobalStats,
  year: number,
  topEmojis: EmojiItem[],
  topWords: { word: string; count: number }[]
) {
  const daily = stats.dailyActivity.filter(d => d.date.startsWith(String(year)));
  const totalYear = daily.reduce((s, d) => s + d.count, 0);
  const yearDays = daily.length;
  const avgPerDay = yearDays > 0 ? Math.round(totalYear / yearDays) : 0;

  const maxDay = daily.reduce((best, d) => d.count > (best?.count || 0) ? d : best, daily[0]);
  const peakHour = stats.hourlyActivity.reduce((best, cnt, h) => cnt > (best.cnt || 0) ? { h, cnt } : best, { h: 0, cnt: 0 });

  const lateNight = stats.hourlyActivity.slice(0, 5).reduce((s, c) => s + c, 0);
  const lateNightPct = totalYear > 0 ? Math.round(lateNight / totalYear * 100) : 0;

  let maxStreak = 0, curStreak = 0, streakStart = "";
  let bestStreak = 0, bestStreakStart = "";
  const daySet = new Set(daily.map(d => d.date));
  const sorted = daily.map(d => d.date).sort();
  for (const d of sorted) {
    if (daySet.has(d)) {
      curStreak++;
      if (curStreak === 1) streakStart = d;
      if (curStreak > bestStreak) { bestStreak = curStreak; bestStreakStart = streakStart; }
    } else {
      curStreak = 0;
    }
  }

  const top5 = stats.topContacts.slice(0, 5);
  const typeDist = stats.typeDistribution.filter(t => t.count > 0);

  return {
    year,
    totalMessages: totalYear,
    yearDays,
    avgPerDay,
    peakDay: maxDay ? { date: maxDay.date, count: maxDay.count } : null,
    peakHour: { hour: peakHour.h, count: peakHour.cnt },
    lateNightCount: lateNight,
    lateNightPct,
    longestStreak: bestStreak,
    longestStreakStart: bestStreakStart,
    topContacts: top5,
    typeDistribution: typeDist,
    monthlyActivity: Array.from({ length: 12 }, (_, i) => {
      const prefix = `${year}-${String(i + 1).padStart(2, "0")}`;
      return { month: i + 1, count: daily.filter(d => d.date.startsWith(prefix)).reduce((s, d) => s + d.count, 0) };
    }),
    hourlyActivity: stats.hourlyActivity,
    topEmojis: topEmojis.map(e => ({ url: e.url, md5: e.md5, source: e.source, count: e.count })),
    emojiTotal: topEmojis.reduce((s, e) => s + e.count, 0) || 0,
    topWords,
  };
}

app.post("/api/ai/sentiment", async (c) => {
  try {
    const { talker } = await c.req.json<{ talker: string }>();
    if (!talker) return c.json({ error: "talker required" }, 400);
    const { isAiEnabled, callAi, extractAiJson: extractJson } = await import("../server/ai.js");
    if (!isAiEnabled()) return c.json({ error: "AI 功能未配置" }, 400);

    const config = getConfig();
    const { getMessages } = await import("../db/query-messages.js");
    const messages = await getMessages(config.dataDir, talker, { limit: 50, reverse: true });
    if (!messages.length) return c.json({ error: "无消息数据" }, 404);

    const textMessages = messages
      .filter(m => m.content && !m.content.startsWith("["))
      .slice(0, 30)
      .map(m => `${m.isSelf ? '我' : m.sender}: ${m.content}`)
      .join("\n");

    const result = await callAi([
      { role: "system", content: "你是聊天情感分析专家。分析以下聊天记录的整体情感倾向。返回JSON格式：{\"overall\":\"积极/消极/中性\",\"score\":0.8,\"summary\":\"简短中文描述\",\"keywords\":[\"关键词1\",\"关键词2\"]}。只返回JSON，不要其他内容。" },
      { role: "user", content: textMessages }
    ], { temperature: 0.3, maxTokens: 300, thinking: false });

    const parsed = extractAiJson(result) || {};

    return c.json(parsed);
  } catch (e: unknown) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

app.post("/api/ai/sentiment-trend", async (c) => {
  try {
    const { talker, chunkSize } = await c.req.json<{ talker: string; chunkSize?: number }>();
    if (!talker) return c.json({ error: "talker required" }, 400);
    const { isAiEnabled, callAi } = await import("../server/ai.js");
    if (!isAiEnabled()) return c.json({ error: "AI 功能未配置" }, 400);

    const config = getConfig();
    const { getMessages } = await import("../db/query-messages.js");
    const messages = await getMessages(config.dataDir, talker, { limit: 200, reverse: true });
    if (!messages.length) return c.json({ error: "无消息数据" }, 404);

    const cs = Math.max(10, Math.min(50, chunkSize || 40));
    const textMsgs = messages.filter(m => m.content && !m.content.startsWith("["));
    const totalChunks = Math.min(6, Math.ceil(textMsgs.length / cs));
    const step = Math.floor(textMsgs.length / totalChunks);
    if (step < 5) return c.json({ error: "消息太少，无法分析趋势" }, 400);

    const results: Array<{ time: string; score: number; label: string }> = [];
    for (let i = 0; i < totalChunks; i++) {
      const start = i * step;
      const batch = textMsgs.slice(start, start + step);
      if (!batch.length) continue;
      const batchText = batch.slice(0, 30).map(m => `${m.isSelf ? '我' : m.sender}: ${m.content}`).join("\n");
      const midTime = batch[Math.floor(batch.length / 2)].time;
      try {
        const result = await callAi([
          { role: "system", content: "分析以下聊天片段的情感倾向。返回JSON：{\"score\":0.8,\"label\":\"积极\"}。score范围-1到1，-1最消极，1最积极，0中性。只返回JSON。" },
          { role: "user", content: batchText }
        ], { temperature: 0.3, maxTokens: 100, thinking: false });
        const p = extractAiJson<{ score?: number; label?: string }>(result);
        if (p && typeof p.score === 'number') {
          results.push({ time: midTime, score: p.score, label: p.label || (p.score > 0.2 ? '积极' : p.score < -0.2 ? '消极' : '中性') });
        } else {
          results.push({ time: midTime, score: 0, label: '中性' });
        }
      } catch {
        results.push({ time: midTime, score: 0, label: '分析失败' });
      }
    }

    results.sort((a, b) => a.time.localeCompare(b.time));
    return c.json({ points: results });
  } catch (e: unknown) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

app.post("/api/ai/smart-search", async (c) => {
  try {
    const { query } = await c.req.json<{ query: string }>();
    if (!query) return c.json({ error: "query required" }, 400);
    const { isAiEnabled, callAi } = await import("../server/ai.js");
    if (!isAiEnabled()) return c.json({ error: "AI 功能未配置" }, 400);

    const aiResult = await callAi([
      { role: "system", content: "你是微信聊天记录搜索助手。用户输入自然语言描述，你提取出搜索关键词。只返回一个JSON数组，包含2-5个关键词字符串，不要其他内容。示例：用户说\"上个月和小王讨论旅游的事情\"，你返回 [\"小王\",\"旅游\"]" },
      { role: "user", content: query }
    ], { temperature: 0.3, maxTokens: 200, thinking: false });

    let keywords: string[] = [];
    try {
      const match = aiResult.match(/\[[\s\S]*\]/);
      if (match) keywords = JSON.parse(match[0]);
    } catch { /* fallback */ }
    if (!keywords.length) keywords = query.split(/\s+/).slice(0, 3);

    const { searchMessages } = await import("../db/query-messages.js");
    const config = getConfig();
    const results = await searchMessages(config.dataDir, keywords.join(" "), 30, 0, {});
    return c.json({ keywords, results });
  } catch (e: unknown) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

export { app };
