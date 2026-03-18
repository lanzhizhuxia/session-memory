# PRD: Session Memory — 开发者的数据分身

Date: 2026-03-19
Version: v0.6
Status: Draft

---

## 0. 一句话

> 从 AI 编码助手的对话历史中，持续提炼个人工作记忆——决策脉络、工作习惯、技术偏好、未竟之事。输出为 7 个 markdown 文件，构成**开发者的数据分身**：任何 AI 工具读取后即可理解你。

## 0.5 定位

session-memory 是一个**独立项目**。它通过 **Source Adapter 架构**从多个 AI 编码助手（OpenCode、Claude Code 等）的对话历史中提取价值，输出为标准 markdown 文件。

**这 7 个 markdown 文件本身就是产品**——一个持续生长的个人知识体。不是报告，不是日志，而是你的数据分身。

**消费者是任何需要了解你的 AI 工具**：

| 消费者 | 接入方式 | 说明 |
|---|---|---|
| OpenCode / Claude Code | CLAUDE.md 中 include 文件路径 | 每个 session 自动加载你的画像 |
| aibuddy | 读取注入 workspace 知识库上下文 | PM 的外脑直接理解你 |
| openclaw | system prompt 注入 | 法律助手知道你的技术偏好和决策风格 |
| 你自己 | 直接打开 review | 周五回顾、季度总结、新人 onboarding |

**与 aibuddy / openclaw 的关系**：平级。session-memory 产出数据，它们消费数据。

---

## 1. 问题

### 1.1 现状

开发者每天与 AI 编码助手进行大量对话（OpenCode 累计 ~36K sessions、~172K messages、跨 12 个项目）。这些对话中沉淀了大量高价值信息：

- 为什么选 SQLite 而不是 Postgres？
- 为什么从心跳 v2 升级到 v3？
- 这个 bug 上次怎么修的？
- 哪些事情说了要做但一直没做？

### 1.2 问题

| # | 问题 | 影响 |
|---|---|---|
| 1 | **对话历史散落无序** | 36K sessions 没有任何组织结构，想找某个决策要翻很久 |
| 2 | **价值随时间衰减** | 三个月前为什么做某个选择，现在已经想不起来了 |
| 3 | **跨项目经验无法复用** | 在 A 项目踩过的坑，在 B 项目又踩一遍 |
| 4 | **AI 不了解你** | 每次新 session 都从零开始，不知道你的偏好和习惯 |
| 5 | **未完成的线索被遗忘** | 250 个 pending + 91 个 in_progress 的 todo 散落在各项目 |

### 1.3 使用场景

| 场景 | 触发 | 消费文件 | 效果 |
|---|---|---|---|
| **AI 冷启动消除** | 新开 session 开发 aibuddy | work-profile.md + tech-preferences.md | AI 自动理解你的偏好，不再问"你想用什么 ORM" |
| **决策追溯** | "上次为什么不用 Postgres？" | decisions.md | 直接定位到决策记录和 session 来源 |
| **新项目冷启动** | 启动一个新项目 | tech-preferences.md | 技术选型不用再解释一遍 |
| **周五回顾** | 每周五下午 | open-threads.md | 清理过期 todo，不遗忘承诺 |
| **跨项目学习** | B 项目遇到类似问题 | pain-points.md | A 项目踩过的坑直接复用解法 |
| **季度汇报** | 需要回顾做了什么 | project-timeline.md | 每个项目的时间线一目了然 |

### 1.4 期望

将对话历史从"一堆聊天记录"变成"结构化的个人工作记忆"：

1. **可查** — 按项目、按维度组织，快速定位
2. **可用** — 输出格式可直接注入 AI 系统提示（CLAUDE.md / system prompt）
3. **可积累** — 定期增量更新，记忆越来越完整

---

## 2. 数据源

session-memory 采用**多数据源架构**。每个 AI 编码助手是一个独立数据源，通过 Source Adapter 统一接入。Phase 0 支持 OpenCode 和 Claude Code，未来可扩展。

### 2.1 数据源总览

| 数据源 | 存储格式 | 路径 | 状态 |
|---|---|---|---|
| **OpenCode** | SQLite (WAL mode) | `~/.local/share/opencode/opencode.db` | Phase 0 |
| **Claude Code** | 文件系统 (JSONL) | `~/.claude/projects/` | Phase 0 |
| *其他* | *待定* | *待定* | *未来扩展* |

### 2.2 OpenCode 数据格式

**存储**：SQLite 单文件（2.4 GB，WAL mode，Drizzle ORM）

**核心表结构**：

```
project
├── id (text, PK, worktree path hash)
├── worktree (text)          -- git 工作目录路径
├── name (text)              -- 项目名
├── time_created (integer)   -- unix timestamp (ms)
└── time_updated (integer)

session
├── id (text, PK)
├── project_id (text, FK → project)
├── parent_id (text)         -- 压缩后的父 session
├── title (text)             -- 会话标题（AI 生成）
├── summary_additions (integer)  -- 代码变更统计
├── summary_deletions (integer)
├── summary_files (integer)
├── time_created (integer)
└── time_archived (integer)

message
├── id (text, PK)
├── session_id (text, FK → session, CASCADE)
├── data (JSON)              -- { role: "user"|"assistant", ... }
├── time_created (integer)
└── time_updated (integer)

part                          -- ⚠️ 消息文本内容在此表，不在 message.data
├── id (text, PK)
├── message_id (text, FK → message, CASCADE)
├── session_id (text)
├── data (JSON)              -- 实际的文本内容
├── time_created (integer)
└── time_updated (integer)

todo
├── session_id (text, FK)
├── position (integer)
├── content (text)
├── status (text)            -- pending | in_progress | completed | cancelled
└── priority (text)
```

**索引**：`part_session_idx`, `session_project_idx`, `message_session_time_created_id_idx`, `part_message_id_id_idx`

### 2.3 Claude Code 数据格式

**存储**：纯文件系统，每个 session 一个 JSONL 文件。无数据库。

**目录结构**：

```
~/.claude/
├── history.jsonl                    # 全局 prompt 索引（append-only，永不删除）
├── projects/                        # 按项目组织的 session 数据
│   ├── -Users-you-project-alpha/    # 项目路径编码（/ → -）
│   │   ├── <uuid-1>.jsonl           # 完整 session 对话记录
│   │   ├── <uuid-2>.jsonl
│   │   ├── sessions-index.json      # session 元数据索引（⚠️ 常不可靠）
│   │   └── memory/
│   │       └── MEMORY.md            # 项目级自动记忆
│   └── -Users-you-project-beta/
│       └── ...
└── todos/                           # 按 session 的 todo 持久化 JSON
```

**Session JSONL 事件类型**：

```jsonc
// session_start — 会话开始
{ "type": "session_start", "sessionId": "uuid", "parentSessionId": null, "timestamp": "2026-03-20T10:00:00Z", "project": "/Users/you/project-alpha" }

// message — 用户/助手消息
{ "type": "message", "role": "user", "content": "Fix the auth bug", "timestamp": "...", "sessionId": "uuid" }

// message — 助手消息（可含 tool_use 块）
{ "type": "message", "role": "assistant", "content": [{"type": "text", "text": "..."}, {"type": "tool_use", "id": "tu_1", "name": "Read", "input": {...}}], "timestamp": "...", "sessionId": "uuid" }

// tool_result — 工具执行结果
{ "type": "tool_result", "toolUseId": "tu_1", "content": "...", "durationMs": 340, "timestamp": "..." }

// session_end — 会话结束（含 token/cost 统计）
{ "type": "session_end", "sessionId": "uuid", "durationMs": 2740000, "tokenCount": 84200, "cost": 0.43, "timestamp": "..." }
```

**关键差异对照**：

