# PRD: Memory Integration — 接入记忆层数据源

Date: 2026-04-07
Version: v0.3
Status: Partially Implemented (Phase 3A complete)

---

## 0. 一句话

> 将 OpenCode 和 Claude Code 已生成的记忆文件（auto memory、rules、session notes）作为零成本数据源接入 session-memory，通过新增的 Layer 0 直接合并到现有 **8 个输出文件**中，同时降低 Layer 3 的提取成本。

---

## 1. 问题

### 1.1 现状

主 PRD (PRD.md) §2 描述的数据流只覆盖**对话历史**：`Project → Session → Message → Todo`。这是原始数据，信噪比低。每个 AI 编码工具自身还在持续产出另一类数据：**已经过提炼的记忆文件**。

### 1.2 遗漏的高价值数据

| 数据类型 | 产出工具 | 信息密度 | 当前是否接入 |
|---|---|---|---|
| 对话历史（raw messages） | OpenCode / Claude Code | 低 | 已接入（见主 PRD） |
| Auto Memory（AI 自动提炼的项目记忆） | Claude Code | 极高 | 未接入 |
| Rules / AGENTS.md（人工编写的规则约束） | Claude Code / OpenCode | 高 | 未接入 |
| Session Notes（会话中段压缩笔记） | Claude Code | 中 | 未接入 |

### 1.3 为什么现在要补上

**这些记忆文件本质上就是 session-memory 的 Layer 3 试图生产的东西，只不过它们是免费的。**

Claude Code 的 Auto Memory 机制会在每次会话结束后自动蒸馏当前项目的关键知识——决策、踩坑记录、用户偏好——并写入结构化 Markdown 文件。CLAUDE.md 和 AGENTS.md 是开发者手动维护的约束规则，代表了最可信的人工标注信号。

不接入这些文件，等于：

1. **重复劳动**：Layer 3 花成本从原始对话中提炼的洞察，这些文件里已经有了
2. **遗漏最高质量信号**：auto memory 是 AI 对自身工作的自述，比任何外部提炼都准确
3. **浪费 Layer 3 预算**：有了 session notes（已压缩的会话摘要），Layer 3 不需要重新读全量对话

---

## 2. 数据源清单

本节列出所有记忆类数据源。对话历史数据源见主 PRD §2，不在此重复。

### 2.1 Claude Code 记忆数据源

| 数据源 | 路径 | 格式 | 写入方 | 信号价值 |
|---|---|---|---|---|
| Auto Memory 索引 | `~/.claude/projects/<project>/memory/MEMORY.md` | Markdown + YAML frontmatter | Claude 自动生成 | 最高 — Claude 对当前项目的蒸馏记忆，每次会话必加载 |
| Auto Memory 主题文件 | `~/.claude/projects/<project>/memory/*.md` | Markdown + YAML frontmatter（type: user/feedback/project/reference） | Claude 自动生成 | 高 — 按类型分类的主题记忆文件 |
| Session Memory 笔记 | `~/.claude/session-memory/` | 结构化模板（Current State / Files and Functions / Worklog） | Claude 会话中段压缩 | 中 — 已压缩的会话笔记，不含原始对话噪音 |
| CLAUDE.md（用户全局） | `~/.claude/CLAUDE.md` | Markdown | 人工编写 | 中 — 人工维护的全局偏好，最可信的规则来源 |
| CLAUDE.md（项目级） | `./CLAUDE.md` 或 `./.claude/CLAUDE.md` | Markdown | 人工编写 | 中 — 项目特定规则 |
| CLAUDE.local.md | `./CLAUDE.local.md` | Markdown | 人工编写 | 低 — 本地覆盖配置，通常 gitignored |
| Rules（用户全局） | `~/.claude/rules/*.md` | Markdown，可含 `paths:` frontmatter | 人工编写 | 中 — 条件约束规则，含适用路径过滤器 |
| Rules（项目级） | `.claude/rules/*.md` | Markdown，可含 `paths:` frontmatter | 人工编写 | 中 — 项目约束规则 |
| Subagent Memory（项目） | `.claude/agent-memory/<agent>/MEMORY.md` | Markdown | 子 Agent 自动生成 | 低 — 特定 agent 的工作记忆 |
| Subagent Memory（用户） | `~/.claude/agent-memory/<agent>/MEMORY.md` | Markdown | 子 Agent 自动生成 | 低 |

**YAML frontmatter 示例**（Auto Memory 主题文件）：

```yaml
---
type: project          # user | feedback | project | reference
title: "SQLite 选型决策"
created: 2026-03-20T10:30:00Z
updated: 2026-04-01T08:15:00Z
---
```

### 2.2 OpenCode 记忆数据源

