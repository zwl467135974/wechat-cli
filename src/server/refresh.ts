import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";
import { closeAll } from "../db/manager.js";
import { clearShardCache } from "../db/query-messages.js";
import { clearSelfCache } from "../db/message-parser.js";
import { saveAllBeforeRefresh } from "../db/recall-store.js";
import { decryptAllDatabases } from "../db/db-decrypt.js";

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
    clearSelfCache();
    if (!cfg.wechatDbSrcPath) return { ok: false, error: "未配置微信数据库路径" };
    const absOutDir = path.resolve(cfg.dataDir);
    if (!fs.existsSync(absOutDir)) fs.mkdirSync(absOutDir, { recursive: true });

    const result = decryptAllDatabases(cfg.wechatDbSrcPath, absOutDir);
    if (result.success === 0 && result.failed > 0) {
      return { ok: false, error: result.details.join("\n") };
    }

    const ts = new Date().toISOString();
    globalThis.__wechatLastRefresh = ts;
    console.log(`[${ts}] Refresh completed: ${result.success} ok, ${result.failed} fail, ${result.skipped} skip`);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[${new Date().toISOString()}] Refresh failed:`, msg);
    return { ok: false, error: msg };
  } finally {
    globalThis.__wechatRefreshLock = false;
  }
}