| 维度 | OpenCode | Claude Code |
|---|---|---|
| 存储引擎 | SQLite 单文件 | 文件系统 JSONL |
| Session 发现 | SQL 查询 `session` 表 | glob `~/.claude/projects/**/*.jsonl` |
| 消息结构 | `message` + `part` 两表 JOIN | JSONL 行，`type: "message"` 事件 |
| 项目关联 | `project_id` FK | 目录名 = 路径编码 |
| Session 标题 | `session.title`（AI 生成） | `sessions-index.json` 中的 `summary`（不可靠，需 fallback 到首条消息） |
| 代码变更统计 | `summary_additions/deletions/files` | 无原生字段（可从 tool_use 事件推断） |
| Todo | `todo` 表 | `~/.claude/todos/<session>.json` |
| 时间戳格式 | Unix ms (integer) | ISO 8601 (string) |
| Session 元数据索引 | 数据库即索引 | `sessions-index.json`（⚠️ 常 stale/缺失，不作为 source of truth） |

**Claude Code Adapter Fallback 策略**：

Claude Code 的数据完整性不如 SQLite——用户可能强制退出、crash、或 index 文件 stale。adapter 需要定义降级行为：

| 字段 | 主要来源 | Fallback | 兜底值 |
|---|---|---|---|
| `title` | `sessions-index.json` → `summary` | 首条用户消息截断 80 字符 | `"(untitled session)"` |
| `duration` | `session_end.durationMs` | `last_msg.timestamp - first_msg.timestamp` | `null`（该 session 不参与时长统计） |
| `messageCount` | 计数 JSONL 中 `type: "message"` 行 | — | 0（空 session） |
| `codeChurn` | 无原生字段 | 可选：从 `tool_use` 事件中统计文件操作 | `undefined`（跳过 churn 相关规则） |
| `timeCreated` | `session_start.timestamp` | JSONL 文件第一行的 `timestamp` | JSONL 文件的 `mtime` |
| `timeEnd` | `session_end.timestamp` | JSONL 文件最后一行的 `timestamp` | `null` |
| `project path` | `session_start.project` | 从目录名反向解码（`-` → `/`） | 目录名原样 |

### 2.4 Source Adapter 抽象层

提取器不直接访问任何数据源的原始格式，而是通过统一的 **Source Adapter 接口**操作：

```
┌─────────────┐   ┌─────────────┐   ┌─────────────┐
│  OpenCode   │   │ Claude Code │   │  Future X   │
│  (SQLite)   │   │  (JSONL)    │   │  (???)      │
└──────┬──────┘   └──────┬──────┘   └──────┬──────┘
       │                 │                  │
       ▼                 ▼                  ▼
┌─────────────────────────────────────────────────┐
│            Source Adapter Interface              │
│                                                 │
│  getProjects(): Project[]                       │
│  getSessions(projectId): Session[]              │
│  getMessages(sessionId): Message[]              │
│  getTodos(): Todo[]                             │
│  getNoiseSignals(projectId): NoiseSignals       │
└──────────────────────┬─────────────────────────┘
                       │  统一中间表示
                       ▼
         ┌──────────────────────────┐
         │  Layer 1 / 2 / 3 提取器  │
         │  (不关心数据来源)         │
         └──────────────────────────┘
```

#### 2.4.1 统一中间类型

```typescript
interface Project {
  id: string              // 内部唯一标识
  name: string            // 项目名（目录名）
  path: string            // git 工作目录绝对路径（用于跨源合并）
  source: string          // 'opencode' | 'claude-code' | ...
  timeCreated: number     // Unix ms
}

interface Session {
  id: string
  projectId: string
  source: string
  title?: string          // OpenCode 直接取；Claude Code 从 index 或首条消息 fallback
  parentId?: string
  messageCount: number
  codeChurn?: {           // OpenCode 有原生数据；Claude Code 可选从 tool_use 推断
    additions: number
    deletions: number
    files: number
  }
  timeCreated: number     // 统一为 Unix ms
  timeEnd?: number
}

interface Message {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  content: string         // 纯文本；tool_use/tool_result 折叠或过滤
  timeCreated: number     // 统一为 Unix ms
}

interface Todo {
  sessionId: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  priority?: string
  source: string
  timeCreated?: number   // Unix ms。OC: 所属 session 的 time_created；CC: todo JSON 文件 mtime 或关联 session 时间戳
}

interface NoiseSignals {
  projectId: string
  hourDistribution: number[]     // 24 个时段的 session 数
  uniqueFirstMessageRatio: number
  medianSessionDurationMs: number
  sessionSharePercent: number    // 该项目 session 数 / 该源总 session 数
  userMessageRatio: number
}
```

#### 2.4.2 Adapter 接口

```typescript
interface SourceAdapter {
  readonly name: string   // 'opencode' | 'claude-code' | ...

  /** 检测数据源是否存在且可用 */
  detect(): Promise<boolean>

  /** 获取所有项目 */
  getProjects(): Promise<Project[]>

  /** 获取项目下所有 session（支持增量：since 为 Unix ms） */
  getSessions(projectId: string, since?: number): Promise<Session[]>

  /** 获取 session 下所有消息 */
  getMessages(sessionId: string): Promise<Message[]>

  /** 获取所有未完成 todo */
  getTodos(): Promise<Todo[]>

  /** 获取噪音检测所需的统计信号 */
  getNoiseSignals(projectId: string): Promise<NoiseSignals>
}
```

每个数据源实现此接口。提取器只调用接口方法，不感知底层格式。

**实现建议**：adapter 应在首次调用 `getProjects()` / `getSessions()` 时内部缓存结果到内存映射表（`Map<sessionId, Session>`），供后续 Layer 渲染 markdown 时按 session_id 快速查找标题和时间戳（来源标注需要）。缓存生命周期 = 单次 extract 运行。

#### 2.4.3 项目合并策略

同一个项目可能在多个数据源中都有 session（比如用 OpenCode 和 Claude Code 交替开发同一项目）。

**合并规则**：以 **worktree 绝对路径** 为主键，跨源合并到同一逻辑项目。

```
OpenCode project (worktree: /Users/you/aibuddy)  ──┐
                                                    ├──→  逻辑项目 "aibuddy"
Claude Code project (path: /Users/you/aibuddy)   ──┘     ├── timeline: 按时间混排，标注来源
                                                          ├── todos: 合并去重
                                                          └── sessions: 保留各自 ID + source 标记
```

**输出标注**：合并后的 markdown 中，每条记录标注来源以便追溯：

```markdown
### 2026-03-18
- [OC] 建立知识库模块框架 (+450/-20, 8 files)
- [CC] 重构 API 路由结构
- [OC] 首次 workspace 创建流程 (+200/-0, 3 files)
```

`[OC]` = OpenCode, `[CC]` = Claude Code。用户可在配置中自定义标签。

#### 2.4.4 配置

```yaml
# config.yaml
sources:
  opencode:
    enabled: true
    db_path: "~/.local/share/opencode/opencode.db"    # 可覆盖默认路径

  claude_code:
    enabled: true
    base_dir: "~/.claude"                              # 可覆盖默认路径

  # 未来扩展示例
  # cursor:
  #   enabled: false
  #   db_path: "~/Library/Application Support/Cursor/..."

# 来源标签（用于输出 markdown 中的标注）
source_labels:
  opencode: "OC"
  claude_code: "CC"
```

### 2.5 数据规模（示例：当前实例）

#### OpenCode

| 维度 | 数量 |
|---|---|
| 项目 | 12 |
| 会话 | 36,297 |
| 消息 | 171,922（assistant 125,586 + user 46,351） |
| 消息片段（part） | 514,100 |
| Todo | 2,776（completed 2,381 / pending 250 / in_progress 91 / cancelled 54） |

#### Claude Code

取决于用户使用量。数据通过 glob 扫描 JSONL 文件获取，无预先统计。

### 2.6 项目分布（示例：当前实例，OpenCode）

