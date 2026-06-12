import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";

export interface Bookmark {
  id: string;
  talker: string;
  seq: number;
  time: string;
  sender: string;
  content: string;
  note: string;
  createdAt: string;
}

function getFilePath(): string {
  const config = getConfig();
  const dir = path.resolve(path.dirname(config.dataDir), "data");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "bookmarks.json");
}

function readAll(): Bookmark[] {
  const fp = getFilePath();
  if (!fs.existsSync(fp)) return [];
  try {
    return JSON.parse(fs.readFileSync(fp, "utf-8"));
  } catch {
    return [];
  }
}

function writeAll(bookmarks: Bookmark[]): void {
  fs.writeFileSync(getFilePath(), JSON.stringify(bookmarks, null, 2), "utf-8");
}

export function addBookmark(b: Omit<Bookmark, "id" | "createdAt">): Bookmark {
  const bookmarks = readAll();
  const entry: Bookmark = {
    ...b,
    id: `${b.talker}::${b.seq}`,
    createdAt: new Date().toISOString(),
  };
  if (bookmarks.some(x => x.id === entry.id)) return entry;
  bookmarks.unshift(entry);
  writeAll(bookmarks);
  return entry;
}

export function removeBookmark(id: string): boolean {
  const bookmarks = readAll();
  const idx = bookmarks.findIndex(x => x.id === id);
  if (idx === -1) return false;
  bookmarks.splice(idx, 1);
  writeAll(bookmarks);
  return true;
}

export function getBookmarks(talker?: string): Bookmark[] {
  const all = readAll();
  if (talker) return all.filter(b => b.talker === talker);
  return all;
}

export function isBookmarked(talker: string, seq: number): boolean {
  return readAll().some(b => b.talker === talker && b.seq === seq);
}
