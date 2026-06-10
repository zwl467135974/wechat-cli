import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

const PYTHON_DIR = path.join(path.dirname(import.meta.url.replace("file:///", "").replace("file://", "")), "..", "..", "python");

let cachedKey: { key: string; xor_key: number } | null = null;

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
  mediaPath: string
): string | null {
  if (!srcPath) return null;

  const srcRoot = path.dirname(srcPath);
  const thumbPath = path.join(srcRoot, mediaPath + "_t.dat");
  if (fs.existsSync(thumbPath)) return thumbPath;

  const origPath = path.join(srcRoot, mediaPath + ".dat");
  if (fs.existsSync(origPath)) return origPath;

  return null;
}

export function resolveCacheThumb(
  srcPath: string,
  talker: string,
  sortSeq: number
): string | null {
  const cfg = (globalThis as any).__wechatConfig;
  if (!cfg?.wechatDbSrcPath) return null;

  const srcRoot = path.dirname(cfg.wechatDbSrcPath);
  const talkerMd5 = crypto.createHash("md5").update(talker).digest("hex");

  const months: string[] = [];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }

  for (const month of months) {
    const thumbDir = path.join(srcRoot, "cache", month, "Message", talkerMd5, "Thumb");
    if (!fs.existsSync(thumbDir)) continue;
    const files = fs.readdirSync(thumbDir);
    for (const f of files) {
      if (f.endsWith("_thumb.jpg") && f.startsWith(`${sortSeq}_`)) {
        return path.join(thumbDir, f);
      }
    }
  }

  return null;
}

export async function decryptImage(datPath: string): Promise<Buffer | null> {
  const key = loadKey();
  if (!key) return null;

  return new Promise((resolve) => {
    const scriptPath = path.join(PYTHON_DIR, "decrypt_image.py");
    const proc = spawn("python", [scriptPath, "decrypt", datPath, key.key, String(key.xor_key)], {
      cwd: PYTHON_DIR,
    });

    const chunks: Buffer[] = [];
    proc.stdout.on("data", (d: Buffer) => chunks.push(d));
    proc.stderr.on("data", () => {});

    proc.on("close", (code) => {
      if (code === 0 && chunks.length > 0) {
        resolve(Buffer.concat(chunks));
      } else {
        resolve(null);
      }
    });

    proc.on("error", () => resolve(null));
  });
}

export async function scanImageKey(): Promise<{ key: string; xor_key: number } | null> {
  return new Promise((resolve) => {
    const scriptPath = path.join(PYTHON_DIR, "decrypt_image.py");
    const proc = spawn("python", [scriptPath, "find-key"], {
      cwd: PYTHON_DIR,
    });

    let stdout = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", () => {});

    proc.on("close", (code) => {
      if (code === 0 && stdout.trim()) {
        try {
          const result = JSON.parse(stdout.trim());
          cachedKey = result;
          resolve(result);
        } catch {
          resolve(null);
        }
      } else {
        resolve(null);
      }
    });

    proc.on("error", () => resolve(null));
  });
}

export function getImageKeyStatus(): { available: boolean; key?: string } {
  const key = loadKey();
  return { available: !!key, key: key?.key };
}