| 项目 | 会话数 | +/- 代码行 | 活跃期 | 备注 |
|---|---|---|---|---|
| **davidbot** | 34,722 | +769K/-155K | 2/14 - 3/17 | 自动化 bot（被噪音规则过滤） |
| **mynotebook** | 688 | +65K/-28K | 2/2 - 3/19 | |
| **/ (global)** | 455 | +8K/-1K | 12/15 - 3/11 | |
| **openclaw** | 102 | +647K/-332K | 3/13 - 3/19 | |
| **wallet-bench** | 101 | +51K/-9K | 3/6 - 3/13 | |
| **aibuddy** | 74 | +39K/-2K | 3/17 - 3/19 | |
| **stock** | 73 | +8K | 1/7 - 2/20 | |
| **daily-report** | 50 | +8K/-5K | 1/22 - 3/2 | |
| **prd-agent** | 13 | 0 | 1/23 - 1/26 | |
| **computer_use_ootb** | 10 | +676/-353 | 1/11 - 1/12 | |
| **0210-Kill-Line** | 6 | +3K/-1K | 2/12 - 2/14 | |
| **assistant-runtime** | 3 | 0 | 3/10 | |

---

## 3. 噪音 Session 过滤

自动化 bot、CI 流水线、脚本触发的 session 会严重干扰分析。需要通用的噪音识别规则，而非硬编码项目名。

噪音过滤**基于 adapter 提供的 `NoiseSignals` 运行**，规则引擎不感知底层数据源格式。每个数据源的 adapter 负责将自身数据统计为统一的 `NoiseSignals` 结构。

### 3.1 自动检测规则

以下特征命中 **2 条及以上**的项目（跨源合并后的逻辑项目），其 sessions 标记为噪音，默认排除：

| # | 规则 | NoiseSignals 字段 | 阈值 | 理由 |
|---|---|---|---|---|
| 1 | 活跃时段分布均匀 | `hourDistribution` 方差 | < 阈值 | 人类有作息规律，bot 没有 |
| 2 | 用户首条消息高度重复 | `uniqueFirstMessageRatio` | < 0.3 | 脚本触发的固定 prompt |
| 3 | 平均 session 时长极短 | `medianSessionDurationMs` | < 60,000 | 自动化任务快速结束 |
| 4 | 单项目 session 占比异常 | `sessionSharePercent` | > 70% | 单项目异常集中 = bot |
| 5 | 用户参与度极低 | `userMessageRatio` | < 0.2 | 人几乎没说话 |

**跨源聚合**：同一逻辑项目如果在多个数据源都有 session，噪音检测基于**合并后的统计**。例如 OpenCode 有 100 个 session + Claude Code 有 20 个，`sessionSharePercent` 基于两个源的总 session 数计算。

### 3.2 手动覆盖

配置文件中可显式指定，优先级高于自动检测：

```yaml
# config.yaml
noise_filter:
  # 显式排除（自动检测未覆盖时手动补充）
  exclude_projects:
    - "some-ci-bot"

  # 显式保留（自动检测误杀时手动挽救）
  include_projects:
    - "davidbot"  # 如果想分析它的少量人类 session

  # 保留噪音项目中的人类 session（通过消息数过滤）
  noise_project_human_threshold: 5  # 用户消息数 > 5 的 session 视为人类
```

**session 级过滤的实现路径**：`noise_project_human_threshold` 需要逐 session 检查用户消息数。噪音过滤器在标记项目为噪音后，额外调用 `adapter.getSessions(projectId)` 获取该项目所有 session，再对每个 session 调用 `adapter.getMessages(sessionId)` 统计用户消息数。超过阈值的 session 保留，其余排除。此操作只在噪音项目上执行（通常 1-2 个），不影响正常项目的性能。

### 3.3 过滤报告

每次提取在输出目录生成 `.noise-report.json`，记录哪些项目/session 被过滤：

```json
{
  "auto_detected_noise_projects": [
    { "project": "davidbot", "sources": ["opencode"] }
  ],
  "rules_triggered": {
    "davidbot": ["uniform_hour_distribution", "low_user_participation", "dominant_session_share"]
  },
  "manual_overrides": { "excluded": [], "included": [] },
  "sessions_filtered": { "opencode": 34500, "claude_code": 0, "total": 34500 },
  "sessions_retained": { "opencode": 1797, "claude_code": 120, "total": 1917 }
}
```

方便 review，发现误杀可调整配置后重跑。按数据源分别统计过滤数量。

---

## 4. 设计：6 个提取维度

> **注**：以下各维度的示例为简化版，省略了文件头（`<!-- generated -->` / `<!-- sources -->`）和 user notes 保留区。完整格式规格见 §6.1.2。

### 4.1 决策考古（Decision Archaeology）

**价值**：最高。决策理由是最容易遗忘、最难重建的知识。

**提取目标**：
- 技术选型的 why（为什么 SQLite 不 Postgres、为什么 shadcn 不 Ant Design）
- 架构变更的 trigger（v2 → v3 升级的驱动因素）
- 被否决的方案（试过但放弃的路径，及原因）

**信号特征**：
- 用户消息中包含"为什么"、"还是"、"要不要"、"改成"、"不用了"
- Session 标题含"refactor"、"migrate"、"redesign"
- 同一功能出现多个 session（表明反复推敲）

**输出**：`decisions.md`，按项目 → 日期组织

```markdown
## [项目名] 决策日志

### 2026-03-17: 选择 SQLite 作为数据库
- **背景**: 单用户 PM 工具，不需要多 writer
- **考虑过的方案**: Postgres (运维成本高)、Turso (多一层网络)
- **决定**: SQLite + WAL mode + Drizzle ORM
- **理由**: 零运维、嵌入式、WAL 支持并发读
- **来源**: session `ses_a1b2c3` [OC] — "数据库选型讨论" (2026-03-17)
```

### 4.2 个人画像（Personal Profile）

**价值**：高。让 AI 更懂你，减少每次对话的冷启动成本。

**包含两个子维度**：

#### 4.2.1 交互风格（→ `work-profile.md`）

- 交互偏好：PRD-first 还是 code-first？逐步确认还是一把梭？
- 推回模式：什么情况下用户会 push back？（过度工程、偏离需求）
- 语言习惯：中英文切换规律（需求讨论用中文、代码注释用英文？）
- 工作节奏：活跃时段、session 时长分布

**信号特征**：
- 用户的第一条消息模式（指令式 vs 讨论式）
- 用户对 AI 建议的修正频率和方向
- Session 内消息数分布（短对话 vs 长对话）

#### 4.2.2 技术偏好（→ `tech-preferences.md`）

- 常用框架和库（Next.js、Drizzle、shadcn、Vercel AI SDK）
- AI 模型使用（LiteLLM + Claude Opus、OpenRouter 免费模型、Gemini）
- 部署方式（GitHub、NAS）
- 工具链（OpenCode、Claude Code、Playwright）

**信号特征**：
- `package.json` 相关讨论
- "安装"、"引入"、"npm install"、"配置" 相关对话
- 跨项目重复出现的技术名词

**边界划分**：`work-profile.md` 讲"你怎么和 AI 协作"；`tech-preferences.md` 讲"你用什么技术栈"。不重叠。

**输出示例**：

```markdown
# work-profile.md

## 交互风格
- 偏好 PRD-first：先写需求文档，再写代码
- 喜欢结构化输出：表格 > 列表 > 段落
- 会主动纠正过度工程

## 语言偏好
- 需求讨论、PRD：中文
- 代码、commit message：英文
- CLAUDE.md：中英混合

## 工作节奏
- 活跃时段：10:00-14:00, 20:00-01:00
- 典型 session 时长：15-45 分钟
```

```markdown
# tech-preferences.md

## 前端
- 框架: Next.js (App Router) — 所有 Web 项目
- UI: shadcn/ui v4 (base-ui) + Tailwind v4
- 状态: 无全局状态库，偏好 server components

## 后端
- ORM: Drizzle（偏好 > Prisma）
- DB: SQLite + WAL（单用户场景首选）
- 调度: node-cron + DB-driven

## AI
- SDK: Vercel AI SDK
- 模型: Claude Opus via LiteLLM proxy
- 本地: Gemini（免费额度用于实验）
```

### 4.3 项目叙事（Project Evolution Narrative）

**价值**：中高。重建每个项目的发展脉络，用于回顾和汇报。

