# WeChat CLI

微信 PC V4 聊天记录工具，支持 MCP 服务器和 Web UI，用于提取、查询和可视化聊天数据。

## 功能特性

- **一键解密** — Web 向导引导完成密钥提取 + 数据库解密，无需手动操作
- **零 Python 依赖** — 密钥提取、数据库解密、图片解密全部使用 Node.js 原生实现（koffi + crypto）
- **MCP Server** — 作为 AI 工具的 MCP 服务端，支持查询会话、消息、联系人、统计等 14 个工具
- **Web UI** — 内置中文 Web 界面，支持聊天浏览、通讯录、全局搜索、数据统计
- **公众号支持** — 公众号/服务号会话聚合分组，文章应用内打开，图片防盗链代理
- **多媒体支持** — 图片(缩略图+原图)、视频流播放、表情三级 fallback、语音转文字
- **数据分析** — 全局统计仪表板 + 单会话统计面板(热力图/词云/成员排行/聊天画像)
- **导出** — 支持 JSON / TXT / HTML 格式导出聊天记录
- **防撤回** — 自动捕捉撤回消息，持久化存储，支持查看撤回原文
- **双主题** — 深色/浅色主题切换，响应式移动端适配

## 系统要求

- **操作系统**: Windows
- **Node.js**: >= 18
- **微信**: PC 版 4.x (Weixin.exe)
- **Python**（可选）: >= 3.10，仅 wxgf 原图转换需要（系统已安装 ffmpeg 则完全不需要）

## 快速开始

### 1. 克隆并安装

```bash
git clone https://gitee.com/wyler_admin/wechat-cli.git
cd wechat-cli
npm install
npm run build
```

无需安装 Python 或任何原生编译工具。所有核心功能（密钥提取、数据库解密、图片解密）均使用 Node.js 原生实现。

### 2. 启动 Web UI

```bash
npm run start:web
```

浏览器打开 `http://localhost:5200`，按向导操作：

1. **配置路径** — 设置微信数据库源路径（`db_storage` 目录）
2. **提取密钥** — 确保微信正在运行，点击按钮自动提取
3. **解密数据库** — 点击按钮解密所有数据库
4. **浏览数据** — 自动加载聊天记录

### 3. MCP 模式（供 AI 工具调用）

```bash
npm run build
npm start
```

在 Claude Desktop / Cursor 等 MCP 客户端中配置。

## API 接口

所有 `/api/*` 接口支持可选认证，设置环境变量 `AUTH_TOKEN` 后，请求需携带 HTTP Header `Authorization: Bearer <token>` 或 Query 参数 `?token=<token>`。未设置则无需认证。

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/health` | GET | 健康检查 |
| `/api/status` | GET | 服务状态与数据库信息 |
| `/api/refresh` | POST | 手动刷新数据 |
| `/api/extract-key` | POST | 提取数据库密钥 |
| `/api/decrypt` | POST | 解密所有数据库 |
| `/api/sessions` | GET | 会话列表（支持搜索） |
| `/api/contacts` | GET | 联系人列表 |
| `/api/messages` | GET | 指定会话的消息 |
| `/api/search` | GET | 全局搜索消息 |
| `/api/stats` | GET | 全局统计数据 |
| `/api/chat-stats` | GET | 单会话统计数据 |
| `/api/chatroom-members` | GET | 群聊成员列表 |
| `/api/image` | GET | 图片（缩略图/原图） |
| `/api/video` | GET | 视频文件 |
| `/api/export` | GET | 导出聊天记录 |

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `5200` | Web UI 端口 |
| `DATA_DIR` | `decrypted` | 解密后数据库目录 |
| `AUTH_TOKEN` | (空) | API 认证 token |
| `WECHAT_DB_SRC_PATH` | - | 微信数据库源路径 |
| `WECHAT_DB_KEY` | - | 数据库解密密钥 |
| `IMAGE_KEY` | - | 图片解密密钥 |
| `XOR_KEY` | - | 图片 XOR 密钥 |

## AI 功能配置

支持所有 **OpenAI 兼容接口**的大模型 API，包括 OpenAI、DeepSeek、智谱 GLM、通义千问、Kimi、豆包、Gemini、硅基流动、Ollama 等。

配置方式：Web UI 设置页 → AI 助手配置 → 选择提供商 → 填入 Key → 保存

启用后可使用 AI 对话摘要、情感分析、情感趋势图、AI 智能搜索等功能。

## MCP 工具

| 工具 | 说明 |
|------|------|
| `extract_db_key` | 从运行中的微信进程提取数据库密钥 |
| `decrypt_database` | 解密微信数据库 |
| `list_sessions` | 列出聊天会话 |
| `get_messages` | 获取指定会话的消息 |
| `search_messages` | 全局搜索消息 |
| `get_contacts` | 获取联系人列表 |
| `get_stats` | 获取全局统计数据 |
| `get_chat_stats` | 获取单会话统计数据 |
| `get_chatroom_members` | 获取群聊成员列表 |
| `export_chat` | 导出聊天记录 |

## 项目结构

```
wechat-cli/
├── python/                        # Python 脚本（仅 wxgf fallback 需要）
├── src/
│   ├── index.ts                    # 入口：MCP / Web 双模式
│   ├── config.ts                   # 配置管理
│   ├── db/                         # 数据库模块
│   │   ├── manager.ts              # 数据库连接、分片索引
│   │   ├── db-decrypt.ts           # Node.js 原生数据库解密
│   │   ├── key-extractor.ts        # Node.js 原生密钥提取
│   │   ├── query-contacts.ts       # 联系人查询
│   │   ├── query-messages.ts       # 消息查询
│   │   ├── stats.ts                # 统计数据
│   │   └── recall-store.ts         # 防撤回存储
│   ├── win/                        # Windows API
│   ├── server/                     # HTTP 服务
│   │   ├── api.ts                  # REST API
│   │   ├── image.ts                # 图片/视频处理
│   │   └── refresh.ts              # 数据刷新
│   ├── tools/                      # MCP 工具
│   └── web/                        # Web UI
├── .env.example                    # 环境变量示例
├── package.json
└── LICENSE
```

## 致谢

感谢以下开源项目提供的思路和启发：

- [wx_key](https://github.com/ycccccccy/wx_key) — 微信 V4 密钥提取方案
- [wechat-decrypt](https://github.com/ylytdeng/wechat-decrypt) — SQLCipher 4 解密思路参考
- [wetrace](https://github.com/afumu/wetrace) — Web UI 与数据分析思路参考

## 免责声明

本项目仅供学习和研究个人聊天数据使用。请确保仅解密和查看**自己的**数据，遵守相关法律法规，不要用于任何未经授权的访问。使用本工具即表示你同意自行承担所有相关风险和责任。

## License

[MIT](LICENSE)