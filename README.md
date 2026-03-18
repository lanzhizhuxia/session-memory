# session-memory

开发者的数据分身。从 AI 编码助手的对话历史中，持续提炼个人工作记忆。

## 它是什么

你每天和 AI 编码助手聊几十上百轮。这些对话里藏着大量高价值信息——技术决策的 why、踩过的坑、没做完的事、你的工作习惯。但它们散落在几万个 session 里，找不到、用不上、会遗忘。

session-memory 把这些对话变成 **7 个结构化的 markdown 文件**，构成你的数据分身。任何 AI 工具读取后即可理解你。

## 输出

```
~/.local/share/session-memory/
├── project-timeline.md      # 每个项目的发展脉络
├── open-threads.md           # 跨项目未完成线索
├── work-patterns.md          # 高频工作模式
├── tech-preferences.md       # 技术偏好图谱
├── decisions.md              # 决策考古日志
├── pain-points.md            # 反复痛点模式库
├── work-profile.md           # 个人工作画像
└── .last-extraction.json     # 增量提取元数据
```

## 谁来消费

这些文件是通用的。任何需要了解你的 AI 工具都可以接入：

| 消费者 | 接入方式 |
|---|---|
| OpenCode / Claude Code | CLAUDE.md 中 include 文件路径 |
| aibuddy | 读取注入 workspace 知识库上下文 |
| openclaw | system prompt 注入 |
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
| Layer 1 | adapter 查询 | 零 | project-timeline, open-threads |
| Layer 2 | adapter + 文本匹配 | 极低 | work-patterns, tech-preferences |
| Layer 3 | AI 批量摘要 | 低（Haiku/Flash） | decisions, pain-points, work-profile |

## 快速开始

```bash
# TODO: Phase 0 实现后补充
```

## 文档

- [PRD](docs/PRD.md) — 产品需求文档

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
│   │   ├── layer1.ts         # 结构化提取
│   │   ├── layer2.ts         # 半结构化提取
│   │   └── layer3.ts         # 深度提取（AI 摘要）
│   └── utils/                # 工具函数
│       ├── noise-filter.ts   # 噪音 session 过滤
│       └── renderer.ts       # Markdown 渲染
├── output/                   # 本地开发输出（gitignore）
├── scripts/                  # 运行脚本
│   └── extract.ts            # CLI 入口
└── config.example.yaml       # 配置模板
```
