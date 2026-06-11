import { describe, it, expect } from "vitest";
import {
  extractWords,
  extractAppMessage,
  getMediaTypeLabel,
  md5,
} from "../db/message-parser.js";

describe("extractWords", () => {
  it("should extract Chinese words", () => {
    const result = extractWords("今天天气真好");
    expect(result.length).toBeGreaterThan(0);
  });

  it("should filter stop words", () => {
    const result = extractWords("好的我知道了");
    expect(result).not.toContain("好");
    expect(result).not.toContain("的");
  });

  it("should filter pure numbers", () => {
    const result = extractWords("123 456");
    expect(result).toHaveLength(0);
  });

  it("should filter short segments", () => {
    const result = extractWords("a b c");
    expect(result).toHaveLength(0);
  });

  it("should return empty for empty input", () => {
    expect(extractWords("")).toHaveLength(0);
    expect(extractWords("   ")).toHaveLength(0);
  });
});

describe("extractAppMessage", () => {
  it("should extract title from app message", () => {
    const xml = '<appmsg><title>测试标题</title><type>5</type><url>http://example.com</url></appmsg>';
    const result = extractAppMessage(xml);
    expect(result.content).toBe("测试标题");
    expect(result.appType).toBe(5);
    expect(result.appUrl).toBe("http://example.com");
  });

  it("should handle refer message (type 57)", () => {
    const xml = '<appmsg><title>回复内容</title><type>57</type><refermsg><content>原始消息</content><displayname>张三</displayname></refermsg></appmsg>';
    const result = extractAppMessage(xml);
    expect(result.content).toContain("回复内容");
    expect(result.content).toContain("张三");
    expect(result.referContent).toBe("原始消息");
  });

  it("should handle file message (type 6)", () => {
    const xml = '<appmsg><title>文档.pdf</title><type>6</type><des>文件大小: 1MB</des></appmsg>';
    const result = extractAppMessage(xml);
    expect(result.content).toContain("[文件]");
    expect(result.content).toContain("文档.pdf");
  });

  it("should return raw content if no title match", () => {
    const result = extractAppMessage("plain text");
    expect(result.content).toBe("plain text");
  });
});

describe("getMediaTypeLabel", () => {
  it("should return correct labels", () => {
    expect(getMediaTypeLabel(3)).toBe("[图片]");
    expect(getMediaTypeLabel(34)).toBe("[语音]");
    expect(getMediaTypeLabel(43)).toBe("[视频]");
    expect(getMediaTypeLabel(47)).toBe("[表情]");
    expect(getMediaTypeLabel(49)).toBe("[文件]");
  });

  it("should return fallback for unknown types", () => {
    expect(getMediaTypeLabel(999)).toContain("消息类型");
  });
});

describe("md5", () => {
  it("should produce consistent MD5 hash", () => {
    const hash1 = md5("test_wxid");
    const hash2 = md5("test_wxid");
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(32);
    expect(hash1).toMatch(/^[0-9a-f]{32}$/);
  });

  it("should produce different hashes for different inputs", () => {
    expect(md5("a")).not.toBe(md5("b"));
  });
});