**提取目标**：
- 每个项目从创建到现在的关键里程碑
- 功能演进顺序（先做了什么、后加了什么）
- 项目间的关系（davidbot 的心跳引擎 → aibuddy 继承）

**信号特征**：
- Session 标题的时间序列（天然形成叙事线）
- `summary_additions`/`summary_deletions` 的突变（大重构）
- 同项目内 session 密度的变化（密集期 = 主要开发期）

**输出**：`project-timeline.md`，按项目 → 日期组织

```markdown
## aibuddy 项目时间线

### 2026-03-17（Day 1）
- [OC] 从 davidbot 提取心跳引擎核心逻辑 (+320/-0, 5 files)
- [OC] 建立知识库模块框架 (+180/-0, 3 files)
- [CC] 首次 workspace 创建流程 (+95/-0, 2 files)

### 2026-03-18（Day 2）
- [OC] PM 初始化引导流程（onboarding）(+450/-20, 8 files)
- [CC] MCP Server 集成 (+200/-30, 4 files)
- [OC] Watch Item AI 建议功能 (+150/-10, 3 files)
- [OC] GitHub 上传
```

### 4.4 未完成线索（Open Threads）

**价值**：中。被遗忘的 todo 可能包含有价值的想法。

**提取目标**：
- 跨项目的 pending/in_progress todo 汇总
- todo 创建时的上下文（所在 session 的讨论内容）
- 按项目聚合
- *(Phase 2+)* 跨项目主题聚类（如"3 个项目都提到 CI/CD 改进"），需 AI 辅助识别

**输出**：`open-threads.md`

```markdown
## 未完成线索

### aibuddy（7 项）
- [ ] Action Agent 执行框架 — *2d ago, from "design action framework" [OC]*
- [ ] WEA 集成（Phase 2）— *5d ago, from "plan phase 2 features" [OC]*
- [~] 知识库双向同步 — *1d ago, from "knowledge base sync" [CC]*

### mynotebook（12 项）
- [ ] 支持 PDF 导出 — *18d ago, from "export features brainstorm" [OC]*
- [ ] 标签分类系统 — *25d ago, from "organize notes" [OC]*
```

### 4.5 反复痛点（Recurring Pain Points）

**价值**：中。同类问题反复出现，值得形成模式或脚本。

**提取目标**：
- 跨项目反复出现的问题类型
- 调试模式（每次遇到类似问题怎么解决的）
- 可以自动化的重复操作

**信号特征**：
- Session 标题含"fix"、"debug"、"broken"、"error"
- 多个项目中出现相似的错误描述
- 同一问题多次出现（如 MCP 连接断开、权限配置）

**输出**：`pain-points.md`

```markdown
## 反复痛点

### MCP 连接不稳定
- **出现频率**: 4 次（davidbot ×2, aibuddy ×2）
- **典型症状**: SSE 连接断开后不自动重连
- **解决模式**: 添加重试 + 指数退避
- **建议**: 封装为通用 MCP client wrapper
- **可能反复**: yes
- **来源**: session `ses_d4e5` [OC] — "fix MCP disconnect" (2026-03-10), session `ses_f6g7` [OC] — "MCP reconnect issue" (2026-03-15)

### Tailwind v4 迁移坑
- **出现频率**: 3 次
- **典型症状**: @plugin 指令不支持、class 名变化
- **解决模式**: 检查 v4 changelog、使用 @import 替代 @plugin
- **可能反复**: yes
- **来源**: session `ses_h8i9` [CC] — "migrate to tailwind v4" (2026-03-12)
```

### 4.6 工作模式（Work Patterns）

**价值**：中。量化你的工作习惯，帮助 AI 理解你的典型任务分布和时间规律。

**提取目标**：
- 高频任务类型分布（fix bug、add feature、refactor、write PRD 等）
- 工作时段热力图（**原始数据**，与 work-profile.md 的工作节奏互补：此处是每小时 session 计数，work-profile 是 AI 归纳的自然语言洞察）
- 首条消息的典型模式（指令式、讨论式、链接式等）

**信号特征**：
- 每个 session 的首条用户消息（意图 = session 目的）
- Session 标题关键词分类
- Session 创建时间的时段分布

**输出**：`work-patterns.md`

```markdown
# 工作模式

## 高频任务类型

| 类型 | 频次 | 占比 | 典型 session |
|---|---|---|---|
| Bug 修复 | 89 | 35% | "fix auth redirect loop" [OC] |
| 新功能开发 | 67 | 26% | "add knowledge base module" [OC] |
| 重构 | 34 | 13% | "refactor heartbeat engine v2→v3" [CC] |
| PRD/文档 | 28 | 11% | "write session memory PRD" [OC] |
| 配置/部署 | 18 | 7% | "setup CI/CD pipeline" [OC] |
| 调研/探索 | 12 | 5% | "evaluate ORM options" [CC] |
| 其他 | 8 | 3% | — |

## 时段分布

| 时段 | 活跃度 |
|---|---|
| 10:00-10:59 | ████████░░ 42 sessions |
| 11:00-11:59 | ██████████ 58 sessions |
| ...

## 首条消息模式

| 模式 | 频次 | 示例 |
|---|---|---|
| 指令式（直接下达任务） | 120 | "把这个组件重构成 server component" |
| 讨论式（提问/探讨） | 45 | "这个架构你怎么看？" |
| PRD 先行（贴需求文档） | 28 | "[pasted PRD content]" |
| 链接/截图（贴 URL 或图） | 15 | "看下这个报错 [screenshot]" |
```

---

## 5. 提取管道（Extraction Pipeline）

所有提取器**面向 Source Adapter 接口**操作，不直接访问任何数据源的原始格式。原始 SQL / JSONL 解析封装在各自 adapter 内部。

### 5.1 三层提取架构

```
                    ┌─────────────────────────────┐
                    │    Source Adapter Registry   │
                    │  (OpenCode + Claude Code)    │
                    └──────────┬──────────────────┘
                               │ 统一中间类型
                               ▼
Layer 1: STRUCTURED（零 AI 成本）
  │  adapter.getProjects() / getSessions() / getTodos()
  │  项目列表、session 频率、时间分布、todo 统计
  │  输出：project-timeline.md, open-threads.md
  │
Layer 2: SEMI-STRUCTURED（文本匹配）
  │  adapter.getMessages() → 首条用户消息
  │  按关键词和主题聚类
  │  输出：work-patterns.md, tech-preferences.md
  │
Layer 3: DEEP（AI 批量摘要）
  │  adapter.getMessages() → 高价值 session 完整对话
  │  AI 批量摘要 → 提取决策、偏好、痛点
  │  输出：decisions.md, pain-points.md, work-profile.md
```

### 5.1.1 增量执行流程

每次提取运行时，读取 `.last-extraction.json` 中各数据源的 `last_session_time`，只处理新增 session：

```typescript
// 伪代码 — 整体增量编排
const metadata = readLastExtraction()

// Step 1: 各 adapter 增量获取新 session
for (const adapter of registry.adapters) {
  const since = metadata.sources[adapter.name]?.last_session_time ?? 0
  const newSessions = await adapter.getSessions(projectId, since)
  // newSessions 只包含 time_created > since 的 session
}

// Step 2: Layer 1 — 追加型文件只处理新 session；聚合型文件（open-threads）全量重建
appendToTimeline(newSessions)
rebuildOpenThreads()  // 每次全量查询所有未完成 todo

// Step 3: Layer 2 — 聚合型文件全量重建
// Layer 2 每次对所有非噪音 session 全量重跑首条消息分析。
// 虽然 getMessages() 是逐 session 调用，但 Layer 2 只取首条用户消息（一次 DB 查询 / JSONL 首行），
// 成本极低（<30s for 2K sessions）。不做中间缓存，换取实现简单和统计准确。
for (const session of allNonNoiseSessions) {
  const messages = await registry.getMessages(session.id)
  const firstUserMsg = messages.find(m => m.role === 'user')
  // 对 firstUserMsg.content 做关键词分类，积累到全局统计中
}
rebuildWorkPatterns()
rebuildTechPreferences()

// Step 4: Layer 3 — 只对新的高价值 session 调 AI（通过 layer3.processed_sessions 去重）
const highValueNew = filterHighValue(newSessions)
  .filter(s => !metadata.layer3.processed_sessions.includes(s.id))
for (const session of highValueNew) {
  const messages = await registry.getMessages(session.id)  // 只对高价值新 session 调用
  await runAISummary(session, messages)  // 决策 + 痛点 + 偏好 3 个 prompt
}
rebuildWorkProfile()

// Step 5: 更新元数据
saveLastExtraction(updatedMetadata)
```