| 数据源 | 路径 | 格式 | 写入方 | 信号价值 |
|---|---|---|---|---|
| AGENTS.md（项目级） | `<project>/AGENTS.md` | Markdown | 人工编写 / `/init` 命令生成 | 中 — 项目规则和约束 |
| AGENTS.md（全局） | `~/.config/opencode/AGENTS.md` | Markdown | 人工编写 | 中 — 跨项目通用规则 |
| Directory Agents | `~/.local/share/opencode/storage/directory-agents/<session>.json` | JSON | 系统自动生成 | 低 — AGENTS.md 注入记录，元数据价值 |
| Rules Injector | `~/.local/share/opencode/storage/rules-injector/<session>.json` | JSON | 系统自动生成 | 低 — rules 注入记录 |
| Skills（已缓存） | `~/.cache/opencode/skills/<name>/SKILL.md` | Markdown | 远程拉取缓存 | 信息性 — 工具使用记录，不含用户知识 |
| Skills（本地） | `.opencode/skills/` 或 `~/.claude/skills/` | Markdown | 人工编写 | 信息性 |
| Config instructions | `opencode.json` 的 `instructions: [...]` | JSON 数组，值为文件路径 | 人工编写 | 低 — 指向其他文件的指针，需跟踪解析 |

**注**：OpenCode 的 `.opencode/memory.md`（GitHub issue #16077）尚未发布。Adapter 设计需兼容其未来到来——检测到该文件时自动接入，视同 `project` 类型的 Auto Memory。

---

## 3. 架构设计

### 3.1 核心洞察：两类数据形态

主 PRD (PRD.md) §2.4 的 `SourceAdapter` 面向**会话导向**数据：`Project → Session → Message`。记忆数据是**知识导向**的：一个文件代表一个知识单元，没有 session 概念，不需要分页遍历。

两者混在同一接口里会引入不必要的复杂度。推荐方案：**独立的 MemoryAdapter 层**，与 SourceAdapter 平级。

### 3.2 方案对比

| | Option A：扩展 SourceAdapter | Option B：独立 MemoryAdapter（推荐） |
|---|---|---|
| 接口复杂度 | 在现有接口加 `getMemories()` / `getRules()` | 独立接口，职责单一 |
| 数据形态匹配 | 不匹配——session 方法返回数组，记忆方法返回文件 | 完全匹配记忆文件的扁平结构 |
| 向后兼容 | 需修改现有 adapter 实现 | 不触碰现有 SourceAdapter 和提取器 |
| 扩展性 | 每个新数据源都要实现两套接口 | 记忆接入和会话接入可独立演进 |

### 3.3 MemoryAdapter 接口定义

接口设计采用单一 `listMemoryItems()` 方法，通过 `kind` 字段的判别联合类型（discriminated union）区分数据子类型。新增 kind 值不需要改动接口签名。

```typescript
interface MemoryAdapter {
  readonly name: string;

  /** 检测记忆数据源是否存在且可用 */
  detect(): Promise<boolean>;

  /**
   * 列出所有记忆条目（auto-memory、rules、session-note 等）
   * kind 字段区分类型，Layer 0 按 kind 路由到对应输出文件
   */
  listMemoryItems(projectPath?: string): Promise<MemoryItem[]>;
}

interface MemoryItem {
  kind: 'auto-memory' | 'rule' | 'session-note' | 'skill-metadata';
  stableId: string;           // 由文件路径派生，跨运行稳定（用于增量追踪）
  path: string;
  content: string;
  contentHash: string;        // SHA-256 前 16 字符
  source: string;             // 'claude-code' | 'opencode'
  scope: 'user' | 'project' | 'org';
  canonicalProjectPath?: string;  // 规范化项目路径（与 SourceAdapter 共享同一规范化逻辑）
  memoryType?: string;        // YAML frontmatter type（auto-memory 专用）
  pathFilters?: string[];     // rules 的 paths: frontmatter 字段
  sections?: Record<string, string>; // session-note 各节内容（Current State / Worklog 等）
  lastModified: number;       // Unix ms
}
```

**实现注意**：`MemoryItem` 的 `kind` 字段目前是字符串联合类型，便于接口稳定。实现时推荐将每个 kind 值拆为独立的判别联合类型（discriminated union per kind），这样每个 kind 对应的额外字段（如 `auto-memory` 的 `memoryType`、`session-note` 的 `sections`）可通过类型系统静态保证，避免运行时 undefined 访问。接口签名不变，只是实现层的类型更严格。

**`kind` 字段的映射关系**：

