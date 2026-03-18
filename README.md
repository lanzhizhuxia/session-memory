# session-memory

开发者的数据分身。从 AI 编码助手的对话历史中，持续提炼个人工作记忆。

## 它是什么

你每天和 AI 编码助手聊几十上百轮。这些对话里藏着大量高价值信息——技术决策的 why、踩过的坑、没做完的事、你的工作习惯。但它们散落在几万个 session 里，找不到、用不上、会遗忘。

session-memory 把这些对话变成 **7 个结构化的 markdown 文件**，构成你的数据分身。任何 AI 工具读取后即可理解你。

## 输出

```
~/.local/share/session-memory/
├── 项目时间线.md        # 每个项目的发展脉络（跨源合并，按日期分组）
├── 未完成线索.md        # 跨项目未完成 todo 汇总
├── 工作模式.md          # 高频任务类型 + 时段分布 + 首条消息模式
├── 技术偏好.md          # 跨项目技术关键词提取
├── 决策日志.md          # AI 提取的技术/产品决策（含替代方案和理由）
├── 反复痛点.md          # AI 提取的反复出现的工程问题
├── 工作画像.md          # AI 综合的个人工作画像
├── .last-extraction.json  # 增量提取元数据
└── .noise-report.json     # 噪音过滤报告
```

## 谁来消费

这些文件是通用的。任何需要了解你的 AI 工具都可以接入：

| 消费者 | 接入方式 |
|---|---|
| OpenCode / Claude Code | CLAUDE.md 中 include 文件路径 |
| 你的其他 AI 工具 | 读取注入知识库上下文 / system prompt |
| 你自己 | 直接打开 review |

## 数据源

通过 **Source Adapter 架构**支持多个 AI 编码助手，按项目路径跨源合并：

| 数据源 | 格式 | 路径 |
|---|---|---|
| OpenCode | SQLite | `~/.local/share/opencode/opencode.db` |
| Claude Code | JSONL | `~/.claude/projects/` |

未来可扩展其他数据源（Cursor 等），只需实现 `SourceAdapter` 接口。

## 三层提取

| 层 | 方法 | 成本 | 输出 |
|---|---|---|---|
| Layer 1 | adapter 查询 | 零 | 项目时间线、未完成线索 |
| Layer 2 | adapter + 文本匹配 | 极低 | 工作模式、技术偏好 |
| Layer 3 | AI 批量摘要 + 精炼 | 低（Haiku 提取 + Sonnet 精炼） | 决策日志、反复痛点、工作画像 |

## 快速开始

```bash
# 安装依赖
npm install

# 创建配置文件
cp config.example.yaml config.yaml
# 编辑 config.yaml，配置数据源路径和 Layer 3 API key

# 构建
npm run build

# 运行提取
npm run extract
```

首次运行会全量提取，后续运行自动增量。Layer 3 需要设置 `ANTHROPIC_API_KEY` 环境变量或在 config.yaml 中配置 `layer3.api_key`。

## 文档

- [PRD](docs/PRD.md) — 产品需求文档（v0.6，完整设计规格）

## 项目结构

```
session-memory/
├── docs/                     # 文档
│   └── PRD.md                # 产品需求
├── src/
│   ├── adapters/             # 数据源适配器
│   │   ├── types.ts          # 统一中间类型定义
│   │   ├── interface.ts      # SourceAdapter 接口
│   │   ├── registry.ts       # 多源注册 + 项目合并
│   │   ├── opencode.ts       # OpenCode adapter (SQLite)
│   │   └── claude-code.ts    # Claude Code adapter (JSONL)
│   ├── extractors/           # 三层提取器
│   │   ├── layer1.ts         # 结构化提取（时间线 + todo）
│   │   ├── layer2.ts         # 半结构化提取（工作模式 + 技术偏好）
│   │   └── layer3.ts         # 深度提取（AI 摘要 + 精炼）
│   └── utils/                # 工具函数
│       ├── noise-filter.ts   # 噪音 session 过滤
│       └── renderer.ts       # Markdown 渲染
├── scripts/                  # 运行脚本
│   └── extract.ts            # CLI 入口
└── config.example.yaml       # 配置模板
```
