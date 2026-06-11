import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";
import { closeAll } from "../db/manager.js";
import { clearShardCache } from "../db/query-messages.js";
import { saveAllBeforeRefresh } from "../db/recall-store.js";
import { execPython } from "../python/runner.js";

async function runDecrypt(dbDir: string, outDir: string): Promise<string> {
  return execPython("decrypt_db_v2.py", {
    db_dir: dbDir,
    out_dir: outDir,
  });
}

declare global {
  var __wechatLastRefresh: string | undefined;
  var __wechatRefreshLock: boolean | undefined;
}

export async function doRefresh(): Promise<{ ok: boolean; error?: string }> {
  if (globalThis.__wechatRefreshLock) return { ok: false, error: "刷新进行中，请稍候" };
  globalThis.__wechatRefreshLock = true;
  try {
    const cfg = getConfig();
    saveAllBeforeRefresh(cfg.dataDir);
    closeAll();
    clearShardCache();
    if (!cfg.wechatDbSrcPath) return { ok: false, error: "未配置微信数据库路径" };
    const absOutDir = path.resolve(cfg.dataDir);
    if (!fs.existsSync(absOutDir)) fs.mkdirSync(absOutDir, { recursive: true });
    await runDecrypt(cfg.wechatDbSrcPath, absOutDir);
    const ts = new Date().toISOString();
    globalThis.__wechatLastRefresh = ts;
    console.log(`[${ts}] Refresh completed`);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[${new Date().toISOString()}] Refresh failed:`, msg);
    return { ok: false, error: msg };
  } finally {
    globalThis.__wechatRefreshLock = false;
  }
}