**关键原则**：`getMessages()` 调用策略因层而异。Layer 2 每次全量重跑（只取首条消息，成本低），Layer 3 仅对新的高价值 session 调用（通过 `layer3.processed_sessions` 去重避免重复调 AI）。

### 5.2 Layer 1: 结构化提取

**零 AI 成本，基于 adapter 接口查询。**

#### 5.2.1 项目时间线

```typescript
// 伪代码 — 实际逻辑，adapter 内部各自用 SQL / JSONL 实现
const projects = await registry.getAllProjects()           // 跨源合并后的逻辑项目
const excludedIds = noiseFilter.getExcludedProjectIds()

for (const project of projects) {
  if (excludedIds.includes(project.id)) continue
  const sessions = await registry.getSessions(project.id)  // 跨源合并，按时间排序
  // 按日期分组，渲染 markdown：
  // ### 2026-03-18
  // - [OC] 建立知识库模块框架 (+450/-20, 8 files)
  // - [CC] 重构 API 路由结构
}
```

**OpenCode adapter 内部**（参考 SQL）：
```sql
SELECT p.name, date(s.time_created/1000, 'unixepoch', 'localtime') as day,
  s.title, s.summary_additions, s.summary_deletions, s.summary_files
FROM session s JOIN project p ON s.project_id = p.id
WHERE s.title IS NOT NULL ORDER BY p.name, s.time_created;
```

**Claude Code adapter 内部**（参考逻辑）：
```typescript
// glob ~/.claude/projects/**/*.jsonl → 解析 session_start + message 事件
// title 优先取 sessions-index.json，fallback 到首条用户消息截断
```

#### 5.2.2 未完成线索

```typescript
const todos = await registry.getAllTodos()  // 跨源合并，按项目聚合
// 按项目分组，渲染 markdown
// OpenCode: 从 todo 表查询
// Claude Code: 从 ~/.claude/todos/<session>.json 解析
```

### 5.3 Layer 2: 半结构化提取

**adapter 提取消息 + 文本模式匹配。**

#### 5.3.1 首条消息意图分析

```typescript
for (const session of nonNoiseSessions) {
  const messages = await registry.getMessages(session.id)
  const firstUserMsg = messages.find(m => m.role === 'user')
  // 对 firstUserMsg.content 做意图分类
  // adapter 已统一为纯文本 content，不关心底层是 part 表还是 JSONL 事件
}
```

#### 5.3.2 技术关键词提取

对首条消息和 session 标题做关键词匹配：

| 类别 | 关键词模式 |
|---|---|
| 框架 | `next.js`, `react`, `drizzle`, `shadcn`, `tailwind` |
| AI | `claude`, `gemini`, `openai`, `litellm`, `vercel ai` |
| 工具 | `playwright`, `mcp`, `node-cron`, `nanoid` |
| 操作 | `fix`, `debug`, `refactor`, `migrate`, `deploy` |

关键词表可在配置文件中扩展。

### 5.4 Layer 3: 深度提取（AI 批量摘要）

**选取高价值 session，调 AI 做深度分析。**

#### 5.4.1 高价值 Session 筛选

加权筛选，优先选出含决策的 session。所有条件基于 `Session` 和 `Message` 统一中间类型，**不依赖特定数据源字段**：

| 条件 | 权重 | 数据来源 | 理由 |
|---|---|---|---|
| 用户消息数 > 5 | 必要条件 | `messages.filter(role='user').length` | 排除 AI 自说自话 |
| 标题匹配决策关键词 | +3 | `session.title` | refactor, migrate, design, prd, architecture, choose, vs |
| codeChurn > 500 | +2 | `session.codeChurn`（可选字段，无则跳过该规则） | 大变更通常伴随决策 |
| 同项目 24h 内 2+ sessions | +2 | `session.timeCreated` 聚合 | 反复推敲 = 决策 |
| 总消息数 > 15 | +1 | `session.messageCount` | 长对话可能有深度讨论 |

`codeChurn` 为可选字段：OpenCode 有原生数据，Claude Code 可从 tool_use 事件推断（v1 不推断也可，该规则自动跳过）。

**入选条件**：满足必要条件（用户消息数 > 5）且加权分数 **≥ 3** 的 session 进入 AI 分析。预计首次全量约 200 个 session 符合条件，增量每次约 20 个。分数阈值可在 config.yaml 中调整：

```yaml
# config.yaml
layer3:
  min_score: 3          # 加权分数 ≥ 此值进入 AI 分析
  max_sessions: 500     # 单次运行上限（safety cap，避免意外高额 AI 费用）
```

#### 5.4.2 AI 摘要 Prompt

**每个维度用专门的 prompt，分开跑**（而非一个通用 prompt 同时提取 4 个维度）。质量远优于通用提取。

**决策提取 prompt**：

```
你是一个技术决策提取器。只关注决策，忽略其他一切。

分析以下 AI 编码对话，提取所有技术/产品决策：
- 做了什么决定？
- 为什么这么选？
- 考虑过哪些替代方案？为什么否决？
- 什么触发了这个决策？

如果对话中没有明确决策，返回空数组。不要编造。

输出 JSON：
{
  "decisions": [{ "what": "", "why": "", "alternatives": [""], "trigger": "", "date": "" }]
}
```

**痛点提取 prompt**：

```
你是一个问题模式提取器。只关注遇到的问题和解决方式。

分析以下 AI 编码对话，提取：
- 遇到了什么问题/错误？
- 怎么诊断的？
- 最终怎么解决的？
- 这个问题是否像是会反复出现的？

如果对话中没有明确问题，返回空数组。不要编造。

输出 JSON：
{
  "pain_points": [{ "problem": "", "diagnosis": "", "solution": "", "likely_recurring": bool }]
}
```

**偏好提取 prompt**：

```
你是一个工作风格观察器。只关注用户（非 AI）的行为模式。

分析以下对话，观察用户表现出的：
- 与 AI 的交互方式（指令式/讨论式/PRD 先行/代码先行）
- 对 AI 建议的反应（接受/修正/拒绝的模式）
- 技术审美（偏好简单/复杂、务实/完美主义）
- 沟通风格（简洁/详细、中文/英文切换）

只记录有证据支撑的观察。不要推测。

输出 JSON：
{
  "preferences": [{ "category": "", "observation": "", "evidence": "" }]
}
```

#### 5.4.3 批量处理策略

| 参数 | 值 | 理由 |
|---|---|---|
| 模型 | Claude Haiku / Gemini Flash | 成本低、速度快，摘要任务不需要最强模型 |
| 并发 | 5 sessions / batch | 避免 rate limit |
| 上下文裁剪 | 每 session 取前 20 条消息 | 大部分决策在前半段对话中 |
| 去重 | 按 session_id 幂等 | 支持增量重跑 |
| 每个 session 跑 3 个 prompt | 决策 + 痛点 + 偏好 | 专注单维度，质量高 |

#### 5.4.4 成本估算

| 项目 | 计算 | 金额 |
|---|---|---|
| 高价值 session 数 | ~200（首次提取） | — |
| 平均 input | 20 条消息 × 500 tokens ≈ 10K tokens/session | — |
| 总 input | 200 × 10K × 3 prompts = 6M tokens | — |
| 总 output | ~1M tokens（估） | — |
| **Haiku 成本** | $0.25/M in + $1.25/M out | **~$2.75** |
| **Flash 成本** | $0.075/M in + $0.30/M out | **~$0.75** |
| 增量每次 | ~20 new sessions × 3 prompts | **~$0.03-$0.15** |

