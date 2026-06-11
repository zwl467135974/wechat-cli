import fs from "node:fs";
import path from "node:path";
import type { Message } from "./models.js";
import { getConnection } from "./manager.js";
import { listMsgTables, md5 } from "./message-parser.js";

const BUFFER_TTL_MS = 5 * 60 * 1000;

interface StoredMsg {
  seq: number;
  time: number;
  type: number;
  content: string;
  sender: string;
  isSelf: boolean;
  mediaPath?: string;
  emojiUrl?: string;
  voiceDuration?: number;
  voiceText?: string;
}

type PersistedRecalled = Record<string, StoredMsg>;

const buffer = new Map<string, StoredMsg[]>();
let persistedCache: PersistedRecalled | null = null;
const PERSIST_PATH = path.resolve(process.cwd(), "data", "recalled.json");

function loadPersisted(): PersistedRecalled {
  if (persistedCache) return persistedCache;
  try {
    if (fs.existsSync(PERSIST_PATH)) {
      persistedCache = JSON.parse(fs.readFileSync(PERSIST_PATH, "utf-8"));
    }
  } catch { /* ignore */ }
  if (!persistedCache) persistedCache = {};
  return persistedCache;
}

function persistRecalled(talker: string, seq: number, msg: StoredMsg): void {
  const store = loadPersisted();
  const k = `${talker}::${seq}`;
  if (store[k]) return;
  store[k] = msg;
  const dir = path.dirname(PERSIST_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PERSIST_PATH, JSON.stringify(store), "utf-8");
}

function evict(): void {
  const cutoff = Date.now() - BUFFER_TTL_MS;
  for (const [k, msgs] of buffer) {
    const kept = msgs.filter(m => m.time > cutoff);
    if (kept.length === 0) {
      buffer.delete(k);
    } else if (kept.length < msgs.length) {
      buffer.set(k, kept);
    }
  }
}

export function saveMessages(talker: string, messages: Message[]): void {
  if (messages.length === 0) return;
  const existing = buffer.get(talker) || [];
  const existingSeqs = new Set(existing.map(m => m.seq));
  for (const m of messages) {
    if (m.type === 10000 || m.type === 10002) continue;
    if (existingSeqs.has(m.seq)) continue;
    existing.push({
      seq: m.seq,
      time: new Date(m.time).getTime(),
      type: m.type,
      content: m.content,
      sender: m.sender,
      isSelf: m.isSelf,
      mediaPath: m.mediaPath,
      emojiUrl: m.emojiUrl,
      voiceDuration: m.voiceDuration,
      voiceText: m.voiceText,
    });
  }
  buffer.set(talker, existing);
}

export function findRecalledMessage(
  talker: string,
  seq: number,
  revokeTime: string
): StoredMsg | null {
  const persistKey = `${talker}::${seq}`;
  const persisted = loadPersisted();
  if (persisted[persistKey]) return persisted[persistKey];

  evict();
  const msgs = buffer.get(talker);
  if (!msgs || msgs.length === 0) return null;

  const revokeTs = new Date(revokeTime).getTime();
  const cutoff = revokeTs - BUFFER_TTL_MS;

  let best: StoredMsg | null = null;
  let bestDist = Infinity;

  for (const m of msgs) {
    if (m.time < cutoff || m.time > revokeTs) continue;
    if (m.type === 10000 || m.type === 10002) continue;
    const dist = Math.abs(m.time - revokeTs);
    if (dist < bestDist) {
      bestDist = dist;
      best = m;
    }
  }

  if (best) {
    persistRecalled(talker, seq, best);
  }

  return best;
}

export async function saveAllBeforeRefresh(dataDir: string): Promise<void> {
  try {
    const { buildShardIndex } = await import("./manager.js");
    const shards = await buildShardIndex(dataDir);
    for (const shard of shards) {
      try {
        const db = await getConnection(shard.filePath);
        const tables = listMsgTables(db);
        const talkerReverse = new Map<string, string>();
        try {
          const n2i = db.exec("SELECT user_name FROM Name2Id");
          if (n2i.length > 0) {
            for (const r of n2i[0].values) {
              const name = String(r[0]);
              talkerReverse.set(`Msg_${md5(name)}`, name);
            }
          }
        } catch { /* ignore */ }

        for (const tableName of tables) {
          const talker = talkerReverse.get(tableName) || tableName;
          const cutoff = Math.floor((Date.now() - BUFFER_TTL_MS) / 1000);
          try {
            const rows = db.exec(
              `SELECT sort_seq, create_time, local_type, message_content, status FROM "${tableName}" WHERE create_time > ? ORDER BY create_time DESC LIMIT 200`,
              [cutoff]
            );
            if (rows.length === 0) continue;
            const existing = buffer.get(talker) || [];
            const existingSeqs = new Set(existing.map(m => m.seq));
            for (const r of rows[0].values) {
              const seq = Number(r[0]);
              if (existingSeqs.has(seq)) continue;
              const localType = Number(r[2]) & 0xFFFF;
              if (localType === 10000 || localType === 10002) continue;
              const status = Number(r[4]) || 0;
              let content = "";
              const raw = r[3];
              if (raw instanceof Uint8Array || Buffer.isBuffer(raw)) {
                try {
                  const { decodeMessageContent } = await import("./codec.js");
                  content = await decodeMessageContent(Buffer.from(raw));
                } catch { content = ""; }
              } else if (raw != null) {
                content = String(raw);
              }
              const isChatRoom = talker.endsWith("@chatroom");
              let sender = "";
              let isSelf = status === 2;
              if (isChatRoom && content) {
                const split = content.split(":\n", 2);
                if (split.length === 2) {
                  sender = split[0];
                  content = split[1];
                  isSelf = false;
                }
              }
              if (!sender) sender = talker;
              existing.push({
                seq,
                time: Number(r[1]) * 1000,
                type: localType,
                content,
                sender,
                isSelf,
              });
            }
            buffer.set(talker, existing);
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  evict();
}
