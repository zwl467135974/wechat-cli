import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const PYTHON_DIR = path.join(path.dirname(import.meta.url.replace("file:///", "").replace("file://", "")), "..", "..", "python");

let cachedKey: { key: string; xor_key: number } | null = null;

const SIG_V2 = Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07]);
const SIG_V1 = Buffer.from([0x07, 0x08, 0x56, 0x31, 0x08, 0x07]);
const KNOWN_HEADERS: Buffer[] = [
  Buffer.from([0xff, 0xd8, 0xff]),
  Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  Buffer.from([0x47, 0x49, 0x46, 0x38]),
  Buffer.from([0x52, 0x49, 0x46, 0x46]),
];

export function detectMime(buf: Buffer): string {
  if (buf.length < 4) return "application/octet-stream";
  const pfx4 = buf.subarray(0, 4).toString("ascii");
  if (pfx4 === "\x89PNG") return "image/png";
  if (pfx4 === "RIFF") return "image/webp";
  if (pfx4 === "GIF8") return "image/gif";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  return "application/octet-stream";
}

export function isWxgf(buf: Buffer): boolean {
  return buf.length >= 4 && buf.subarray(0, 4).toString("ascii") === "wxgf";
}

let ffmpegPath: string | null | undefined;

function findFfmpeg(): string | null {
  if (ffmpegPath !== undefined) return ffmpegPath;
  try {
    const r = spawnSync("ffmpeg", ["-version"], { stdio: "ignore", timeout: 3000 });
    ffmpegPath = r.status === 0 ? "ffmpeg" : null;
  } catch {
    ffmpegPath = null;
  }
  if (!ffmpegPath && process.platform === "win32") {
    const candidates = [
      path.join(process.env.PROGRAMFILES || "C:\\Program Files", "ffmpeg", "bin", "ffmpeg.exe"),
      "C:\\ffmpeg\\bin\\ffmpeg.exe",
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) { ffmpegPath = p; break; }
    }
  }
  return ffmpegPath;
}

function findHevcStart(data: Buffer): number {
  for (let i = 0; i < data.length - 5; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) {
      const naluType = (data[i + 4] >> 1) & 0x3f;
      if (naluType === 32 || naluType === 33 || naluType === 34 || naluType === 19 || naluType === 20) return i;
    }
  }
  for (let i = 0; i < data.length - 5; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) return i;
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) return i;
  }
  return -1;
}

export async function convertWxgfToJpg(decryptedData: Buffer): Promise<Buffer | null> {
  const tmpDir = path.join(os.tmpdir(), "wechat-cli");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const tmpId = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  const tmpInput = path.join(tmpDir, `wxgf_${tmpId}.265`);
  const tmpOutput = path.join(tmpDir, `wxgf_${tmpId}.jpg`);

  try {
    const hevcOffset = findHevcStart(decryptedData);
    if (hevcOffset < 0) return null;
    fs.writeFileSync(tmpInput, decryptedData.subarray(hevcOffset));

    const ffmpeg = findFfmpeg();
    if (ffmpeg) {
      const r = spawnSync(ffmpeg, ["-i", tmpInput, "-frames:v", "1", "-q:v", "2", "-y", tmpOutput], {
        stdio: "ignore", timeout: 10000,
      });
      if (r.status === 0 && fs.existsSync(tmpOutput)) {
        return fs.readFileSync(tmpOutput);
      }
    }

    const scriptPath = path.join(PYTHON_DIR, "convert_wxgf.py");
    const result = await new Promise<boolean>((resolve) => {
      const proc = spawn("python", [scriptPath, tmpInput, tmpOutput], { cwd: PYTHON_DIR });
      proc.stderr.on("data", () => {});
      proc.on("close", (code) => resolve(code === 0));
      proc.on("error", () => resolve(false));
    });
    if (result && fs.existsSync(tmpOutput)) {
      return fs.readFileSync(tmpOutput);
    }
    return null;
  } finally {
    if (fs.existsSync(tmpInput)) fs.unlinkSync(tmpInput);
    if (fs.existsSync(tmpOutput)) fs.unlinkSync(tmpOutput);
  }
}

function loadKey(): { key: string; xor_key: number } | null {
  if (cachedKey) return cachedKey;
  const keyFile = path.join(PYTHON_DIR, "image_key.txt");
  if (fs.existsSync(keyFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(keyFile, "utf-8"));
      cachedKey = { key: data.key, xor_key: data.xor_key ?? 0xD5 };
      return cachedKey;
    } catch {
      return null;
    }
  }
  return null;
}

export function resolveImagePath(
  srcPath: string,
  talker: string,
  mediaPath: string,
  preferOriginal = false
): string | null {
  if (!srcPath) return null;
  if (mediaPath.includes("..")) return null;

  const srcRoot = path.dirname(srcPath);

  if (preferOriginal) {
    const origPath = path.join(srcRoot, mediaPath + ".dat");
    if (fs.existsSync(origPath)) return origPath;
  }

  const thumbPath = path.join(srcRoot, mediaPath + "_t.dat");
  if (fs.existsSync(thumbPath)) return thumbPath;

  const origPath = path.join(srcRoot, mediaPath + ".dat");
  if (fs.existsSync(origPath)) return origPath;

  return null;
}

