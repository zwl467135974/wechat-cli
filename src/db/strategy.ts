export type GroupType =
  | "message"
  | "contact"
  | "image"
  | "video"
  | "file"
  | "voice"
  | "session"
  | "favorite";

export interface FileMeta {
  type: GroupType;
  index?: string;
}

const V4_PATTERNS: Array<{ type: GroupType; re: RegExp }> = [
  { type: "message", re: /^(biz_)?message(_[0-9]{1,2})?\.db$/i },
  { type: "contact", re: /^contact\.db$/i },
  { type: "session", re: /^session\.db$/i },
  { type: "image", re: /^hardlink\.db$/i },
  { type: "video", re: /^hardlink\.db$/i },
  { type: "file", re: /^hardlink\.db$/i },
  { type: "voice", re: /^media(_[0-9]{1,2})?\.db$/i },
  { type: "favorite", re: /^favorite\.db$/i },
];

export function identify(filename: string): FileMeta | null {
  for (const { type, re } of V4_PATTERNS) {
    const matches = re.exec(filename);
    if (matches) {
      const meta: FileMeta = { type };
      if (matches[1]) {
        meta.index = matches[1].replace(/^_/, "");
      }
      return meta;
    }
  }
  return null;
}

export const SUB_DIR_MAP: Record<string, string> = {
  message: "message",
  contact: "contact",
  session: "session",
  image: "hardlink",
  video: "hardlink",
  file: "hardlink",
  voice: "media",
  favorite: "favorite",
};
