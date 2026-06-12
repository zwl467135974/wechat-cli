# WeChat CLI

微信 PC V4 聊天记录工具，支持 MCP 服务器和 Web UI，用于提取、查询和可视化聊天数据。

## 功能特性

- **一键解密** — Web 向导引导完成密钥提取 + 数据库解密，无需手动操作
- **MCP Server** — 作为 AI 工具的 MCP 服务端，支持查询会话、消息、联系人、统计等 10 个工具
- **Web UI** — 内置中文 Web 界面，支持聊天浏览、通讯录、全局搜索、数据统计
- **多媒体支持** — 图片(缩略图+原图)、视频流播放、表情三级 fallback、语音转文字
- **数据分析** — 全局统计仪表板 + 单会话统计面板(热力图/词云/成员排行/聊天画像)
- **导出** — 支持 JSON / TXT / HTML 格式导出聊天记录
- **防撤回** — 自动捕捉撤回消息，持久化存储，支持查看撤回原文
- **双主题** — 深色/浅色主题切换，响应式移动端适配

## 系统要求

- **OS**: Windows
- **Node.js**: >= 18
- **Python**: >= 3.10
- **微信**: PC 版 4.x (Weixin.exe)

## 快速开始

### 1. 安装依赖

```bash
npm install

pip install pycryptodome pillow-heif Pillow av
```

### 2. 启动 Web UI

```bash
npm start
```

浏览器打开 `http://localhost:5200`，按向导操作：

1. **提取密钥** — 确保微信正在运行，点击按钮自动提取
2. **解密数据库** — 点击按钮解密所有数据库
3. **浏览数据** — 自动加载聊天记录

### 3. 其他启动方式

```bash
# MCP 模式（供 AI 工具调用）
npm run dev

# 构建
npm run build
```

## API 接口

所有 `/api/*` 接口支持可选认证，设置环境变量 `AUTH_TOKEN` 后，请求需携带：
- HTTP Header: `Authorization: Bearer <token>`
- 或 Query 参数: `?token=<token>`

未设置 `AUTH_TOKEN` 则无需认证。

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/health` | GET | 健康检查 |
| `/api/status` | GET | 服务状态与数据库信息 |
| `/api/last-refresh` | GET | 上次刷新时间 |
| `/api/refresh` | POST | 手动刷新数据（重新解密数据库） |
| `/api/extract-key` | POST | 提取数据库密钥 |
| `/api/decrypt` | POST | 解密所有数据库 |
| `/api/save-config` | POST | 保存配置 |
| `/api/sessions` | GET | 会话列表（支持搜索） |
| `/api/contacts` | GET | 联系人列表 |
| `/api/messages` | GET | 指定会话的消息（支持分页、搜索、时间范围） |
| `/api/search` | GET | 全局搜索消息 |
| `/api/stats` | GET | 全局统计数据（缓存 5 分钟） |
| `/api/chat-stats` | GET | 单会话统计数据（含成员排行、热力图、词云） |
| `/api/chatroom-members` | GET | 群聊成员列表 |
| `/api/image` | GET | 图片（缩略图/原图，自动解密 wxgf 格式） |
| `/api/emoji` | GET | 表情图片 |
| `/api/video` | GET | 视频文件（Range 流式） |
| `/api/file` | GET | 通用文件下载 |
| `/api/export` | GET | 导出聊天记录（json/txt/html） |
| `/api/image-key` | GET | 图片密钥状态 |
| `/api/scan-image-key` | POST | 扫描图片解密密钥 |

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `5200` | Web UI 端口 |
| `DATA_DIR` | `decrypted` | 解密后数据库目录 |
| `PYTHON_PATH` | `python` | Python 可执行文件路径 |
| `AUTO_REFRESH_MS` | `60000` | 自动刷新间隔（毫秒），0 禁用 |
| `AUTH_TOKEN` | (空) | API 认证 token，空则跳过认证 |
| `WECHAT_DB_SRC_PATH` | - | 微信数据库源路径 |
| `WECHAT_DB_KEY` | - | 数据库解密密钥 |
| `WECHAT_PATH` | - | 微信安装路径 |
| `WECHAT_DATA_PATH` | - | 微信数据目录 |
| `IMAGE_KEY` | - | 图片解密密钥 |
| `XOR_KEY` | - | 图片 XOR 密钥 |

以上配置也可通过 Web UI 设置页保存到 `.env` 文件。

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

在 Claude Desktop 等 MCP 客户端中配置：

```json
{
  "mcpServers": {
    "wechat-cli": {
      "command": "node",
      "args": ["path/to/wechat-cli/dist/index.js"]
    }
  }
}
```

## 项目结构

```
wechat-cli/
├── python/
│   ├── extract_key_v3.py      # 密钥提取
│   ├── decrypt_db_v2.py       # 数据库解密
│   ├── decrypt_image.py       # 图片解密 & 密钥扫描
│   ├── convert_wxgf.py        # wxgf(HEVC)转JPEG
│   └── image_key.txt          # 图片密钥(运行时生成)
├── src/
│   ├── index.ts               # 入口：MCP / Web 双模式
│   ├── config.ts              # 配置管理(.env 持久化)
│   ├── db/
│   │   ├── manager.ts         # 数据库连接、分片索引
│   │   ├── models.ts          # 类型定义
│   │   ├── codec.ts           # Zstd 解码
│   │   ├── query-contacts.ts  # 联系人 & 会话 & 群成员查询
│   │   ├── query-messages.ts  # 消息查询 & 搜索
│   │   ├── query-search.ts    # 全局搜索
│   │   ├── stats.ts           # 统计数据
│   │   ├── message-parser.ts  # 消息解析 & 分词
│   │   └── recall-store.ts    # 防撤回：内存缓冲 + 持久化
│   ├── server/
│   │   ├── api.ts             # Hono REST API
│   │   ├── image.ts           # 图片/视频解析 & wxgf 转换
│   │   └── refresh.ts         # 数据刷新逻辑
│   ├── python/
│   │   └── runner.ts          # Python 调用封装
│   ├── tools/
│   │   └── handlers.ts        # MCP 工具处理
│   └── web/
│       ├── index.html          # Web UI (中文 SPA)
│       └── assets/style.css    # 样式
├── CLAUDE.md                   # 项目指引
├── package.json
├── tsconfig.json
└── LICENSE
```

## 致谢

感谢以下开源项目提供的思路和启发：

| 项目 | 许可证 | 说明 |
|------|--------|------|
| [wx_key](https://github.com/ycccccccy/wx_key) | MIT | 微信 V4 密钥提取方案 |
| [wechat-decrypt](https://github.com/ylytdeng/wechat-decrypt) | - | SQLCipher 4 解密思路参考 |
| [wetrace](https://github.com/afumu/wetrace) | CC BY-NC-SA 4.0 | Web UI 与数据分析思路参考 |
| pywxdump (xaoyaoo) | - | 早期版本数据库结构参考 |

## 免责声明

本项目仅供学习和研究个人聊天数据使用。请确保仅解密和查看**自己的**数据，遵守相关法律法规，不要用于任何未经授权的访问。使用本工具即表示你同意自行承担所有相关风险和责任。

## License

[MIT](LICENSE)
