import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PYTHON_DIR = path.resolve(__dirname, "../../python");

export async function execPython(
  script: string,
  args: Record<string, string>
): Promise<string> {
  const config = getConfig();
  const scriptPath = path.join(PYTHON_DIR, script);
  const pythonPath = config.pythonPath || "python";

  const argsList = [scriptPath, "--args", JSON.stringify(args)];

  return new Promise((resolve, reject) => {
    const proc = spawn(pythonPath, argsList, {
      cwd: PYTHON_DIR,
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: unknown) => {
      stdout += String(data);
    });

    proc.stderr.on("data", (data: unknown) => {
      stderr += String(data);
    });

    proc.on("close", (code: number | null) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Python script failed (${script}): ${stderr || stdout}`));
      }
    });

    proc.on("error", (err: Error) => {
      reject(new Error(`Failed to spawn Python: ${err.message}`));
    });
  });
}
