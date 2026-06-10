# WeChat CLI

微信 PC 数据库解密与查询工具，支持 MCP (Model Context Protocol) 服务和 Web UI。

通过内存扫描提取 SQLCipher 4 密钥，解密微信 V4 数据库，提供 REST API 和 MCP 工具接口，方便 AI 工具直接查询你的聊天记录。

## 功能特性

- **密钥提取** — 扫描 Weixin.exe 进程内存，自动提取 SQLCipher 4 加密密钥（基于 HMAC-SHA512 验证）
- **数据库解密** — 纯 Python AES-256-CBC 逐页解密，无需安装 sqlcipher
- **MCP Server** — 作为 AI 工具的 MCP 服务端，支持查询会话、消息、联系人
- **Web UI** — 内置中文 Web 界面，支持浏览聊天记录、通讯录、搜索、统计
- **REST API** — 完整的 HTTP API，方便二次开发
- **微信 V4 适配** — 支持 Weixin.exe (微信 4.x) 的新数据库格式

## 系统要求

- **OS**: Windows（密钥提取和解密仅支持 Windows）
- **Node.js**: >= 18
- **Python**: >= 3.8
- **微信**: PC 版 4.x（Weixin.exe）

## 快速开始

### 1. 安装依赖

```bash
# Node.js 依赖
npm install

# Python 依赖
pip install pycryptodome
```

### 2. 提取密钥 & 解密数据库

确保微信正在运行，然后执行：

```bash
# 提取密钥（扫描 Weixin.exe 进程内存，输出到 python/all_keys.json）
python python/extract_key_v3.py

# 解密所有数据库（输出到 decrypted/ 目录）
python python/decrypt_db_v2.py
```

也可以指定参数：

```bash
# 指定 DB 目录
python python/extract_key_v3.py "D:\xwechat_files\wxid_xxx\db_storage"

# 增量解密（仅解密有变更的数据库）
python python/decrypt_db_v2.py --incremental

# 解密单个数据库
python python/decrypt_db_v2.py --db contact/contact.db
```

### 3. 启动服务

```bash
# 开发模式 - Web UI（默认端口 5200）
npm run dev:web

# 开发模式 - MCP stdio
npm run dev

# 生产模式
npm run build
npm run start:web
```

### 4. 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `DATA_DIR` | 解密后的数据库目录 | `decrypted` |
| `PORT` | Web 服务端口 | `5200` |
| `PYTHON_PATH` | Python 可执行文件路径 | `python` |
| `WECHAT_DB_SRC_PATH` | 微信原始数据库目录 | 自动检测 |

## API 接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/status` | GET | 服务状态 |
| `/api/extract-key` | POST | 提取数据库密钥 |
| `/api/decrypt` | POST | 解密所有数据库 |
| `/api/sessions` | GET | 获取会话列表 |
| `/api/contacts` | GET | 获取联系人列表 |
| `/api/messages` | GET | 获取指定会话的消息 |
| `/api/search` | GET | 全局搜索消息 |

### 示例

```bash
# 获取会话列表
curl "http://localhost:5200/api/sessions?limit=10"

# 获取某个聊天的消息
curl "http://localhost:5200/api/messages?talker_id=wxid_xxx&limit=20"

# 搜索消息
curl "http://localhost:5200/api/search?keyword=关键词&limit=10"

# 获取联系人
curl "http://localhost:5200/api/contacts?keyword=张三"
```

## MCP 工具

本项目可作为 MCP Server 使用，提供以下工具给 AI 助手：

| 工具 | 说明 |
|------|------|
| `extract_db_key` | 从运行中的微信进程提取数据库密钥 |
| `decrypt_database` | 解密微信数据库 |
| `list_sessions` | 列出所有聊天会话 |
| `get_messages` | 获取指定会话的消息 |
| `search_messages` | 全局搜索消息 |
| `get_contacts` | 获取联系人列表 |

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
│   ├── extract_key_v3.py      # SQLCipher 4 密钥提取（内存扫描）
│   ├── decrypt_db_v2.py       # 数据库解密（AES-256-CBC）
│   └── requirements.txt       # Python 依赖
├── src/
│   ├── index.ts               # 入口：MCP / Web 双模式
│   ├── config.ts              # 配置管理
│   ├── db/
│   │   ├── manager.ts         # 数据库连接、分片索引
│   │   ├── strategy.ts        # V4 数据库文件识别
│   │   ├── models.ts          # 类型定义
│   │   ├── query-contacts.ts  # 联系人 & 会话查询
│   │   ├── query-messages.ts  # 消息查询 & 搜索
│   │   └── codec.ts           # Zstd 解码
│   ├── server/
│   │   └── api.ts             # Hono REST API
│   ├── tools/
│   │   └── handlers.ts        # MCP 工具处理
│   └── web/
│       └── index.html          # Web UI（中文 SPA）
├── package.json
├── tsconfig.json
└── LICENSE
```

## 技术原理

### 密钥提取

微信 V4 使用 SQLCipher 4 加密数据库，32 字节 raw key 缓存在 Weixin.exe 进程内存中，格式为 SQL 十六进制字面量 `x'<64hex_enc_key><32hex_salt>'`。

本工具扫描进程内存匹配该模式，并通过 SQLCipher 4 的 HMAC-SHA512 验证机制（PBKDF2-SHA512, iterations=2）确认密钥正确性。

### 数据库解密

采用纯 Python 实现的 AES-256-CBC 逐页解密：

- Page size: 4096 字节
- Reserve zone: 80 字节（IV 16 + HMAC 64）
- 每页独立 IV，位于 reserve zone 前 16 字节
- HMAC-SHA512 完整性校验

### V4 数据库结构

微信 V4 的消息表按对话分表，表名为 `Msg_<md5(username)>`，每张表存储一个对话的所有消息。

## 致谢

本项目的核心实现参考和借鉴了以下开源项目：

| 项目 | 说明 |
|------|------|
| [wechat-decrypt](https://github.com/ylytdeng/wechat-decrypt) | SQLCipher 4 密钥扫描与验证算法、AES-256-CBC 逐页解密逻辑 |
| [wx_key](https://github.com/ycccccccy/wx_key) | 微信 V4 内存 Hook 密钥提取方案、版本特征码 |
| [pywxdump](https://github.com/xaoyaoo/pywxdump) | 微信数据库解密工具，早期版本的参考 |

## 免责声明

本项目仅供学习和技术研究使用。请遵守相关法律法规，不要用于任何非法用途。使用本工具即表示你同意自行承担所有相关风险和责任。

## License

[MIT](LICENSE)