| kind | 对应数据源 | 说明 |
|---|---|---|
| `auto-memory` | Claude Code memory/*.md | AI 自动生成的主题记忆文件 |
| `rule` | CLAUDE.md / AGENTS.md / .claude/rules/*.md | 人工编写的规则约束文件 |
| `session-note` | ~/.claude/session-memory/ | 会话中段压缩笔记 |
| `skill-metadata` | skills/*.md | 技能元数据（信息性，低优先级） |

### 3.4 更新后的整体架构：信号注入模式

当前代码中，每层各自拥有渲染逻辑：

- `renderer.ts` 渲染 Layer 1 的 `project-timeline.md` 和 `open-threads.md`
- `layer2.ts` 渲染 `work-patterns.md` 和 `tech-preferences.md`
- `layer3.ts` 渲染 `decisions.md`、`pain-points.md` 和 `work-profile.md`

Memory 集成**不重写这一架构**。Layer 0 产出 `MemorySignals` 中间结构，各层在渲染时读取与自己输出相关的 memory 信号，注入到已有数据中，统一输出。

```
┌─────────────────────────────────────────────────────────┐
│  Source Adapters（现有，不变）                            │
│  OpenCode (SQLite) | Claude Code (JSONL)                 │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────┼──────────────────────────────────┐
│  Memory Adapters（本 PRD 新增）                           │
│  OpenCode Memory | Claude Code Memory                    │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│  Layer 0: 收集 Memory 信号 → MemorySignals               │
│  （不写输出文件，仅产出结构化信号）                        │
└──────────────────────┬──────────────────────────────────┘
                       │ MemorySignals 传入各层
         ┌─────────────┼─────────────┐
         ▼             ▼             ▼
┌──────────────┐ ┌───────────┐ ┌───────────────┐
│ Layer 2      │ │ Layer 3   │ │ Layer 1       │
│ + techPrefs  │ │ + decs    │ │ (不变,Phase3B)│
│ 信号注入     │ │ + pain    │ │               │
│ → 2 files    │ │ + profile │ │ → 2 files     │
│              │ │ 信号注入  │ │               │
│              │ │ → 3 files │ │               │
└──────────────┘ └───────────┘ └───────────────┘
```

**数据流说明**：

- Layer 0 先于其他层运行，产出 `MemorySignals`（详见 §4.0）
- 各层保持各自的渲染逻辑不变，只是在渲染前额外接收 `MemorySignals` 中与自身输出相关的信号
- Layer 2 渲染 `tech-preferences.md` 时，合并 `MemorySignals.techPreferences`（来自 rules 文件的技术偏好）
- Layer 3 渲染 `decisions.md`/`pain-points.md`/`work-profile.md` 时，合并 `MemorySignals.decisions`/`.painPoints`/`.workProfile`（来自 auto memory）
- Layer 1 在 Phase 3A 不受影响；Phase 3B 再考虑 `project-timeline.md` 的 memory 标注
- **不引入集中式 Renderer 重写**——这是最小化改动的核心原则

### 3.5 项目路径规范化

MemoryAdapter 使用与主 PRD §2.4.3 中 AdapterRegistry **相同的路径规范化逻辑**。具体通过共享的 `canonicalizeProjectPath()` 工具函数实现：

- 展开 `~` 为绝对路径
- 解析 symlink
- 统一路径分隔符
- 去除末尾 `/`

`MemoryItem.canonicalProjectPath` 字段存储规范化后的路径，确保 Memory 来源的条目能与 Source Adapter 的项目路径正确匹配，合并到同一逻辑项目下。

此外，主 PRD §8.4 的 `project_aliases` 配置同样适用于 memory 文件的路径匹配——同一项目在不同机器上的路径差异，通过别名声明统一处理。

---

## 4. Layer 0 设计：Memory 信号收集

Layer 0 是一个纯文件解析层。输入是 MemoryAdapter 返回的 `MemoryItem` 列表，输出是填充完整的 `MemorySignals` 中间结构。全程零 AI 调用，**不写任何输出文件**。

`MemorySignals` 传递给各层现有的渲染器，在各层自己的渲染流程中与 session 数据合并。

### 4.0 MemorySignals 中间结构定义

这是 Layer 0 与各层渲染器之间的契约。每个信号桶对应一个目标输出文件，桶内信号的字段与该层已有的结构化类型对齐。

```typescript
/** Layer 0 输出，传递给各层渲染器 */
interface MemorySignals {
  /** → decisions.md（Layer 3 渲染器合并） */
  decisions: MemoryDecision[];
  /** → pain-points.md（Layer 3 渲染器合并） */
  painPoints: MemoryPainPoint[];
  /** → work-profile.md（Layer 3 渲染器合并） */
  workProfile: MemoryProfileEntry[];
  /** → tech-preferences.md（Layer 2 渲染器合并） */
  techPreferences: MemoryTechPreference[];
  /** Session notes — 供 Layer 3 用作压缩提示词线索（Phase 3B） */
  sessionNotes: Map<string, SessionNoteData>;
}

/**
 * 对齐 layer3.ts 的 Decision 类型。
 * stableId 和 sourceLabel 是 memory 专属字段，
 * 其余字段与 Layer 3 AI 提取的 Decision 结构相同。
 */
interface MemoryDecision {
  stableId: string;           // 用于增量替换追踪
  sourceLabel: string;        // '[CC-MEM]' | '[OC-MEM]'
  sourcePath: string;         // 原始 memory 文件路径（用于来源标注）
  projectName: string;
  date?: string;              // YYYY-MM-DD（从 frontmatter 或文件 mtime）
  what: string;               // 决策内容
  why?: string;               // 理由
  alternatives?: string[];    // 考虑过的替代方案
  trigger?: string;           // 触发背景
}

/**
 * 对齐 layer3.ts 的 PainPoint 类型。
 */
interface MemoryPainPoint {
  stableId: string;
  sourceLabel: string;
  sourcePath: string;
  projectName: string;
  problem: string;
  diagnosis?: string;
  solution?: string;
  likelyRecurring?: boolean;
}

