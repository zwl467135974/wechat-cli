import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const PYTHON_DIR = path.join(path.dirname(import.meta.url.replace("file:///", "").replace("file://", "")), "..", "..", "python");

let cachedKey: { key: string; xor_key: number } | null = null;

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

export async function convertWxgfToJpg(decryptedData: Buffer): Promise<Buffer | null> {
  const tmpDir = path.join(os.tmpdir(), "wechat-cli");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const tmpId = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  const tmpDat = path.join(tmpDir, `wxgf_${tmpId}.bin`);
  const tmpJpg = path.join(tmpDir, `wxgf_${tmpId}.jpg`);

  try {
    fs.writeFileSync(tmpDat, decryptedData);

    const scriptPath = path.join(PYTHON_DIR, "convert_wxgf.py");
    const result = await new Promise<boolean>((resolve) => {
      const proc = spawn("python", [scriptPath, tmpDat, tmpJpg], { cwd: PYTHON_DIR });
      proc.stderr.on("data", () => {});
      proc.on("close", (code) => resolve(code === 0));
      proc.on("error", () => resolve(false));
    });

    if (result && fs.existsSync(tmpJpg)) {
      return fs.readFileSync(tmpJpg);
    }
    return null;
  } finally {
    if (fs.existsSync(tmpDat)) fs.unlinkSync(tmpDat);
    if (fs.existsSync(tmpJpg)) fs.unlinkSync(tmpJpg);
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
