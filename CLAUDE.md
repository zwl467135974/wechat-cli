# CLAUDE.md — 项目指引

## 语言要求

- **所有回答必须使用中文**，包括解释、分析、建议、错误信息等
- **思考过程也必须使用中文**
- 代码中的变量名、函数名可以使用英文，但注释、文档、面向用户的文本一律使用中文

## 项目概述

微信 PC V4 聊天记录工具，支持 MCP 服务器和 Web UI，用于提取/解密/查询/可视化聊天数据。

## 技术栈

- TypeScript (Node.js v22.14.0) + Python 3.14.2
- MCP SDK: `@modelcontextprotocol/sdk` v1.29.0
- 数据库: `sql.js` (WASM)，HTTP: `hono`，Zstd: `zstd-codec`
- 测试: Vitest
- 前端: 单文件 SPA，无构建步骤 (`src/web/index.html` + `src/web/assets/style.css`)

## 约束

- 仅支持微信 V4 (Weixin.exe 4.1.9.62)
- 不使用需要原生编译的 npm 包
- `package.json` `"type": "module"` — debug 脚本用 `.cjs` 扩展名
- 开源项目 (MIT License)

## 构建与运行

```bash
npm run build    # TypeScript 编译 (tsc)
npm start        # 启动 Web UI (端口 5200)
npm run dev      # 启动 MCP 模式
```

测试端口可用 5201/5202/5203，主服务 PID 可能需要用户手动关闭。

## 关键目录

- `src/` — TypeScript 源码
  - `db/` — 数据库层 (manager, query-contacts, query-messages, query-search, stats, message-parser, codec, models, recall-store)
  - `server/` — HTTP 服务 (api, image, refresh)
  - `python/` — Python 调用层 (runner)
  - `tools/` — MCP 工具定义
  - `web/` — 前端 SPA (index.html, assets/style.css)
- `python/` — Python 工具 (密钥提取、数据库解密、图片解密)
- `decrypted/` — 解密后的数据库文件 (运行时生成)
- `data/` — 运行时数据 (recalled.json 持久化撤回消息，已在 .gitignore)

## 编码规范

- 不添加注释，除非用户要求
- 遵循现有代码风格和命名约定
- 优先编辑现有文件，避免创建新文件
- 完成任务后运行 `npm run build` 确保编译通过

## 重要上下文

- 图片缩略图 (`_t.dat`) 是 JPEG，原图 (`.dat`) 解密后是 wxgf 格式，浏览器无法渲染
- 表情包三级 fallback: `cdnurl` → `thumburl` → `md5` (本地) → `[表情]`
- 视频文件无加密，纯 MP4
- 自发表情本地文件加密方式未知，目前无法解密
- talker 与表名映射: `Msg_<md5(talker_wxid)>`
- 防撤回: 内存缓冲区 5 分钟 TTL + `data/recalled.json` 持久化，按 `talker::seq` 索引
- 手动刷新: `POST /api/refresh`，刷新逻辑在 `src/server/refresh.ts`，前端 header 有刷新按钮
- 自动刷新默认 60s，调用 `doRefresh()` 与手动刷新共用同一逻辑
- API 认证可选: `AUTH_TOKEN` 环境变量，空则跳过
- Python `--args` 协议: Node 传 `--args '{"key":"val"}'`，Python 用 `argparse` + `json.loads` 解析
- 消息表列名: `sort_seq, create_time, local_type, message_content, compress_content, status, source, packed_info_data`；`status=2` 为自发
- 群聊消息: `message_content` = `wxid_xxx:\n实际内容`