/**
 * 对齐 layer3.ts 的 Preference 类型。
 */
interface MemoryProfileEntry {
  stableId: string;
  sourceLabel: string;        // '[CC-MEM]' | '[CC-RULE]' | '[OC-RULE]'
  sourcePath: string;
  category: string;           // '交互风格' | '语言偏好' | '技术审美' 等
  observation: string;
  evidence?: string;
}

/**
 * 对齐 layer2.ts 的 TechMention 聚合逻辑。
 * Layer 2 按技术名聚合后统计 sessionCount。
 * Memory 来源的技术偏好直接以确定性条目注入，不参与频次统计。
 */
interface MemoryTechPreference {
  stableId: string;
  sourceLabel: string;        // '[CC-RULE]' | '[OC-RULE]'
  sourcePath: string;
  category: string;           // '前端' | '后端' | 'AI' | '工具' | '部署'
  techName: string;
  description: string;
  projectNames?: string[];    // 涉及的项目
}

interface SessionNoteData {
  currentState?: string;
  worklog?: string;
  filesAndFunctions?: string;
  lastModified: number;
}
```

**设计原则**：

- 每个 Memory 信号类型的字段与对应层已有的结构化类型（`Decision`、`PainPoint`、`Preference`、`TechMention`）对齐，确保各层渲染器可以用最小改动合并 memory 条目
- `stableId` 是每个信号必带的字段，用于增量替换（见 §7）
- `sourceLabel` 和 `sourcePath` 是每个信号必带的字段，用于输出标注（见 §5）

### 4.1 Auto Memory 信号映射

Claude Code 的 Auto Memory 文件包含 YAML frontmatter 的 `type` 字段，作为主要路由信号。内容语义作为辅助路由信号。

| Memory 文件类型 | 内容特征 | 目标输出文件 | 合并方式 |
|---|---|---|---|
| `type: project` | 架构决策、技术选型理由 | `decisions.md` | 注入 Layer 3 的 Decision 数组，标注 `[CC-MEM]` |
| `type: feedback` | 踩坑记录、调试教训 | `pain-points.md` | 注入 Layer 3 的 PainPoint 数组，标注 `[CC-MEM]` |
| `type: user` | 用户偏好、交互习惯 | `work-profile.md` | 注入 Layer 3 的 Preference 数组 |
| `type: reference` | 技术参考、常用工具 | `tech-preferences.md` | 注入 Layer 2 的技术关键词聚合 |
| MEMORY.md 索引 | 跨类型摘要 | （Phase 3B 再决定） | Phase 3A 不路由；Phase 3B 评估是否注入 `project-timeline.md` |

**合并示例**（decisions.md 中的 memory 来源条目）：

```markdown
### 2026-03-20: 选择 WAL 模式 SQLite
- **背景**: 单机本地工具，不需要分布式
- **决定**: SQLite + WAL mode
- **理由**: 零运维，读并发优秀
- **来源**: [CC-MEM] ~/.claude/projects/-Users-you-project/memory/db-choice.md
```

### 4.2 Rules 信号映射

CLAUDE.md / AGENTS.md 不直接复制原始内容，而是提取**结构化信号**后存入 `MemorySignals`，由各层渲染器在自己的渲染流程中合并。原始规则文件保留原地供工具读取，session-memory 只提炼其中的偏好信息。

| 规则文件 | 提取信号 | 目标输出文件 |
|---|---|---|
| CLAUDE.md（全局/项目） | 技术栈偏好、工具声明、禁用技术 | `tech-preferences.md` |
| CLAUDE.md（工作方式描述） | 交互风格、语言偏好、验证习惯 | `work-profile.md` |
| AGENTS.md | 项目规则、架构约束 | `tech-preferences.md` |
| `.claude/rules/*.md`（含 paths:） | 条件路由规则（特定目录适用的规范） | `tech-preferences.md`（附路径注释） |

**提取规则**：

- 识别包含具体技术名词的段落（框架、库、工具名），提取为 `tech-preferences.md` 条目
- 识别包含"偏好"、"总是"、"不要"、"禁止"、"prefer"、"avoid" 等措辞的段落，提取为 `work-profile.md` 条目
- 不提取纯操作性规则（如"提交前运行 npm test"），这类信息不属于个人知识体

### 4.3 Session Notes 上下文增强

Claude Code 的 session-memory 笔记已经是压缩后的会话摘要，包含以下固定节：

```
Current State:        当前任务状态和进度
Files and Functions:  涉及的文件和函数
Worklog:              完成的工作记录
```

**Session ID 派生**：`~/.claude/session-memory/` 下的笔记文件，其文件名（去除 `.md` 扩展名后）即为对应的 session ID，与 Claude Code JSONL 存储中的 session ID 格式一致。例如 `ses_01abc123.md` 对应 session `ses_01abc123`。如文件名不符合 session ID 格式，则以文件内容哈希为 `stableId`，作为独立知识条目处理，不与特定 session 关联。

Layer 0 解析这些节并写入 `.last-extraction.json` 的 `memory` 键：

```json
{
  "memory": {
    "sessionNotes": {
      "<sessionId>": {
        "currentState": "...",
        "worklog": "...",
        "lastSeen": 1712345678000
      }
    }
  }
}
```

Layer 3 在构建提示词时，将 session notes 视为**压缩提示词的线索**，而非原始消息的完全替代。具体策略：

1. **高价值判断**：先用 session note 快速评估该 session 是否值得深度分析（成本远低于扫描全量消息）
2. **摘要前缀**：将 session note 作为 Layer 3 提示词的"摘要前言"，提供上下文后再附原始消息
3. **消息裁剪**：有 session note 时，可基于 note 内容更精准地裁剪要送入 AI 的原始消息（跳过 note 已覆盖的冗余部分）
4. **降级场景**：仅当原始消息不可用（如 Claude Code 30 天保留窗口外的历史 session）时，才退化为仅用 session note 作为内容

此方案相比"用 note 完全替代消息"的做法，保留了原始证据以供决策/痛点提取，同时仍显著降低 token 消耗。

**成本影响估算**：

| 场景 | 无 session notes | 有 session notes |
|---|---|---|
| Layer 3 输入 token（单 session） | 原始消息全量（可达数千 token） | note 前缀（200-500 token）+ 裁剪后消息（按 note 指导选取关键段） |
| 信息损失 | — | 极低（原始消息仍参与提取，note 只做裁剪指导） |

### 4.4 去重策略

Memory 文件和 Layer 3 从原始对话中提取的内容可能重叠。

**优先级规则**：Memory 来源的条目优先。Memory 文件的保真度更高（AI 写的是自己的工作记录），Layer 3 的外部提炼只在 Memory 未覆盖时补充。

**实现步骤**：

1. Layer 0 收集条目时，记录内容哈希到 `.last-extraction.json` 的 `memoryHashes` 集合
2. Layer 3 写入前，检查内容哈希是否已存在于 `memoryHashes`
3. 重叠则跳过 Layer 3 的该条目；不重叠则正常写入，标注 `[CC]` / `[OC]` 来源

哈希算法：对条目正文（去除标注和元数据后）取 SHA-256 前 16 字符，用于快速碰撞检测，不要求完全精确——宁可漏判不重复，不可误删有价值条目。

**v1 局限性说明**：SHA-256 精确哈希无法捕捉语义重复。Claude Code 的 autoDream 机制会每晚重写 auto memory 文件，改写后的文件与原文在语义上等价但内容不同，精确哈希会视为全新内容。v1 的应对方式是：当 autoDream 重写某个文件时，该文件的 `stableId` 不变（路径不变），`contentHash` 更新，增量策略会将旧输出**替换**为新输出（见 §7），不会重复追加，因此不产生重复条目。语义级别的去重（跨文件同义内容合并）是 Phase 3C 的工作，不在当前版本范围内。

### 4.5 Append 型文件的标记式替换

`decisions.md` 和 `pain-points.md` 在主 PRD 中定义为追加型（append-type）文件。Session 来源的条目保持追加语义不变，但 Memory 来源的条目需要支持**替换和撤回**（因为 memory 文件可被 autoDream 重写或删除）。

**实现方式**：Memory 来源的条目用 HTML 注释标记包裹，标记中嵌入 `stableId`：

```markdown
## [session-memory] 决策日志

<!-- mem:a3f8b2c1d4e5f6a7 -->
### 2026-03-20: 选择 WAL 模式 SQLite
- **背景**: 单机本地工具，不需要分布式
- **决定**: SQLite + WAL mode
- **理由**: 零运维，读并发优秀
- **来源**: [CC-MEM] ~/.claude/projects/.../memory/db-choice.md
<!-- /mem:a3f8b2c1d4e5f6a7 -->

### 2026-03-17: 选择 Drizzle ORM
- **来源**: session `ses_abc123` [OC] — "ORM 选型" (2026-03-17)
```

**替换逻辑**：

1. 渲染器输出 memory 条目时，用 `<!-- mem:{stableId} -->` 和 `<!-- /mem:{stableId} -->` 包裹
2. 下次渲染时，先在已有文件中查找匹配的 `stableId` 标记块：
   - 找到且 contentHash 已变 → 替换标记块内容
   - 找到但 stableId 不再出现在 MemorySignals 中 → 删除整个标记块（文件被删除的情况）
   - 未找到 → 正常追加（新文件首次处理）
3. Session 来源的条目（无标记）保持追加语义，不受影响

**聚合型文件不需要此机制**：`tech-preferences.md`、`work-profile.md` 等聚合型文件每次全量重建，memory 信号在重建时自然合并，无需标记。

---

## 5. 输出变更

### 5.1 新增来源标签

本 PRD 引入 4 个新标签，与主 PRD (PRD.md) §2.4.3 定义的 `[OC]` / `[CC]` 标签并列使用：

| 标签 | 含义 | 用例 |
|---|---|---|
| `[CC-MEM]` | Claude Code Auto Memory 来源 | `[CC-MEM] ~/.claude/.../memory/db.md` |
| `[CC-RULE]` | Claude Code 规则文件来源（CLAUDE.md / rules/） | `[CC-RULE] ~/.claude/CLAUDE.md` |
| `[OC-MEM]` | OpenCode Memory 来源（未来） | `[OC-MEM] .opencode/memory.md` |
| `[OC-RULE]` | OpenCode 规则文件来源（AGENTS.md） | `[OC-RULE] ./AGENTS.md` |

标签格式与主 PRD 保持一致：`[来源标签]` 跟随在条目末尾，与 session 引用并列。

### 5.2 不新增输出文件

记忆数据的接入不引入新的输出文件。现有 8 个文件的结构和格式（见主 PRD §6）保持不变，只是部分文件新增了来自 memory 的条目，通过标签标明来源。

### 5.3 格式示例

```markdown
## [session-memory] 决策日志

### 2026-04-01: 使用独立 MemoryAdapter 架构
- **背景**: SourceAdapter 面向会话数据，形态不匹配记忆文件
- **决定**: MemoryAdapter 独立层，平行于 SourceAdapter
- **理由**: 避免污染现有接口，允许记忆和会话接入独立演进
- **来源**: [CC-MEM] ~/.claude/projects/.../memory/adapter-design.md

### 2026-03-20: 选择 SQLite WAL 模式
- **来源**: session `ses_abc123` [OC] — "数据库讨论" (2026-03-20)
```

两类来源在同一文件中自然共存，用标签区分。

---

## 6. 配置

在现有 `config.yaml` 的 `sources` 块之后新增 `memory` 块：

```yaml
# Memory 层配置（追加到现有 config.yaml 中）
memory:
  enabled: true

  claude-code:
    auto_memory: true          # ~/.claude/projects/*/memory/ 下的 AI 自动记忆
    session_memory: true       # ~/.claude/session-memory/ 下的会话压缩笔记
    rules: true                # CLAUDE.md + .claude/rules/*.md
    subagent_memory: false     # .claude/agent-memory/ — 默认关闭，信号价值偏低
    # memory_dir: "~/.claude"  # 可覆盖 Claude Code 数据根目录（默认自动检测）

  opencode:
    agents_md: true            # AGENTS.md 文件（项目级 + 全局）
    directory_agents: false    # storage/directory-agents/ — 默认关闭，元数据价值为主
    rules_injector: false      # storage/rules-injector/ — 默认关闭
    skills: false              # skills 文件 — 信息性，不含用户知识

  # Memory 来源标签（用于输出 Markdown 中的标注）
  source_labels:
    claude-code-memory: "CC-MEM"
    claude-code-rule: "CC-RULE"
    opencode-memory: "OC-MEM"
    opencode-rule: "OC-RULE"
