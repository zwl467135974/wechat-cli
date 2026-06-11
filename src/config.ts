import fs from "node:fs";
import path from "node:path";

export interface AppConfig {
  dataDir: string;
  wechatDbSrcPath: string;
  wechatDbKey: string;
  wechatPath: string;
  wechatDataPath: string;
  imageKey: string;
  xorKey: string;
  pythonPath: string;
}

const DEFAULT_CONFIG: Partial<AppConfig> = {
  dataDir: "data",
  pythonPath: "python",
};

let _config: AppConfig | null = null;

function getEnvPath(): string {
  return path.resolve(process.cwd(), ".env");
}

export function loadEnvFile(): Record<string, string> {
  const envPath = getEnvPath();
  const result: Record<string, string> = {};
  if (!fs.existsSync(envPath)) return result;
  const content = fs.readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.substring(0, eqIdx).trim();
    let val = trimmed.substring(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

export function saveEnvFile(values: Record<string, string>): void {
  const envPath = getEnvPath();
  const existing = loadEnvFile();
  const merged = { ...existing, ...values };
  const lines = Object.entries(merged)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(envPath, lines.join("\n") + "\n", "utf-8");
}

export function initConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const envFile = loadEnvFile();

  _config = {
    ...DEFAULT_CONFIG,
    wechatDbSrcPath: envFile.WECHAT_DB_SRC_PATH || "",
    wechatDbKey: envFile.WECHAT_DB_KEY || "",
    wechatPath: envFile.WECHAT_PATH || "",
    wechatDataPath: envFile.WECHAT_DATA_PATH || "",
    imageKey: envFile.IMAGE_KEY || "",
    xorKey: envFile.XOR_KEY || "",
    ...overrides,
  } as AppConfig;

  if (!_config.dataDir) _config.dataDir = "data";

  return _config;
}

export function getConfig(): AppConfig {
  if (!_config) {
    throw new Error("Config not initialized. Call initConfig() first.");
  }
  return _config;
}
