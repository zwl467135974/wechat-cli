import path from "node:path";
import fs from "node:fs";
import initSqlJs, { Database } from "sql.js";
import { identify, SUB_DIR_MAP, type GroupType } from "./strategy.js";
import type { DatabaseShard } from "./models.js";

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;

async function getSqlJs() {
  if (!SQL) {
    SQL = await initSqlJs();
  }
  return SQL;
}

const connectionCache = new Map<string, Database>();

export async function getConnection(dbPath: string): Promise<Database> {
  const cached = connectionCache.get(dbPath);
  if (cached) return cached;

  const SQL = await getSqlJs();
  const buffer = fs.readFileSync(dbPath);
  const db = new SQL.Database(buffer);
  connectionCache.set(dbPath, db);
  return db;
}

export function closeAll() {
  for (const db of connectionCache.values()) {
    db.close();
  }
  connectionCache.clear();
}

export function findFilesByType(
  baseDir: string,
  targetType: GroupType
): string[] {
  const results: string[] = [];
  const subDir = SUB_DIR_MAP[targetType];

  if (subDir) {
    const subDirPath = path.join(baseDir, subDir);
    const files = scanDir(subDirPath, targetType);
    if (files.length > 0) return files;
  }

  return scanDir(baseDir, targetType);
}

function scanDir(dir: string, targetType: GroupType): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    const meta = identify(entry.name);
    if (meta && meta.type === targetType) {
      results.push(path.join(dir, entry.name));
    }
  }
  return results;
}

export function discoverMessageShards(baseDir: string): string[] {
  return findFilesByType(baseDir, "message");
}

export async function buildShardIndex(
  baseDir: string
): Promise<DatabaseShard[]> {
  const msgFiles = discoverMessageShards(baseDir);
  const shards: DatabaseShard[] = [];

  for (const filePath of msgFiles) {
    const db = await getConnection(filePath);
    const startTime = readStartTime(db);
    const talkerMap = readTalkerMap(db);

    shards.push({
      filePath,
      startTime: startTime ?? new Date(0),
      endTime: new Date(),
      talkerMap,
    });
  }

  shards.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

  for (let i = 0; i < shards.length; i++) {
    if (i < shards.length - 1) {
      shards[i].endTime = shards[i + 1].startTime;
    }
  }

  return shards;
}

function readStartTime(db: Database): Date | null {
  try {
    const tables = db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%' LIMIT 10"
    );
    const tList = tables.length > 0 ? tables[0].values.flat() : [];
    for (const table of tList) {
      const t = String(table);
      const r = db.exec(`SELECT MIN(create_time) AS ts FROM "${t}"`);
      if (r.length > 0 && r[0].values.length > 0) {
        const ts = r[0].values[0][0] as number;
        if (ts) return new Date(ts * 1000);
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function readTalkerMap(db: Database): Map<string, number> {
  const map = new Map<string, number>();
  try {
    const rows = db.exec("SELECT user_name, is_session FROM Name2Id");
    if (rows.length > 0) {
      for (const row of rows[0].values) {
        map.set(String(row[0]), Number(row[1]));
      }
    }
  } catch {
    // Name2Id table may not exist in all shards
  }
  return map;
}

export function resolveShards(
  shards: DatabaseShard[],
  start: Date,
  end: Date,
  talker: string
): Array<{ filePath: string; talkerId: number | null }> {
  const results: Array<{ filePath: string; talkerId: number | null }> = [];

  for (const shard of shards) {
    if (shard.startTime < end && shard.endTime > start) {
      results.push({
        filePath: shard.filePath,
        talkerId: shard.talkerMap.get(talker) ?? null,
      });
    }
  }

  return results;
}

export function findSingleFile(
  baseDir: string,
  targetType: GroupType
): string | null {
  const files = findFilesByType(baseDir, targetType);
  return files.length > 0 ? files[0] : null;
}
