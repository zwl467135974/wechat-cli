import { getConfig } from "../config.js";

export interface AiChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function callAi(
  messages: AiChatMessage[],
  options?: { temperature?: number; maxTokens?: number }
): Promise<string> {
  const config = getConfig();
  if (!config.aiEnabled || !config.aiApiUrl || !config.aiApiKey) {
    throw new Error("AI 功能未配置");
  }

  const url = config.aiApiUrl.replace(/\/+$/, "") + "/chat/completions";
  const body = {
    model: config.aiModel || "gpt-4o-mini",
    messages,
    temperature: options?.temperature ?? 0.7,
    max_tokens: options?.maxTokens ?? 2000,
  };

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
  return data.choices?.[0]?.message?.content || "";
}

export function isAiEnabled(): boolean {
  const config = getConfig();
  return config.aiEnabled && !!config.aiApiUrl && !!config.aiApiKey;
}