export function resolveVideoPath(
  srcPath: string,
  mediaPath: string
): string | null {
  if (!srcPath) return null;
  if (mediaPath.includes("..")) return null;

  const srcRoot = path.dirname(srcPath);
  const extensions = [".mp4", ".dat", ""];
  for (const ext of extensions) {
    const fullPath = path.join(srcRoot, mediaPath + ext);
    if (fs.existsSync(fullPath)) return fullPath;
  }

  const videoDir = path.dirname(path.join(srcRoot, mediaPath));
  if (fs.existsSync(videoDir)) {
    const baseName = path.basename(mediaPath);
    const files = fs.readdirSync(videoDir);
    for (const f of files) {
      if (f.startsWith(baseName)) {
        return path.join(videoDir, f);
      }
    }
  }

  return null;
}

function decryptV2Dat(data: Buffer, aesKey: string, xorKey: number): Buffer | null {
  if (data.length < 15) return null;

  const sig = data.subarray(0, 6);
  if (!sig.equals(SIG_V2) && !sig.equals(SIG_V1)) return null;

  const aesSize = data.readUInt32LE(6);
  const xorSize = data.readUInt32LE(10);

  const fileData = data.subarray(15);
  const alignedAesSize = aesSize + (16 - (aesSize % 16));

  if (alignedAesSize > fileData.length) return null;

  const keyBytes = Buffer.from(aesKey.substring(0, 16), "ascii");
  if (keyBytes.length < 16) return null;

  const aesPart = fileData.subarray(0, alignedAesSize);
  const decipher = crypto.createDecipheriv("aes-128-ecb", keyBytes, null);
  decipher.setAutoPadding(false);
  const decRaw = Buffer.concat([decipher.update(aesPart), decipher.final()]);

  const padLen = decRaw[decRaw.length - 1];
  let decAes: Buffer;
  if (padLen > 0 && padLen <= 16) {
    let valid = true;
    for (let i = decRaw.length - padLen; i < decRaw.length; i++) {
      if (decRaw[i] !== padLen) { valid = false; break; }
    }
    decAes = valid ? decRaw.subarray(0, decRaw.length - padLen) : decRaw;
  } else {
    decAes = decRaw;
  }

  const remaining = fileData.subarray(alignedAesSize);
  if (remaining.length < xorSize) return null;
  const rawLen = remaining.length - xorSize;
  const rawData = remaining.subarray(0, rawLen);
  const xorData = Buffer.from(remaining.subarray(rawLen));
  for (let i = 0; i < xorData.length; i++) xorData[i] ^= xorKey;

  return Buffer.concat([decAes, rawData, xorData]);
}

function decryptSimpleXor(data: Buffer): Buffer | null {
  for (const header of KNOWN_HEADERS) {
    const candidate = data[0] ^ header[0];
    let match = true;
    for (let i = 1; i < header.length; i++) {
      if ((data[i] ^ candidate) !== header[i]) { match = false; break; }
    }
    if (match) {
      const result = Buffer.from(data);
      for (let i = 0; i < result.length; i++) result[i] ^= candidate;
      return result;
    }
  }
  return null;
}

export async function decryptImage(datPath: string): Promise<Buffer | null> {
  const key = loadKey();
  let data: Buffer;
  try {
    data = fs.readFileSync(datPath);
  } catch {
    return null;
  }

  if (key) {
    const v2Result = decryptV2Dat(data, key.key, key.xor_key);
    if (v2Result) return v2Result;
  }

  return decryptSimpleXor(data);
}

export function deriveXorKey(attachBase: string): number | null {
  const pairs: Array<[number, number]> = [];

  function scan(dir: string) {
    if (pairs.length >= 20) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (pairs.length >= 20) return;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(fullPath);
      } else if (entry.name.endsWith("_t.dat")) {
        try {
          const fdata = fs.readFileSync(fullPath);
          if (fdata.length >= 2) {
            pairs.push([fdata[fdata.length - 2], fdata[fdata.length - 1]]);
          }
        } catch { /* skip */ }
      }
    }
  }
  scan(attachBase);

  if (pairs.length === 0) return null;

  const counter = new Map<string, number>();
  for (const [b0, b1] of pairs) {
    const k = `${b0},${b1}`;
    counter.set(k, (counter.get(k) || 0) + 1);
  }

  let best: [number, number] | null = null;
  let bestCount = 0;
  for (const [k, count] of counter) {
    if (count > bestCount) {
      bestCount = count;
      const parts = k.split(",");
      best = [parseInt(parts[0]), parseInt(parts[1])];
    }
  }

  if (!best) return null;
  const xorFF = best[0] ^ 0xff;
  const xorD9 = best[1] ^ 0xd9;
  return xorFF === xorD9 ? xorFF : null;
}

export async function scanImageKey(): Promise<{ key: string; xor_key: number } | null> {
  const config = (await import("../config.js")).getConfig();
  if (!config.wechatDbSrcPath) return null;

  const srcRoot = path.dirname(config.wechatDbSrcPath);
  const attachBase = path.join(srcRoot, "msg", "attach");

  try {
    const { extractImageKey } = await import("../db/key-extractor.js");
    const result = extractImageKey(attachBase);
    if (result) {
      cachedKey = result;
      const keyFile = path.join(PYTHON_DIR, "image_key.txt");
      try { fs.writeFileSync(keyFile, JSON.stringify(result)); } catch { /* ignore */ }
    }
    return result;
  } catch {
    return null;
  }
}

export function getImageKeyStatus(): { available: boolean; key?: string } {
  const key = loadKey();
  return { available: !!key, key: key?.key };
}
