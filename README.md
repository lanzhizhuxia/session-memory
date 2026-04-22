# session-memory

开发者的数据分身。从 AI 编码助手的对话历史中，持续提炼个人工作记忆。

## 它是什么

你每天和 AI 编码助手聊几十上百轮。这些对话里藏着大量高价值信息——技术决策的 why、踩过的坑、没做完的事、你的工作习惯。但它们散落在几万个 session 里，找不到、用不上、会遗忘。

session-memory 把这些对话变成 **8 个结构化的 markdown 文件**，构成你的数据分身。任何 AI 工具读取后即可理解你。

## 输出

```
~/.local/share/session-memory/
├── 工作画像.md          # 核心画像（角色/职责/关注领域）+ 交互风格 + 技术审美
├── 项目时间线.md        # 每个项目的发展脉络（AI 生成项目描述，跨源合并）
├── 本周重点.md          # 滚动窗口：进行中 / 已完成 / 关键决策
├── 未完成线索.md        # 跨项目未完成 todo 汇总
├── 决策日志.md          # AI 提取的技术/产品决策（含替代方案和理由）
├── 反复痛点.md          # AI 提取的反复出现的工程问题
├── 技术偏好.md          # 跨项目技术偏好（框架/工具/部署）
├── 工作模式.md          # 高频任务类型 + 时段分布 + 首条消息模式
├── .state/              # Canonical signal store（信号/证据/隔离区）
├── .last-extraction.json  # 增量提取 checkpoint
├── .noise-report.json     # 噪音过滤报告
└── cron.log               # 定时提取运行日志
```

## 架构

### Canonical Signal Pipeline

系统的核心是 **Canonical Signal Pipeline**——将 raw session 数据转化为结构化知识声明：

```
数据源 → 适配器 → 三层提取 → 候选信号 → 质量门 → 确定性合并 → 信号存储 → 视图编译 → Markdown
```

7 种信号类型：`tech_preference` / `work_style` / `profile_fact` / `decision` / `pain_point` / `timeline_event` / `open_thread`

### 三层提取

| 层 | 方法 | 成本 | 输出 |
|---|---|---|---|
| Layer 1 | 结构化查询（全量重建） | 零 | 项目时间线、未完成线索 |
| Layer 2 | 文本匹配 + 技术检测 | 极低 | 工作模式、技术偏好 |
| Layer 3 | AI 批量提取 + 合并 | 低 | 决策日志、反复痛点、工作画像 |

Layer 3 使用可配置模型提取（默认 anthropic/claude-haiku-4.5，可通过 config.yaml 覆盖为 gpt-5.4-mini 等；batch=30，峰值 90 并发），合并去重模型同样可配置。
工作画像的核心画像由 AI 语义提取器生成（一次调用，综合 memory + 决策 + 项目分布）。
项目描述由 AI batch 调用生成（render-time metadata，不存储）。

### 数据源

通过 **Source Adapter 架构**支持多个 AI 编码助手，按项目路径跨源合并：

| 数据源 | 格式 | 路径 |
|---|---|---|
| OpenCode | SQLite | `~/.local/share/opencode/opencode.db` |
| Claude Code | JSONL | `~/.claude/projects/` |

## 快速开始

```bash
npm install
cp config.example.yaml config.yaml
# 编辑 config.yaml，配置 layer3.api_key 和 layer3.api_base_url
npm run build
npm run extract
```

首次运行全量提取（~7 分钟，含 AI 调用）。后续增量运行 ~50 秒。

### 自动更新

已配置 cron 每 4 小时增量运行：

```bash
# 查看 cron
crontab -l

# 查看运行日志
tail -50 ~/.local/share/session-memory/cron.log

# 手动触发
npm run extract
```

## 谁来消费

| 消费者 | 接入方式 |
|---|---|
| OpenCode / Claude Code | CLAUDE.md 中 include 文件路径 |
| deep-daily-report | 读取 8 个 markdown 文件 |
| 其他 AI 工具 | 读取注入 system prompt / 知识库 |
| 你自己 | 直接打开 review |

## 文档

- [PRD](docs/PRD.md) — 产品需求文档
- [Canonical Signal Pipeline PRD](docs/PRD-canonical-signal-pipeline.md) — 信号管线架构设计（v0.2）
- [Output Quality Fixes PRD](docs/PRD-output-quality-fixes.md) — 输出质量修复（v0.2）
- [Memory Integration PRD](docs/PRD-memory-integration.md) — Memory 集成设计

## 项目结构

```
session-memory/
├── docs/                          # 文档
│   ├── PRD.md                     # 产品需求
│   ├── PRD-canonical-signal-pipeline.md  # 信号管线架构
│   ├── PRD-output-quality-fixes.md      # 输出质量修复
│   └── PRD-memory-integration.md        # Memory 集成
├── src/
│   ├── adapters/                  # 数据源适配器
│   │   ├── types.ts               # 统一中间类型
│   │   ├── interface.ts           # SourceAdapter 接口
│   │   ├── registry.ts            # 多源注册 + 项目合并
│   │   ├── opencode.ts            # OpenCode adapter (SQLite)
│   │   └── claude-code.ts         # Claude Code adapter (JSONL)
│   ├── canonical/                 # Canonical Signal Pipeline
│   │   ├── types.ts               # 信号/证据/视图类型
│   │   ├── quality-gate.ts        # 质量门（7 种信号规则）
│   │   ├── merge.ts               # 确定性合并引擎
│   │   ├── store.ts               # .state/ 文件存储
│   │   ├── relevance.ts           # 相关性分类器
│   │   ├── extractors/            # 信号候选提取器
│   │   │   ├── tech-preference.ts
│   │   │   ├── work-style.ts
│   │   │   ├── profile-fact.ts    # 含 AI 语义提取
│   │   │   ├── decision.ts        # 含 meta-commentary 过滤
│   │   │   ├── pain-point.ts
│   │   │   ├── timeline.ts
│   │   │   ├── open-thread.ts
│   │   │   └── project-summary.ts # AI 项目描述生成
│   │   └── views/                 # 视图编译器（thin compiler）
│   │       ├── tech-preferences.ts
│   │       ├── work-profile.ts
│   │       ├── decisions.ts
│   │       ├── pain-points.ts
│   │       ├── timeline.ts
│   │       ├── open-threads.ts
│   │       └── weekly-focus.ts
│   ├── extractors/                # 三层提取器
│   │   ├── layer1.ts              # 结构化（时间线 + todo，全量重建）
│   │   ├── layer2.ts              # 半结构化（工作模式 + 技术偏好）
│   │   └── layer3.ts              # 深度提取（AI batch + consolidation + retry）
│   ├── memory/                    # Memory adapter（CLAUDE.md / rules）
│   └── utils/                     # 工具函数
│       ├── noise-filter.ts        # 噪音 session 过滤
│       └── renderer.ts            # 遗留 Markdown 渲染
├── scripts/
│   ├── extract.ts                 # CLI 入口 + canonical pipeline 编排
│   └── cron-extract.sh            # 定时增量提取（crontab）
└── config.example.yaml            # 配置模板
```
