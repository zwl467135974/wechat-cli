import { getConfig } from "../config.js";

export interface AiChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function callAi(
  messages: AiChatMessage[],
  options?: { temperature?: number; maxTokens?: number; thinking?: boolean }
): Promise<string> {
  const config = getConfig();
  if (!config.aiEnabled || !config.aiApiUrl || !config.aiApiKey) {
    throw new Error("AI 功能未配置");
  }

  const url = config.aiApiUrl.replace(/\/+$/, "") + "/chat/completions";
  const body: Record<string, unknown> = {
    model: config.aiModel || "gpt-4o-mini",
    messages,
    temperature: options?.temperature ?? 0.7,
    max_tokens: options?.maxTokens ?? 2000,
  };
  if (options?.thinking === false) {
    body.thinking = { type: "disabled" };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.aiApiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AI API 错误 ${res.status}: ${text.substring(0, 200)}`);
  }

  const data = await res.json();
  const msg = data.choices?.[0]?.message;
  return msg?.content || msg?.reasoning_content || "";
}

export function isAiEnabled(): boolean {
  const config = getConfig();
  return config.aiEnabled && !!config.aiApiUrl && !!config.aiApiKey;
}

export function extractAiJson<T = Record<string, unknown>>(raw: string): T | null {
  const codeBlock = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const candidate = codeBlock ? codeBlock[1].trim() : raw.trim();
  const jsonMatch = candidate.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    return JSON.parse(jsonMatch[0]) as T;
  } catch {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      return null;
    }
  }
}
