import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import { getSessions, getContacts, getChatRoomMembers } from "../db/query-contacts.js";
import {
  getMessages,
  searchMessages,
  getGlobalStats,
} from "../db/query-messages.js";
import { closeAll, findFilesByType } from "../db/manager.js";
import { execPython } from "../python/runner.js";
import { getConfig } from "../config.js";
import {
  resolveImagePath,
  resolveCacheThumb,
  resolveVideoPath,
  decryptImage,
  scanImageKey,
  getImageKeyStatus,
} from "./image.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = new Hono();

app.use("*", cors());
app.use("*", async (c, next) => {
  await next();
  c.res.headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
  c.res.headers.set("Pragma", "no-cache");
  c.res.headers.set("Expires", "0");
});

app.get("/api/health", (c) => c.json({ status: "ok" }));

app.get("/api/last-refresh", (c) => {
  return c.json({ lastRefresh: globalThis.__wechatLastRefresh || null });
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
  });
});

app.post("/api/decrypt", async (c) => {
  const config = getConfig();
  const outDir = config.dataDir;

  const result = await execPython("decrypt_db_v2.py", {
    db_dir: config.wechatDbSrcPath,
    out_dir: outDir,
  });
  closeAll();

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
  const reverse = c.req.query("reverse") === "true";

  if (!talkerId) {
    return c.json({ error: "talker_id is required" }, 400);
  }

  const messages = await getMessages(config.dataDir, talkerId, {
    keyword,
    limit,
    offset,
    reverse,
  });
  return c.json(messages);
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

app.get("/api/stats", async (c) => {
  const config = getConfig();
  try {
    const stats = await getGlobalStats(config.dataDir);
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
    limit: 10000,
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

function buildExportHtml(talker: string, messages: import("../db/models.js").Message[]): string {
  const rows = messages.map(m => {
    const t = new Date(m.time).toLocaleString("zh-CN");
    const sender = m.sender || m.talker;
    const cls = m.isSelf ? "self" : "other";
    return `<div class="msg ${cls}"><span class="time">${t}</span><span class="sender">${sender}</span><span class="content">${m.content}</span></div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>聊天记录 - ${talker}</title>
<style>
body{font-family:system-ui;margin:20px auto;max-width:800px;background:#f5f5f5;padding:20px}
h1{font-size:18px;color:#333;border-bottom:1px solid #ddd;padding-bottom:8px}
.msg{padding:6px 0;border-bottom:1px solid #eee;display:flex;gap:8px;font-size:14px}
.msg.self .sender{color:#3b82f6}.msg.other .sender{color:#22c55e}
.time{color:#999;min-width:140px;font-size:12px}
.sender{min-width:80px;font-weight:bold;font-size:13px}
.content{flex:1;word-break:break-all}
</style></head><body><h1>聊天记录 - ${talker} (${messages.length}条)</h1>${rows}</body></html>`;
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
  if (decrypted) {
    const prefix = decrypted.subarray(0, 4).toString('ascii');
    let mime = "image/jpeg";
    if (prefix === "\x89PNG") mime = "image/png";
    else if (prefix === "RIFF") mime = "image/webp";
    else if (prefix === "GIF8") mime = "image/gif";
    else if (prefix === "wxgf") {
      if (decrypted.length > 20) {
        const inner = decrypted.subarray(16);
        const innerPfx = inner.subarray(0, 4).toString('ascii');
        if (innerPfx === "RIFF") mime = "image/webp";
        else if (innerPfx === "\x89PNG") mime = "image/png";
        else if (innerPfx.substring(0, 3) === "\xff\xd8\xff") mime = "image/jpeg";
      }
    }
    return new Response(new Uint8Array(decrypted), {
      headers: {
        "Content-Type": mime,
        "Cache-Control": "public, max-age=3600",
      },
    });
  }

  return c.json({ error: "Image decryption key not available", keyStatus: getImageKeyStatus() }, 503);
});

app.get("/api/emoji", async (c) => {
  const md5 = c.req.query("md5");
  if (!md5 || !/^[0-9a-f]{32}$/i.test(md5)) {
    return c.json({ error: "Invalid md5" }, 400);
  }

  const config = getConfig();
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
  const filePath = path.join(webDir, urlPath === "/" ? "index.html" : urlPath);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const content = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
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
  const indexPath = path.join(webDir, "index.html");
  const indexContent = fs.readFileSync(indexPath);
  return new Response(indexContent, {
    headers: { "Content-Type": "text/html" },
  });
});

export { app };
