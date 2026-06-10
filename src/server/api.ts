import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import { getSessions, getContacts } from "../db/query-contacts.js";
import {
  getMessages,
  searchMessages,
} from "../db/query-messages.js";
import { closeAll, findFilesByType } from "../db/manager.js";
import { execPython } from "../python/runner.js";
import { getConfig } from "../config.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = new Hono();

app.use("*", cors());

app.get("/api/health", (c) => c.json({ status: "ok" }));

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