```

**配置优先级**：`memory.enabled: false` 时完全跳过 Layer 0 和所有 MemoryAdapter，不影响现有 Layer 1/2/3 行为。各子项的 `false` 只跳过该类型的文件，其余照常处理。

---

## 7. 增量策略

### 7.1 stableId + contentHash + lastSeen 方案

记忆文件不像对话历史那样 append-only。Claude Code 的 autoDream 机制会每晚重写 auto memory 文件。Session notes 在会话结束后写入一次，之后不变。Rules 文件由人工维护，改动频率低但不规律。

仅用 mtime 追踪不够可靠：文件可能被 touch 而内容未变（误触发重处理），或被删除后留下 stale 条目，或 autoDream 重写导致追加型文件积累重复条目。

增量策略改用 **`stableId + contentHash + lastSeen`** 三元组：

- **`stableId`**：由文件路径派生的稳定标识符，跨运行不变。路径规范化后取 SHA-256 前 16 字符作为 ID。autoDream 重写同一文件时，stableId 保持不变
- **`contentHash`**：当前文件内容的 SHA-256 前 16 字符。检测真实内容变化，区分"文件被 touch"和"内容被修改"
- **`lastSeen`**：本次提取运行看到该文件时的时间戳（Unix ms）

**每次运行的处理逻辑**：

1. 遍历所有 memory 文件，计算每个文件的 stableId 和 contentHash
2. 对比 `.last-extraction.json` 中已记录的值：
   - `contentHash` 未变 → 跳过，不重处理
   - `contentHash` 已变 → 重新解析，**替换**（不追加）旧输出中该 stableId 对应的所有条目
   - stableId 是新出现的 → 首次处理，写入输出
3. 本次运行结束后，检查上次记录中哪些 stableId 本次没有出现 → 标记为 stale，从输出中撤回对应条目
4. 更新 `.last-extraction.json`，记录本次所有已见文件的 stableId + contentHash + lastSeen

此方案正确处理三类场景：内容更新（contentHash 变化，替换旧输出）、文件删除（stableId 消失，撤回条目）、文件重写（stableId 稳定，contentHash 更新，替换而非追加）。

### 7.2 `.last-extraction.json` memory 键结构

```json
{
  "sessions": { "...": "..." },
  "memory": {
    "files": {
      "a3f8b2c1d4e5f6a7": {
        "path": "~/.claude/projects/-Users-you-project/memory/db-choice.md",
        "contentHash": "b1c2d3e4f5a6b7c8",
        "lastSeen": 1712345678000
      },
      "f9e8d7c6b5a4f3e2": {
        "path": "~/.claude/CLAUDE.md",
        "contentHash": "c3d4e5f6a7b8c9d0",
        "lastSeen": 1712345678000
      }
    },
    "memoryHashes": [
      "a3f8b2c1d4e5f6a7",
      "b1c2d3e4f5a6b7c8"
    ],
    "sessionNotes": {
      "<sessionId>": {
        "currentState": "...",
        "worklog": "...",
        "lastSeen": 1712345678000
      }
    }
  }
}
```

### 7.3 各类型增量策略

| 文件类型 | 增量策略 | 理由 |
|---|---|---|
| Auto Memory（AI 生成） | stableId + contentHash：hash 不变则跳过，hash 变则替换 | autoDream 整体重写，替换而非追加才能避免重复条目 |
| Session Notes | stableId + contentHash：仅处理新增或内容变化的文件 | 通常写入后不变；新 session 才会产生新文件 |
| CLAUDE.md / AGENTS.md | 每次运行必读（小文件，成本可忽略）；contentHash 变化时替换输出 | 人工改动无规律，文件小，全量重读成本可忽略 |
| Rules 文件 | 同上 | 同上 |

### 7.4 强制重新处理

`extract --reset-memory` 标志：清除 `memory.files`、`memory.memoryHashes` 和 `memory.sessionNotes`，强制重新处理所有记忆文件。适用于输出文件损坏或规则逻辑调整后的修复场景。

---

## 8. 分阶段交付

### Phase 3A（P0）— Claude Code Auto Memory + CLAUDE.md Rules

**目标**：最高 ROI 的两个数据源优先接入，最小化架构改动。

**交付内容**：

- `ClaudeCodeMemoryAdapter` 实现
  - `listMemoryItems()`: glob `~/.claude/projects/*/memory/*.md`，解析 YAML frontmatter，返回 `kind: 'auto-memory'` 条目；读取 `~/.claude/CLAUDE.md`、`./CLAUDE.md`、`.claude/CLAUDE.md`，返回 `kind: 'rule'` 条目
  - **不含** session-note 接入（Phase 3B）
- 基础路径规范化（展开 `~`、解析 symlink、去末尾 `/`），供 MemoryAdapter 和 SourceAdapter 共用。Phase 3B 再正式提取为 `canonicalizeProjectPath()` 并支持 `project_aliases`
- Layer 0 信号收集逻辑，产出 `MemorySignals`（§4.0 定义的结构）
  - Auto Memory 按 YAML type 路由到 `decisions`、`painPoints`、`workProfile`、`techPreferences` 信号桶
  - Rules 文件提取技术偏好和工作风格信号
- Layer 2 渲染器改动：接收 `MemorySignals.techPreferences`，在 `tech-preferences.md` 全量重建时合并 memory 条目
- Layer 3 渲染器改动：接收 `MemorySignals.decisions`/`.painPoints`/`.workProfile`，在 `decisions.md`（标记式追加）、`pain-points.md`（标记式追加）、`work-profile.md`（全量重建）中合并 memory 条目
- `.last-extraction.json` 新增 `memory` 键（stableId + contentHash + lastSeen 追踪）
- 新来源标签 `[CC-MEM]`、`[CC-RULE]`

**不含**：OpenCode 接入、session-note 接入、Layer 3 上下文增强、project-timeline.md 的 memory 标注、正式的 `canonicalizeProjectPath()` 和 `project_aliases` 支持。

**验收标准**：
- `ClaudeCodeMemoryAdapter.detect()` 正确检测 `~/.claude/projects/` 目录可用性
- Auto Memory 文件按 YAML type 正确路由到对应输出文件
- YAML frontmatter 缺失或异常的文件被跳过，CLI 输出警告
- `decisions.md` 和 `pain-points.md` 中的 memory 条目带有 `<!-- mem:stableId -->` 标记
- 重复运行时，contentHash 未变的文件被跳过；contentHash 变化的文件替换旧输出
- Memory 条目在输出中带有 `[CC-MEM]` 或 `[CC-RULE]` 来源标签

### Phase 3B（P1）— OpenCode AGENTS.md + Session Notes + Timeline 标注

**目标**：接入 OpenCode 规则；启用 Layer 3 成本优化；评估 timeline memory 标注。

**交付内容**：

- `OpenCodeMemoryAdapter` 实现
  - `listMemoryItems()`: 读取 `./AGENTS.md`、`~/.config/opencode/AGENTS.md`，返回 `kind: 'rule'` 条目；解析 `opencode.json` 的 `instructions` 指针；`kind: 'auto-memory'` 条目暂返回空（等待 `.opencode/memory.md` 发布）
- Session-note 接入：`ClaudeCodeMemoryAdapter` 扩展 glob `~/.claude/session-memory/`，返回 `kind: 'session-note'`
- Layer 3 增强：以 session notes 为压缩提示词线索（见 §4.3），而非完全替代原始消息
- 正式提取 `canonicalizeProjectPath()` 工具函数，支持 `project_aliases`
- 评估 `MEMORY.md` 索引 → `project-timeline.md` 标注的可行性。如可行，更新主 PRD 的 timeline 语义定义
- 新来源标签 `[OC-RULE]`、`[OC-MEM]`

### Phase 3C（P2）— 完整接入

**目标**：覆盖所有低优先级数据源，跨源去重优化。

**交付内容**：

- Subagent Memory 接入（`claude-code.subagent_memory: true` 解锁）
- Directory Agents / Rules Injector 的元数据分析
- Skills 文件的工具使用模式提取
- 跨源 memory 语义去重（同一知识点在 CC-MEM 和 Layer 3 双重出现时的语义合并，超越 v1 的精确哈希方案）
- OpenCode `.opencode/memory.md` 正式支持（跟随工具发布时间）

---

## 9. 注意事项

### 9.1 隐私

记忆文件可能包含敏感的项目知识、代码片段、架构细节。与主 PRD (PRD.md) §7 的原则一致，session-memory 只在本地运行，所有输出文件保留在本地。记忆文件不上传、不外传、不写入任何远程服务。

### 9.2 格式稳定性

Claude Code 的 Auto Memory 格式（YAML frontmatter 字段、目录结构）属于工具内部实现，可能在版本升级时变更。Adapter 需要对格式变更保持弹性：

- YAML frontmatter 缺失或格式异常时，**跳过该文件并记录警告到 CLI 输出**。不默认路由到任何特定输出文件——误路由比遗漏更有害。用户可手动为文件添加正确的 frontmatter 后重跑
- `type` 字段值不在预期范围（`project` / `feedback` / `user` / `reference`）内时，同样跳过并记录警告
- 目录结构变化时，通过在 config.yaml 的 `memory.claude-code` 下新增 `memory_dir` 字段覆盖默认路径

### 9.3 OpenCode Memory 的未来兼容

`.opencode/memory.md`（GitHub issue #16077）尚未发布。`OpenCodeMemoryAdapter.listMemoryItems()` 在 Phase 3B 交付时对 `kind: 'auto-memory'` 返回空数组，但接口已就绪。工具发布后，只需在实现中添加文件读取逻辑，无需改动 Layer 0 或输出映射。

### 9.4 成本影响

Layer 0 本身零 AI 成本。Layer 3 的增强（以 session notes 为提示词线索）**降低**了整体成本：有 session notes 覆盖的 session，Layer 3 的输入 token 减少明显，同时保留了提取决策和痛点所需的原始证据。预计 Phase 3B 之后，Layer 3 总成本可减少 30-50%（取决于 session notes 的覆盖率）。

### 9.5 命名约定

所有配置键、代码中的 source 字段、标签路由使用 **kebab-case**：`claude-code`、`opencode`。这与代码中 `SourceAdapter.name` 的实际值（`src/adapters/claude-code.ts`、`src/adapters/opencode.ts`）保持一致，避免配置解析和标签路由时出现大小写不匹配的 bug。不使用 snake_case（`claude_code`）作为 source 标识符。

---

## 10. Changelog

| 版本 | 日期 | 作者 | 变更 |
|---|---|---|---|
| v0.1 | 2026-04-07 | — | 初稿，覆盖 Claude Code + OpenCode 全部记忆数据源、MemoryAdapter 接口、Layer 0 设计、三阶段交付计划 |
| v0.2 | 2026-04-07 | — | 架构评审修订。(1) Layer 0 重定义为"信号收集"而非"写文件"，引入 MemorySignals 中间结构，修复 FULL REBUILD 文件被多次写入覆盖的问题。(2) 增量策略从 mtime 改为 stableId + contentHash + lastSeen 三元组，正确处理 autoDream 重写、文件删除和 stale 条目。(3) MemoryAdapter 接口简化为单一 listMemoryItems() 方法，通过 kind 判别联合类型扩展。(4) 新增 §3.5 路径规范化节。(5) 配置键统一为 kebab-case。(6) Session notes 从"替代原始消息"改为"压缩提示词线索"。(7) 明确 SHA-256 精确哈希的 v1 局限性。 |
| v0.3 | 2026-04-07 | — | 二审修订。(1) 新增 §4.0 MemorySignals 具体 schema 定义（MemoryDecision/PainPoint/ProfileEntry/TechPreference 等完整 TypeScript 接口），从概念落地为可实现的契约。(2) §3.4 架构从"集中式 Renderer 单次渲染"改为"信号注入现有各层渲染器"，不要求 pipeline 重构，与当前 layer1/layer2/layer3 各自渲染的代码架构对齐。(3) Phase 3A 范围缩小：移除 session-note 接入、正式 canonicalize 函数、project-timeline memory 标注，聚焦 Claude auto memory + rules 的最小可交付。新增验收标准。(4) 新增 §4.5 append 型文件的标记式替换机制（`<!-- mem:stableId -->`），解决 memory 条目在 decisions.md/pain-points.md 中的替换和撤回问题。(5) §9.2 malformed frontmatter fallback 从"默认追加到 decisions.md"改为"跳过并记录警告"。(6) MEMORY.md → project-timeline.md 映射从 Phase 3A 推迟到 Phase 3B 评估。 |