首次全量提取 < $3，增量几乎免费。

> 以上估算基于 OpenCode 单源（~200 高价值 sessions）。加入 Claude Code 后按使用量线性增加，预计总量仍在同一量级（< $5 首次全量）。

---

## 6. 输出规格

### 6.1 输出文件列表

| 优先级 | 文件名 | 内容 | 数据来源 | 更新策略 |
|---|---|---|---|---|
| **P0** | `project-timeline.md` | 每个项目的 session 标题时间线 | Layer 1 | 追加型 |
| **P0** | `open-threads.md` | 跨项目未完成 todo 汇总 | Layer 1 | 聚合型 |
| **P1** | `work-patterns.md` | 用户首条消息聚类，高频任务类型 | Layer 2 | 聚合型 |
| **P1** | `tech-preferences.md` | 跨项目技术关键词提取 | Layer 2 | 聚合型 |
| **P2** | `decisions.md` | AI 摘要的决策日志 | Layer 3 | 追加型 |
| **P2** | `pain-points.md` | AI 提取的反复痛点 | Layer 3 | 追加型 |
| **P2** | `work-profile.md` | AI 综合的个人工作画像 | Layer 3 | 聚合型 |

### 6.1.1 通用格式约定

所有输出文件遵循以下约定，确保消费者可稳定解析：

**文件头**（所有文件必须包含）：

```markdown
<!-- generated: 2026-03-19T15:00:00+08:00 -->
<!-- sources: opencode(130 sessions) + claude_code(20 sessions) -->
# {文件标题}
```

**来源标注格式**（所有涉及 session 引用的地方统一使用）：

```
session `{session_id}` [{source_label}] — "{session_title}" ({YYYY-MM-DD})
```

示例：`session `abc-123` [OC] — "重构心跳引擎" (2026-03-17)`

**来源标签**：`[OC]` = OpenCode, `[CC]` = Claude Code，可在 config.yaml 的 `source_labels` 中自定义。

### 6.1.2 各文件格式规格

#### `project-timeline.md`

```markdown
<!-- generated: {ISO8601} -->
<!-- sources: {source_summary} -->
# 项目时间线

## {项目名}

### {YYYY-MM-DD}
- [{source_label}] {session_title} (+{additions}/-{deletions}, {files} files)
- [{source_label}] {session_title}
```

| 元素 | 固定/动态 | 说明 |
|---|---|---|
| `# 项目时间线` | 固定 | 一级标题 |
| `## {项目名}` | 动态 | 二级标题，每个逻辑项目一个 section |
| `### {YYYY-MM-DD}` | 动态 | 三级标题，按日期分组 |
| 列表项 | 动态 | `[{label}] {title} ({churn})` — churn 可选（Claude Code 可能无） |

#### `open-threads.md`

```markdown
<!-- generated: {ISO8601} -->
<!-- sources: {source_summary} -->
# 未完成线索

## {项目名}（{count} 项）

- [ ] {todo_content} — *{age}, from "{session_title}" [{source_label}]*
- [~] {todo_content} — *{age}, from "{session_title}" [{source_label}]*

<!-- user notes -->
<!-- 在此处添加个人备注，全量重建时不会被覆盖 -->
<!-- /user notes -->
```

| 元素 | 固定/动态 | 说明 |
|---|---|---|
| `# 未完成线索` | 固定 | 一级标题 |
| `## {项目名}（{count} 项）` | 动态 | 二级标题 |
| `- [ ]` | pending | 标准 markdown checkbox |
| `- [~]` | in_progress | 用 `~` 表示进行中 |
| `— *{age}, from ...*` | 动态 | 斜体后缀：`3d ago` / `2mo ago`，来源 session 标题 + 数据源标签 |
| `<!-- user notes -->` | 固定 | 用户笔记保留区（全量重建时保留） |

**年龄格式**：`< 1h` → `Xm ago`，`< 24h` → `Xh ago`，`< 30d` → `Xd ago`，`< 365d` → `Xmo ago`，`≥ 365d` → `Xy ago`

#### `work-patterns.md`

```markdown
<!-- generated: {ISO8601} -->
<!-- sources: {source_summary} -->
# 工作模式

## 高频任务类型

| 类型 | 频次 | 占比 | 典型 session |
|---|---|---|---|
| {category} | {count} | {percent}% | "{session_title}" [{source_label}] |

## 时段分布

| 时段 | 活跃度 |
|---|---|
| {HH}:00-{HH}:59 | {bar} {count} sessions |

## 首条消息模式

| 模式 | 频次 | 示例 |
|---|---|---|
| {pattern_desc} | {count} | "{example_first_msg}" |

<!-- user notes -->
<!-- 在此处添加个人备注，全量重建时不会被覆盖 -->
<!-- /user notes -->
```

| 元素 | 固定/动态 | 说明 |
|---|---|---|
| `# 工作模式` | 固定 | 一级标题 |
| `## 高频任务类型` | 固定 | 二级标题，表格格式 |
| `## 时段分布` | 固定 | 二级标题，**原始数据**：每小时 session 计数（Layer 2 统计） |
| `## 首条消息模式` | 固定 | 二级标题 |
| `<!-- user notes -->` | 固定 | 用户笔记保留区（见 §6.3.2） |

#### `tech-preferences.md`

```markdown
<!-- generated: {ISO8601} -->
<!-- sources: {source_summary} -->
# 技术偏好

## {类别}
- **{技术名}**: {使用描述} — *{出现次数} sessions, {项目列表}*

<!-- user notes -->
<!-- 在此处添加个人备注，全量重建时不会被覆盖 -->
<!-- /user notes -->
```

| 元素 | 固定/动态 | 说明 |
|---|---|---|
| `# 技术偏好` | 固定 | 一级标题 |
| `## {类别}` | 动态 | 二级标题：前端、后端、AI、工具、部署 等 |
| 列表项 | 动态 | bold 技术名 + 描述 + 斜体统计 |
| `<!-- user notes -->` | 固定 | 用户笔记保留区 |

#### `decisions.md`

```markdown
<!-- generated: {ISO8601} -->
<!-- sources: {source_summary} -->
# 决策日志

## {项目名}

### {YYYY-MM-DD}: {决策标题}
- **背景**: {context}
- **考虑过的方案**: {alternatives}
- **决定**: {decision}
- **理由**: {reasoning}
- **来源**: session `{session_id}` [{source_label}] — "{session_title}" ({date})
```

| 字段 | 必选 | 说明 |
|---|---|---|
| **背景** | ✅ | 什么触发了这个决策 |
| **考虑过的方案** | ✅ | 列出被否决的替代方案 |
| **决定** | ✅ | 最终选择了什么 |
| **理由** | ✅ | 为什么这么选 |
| **来源** | ✅ | 标准来源标注格式 |

#### `pain-points.md`

```markdown
<!-- generated: {ISO8601} -->
<!-- sources: {source_summary} -->
# 反复痛点

## {问题标题}
- **出现频率**: {count} 次（{project1} ×{n}, {project2} ×{n}）
- **典型症状**: {symptoms}
- **解决模式**: {solution_pattern}
- **建议**: {suggestion}
- **可能反复**: {yes/no}
- **来源**: session `{id}` [{label}] — "{title}" ({date}), ...
```

| 字段 | 必选 | 说明 |
|---|---|---|
| **出现频率** | ✅ | 跨项目统计 |
| **典型症状** | ✅ | 问题描述 |
| **解决模式** | ✅ | 怎么解决的 |
| **建议** | ❌ | 可选，自动化建议 |
| **可能反复** | ✅ | AI 判断 |
| **来源** | ✅ | 可多个，逗号分隔 |

#### `work-profile.md`

