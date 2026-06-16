import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { verifyKey } from "./db-decrypt.js";
import {
  findWechatPids,
  openProcess,
  closeProcess,
  enumRegions,
  readMemory,
} from "../win/memory-reader.js";

interface DbFileInfo {
  rel: string;
  path: string;
  salt: string;
  page1: Buffer;
  size: number;
}

function collectDbFiles(dbDir: string): DbFileInfo[] {
  const results: DbFileInfo[] = [];
  function scan(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(fullPath);
      } else if (entry.name.endsWith(".db") && !entry.name.endsWith("-wal") && !entry.name.endsWith("-shm")) {
        const size = fs.statSync(fullPath).size;
        if (size < 4096) continue;
        const page1 = Buffer.alloc(4096);
        const fd = fs.openSync(fullPath, "r");
        fs.readSync(fd, page1, 0, 4096, 0);
        fs.closeSync(fd);
        const salt = page1.subarray(0, 16).toString("hex");
        results.push({ rel: path.relative(dbDir, fullPath), path: fullPath, salt, page1, size });
      }
    }
  }
  scan(dbDir);
  return results;
}

function tryMatchHexKey(
  hexStr: string,
  saltToDbs: Map<string, DbFileInfo[]>,
  keyMap: Map<string, string>,
  remainingSalts: Set<string>
): boolean {
  const hexLen = hexStr.length;

  const attempt = (encKeyHex: string, saltHex: string): boolean => {
    if (!remainingSalts.has(saltHex)) return false;
    const encKey = Buffer.from(encKeyHex, "hex");
    const dbs = saltToDbs.get(saltHex);
    if (!dbs) return false;
    if (verifyKey(encKey, dbs[0].page1)) {
      keyMap.set(saltHex, encKeyHex);
      remainingSalts.delete(saltHex);
      return true;
    }
    return false;
  };

  if (hexLen === 96) {
    return attempt(hexStr.substring(0, 64), hexStr.substring(64));
  } else if (hexLen === 64 && remainingSalts.size > 0) {
    const encKey = Buffer.from(hexStr, "hex");
    for (const [saltHex, dbs] of saltToDbs) {
      if (!remainingSalts.has(saltHex)) continue;
      if (verifyKey(encKey, dbs[0].page1)) {
        keyMap.set(saltHex, hexStr);
        remainingSalts.delete(saltHex);
        return true;
      }
    }
  } else if (hexLen > 96 && hexLen % 2 === 0) {
    return attempt(hexStr.substring(0, 64), hexStr.substring(hexLen - 32));
  }
  return false;
}

function crossVerify(
  saltToDbs: Map<string, DbFileInfo[]>,
  keyMap: Map<string, string>
): void {
  const missing = new Set([...saltToDbs.keys()].filter((s) => !keyMap.has(s)));
  if (missing.size === 0 || keyMap.size === 0) return;

  const knownKeys = [...keyMap.values()];
  for (const saltHex of missing) {
    const dbs = saltToDbs.get(saltHex);
    if (!dbs) continue;
    for (const keyHex of knownKeys) {
      if (verifyKey(Buffer.from(keyHex, "hex"), dbs[0].page1)) {
        keyMap.set(saltHex, keyHex);
        break;
      }
    }
  }
}

export interface ExtractDbKeysResult {
  keys: Record<string, unknown>;
  details: string[];
}

export function extractDbKeys(dbDir: string): ExtractDbKeysResult {
  const details: string[] = [];

  const dbFiles = collectDbFiles(dbDir);
  const saltToDbs = new Map<string, DbFileInfo[]>();
  for (const db of dbFiles) {
    if (!saltToDbs.has(db.salt)) saltToDbs.set(db.salt, []);
    saltToDbs.get(db.salt)!.push(db);
  }

  details.push(`找到 ${dbFiles.length} 个数据库, ${saltToDbs.size} 个不同的 salt`);

  const pids = findWechatPids();
  if (pids.length === 0) {
    details.push("Weixin.exe 未运行，请先启动微信");
    return { keys: {}, details };
  }

  const keyMap = new Map<string, string>();
  const remainingSalts = new Set(saltToDbs.keys());
  const hexRe = /x'([0-9a-fA-F]{64,192})'/g;

  for (const { pid, memKb } of pids) {
    details.push(`扫描 PID=${pid} (${Math.round(memKb / 1024)}MB)`);
    const handle = openProcess(pid);
    if (!handle) continue;

    try {
      const regions = enumRegions(handle);
      let totalMb = 0;
      for (const r of regions) totalMb += Number(r.size) / 1048576;
      details.push(`  ${regions.length} regions, ${Math.round(totalMb)}MB`);

      for (let i = 0; i < regions.length && remainingSalts.size > 0; i++) {
        const data = readMemory(handle, regions[i].base, regions[i].size);
        if (!data) continue;

        const text = data.toString("latin1");
        hexRe.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = hexRe.exec(text)) !== null && remainingSalts.size > 0) {
          tryMatchHexKey(match[1], saltToDbs, keyMap, remainingSalts);
        }
      }
    } finally {
      closeProcess(handle);
    }

    if (remainingSalts.size === 0) {
      details.push("所有密钥已找到");
      break;
    }
  }

  crossVerify(saltToDbs, keyMap);

  const keys: Record<string, unknown> = {};
  for (const db of dbFiles) {
    if (keyMap.has(db.salt)) {
      keys[db.rel] = {
        enc_key: keyMap.get(db.salt),
        salt: db.salt,
        size_mb: Math.round(db.size / 1048576 * 10) / 10,
      };
    } else {
      details.push(`MISSING: ${db.rel}`);
    }
  }
  keys["_db_dir"] = dbDir;

  details.push(`结果: ${keyMap.size}/${saltToDbs.size} salts 找到密钥`);

  return { keys, details };
}

