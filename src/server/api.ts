import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import { getSessions, getContacts, getChatRoomMembers } from "../db/query-contacts.js";
import {
  getMessages,
  searchMessages,
  clearShardCache,
} from "../db/query-messages.js";
import { getGlobalStats, getChatStats } from "../db/stats.js";
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
  saveEnvFile(mapping);
  const config = getConfig();
  if (body.wechatDbSrcPath) config.wechatDbSrcPath = body.wechatDbSrcPath;
  if (body.wechatPath) config.wechatPath = body.wechatPath;
  if (body.wechatDbKey) config.wechatDbKey = body.wechatDbKey;
  if (body.imageKey) config.imageKey = body.imageKey;
  if (body.xorKey) config.xorKey = body.xorKey;
  if (body.selfWxid) config.selfWxid = body.selfWxid;
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
  const keyword = c.req.query("keyword");
  const limit = Number(c.req.query("limit")) || 50;
  const offset = Number(c.req.query("offset")) || 0;

  if (!keyword) {
    return c.json({ error: "keyword is required" }, 400);
  }

  const results = await searchMessages(config.dataDir, keyword, limit, offset);
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

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildExportHtml(talker: string, messages: import("../db/models.js").Message[]): string {
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

app.post("/api/scan-image-key", async (c) => {
  const result = await scanImageKey();
  if (result) {
    return c.json({ success: true, key: result.key, xor_key: result.xor_key });
  }
  return c.json({ success: false, error: "Key not found. Try viewing some images in WeChat first." });
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

export { app };
