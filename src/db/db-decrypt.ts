import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PAGE_SZ = 4096;
const KEY_SZ = 32;
const SALT_SZ = 16;
const IV_SZ = 16;
const HMAC_SZ = 64;
const RESERVE_SZ = 80;
const SQLITE_HDR = Buffer.from("SQLite format 3\x00");

export function deriveMacKey(encKey: Buffer, salt: Buffer): Buffer {
  const macSalt = Buffer.from(salt);
  for (let i = 0; i < macSalt.length; i++) macSalt[i] ^= 0x3a;
  return crypto.pbkdf2Sync(encKey, macSalt, 2, KEY_SZ, "sha512");
}

export function verifyKey(encKey: Buffer, page1: Buffer): boolean {
  const salt = page1.subarray(0, SALT_SZ);
  const macKey = deriveMacKey(encKey, salt);
  const hmacData = page1.subarray(SALT_SZ, PAGE_SZ - RESERVE_SZ + IV_SZ);
  const storedHmac = page1.subarray(PAGE_SZ - HMAC_SZ, PAGE_SZ);
  const hmac = crypto.createHmac("sha512", macKey);
  hmac.update(hmacData);
  const pgnoBuf = Buffer.alloc(4);
  pgnoBuf.writeUInt32LE(1);
  hmac.update(pgnoBuf);
  return crypto.timingSafeEqual(hmac.digest(), storedHmac);
}

function decryptPage(encKey: Buffer, page: Buffer, pgno: number): Buffer {
  const iv = page.subarray(PAGE_SZ - RESERVE_SZ, PAGE_SZ - RESERVE_SZ + IV_SZ);
  const result = Buffer.alloc(PAGE_SZ);

  let encrypted: Buffer;
  let destOffset: number;

  if (pgno === 1) {
    SQLITE_HDR.copy(result, 0);
    encrypted = page.subarray(SALT_SZ, PAGE_SZ - RESERVE_SZ);
    destOffset = SALT_SZ;
  } else {
    encrypted = page.subarray(0, PAGE_SZ - RESERVE_SZ);
    destOffset = 0;
  }

  const decipher = crypto.createDecipheriv("aes-256-cbc", encKey, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  decrypted.copy(result, destOffset);

  return result;
}

export function decryptDatabase(dbPath: string, outPath: string, encKeyHex: string): boolean {
  const fileSize = fs.statSync(dbPath).size;
  if (fileSize < PAGE_SZ) return false;
  const totalPages = Math.floor(fileSize / PAGE_SZ);

  const encKey = Buffer.from(encKeyHex, "hex");
  if (encKey.length !== KEY_SZ) return false;

  const input = fs.openSync(dbPath, "r");
  const page1 = Buffer.alloc(PAGE_SZ);
  fs.readSync(input, page1, 0, PAGE_SZ, 0);

  if (!verifyKey(encKey, page1)) {
    fs.closeSync(input);
    return false;
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const output = fs.openSync(outPath, "w");

  for (let pgno = 1; pgno <= totalPages; pgno++) {
    const page = Buffer.alloc(PAGE_SZ);
    fs.readSync(input, page, 0, PAGE_SZ, (pgno - 1) * PAGE_SZ);
    const decrypted = decryptPage(encKey, page, pgno);
    fs.writeSync(output, decrypted, 0, PAGE_SZ);
  }

  fs.closeSync(input);
  fs.closeSync(output);
  return true;
}

export interface DecryptResult {
  success: number;
  failed: number;
  skipped: number;
  details: string[];
}

function findKeysFile(): string | null {
  const candidates = [
    path.join(process.cwd(), "python", "all_keys.json"),
    path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "").replace(/\//g, path.sep)), "..", "..", "python", "all_keys.json"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function collectDbFiles(dbDir: string): Array<{ rel: string; path: string }> {
  const results: Array<{ rel: string; path: string }> = [];
  function scan(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(fullPath);
      } else if (entry.name.endsWith(".db") && !entry.name.endsWith("-wal") && !entry.name.endsWith("-shm")) {
        results.push({ rel: path.relative(dbDir, fullPath), path: fullPath });
      }
    }
  }
  scan(dbDir);
  return results;
}

export function decryptAllDatabases(dbDir: string, outDir: string): DecryptResult {
  const keysFile = findKeysFile();

  if (!keysFile) {
    return {
      success: 0,
      failed: 0,
      skipped: 0,
      details: ["密钥文件 all_keys.json 不存在，请先提取密钥"],
    };
  }

  const keys = JSON.parse(fs.readFileSync(keysFile, "utf-8"));
  const dbFiles = collectDbFiles(dbDir);

  let success = 0, failed = 0, skipped = 0;
  const details: string[] = [];

  for (const { rel, path: dbPath } of dbFiles) {
    const candidates = [rel, rel.replace(/\\/g, "/"), rel.replace(/\//g, "\\")];
    let keyInfo: { enc_key: string } | null = null;
    for (const c of candidates) {
      if (keys[c] && keys[c].enc_key) {
        keyInfo = keys[c];
        break;
      }
    }

    if (!keyInfo) {
      skipped++;
      continue;
    }

    const outPath = path.join(outDir, rel);
    const ok = decryptDatabase(dbPath, outPath, keyInfo.enc_key);
    if (ok) {
      success++;
      details.push(`OK: ${rel}`);
    } else {
      failed++;
      details.push(`FAIL: ${rel}`);
    }
  }

  return { success, failed, skipped, details };
}