function verifyImageAesKey(ciphertext: Buffer, keyStr: string): boolean {
  if (keyStr.length < 16) return false;
  const keyBytes = Buffer.from(keyStr.substring(0, 16), "ascii");
  try {
    const decipher = crypto.createDecipheriv("aes-128-ecb", keyBytes, null);
    decipher.setAutoPadding(false);
    const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return dec.length >= 3 && dec[0] === 0xff && dec[1] === 0xd8 && dec[2] === 0xff;
  } catch {
    return false;
  }
}

function getTemplateCiphertext(attachBase: string): Buffer | null {
  const sig = Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07]);
  let result: Buffer | null = null;

  function scan(dir: string, depth: number): boolean {
    if (result || depth > 5) return !!result;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    for (const entry of entries) {
      if (result) return true;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (scan(fullPath, depth + 1)) return true;
      } else if (entry.name.endsWith("_t.dat")) {
        try {
          const data = fs.readFileSync(fullPath);
          if (data.length >= 0x1f && data.subarray(0, 6).equals(sig)) {
            result = Buffer.from(data.subarray(0x0f, 0x1f));
            return true;
          }
        } catch { /* skip */ }
      }
    }
    return false;
  }

  scan(attachBase, 0);
  return result;
}

export interface ExtractImageKeyResult {
  key: string;
  xor_key: number;
}

function deriveXorKeyInline(attachBase: string): number | null {
  const pairs: Array<[number, number]> = [];
  function scan(dir: string, depth: number) {
    if (pairs.length >= 20 || depth > 5) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (pairs.length >= 20) return;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) { scan(fullPath, depth + 1); }
      else if (entry.name.endsWith("_t.dat")) {
        try {
          const fdata = fs.readFileSync(fullPath);
          if (fdata.length >= 2) pairs.push([fdata[fdata.length - 2], fdata[fdata.length - 1]]);
        } catch { /* skip */ }
      }
    }
  }
  scan(attachBase, 0);
  if (pairs.length === 0) return null;
  const counter = new Map<string, number>();
  for (const [b0, b1] of pairs) {
    const k = `${b0},${b1}`;
    counter.set(k, (counter.get(k) || 0) + 1);
  }
  let best: [number, number] | null = null;
  let bestCount = 0;
  for (const [k, count] of counter) {
    if (count > bestCount) { bestCount = count; const p = k.split(","); best = [parseInt(p[0]), parseInt(p[1])]; }
  }
  if (!best) return null;
  const xorFF = best[0] ^ 0xff;
  const xorD9 = best[1] ^ 0xd9;
  return xorFF === xorD9 ? xorFF : null;
}

export function extractImageKey(attachBase: string): ExtractImageKeyResult | null {
  const xorKey = deriveXorKeyInline(attachBase);
  if (xorKey === null) return null;

  const ciphertext = getTemplateCiphertext(attachBase);
  if (!ciphertext) return { key: "", xor_key: xorKey };

  const pids = findWechatPids();
  if (pids.length === 0) return { key: "", xor_key: xorKey };

  const alnumRe = /[a-z0-9]{32,40}/g;

  for (const { pid } of pids) {
    const handle = openProcess(pid);
    if (!handle) continue;

    try {
      const regions = enumRegions(handle);
      for (const { base, size } of regions) {
        const data = readMemory(handle, base, size);
        if (!data) continue;

        const text = data.toString("latin1");
        alnumRe.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = alnumRe.exec(text)) !== null) {
          const candidate = match[0];
          if (candidate.length >= 32) {
            for (let j = 0; j <= candidate.length - 32; j++) {
              const keyStr = candidate.substring(j, j + 32);
              if (verifyImageAesKey(ciphertext, keyStr)) {
                return { key: keyStr, xor_key: xorKey };
              }
            }
          }
        }
      }
    } finally {
      closeProcess(handle);
    }
  }

  return { key: "", xor_key: xorKey };
}
