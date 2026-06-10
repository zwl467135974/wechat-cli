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

export function initConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  _config = {
    ...DEFAULT_CONFIG,
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