```markdown
<!-- generated: {ISO8601} -->
<!-- sources: {source_summary} -->
# 工作画像

## 交互风格
- {observation} — *{evidence}*

## 语言偏好
- {observation} — *{evidence}*

## 工作节奏
- 活跃时段: {peak_hours}
- 典型 session 时长: {duration_range}
- 日均 session 数: {avg}

## 技术审美
- {observation} — *{evidence}*

<!-- user notes -->
<!-- 在此处添加个人备注，全量重建时不会被覆盖 -->
<!-- /user notes -->
```

| 元素 | 固定/动态 | 说明 |
|---|---|---|
| `# 工作画像` | 固定 | 一级标题 |
| `## 交互风格` | 固定 | 二级标题 |
| `## 语言偏好` | 固定 | 二级标题 |
| `## 工作节奏` | 固定 | 二级标题，**AI 归纳的洞察**：基于 work-patterns 的原始数据，AI 总结出自然语言描述（如"你是夜猫子，10 点前几乎不开工"） |
| `## 技术审美` | 固定 | 二级标题 |
| 列表项 | 动态 | observation + 斜体 evidence |
| `<!-- user notes -->` | 固定 | 用户笔记保留区 |

### 6.2 输出目录

```
~/.local/share/session-memory/
├── project-timeline.md      # P0
├── open-threads.md           # P0
├── work-patterns.md          # P1
├── tech-preferences.md       # P1
├── decisions.md              # P2
├── pain-points.md            # P2
├── work-profile.md           # P2
├── .last-extraction.json     # 增量提取元数据
└── .noise-report.json        # 噪音过滤报告
```

**路径选择**：`~/.local/share/session-memory/`，不放在 opencode 或任何消费者的目录下——独立项目，独立存储。

### 6.3 增量更新

#### 6.3.1 元数据

`.last-extraction.json` 记录上次提取的截止时间，**按数据源分别追踪**：

```json
{
  "last_run": "2026-03-19T15:00:00+08:00",
  "sources": {
    "opencode": {
      "last_session_time": 1710835200000
    },
    "claude_code": {
      "last_session_time": 1710835100000
    }
  },
  "layer3": {
    "processed_sessions": ["session-id-1", "session-id-2", "uuid-a"],
    "failed_sessions": ["session-id-3"]
  },
  "stats": {
    "sessions_processed": { "opencode": 130, "claude_code": 20, "total": 150 },
    "decisions_extracted": 23,
    "todos_found": 341
  }
}
```

**增量策略**：

| 层 | 增量依据 | 说明 |
|---|---|---|
| Layer 1 | `last_session_time` per source | 纯时间戳比较，不需要 session ID 列表 |
| Layer 2 | `last_session_time` per source | 同上，只对新 session 取首条消息 |
| Layer 3 | `layer3.processed_sessions` | AI 摘要需要 session 级幂等，通过 ID 列表去重避免重复调 AI |

`layer3.failed_sessions` 记录 AI 调用失败的 session ID，下次运行自动重试（详见 §8.5）。

#### 6.3.2 Merge 策略

不同文件类型采用不同的 merge 策略：

| 文件类型 | 策略 | 说明 |
|---|---|---|
| **追加型** | Append + 去重 | `project-timeline.md`, `decisions.md`, `pain-points.md` — 新内容追加到对应 section |
| **聚合型** | 每次全量重建 | `work-profile.md`, `tech-preferences.md`, `work-patterns.md`, `open-threads.md` — 需要跨全量数据统计或反映最新状态，增量追加会导致结论偏差或 stale |

**追加型文件**：
- 新 session 的提取结果追加到对应项目 section 末尾
- 按时间排序，新条目在底部
- session_id 去重，同一 session 不重复写入

**聚合型文件**：
- 每次提取完成后，基于所有已提取数据全量重算
- Layer 3 的 AI 摘要结果缓存在 `.last-extraction.json` 的 `processed_sessions` 中，不重复调 AI
- 只有统计和聚合逻辑重跑，成本可忽略
- **用户笔记保留区**：聚合型文件包含 `<!-- user notes -->` ... `<!-- /user notes -->` 区域。全量重建时，该区域内容**原样保留，不覆盖**。用户可在此添加手动备注（如"Drizzle 用着不错但迁移工具差"），不会被自动生成冲掉
- **文件头时间戳**：所有文件（包括追加型和聚合型）头部包含 `<!-- generated: ... -->` 和 `<!-- sources: ... -->`，方便消费者做 freshness check（详见 §6.1.1 通用格式约定）

---

## 7. 分阶段交付

### Phase 0（P0）— 结构化提取 + 多数据源基础

**目标**：零 AI 成本，双数据源接入，快速产出可用结果。

| 交付物 | 实现 | 工作量 |
|---|---|---|
| Source Adapter 接口 | 定义统一中间类型 + SourceAdapter interface | 小 |
| OpenCode Adapter | better-sqlite3 直连，实现全部接口方法 | 中 |
| Claude Code Adapter | glob + JSONL 解析，实现全部接口方法 | 中 |
| Adapter Registry | 多源注册、自动检测可用数据源、项目路径合并 | 小 |
| 噪音过滤器 | 基于 NoiseSignals 的自动检测 + 配置覆盖 | 中 |
| `project-timeline.md` | adapter 查询 → 跨源合并 → 按项目/日期分组 → 标注来源 → markdown 渲染 | 小 |
| `open-threads.md` | adapter 查询 → 跨源合并 → 按项目聚合 → markdown 渲染 | 小 |
| CLI 入口（`extract`） | Node.js CLI，读取 config.yaml，运行提取管道 | 小 |

**验收标准**：
- `OpenCodeAdapter.detect()` 和 `ClaudeCodeAdapter.detect()` 正确检测数据源可用性
- 噪音过滤器基于 adapter 提供的 NoiseSignals 运行（不硬编码项目名）
- 生成 `.noise-report.json`，按数据源分别统计过滤数量
- 时间线跨源合并，按日期分组，每条标注来源 `[OC]` / `[CC]`
- Todo 跨源合并，按项目分组，显示内容 + 状态 + 来源
- 只启用一个数据源时正常工作（另一个 `detect()` 返回 false 则跳过）

### Phase 1（P1）— 半结构化提取

**目标**：从首条消息中提取工作模式和技术偏好。

| 交付物 | 实现 | 工作量 |
|---|---|---|
| `work-patterns.md` | adapter.getMessages() → 首条消息 → 关键词分类 → 频次统计 | 中 |
| `tech-preferences.md` | 技术关键词匹配 → 跨项目 + 跨源聚合 | 中 |

**验收标准**：
- 识别出 top 10 高频任务类型（fix bug、add feature、refactor、write PRD 等）
- 识别出跨项目共用的技术栈
- 正确处理两种数据源的消息格式（OpenCode `part` 表 + Claude Code JSONL 事件流，由 adapter 屏蔽差异）

### Phase 2（P2）— 深度提取

**目标**：AI 批量摘要高价值 session，提取决策和洞察。

| 交付物 | 实现 | 工作量 |
|---|---|---|
| `decisions.md` | 高价值 session 筛选 → AI 摘要 → 聚合 | 大 |
| `pain-points.md` | 同上，侧重问题提取 | 大 |
| `work-profile.md` | 汇总 P0+P1+P2 所有发现 | 中 |
| 增量支持 | AI 摘要结果缓存 + merge | 中 |

**验收标准**：
- 每个决策有 what/why/alternatives/date
- 痛点有 recurring 标记和解决模式
- 支持增量重跑（幂等）
- 首次全量提取成本 < $3（Haiku）

---

## 8. 注意事项

### 8.1 隐私

输出文件可能包含项目名、代码片段、个人工作习惯、技术决策和内部讨论。

**原则**：输出文件仅存储在本地，不上传到任何远程服务。如需分享，由用户手动脱敏。

### 8.2 性能

| 操作 | 预期耗时 |
|---|---|
| 数据源检测 | 毫秒级（文件/DB 存在性检查） |
| 噪音检测 | 秒级（统计查询） |
| Layer 1 结构化提取 | 秒级（SQLite 本地 + JSONL glob） |
| Layer 2 文本匹配 | 分钟级（OpenCode 514K parts 全扫 + Claude Code JSONL 遍历） |
| Layer 3 AI 摘要 | 取决于 session 数，预计 200 sessions × 3 prompts |

建议：
- OpenCode: Layer 2 对 `part` 表建临时索引（`session_id` + `message_id`）加速 JOIN
- Claude Code: JSONL 解析是流式的，内存占用低；大量 session 时考虑并发 glob

### 8.3 技术选型

| 选择 | 理由 |
|---|---|
| Node.js + TypeScript | 与 OpenCode 生态一致 |
| better-sqlite3 | OpenCode adapter: 直连只读，零运维 |
| Node.js fs + readline | Claude Code adapter: 流式 JSONL 解析，内存友好 |
| 独立 CLI | 不依赖任何消费者框架 |
| YAML 配置 | 人类可读，易手动编辑，支持多数据源声明 |

### 8.4 已知限制

#### 跨源项目合并

| 场景 | 当前行为 | 影响 | 未来考虑 |
|---|---|---|---|
| **同项目不同机器路径**（`/Users/alice/proj` vs `/Users/bob/proj`） | 视为不同项目，不合并 | 同一人多台机器开发同一项目时 timeline 分裂 | Phase 2+: 支持 config.yaml 手动声明路径别名映射 |
| **项目迁移/改名**（旧 session 指向旧路径，新 session 指向新路径） | 视为不同项目，不合并 | 项目历史断裂 | Phase 2+: 支持 `path_aliases` 配置合并旧路径 |
| **同名不同项目**（两个都叫 `app/` 但路径不同） | 正确区分（以路径为主键，不以项目名） | 无负面影响 | — |

```yaml
# 未来 config.yaml 扩展示例
project_aliases:
  # 多台机器同一项目
  - paths: ["/Users/alice/aibuddy", "/Users/bob/aibuddy"]
    name: "aibuddy"
  # 项目迁移
  - paths: ["/Users/alice/old-name", "/Users/alice/new-name"]
    name: "new-name"
```

#### Claude Code 数据可靠性

- `sessions-index.json` 频繁 stale 或缺失（已知 GitHub issue #25032, #31768），adapter 必须 fallback 到 JSONL 文件直接扫描
- Session 可能无 `session_end` 事件（crash / 强制退出），时长统计需降级处理（详见 §2.3 Fallback 策略表）
- Claude Code 默认 30 天 session 保留，历史数据可能被清理。首次运行建议尽早执行

### 8.5 错误处理与恢复

| 故障场景 | 处理策略 | 说明 |
|---|---|---|
| **Layer 3 AI 调用失败**（rate limit / 网络错误 / 超时） | 单 session 失败不阻塞整体；记录到 `layer3.failed_sessions`，下次运行自动重试 | 重试次数上限 3 次，超过后标记为 `permanently_failed` 并跳过 |
| **AI 返回非法 JSON** | 重试 1 次；仍失败则记录原始响应到 `logs/`，该 session 归入 `failed_sessions` | 不强制 AI 结果，宁可漏提取也不编造 |
| **中途 crash 后重跑** | 追加型文件通过 session_id 去重保证幂等；聚合型文件每次全量重建，天然幂等 | `.last-extraction.json` 在每个 Layer 完成后即时写入，不等全部 Layer 跑完 |
| **JSONL 文件损坏**（truncated line / 非法 JSON） | 跳过损坏行，继续解析后续行；记录 warning 到 CLI 输出和 `.noise-report.json` | 单行损坏不影响整个 session |
| **SQLite 数据库锁定**（OpenCode 正在运行时） | 以 `SQLITE_OPEN_READONLY` 模式打开；WAL mode 下不会阻塞 OpenCode 写入 | better-sqlite3 默认只读连接 |
| **数据源不存在** | `adapter.detect()` 返回 false，跳过该数据源，不报错 | 只启用一个源时正常工作 |

### 8.6 完整 config.yaml 参考

以下为所有配置项的合并参考，各片段分别在 §2.4.4、§3.2、§5.4.1 中详细说明。

```yaml
# ============================================================
# session-memory config.yaml — 完整参考
# ============================================================

# --- 数据源配置 (§2.4.4) ---
sources:
  opencode:
    enabled: true
    db_path: "~/.local/share/opencode/opencode.db"

  claude_code:
    enabled: true
    base_dir: "~/.claude"

  # 未来扩展
  # cursor:
  #   enabled: false
  #   db_path: "~/Library/Application Support/Cursor/..."

# --- 来源标签 (§2.4.4) ---
source_labels:
  opencode: "OC"
  claude_code: "CC"

# --- 噪音过滤 (§3.2) ---
noise_filter:
  exclude_projects:
    - "some-ci-bot"
  include_projects: []
  noise_project_human_threshold: 5     # 用户消息数 > N 的 session 视为人类

# --- Layer 3 AI 提取 (§5.4.1) ---
layer3:
  min_score: 3            # 加权分数 ≥ 此值进入 AI 分析
  max_sessions: 500       # 单次运行上限（safety cap）

# --- 输出 ---
output_dir: "~/.local/share/session-memory"

# --- 项目路径别名 (§8.4, Phase 2+) ---
# project_aliases:
#   - paths: ["/Users/alice/aibuddy", "/Users/bob/aibuddy"]
#     name: "aibuddy"
```

---

## Changelog

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1 | 2026-03-19 | 初稿 |
| v0.2 | 2026-03-19 | 重定位为"数据分身"；独立项目；通用噪音过滤替代 davidbot 硬编码；补使用场景、消费约定、merge 策略、成本估算；拆分 AI prompt 为单维度；优化高价值 session 筛选；明确工作画像与技术偏好边界 |
| v0.3 | 2026-03-19 | **多数据源架构**：新增 Source Adapter 抽象层；加入 Claude Code (JSONL) 作为第二数据源；定义统一中间类型 (Project/Session/Message/Todo/NoiseSignals)；项目按 worktree 路径跨源合并；噪音过滤改为基于 adapter NoiseSignals；提取管道改为面向接口；Phase 0 扩展为含双数据源 + adapter 层 |
| v0.4 | 2026-03-19 | **消费者契约强化**（基于外部 review 反馈）：新增 §6.1.1-6.1.2 所有输出文件格式规格（固定 heading、必选字段、来源标注标准格式）；聚合型文件增加 `<!-- user notes -->` 保留区 + 文件头生成时间戳；补 §4.6 work-patterns 维度设计 + 输出示例；来源标注升级为 `session_id + source_label + title + date`；open-threads todo 增加年龄标注；Claude Code adapter 补 fallback 策略表；新增 §8.4 已知限制（跨源合并边际场景 + Claude Code 数据可靠性） |
| v0.5 | 2026-03-19 | **实现正确性修复**（基于自审）：`open-threads.md` 从追加型改为聚合型（todo 状态会变，追加逻辑无法处理）；`.last-extraction.json` 的 `processed_sessions` 拆为 `layer3.processed_sessions`（Layer 1/2 纯靠时间戳增量，避免 ID 列表膨胀）；新增 §5.1.1 增量执行流程伪代码（显式说明 getMessages 只对新 session 调用）；§4 示例声明为简化版并指向 §6.1.2 正式规格；§3.2 补充 `noise_project_human_threshold` 的 session 级过滤实现路径；高价值 session 筛选从 `top N` 改为分数阈值 `≥ 3` + config 可配置；新增 §8.5 错误处理与恢复（AI 失败重试、crash 幂等、JSONL 损坏跳过）；明确 work-patterns 时段分布（原始数据）vs work-profile 工作节奏（AI 洞察）的边界 |
| v0.6 | 2026-03-19 | **开工前最后一轮打磨**（基于二次自审）：`Todo` 接口补 `timeCreated?` 字段（open-threads 年龄显示依赖）；澄清 Layer 2 每次全量重跑 `getMessages` 取首条消息（成本可接受，不做中间缓存）；跨项目主题聚合从 open-threads 示例移除推迟到 Phase 2；新增 §8.6 完整 config.yaml 合并参考；adapter 接口补内部缓存实现建议；成本估算补双数据源说明 |
