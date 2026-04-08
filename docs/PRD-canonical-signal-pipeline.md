# PRD: Canonical Signal Pipeline 架构重设计
> session-memory 从「文件中心」到「信号中心」的根本性架构升级

- 版本: v0.2
- 日期: 2026-04-08
- 状态: Draft
- 关联: 主 PRD (PRD.md), Memory PRD (PRD-memory-integration.md)

---

## §0 一句话

引入 Canonical Signal Pipeline，将内部数据模型从「渲染用文本」变为「结构化知识声明」，通过统一质量关卡、确定性去重、输出预算三道防线，从根本上解决输出质量问题。

补充说明：本文档自 v0.2 起正式替代 `PRD-memory-integration.md` 中「MemoryAdapter + 各层 signal 注入 + 输出侧记忆来源分节」的目标架构设计。该文档 §2 的数据源清单仍然是有效参考；但其 §3-§4 的目标架构由本文取代。`PRD-memory-integration.md` 中已落地的 Phase 3A 实现继续作为迁移期过渡代码保留，直到本文 Phase 2 完成 memory 迁移切换。

---

## §1 问题陈述

当前 session-memory 的主要问题，不在于提取能力不足，而在于系统的中心对象选错了：系统围绕“要产出哪些 markdown 文件”组织流程，而不是围绕“要沉淀哪些可信知识声明”组织流程。结果是每一层都在局部优化自己的文本输出，却没有一套共享的知识模型、共享的质量标准、共享的合并机制。

### 1.1 七个根因

#### 1. 无质量关卡

当前流程允许“可疑、重复、过长、无归纳”的文本直接进入最终输出。只要某一层提取到了文字，往往就会被保留，而不是先判断它是否构成一个高质量信号。

具体产出示例：

- `技术偏好.md` 中，同一段“偏好 Next.js/React/Tailwind 的组合”可能分别以不同措辞出现在多个分类下。
- `工作画像.md` 中，存在“把对话原句稍微改写一下就输出”的条目，读起来像聊天记录残片，而不是结构化画像。

#### 2. 无规范化信号存储

当前各层通常直接产出渲染条目，缺失“中间规范化层”。这意味着：

- Layer 2 有自己的关键词与偏好组织方式
- Layer 3 有自己的总结与合并方式
- Memory 层有自己的记忆结构

结果是去重各自为政，跨层无法共享去重结果，也无法共享信号质量判断。

#### 3. 关键词提取产生噪音

现有技术偏好提取中，`buildTechPreferencesFromContent` 一类逻辑可能把整段文本直接回显为“偏好描述”。系统原本想提炼“偏好”，但实际得到的是“原文片段”。

具体产出示例：

- 一个本应表达“偏好 TypeScript 严格模式”的条目，最终却变成包含上下文整段解释、甚至连同不相关背景语句一起被渲染出来。
- 分类标签是“前端框架”，正文却是半段会话摘录。

#### 4. Consolidation 脆弱

当前大 consolidation 依赖单次 AI 调用，导致合并成功与否高度依赖提示词、模型状态和输入规模。一旦模型没有真正压缩，就会出现“1102 → 1102”的零压缩结果：处理花了成本，但输出几乎没有收敛。

具体产出示例：

- 同一类工作习惯被保留成几十个近似句子，只有措辞略有不同。
- 某次 consolidation 因上下文过长或模型保守，返回“基本照抄”的汇总，导致文件持续膨胀。

#### 5. 无输出预算

当前系统缺乏面向消费场景的硬预算控制。只要不断新增信号，文件就持续增长，没有明确的“保留多少条才对下游最有用”的限制。

具体产出示例：

- `工作画像.md` 已达到 1140 行，超过大多数 AI 工具在冷启动时愿意稳定消费的篇幅。
- `项目时间线.md` 和 `未完成线索.md` 在活跃项目较多时存在持续变长趋势，但没有统一的截断策略与优先级原则。

#### 6. Session 过滤各层各做

哪些 session 有价值、哪些 session 是噪音，目前由不同层各自判断。于是：

- Layer 2 按自己的启发式做过滤
- Layer 3 按自己的评分做过滤
- Memory 层几乎不复用会话过滤经验

系统缺少共享质量分类器，导致同一 session 在某层被当噪音、在另一层又被当高价值输入，标准不一致。

#### 7. Memory 集成感觉像“贴补”

当前 Memory 集成虽然提升了信号密度，但在结构上仍然像给现有流程额外开了一个“记忆来源”入口，而不是成为统一知识管道中的原生证据。

具体产出示例：

- 输出中容易形成独立的“记忆来源”节，与对话提取得到的内容并列出现。
- 来自 `CLAUDE.md` 的高信任偏好，与 session 中重复出现的行为模式，不能自然合并成一条更强的规范化信号。

### 1.2 根本缺陷

根本缺陷是：系统是 file-centric，而不是 claim-centric。

- file-centric：先想“我要生成技术偏好.md、工作画像.md”，再让每一层拼文本。
- claim-centric：先想“我要形成哪些可信声明”，然后再把这些声明编译成不同视图。

前者优化的是“写出文件”，后者优化的是“构建可信记忆”。当前所有质量问题，几乎都能追溯到这一中心对象错位。

换言之，旧 memory integration 方案虽然补上了高价值来源，但仍然是在 file-centric 主干上做“旁路注入”；v0.2 的目标是把 memory 提升为统一证据主干中的原生输入，而不是输出层补丁。

---

## §2 目标架构

目标架构不是增加一个新提取层，而是重建内部主干：所有来源统一先产出信号候选，经过共享质量关卡与规范化合并后，才进入面向文件的视图编译阶段。

### 2.1 架构总览

```text
┌────────────────────────────────────────────────────────────────────┐
│                           证据输入层                               │
│  对话消息 / Todo / Session Notes / Auto Memory / Rules / CLAUDE   │
└───────────────┬───────────────────────────────┬────────────────────┘
                │                               │
                ▼                               ▼
      ┌──────────────────┐            ┌──────────────────┐
      │ EvidenceRecord   │            │ EvidenceRecord   │
      │  对话证据        │            │  记忆证据        │
      └────────┬─────────┘            └────────┬─────────┘
               └──────────────┬────────────────┘
                              ▼
                    ┌────────────────────┐
                    │ SignalCandidate     │
                    │ 候选信号提取层      │
                    └─────────┬──────────┘
                              ▼
                    ┌────────────────────┐
                    │ QualityGate         │
                    │ 统一质量关卡        │
                    └─────────┬──────────┘
                              ▼
                    ┌────────────────────┐
                    │ Canonical Merge     │
                    │ 规范化合并引擎      │
                    └─────────┬──────────┘
                              ▼
                    ┌────────────────────┐
                    │ CanonicalSignal     │
                    │ 规范化信号仓        │
                    └─────────┬──────────┘
                              ▼
                    ┌────────────────────┐
                    │ View Compiler       │
                    │ 排序 + 预算 + 渲染  │
                    └─────────┬──────────┘
                              ▼
                    ┌────────────────────┐
                    │ PublishedView       │
                    │ markdown 输出       │
                    └────────────────────┘
```

### 2.2 核心生命周期

```text
EvidenceRecord
  → SignalCandidate
  → CanonicalSignal
  → PublishedView
```

含义如下：

1. `EvidenceRecord`：原始但带元数据的证据单元。
2. `SignalCandidate`：从证据中抽取出的结构化候选声明。
3. `CanonicalSignal`：经过质量关卡与合并后的规范化声明。
4. `PublishedView`：按消费场景编译出的 markdown 视图。

### 2.3 六条设计原则

1. 先有信号，后有文件
   - 文件只是视图，不再是系统内部的主数据结构。

2. 所有来源一视同仁进入同一主干
   - 对话、memory、rules 都先变成证据，再变成候选信号。

3. 质量先于覆盖率
   - 不因“可能有点用”而放行低质量信号。

4. 确定性优先于生成式
   - 去重、聚类、合并尽量先走可解释的确定性规则；AI 仅用于小簇重写。

5. 输出必须有预算
   - 每个视图只保留最值得被 AI 和人类重复消费的内容。

6. 状态持久化面向增量演进
   - 保存证据指纹、候选缓存、规范化信号和视图产物，支持低成本增量更新与未来迁移。

---

## §3 核心抽象

本节定义 Canonical Signal Pipeline 的核心类型。以下接口为目标接口，不要求一次性全部落地，但要求未来实现围绕这些抽象演进。

### 3.1 EvidenceRecord

```typescript
export type EvidenceSourceKind =
  | 'session_message'
  | 'session_todo'
  | 'session_summary'
  | 'memory_file'
  | 'rule_file'
  | 'session_note'
  | 'derived_note';

export interface EvidenceRecord {
  id: string;
  sourceKind: EvidenceSourceKind;
  sourceLabel: string;           // 'claude-code' | 'opencode' | 'manual-rule'
  projectId?: string;
  projectName?: string;
  canonicalProjectPath?: string;

  sessionId?: string;
  messageId?: string;
  todoId?: string;
  filePath?: string;

  content: string;
  contentHash: string;
  capturedAt: number;            // Unix ms
  observedAt?: string;           // 业务时间，如 session 日期
  authorRole?: 'user' | 'assistant' | 'system' | 'tool';

  trustScore: 1 | 2 | 3 | 4 | 5;
  recencyScore: number;          // 0-1
  extractionHints?: string[];    // 如: ['tech-preference', 'decision']
  metadata?: Record<string, string | number | boolean | string[]>;
}
```

设计要点：

- `EvidenceRecord` 是统一入口，替代“不同层直接读不同原始结构”。
- `trustScore` 是后续质量判断与合并排序的重要输入。
- `contentHash` 与来源标识共同支撑增量更新。
- 所有时间戳字段统一使用 Unix ms（`number`）；所有字符串日期字段（如 `observedAt`、各类 payload 中的 `date`）统一使用 ISO 8601 `YYYY-MM-DD` 格式，避免同一管道中混用本地化时间文本。

### 3.2 SignalCandidate

```typescript
export type SignalKind =
  | 'decision'
  | 'tech_preference'
  | 'pain_point'
  | 'work_style'
  | 'profile_fact'
  | 'timeline_event'
  | 'open_thread';

export interface SignalCandidateBase {
  id: string;
  kind: SignalKind;
  evidenceIds: string[];
  primaryEvidenceId: string;
  projectId?: string;
  projectName?: string;
  confidence: number;            // 0-1
  trustScore: 1 | 2 | 3 | 4 | 5;
  observedAt?: string;
  extractor: string;             // 'layer0-memory' | 'layer2-pattern' | 'layer3-ai'
  rawText?: string;
  fingerprint?: string;
  canonicalKeyHint?: string;
}

export interface DecisionPayload {
  topic: string;
  decision: string;
  rationale: string;
  alternatives: string[];
  trigger?: string;
  scope: 'project' | 'cross_project' | 'personal';
}

export interface TechPreferencePayload {
  category: string;
  technology: string;
  stance: 'prefer' | 'avoid' | 'conditional';
  rationale: string;
  conditions?: string[];
}

export interface PainPointPayload {
  problem: string;
  symptoms?: string[];
  diagnosis?: string;
  workaround?: string;
  recurrence: 'low' | 'medium' | 'high';
}

export interface WorkStylePayload {
  dimension: string;
  claim: string;
  rationale?: string;
  frequency?: 'once' | 'repeated' | 'habitual';
}

export interface ProfileFactPayload {
  dimension: 'role' | 'responsibility' | 'focus_area';
  claim: string;
  scope: 'global' | 'project';
  rationale?: string;
}

export interface TimelineEventPayload {
  eventType: 'milestone' | 'decision' | 'incident' | 'delivery' | 'refactor';
  title: string;
  summary: string;
  date: string;
}

export interface OpenThreadPayload {
  threadType: 'todo' | 'risk' | 'question' | 'followup';
  title: string;
  status: 'open' | 'blocked' | 'in_progress';
  nextAction?: string;
  ownerHint?: string;
}

export type SignalCandidate =
  | (SignalCandidateBase & { kind: 'decision'; payload: DecisionPayload })
  | (SignalCandidateBase & { kind: 'tech_preference'; payload: TechPreferencePayload })
  | (SignalCandidateBase & { kind: 'pain_point'; payload: PainPointPayload })
  | (SignalCandidateBase & { kind: 'work_style'; payload: WorkStylePayload })
  | (SignalCandidateBase & { kind: 'profile_fact'; payload: ProfileFactPayload })
  | (SignalCandidateBase & { kind: 'timeline_event'; payload: TimelineEventPayload })
  | (SignalCandidateBase & { kind: 'open_thread'; payload: OpenThreadPayload });
```

设计要点：

- 所有候选信号都必须绑定证据，而不是凭空生成。
- `payload` 强类型化，避免“把一段文本塞进 observation”式逃逸。
- `fingerprint` 用于精确去重；`canonicalKeyHint` 用于宽松聚类。
- `profile_fact` 用于承接稳定、可复用、证据支撑充分的画像事实，避免把“角色/职责/关注领域”混在 `work_style` 的行为类声明里。

### 3.3 QualityGate

```typescript
export type QualityDecision = 'accept' | 'reject' | 'needs_merge';

export interface QualityIssue {
  code:
    | 'too_vague'
    | 'too_long'
    | 'echo_raw_text'
    | 'missing_required'
    | 'missing_rationale'
    | 'weak_evidence'
    | 'single_occurrence_low_trust'
    | 'no_actionability'
    | 'invalid_date';
  message: string;
}

export interface QualityGateResult {
  candidateId: string;
  decision: QualityDecision;
  score: number;                 // 0-100
  issues: QualityIssue[];
}

export interface QualityGate {
  evaluate(candidate: SignalCandidate, supportingEvidence: EvidenceRecord[]): QualityGateResult;
}
```

补充边界说明：重复检测是合并阶段（§4.4）的职责，不属于质量关卡。质量关卡只评估单条候选信号的内在质量。
质量关卡接口因此不接收 canonical state context；是否与现有 canonical signal 重复、冲突或可合并，统一留给 merge 层处理。

#### 各信号类型的硬规则

1. decision
   - `decision` 不能为空，且不能只是“做了优化”“改了实现”之类泛化表述。
   - `rationale` 至少包含一个具体原因。
   - 至少满足以下之一：
     - 证据信任分 >= 4
     - 多条独立证据支持
     - 来自明确决策语义的 session 片段

2. tech_preference
   - `technology` 必须是规范技术名，不能是一整段原文。
   - `rationale` 不能为空。
   - 若 `stance = conditional`，必须有 `conditions`。
   - 原始文本长度若远大于归纳结果，且归纳结果与原文高度重叠，判定为 `echo_raw_text`。

3. pain_point
   - `problem` 必须可复述为具体工程问题，不能是“这里有点麻烦”。
   - 至少有 `diagnosis` 或 `workaround` 之一。
   - 单次低信任抱怨且无后续证据，不进入规范化层。

4. work_style
   - 必须描述稳定行为模式，而不是单次事件。
   - 若 `frequency = once` 且证据仅一条，默认拒绝。
   - `claim` 不得直接复制会话原句超过设定重叠阈值。

5. profile_fact
   - `claim` 必须是稳定且有证据支撑的画像事实，而不是一次性操作记录。
   - 拒绝原聊天段落回显、长句照抄、上下文过重的原文拼接。
   - 若 `scope = global`，不得把项目局部执行细节误写成全局画像事实。
   - 角色、职责、关注领域类事实默认要求 `trustScore >= 4` 或至少两条独立证据支撑。

6. timeline_event
   - `date` 必须可解析。
   - `title` 不得为空。
   - 同日同项目同标题指纹重复时，进入合并而非重复保留。

7. open_thread
   - 必须包含明确未完成状态。
   - `title` 不能只是“继续处理”“看一下”。
   - 若已在新证据中明确关闭，应在视图阶段隐藏或降级，而不是继续输出。

### 3.4 CanonicalSignal

```typescript
export interface CanonicalSignalBase {
  id: string;
  kind: SignalKind;
  canonicalKey: string;
  fingerprintSet: string[];
  status: 'active' | 'superseded' | 'archived';

  projectIds: string[];
  projectNames: string[];
  evidenceIds: string[];
  sourceLabels: string[];

  trustScore: 1 | 2 | 3 | 4 | 5;
  confidence: number;            // 0-1
  supportCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
  lastPublishedAt?: number;

  summary: string;
  mergeNotes?: string[];
}

export type CanonicalSignal =
  | (CanonicalSignalBase & { kind: 'decision'; payload: DecisionPayload })
  | (CanonicalSignalBase & { kind: 'tech_preference'; payload: TechPreferencePayload })
  | (CanonicalSignalBase & { kind: 'pain_point'; payload: PainPointPayload })
  | (CanonicalSignalBase & { kind: 'work_style'; payload: WorkStylePayload })
  | (CanonicalSignalBase & { kind: 'profile_fact'; payload: ProfileFactPayload })
  | (CanonicalSignalBase & { kind: 'timeline_event'; payload: TimelineEventPayload })
  | (CanonicalSignalBase & { kind: 'open_thread'; payload: OpenThreadPayload });
```

设计要点：

- `CanonicalSignal` 才是系统内部长期持有的“知识声明”。
- 一条规范化信号可以绑定多条证据、多项目、多来源。
- `summary` 是对外展示友好的短摘要，但不再等同于唯一数据载体。

### 3.5 ViewBudget 与 PublishedView

```typescript
export type ViewBuildMode = 'full_rebuild' | 'append_only' | 'rolling_window';

export interface ViewBudget {
  viewId: string;
  buildMode: ViewBuildMode;
  maxSignals?: number;
  maxChars: number;
  maxSections?: number;
  maxItemsTotal?: number;
  maxItemsPerSection?: number;
  sections?: string[];
  overflowPolicy: 'truncate' | 'summarize' | 'drop_low_score';
}

export interface PublishedViewSection {
  title: string;
  signalIds: string[];
  markdown: string;
}

export interface PublishedView {
  viewId: string;
  title: string;
  generatedAt: number;
  sourceSignalIds: string[];
  budget: ViewBudget;
  sections: PublishedViewSection[];
  markdown: string;
}
```

#### 视图类型

1. `full_rebuild`
   - 每次从当前 canonical store 全量取数并重建目标文件。
   - 适用于 `技术偏好.md`、`工作画像.md` 一类聚合视图。

2. `append_only`
   - 以追加为主，但追加条目仍必须来自 canonical signal，而不是直接写原始提取结果。
   - 适用于带时间顺序的日志型视图。

3. `rolling_window`
   - 基于滑动时间窗口选择 canonical signal，只保留最近 N 天内最有价值的子集。
   - 与 append-style 的区别是：窗口外内容会自然退出视图；与 full rebuild 的区别是：它有明确的时间边界和窗口预算。

#### 新增发布视图：`weekly_focus`

```typescript
const weeklyFocusBudget = {
  viewId: 'weekly_focus',
  buildMode: 'rolling_window',
  maxChars: 6000,
  maxItemsTotal: 30,
  maxItemsPerSection: 12,
  sections: ['进行中', '已完成', '关键决策'],
  overflowPolicy: 'drop_low_score',
};
```

`weekly_focus`（发布文件：`本周重点.md`）规则：

- `进行中`：`open_thread` 信号，且 `lastSeenAt` 距当前不超过 3 天。
- `已完成`：7 天内的 `timeline_event`，并带有完成语义（如 deploy、review 通过、完成）。
- `关键决策`：7 天内的 `decision`。
- 每条格式统一为 `- [项目名] 一句话描述`。
- 空分区省略不输出。
- 窗口过滤优先使用业务日期；无业务日期时回退到 `lastSeenAt`。

#### 每文件推荐预算值

| 文件 | 推荐信号上限 | 推荐字符上限 | 说明 |
|---|---:|---:|---|
| `技术偏好.md` | 40 | 12000 | 高价值偏好应少而精，跨项目归并后输出 |
| `工作画像.md` | 30 | 10000 | 只保留可重复消费的稳定习惯 |
| `本周重点.md` | 30 | 6000 | 滚动窗口视图，只保留最近一周最值得持续关注的事项 |
| `决策日志.md` | 50 | 16000 | 按时间倒序保留高影响决策 |
| `反复痛点.md` | 35 | 12000 | 只保留复发性高、可操作性强的问题 |
| `项目时间线.md` | 80 | 18000 | 允许较多事件，但每事件必须短摘要 |
| `未完成线索.md` | 60 | 12000 | 只保留仍开放且优先级较高的线程 |
| `工作模式.md` | 24 | 8000 | 更偏概览性视图，应压缩得更紧 |

### 3.6 RelevanceClassifier

```typescript
type RelevanceClass =
  | 'noise'
  | 'generic_execution'
  | 'decision_rich'
  | 'preference_rich'
  | 'pain_rich'
  | 'timeline_fact'
  | 'todo_fact';

interface RelevanceClassifier {
  classify(evidence: EvidenceRecord): RelevanceClass;
}
```

分类规则：

- `noise`
  - session 标题匹配 `Background:`、`look_at:`、`hello`、`echo`、`<local-command-caveat>`、测试会话标题。
  - 内容明显为工具回显、寒暄、探针命令、空白对话或占位测试。
- `generic_execution`
  - 仅体现例行编码推进，不包含显式决策、偏好、约束、痛点或里程碑。
  - relevance score 低于阈值（建议初始阈值 `0.35`）时归入该类。
- `decision_rich`
  - 含 trade-off、alternatives、"chose X over Y"、"改用/放弃/选择" 等决策语言。
- `preference_rich`
  - 含偏好、约束、风格、禁用项、必须/不要/优先/倾向 等语言。
- `pain_rich`
  - 含 error/debug/fix/workaround、报错、排查、绕过、修复、踩坑、根因 等语言。
- `timeline_fact`
  - 明确表达里程碑、交付、review 通过、上线、发布、重构完成等时间线事实。
- `todo_fact`
  - 含显式 todo、待办、下一步、待跟进、blocked、in progress 等未闭环事项。

使用时点：`RelevanceClassifier` 从 Phase 1 即进入主干，用于 evidence 预筛选与候选提取路由；Phase 4 只是在 timeline/open_thread/weekly_focus 等后续视图上进一步复用，而不是到 Phase 4 才引入。

---

## §4 数据流

### 4.1 证据收集

目标：把所有原始来源统一转换为 `EvidenceRecord`。

输入来源包括：

- 对话消息
- Todo
- Session Summary
- Claude / OpenCode 的 memory 文件
- `CLAUDE.md` / `AGENTS.md` / rules
- 已存在的 session notes

收集规则：

1. 每条证据必须携带稳定来源定位信息。
2. 每条证据必须计算 `contentHash`。
3. 每条证据进入管道前就赋予初始 `trustScore`。
4. 对过长文本按结构切片，避免单条证据过大。

证据切片示例：

- `CLAUDE.md` 不应整体作为一条证据，而应按段落或条目切片。
- Session Note 应按 `Current State`、`Worklog`、`Files and Functions` 切成多条证据。

### 4.2 候选提取

目标：从证据中提取 `SignalCandidate`，但此时不做最终发布判断。

提取方式分三类：

1. 规则提取
   - 对 Todo、明确格式化 memory 段落直接提取。

2. 模式提取
   - 对技术偏好、工作习惯使用关键词、句式、结构模板生成候选。

3. 小模型提取
   - 对决策、痛点、复杂工作风格等，用 AI 将证据转成结构化候选，而不是直接生成渲染文本。

输出要求：

- 必须绑定 `evidenceIds`
- 必须给出 `payload`
- 必须提供 `confidence`
- 尽可能生成 `fingerprint` 与 `canonicalKeyHint`

### 4.3 质量关卡

目标：在候选进入合并层前，统一剔除低质量噪音。

质量关卡应在系统中成为显式阶段，而不是散落在各个渲染函数里。它负责：

1. 判定候选是否可接受
2. 标注问题类型
3. 为合并层提供排序分数

推荐评分维度：

- 证据信任等级
- 候选结构完整度
- 是否为原文回显
- 是否存在多源支持
- 是否具有行动性或长期价值
- 是否过旧且已失效

输出结果：

- `accept`：进入合并层
- `needs_merge`：可能是重复或过细粒度项，优先参与聚类合并
- `reject`：不进入规范化层，但保留拒绝原因供调试

### 4.4 规范化合并

目标：把大量相似候选收敛成少量高质量 `CanonicalSignal`。

合并顺序必须“确定性优先”：

#### 第一步：精确指纹

若 `fingerprint` 完全一致，直接视为同一声明的重复观测：

- 合并证据集合
- 更新 `lastSeenAt`
- 累加 `supportCount`

#### 第二步：规范键聚类

若精确指纹不同，但 `canonicalKeyHint` 接近，进入同类簇。例如：

- `frontend|next.js|prefer`
- `frontend|react+next|prefer`

通过标准化技术名、动词与分类词，把近似表述拉到同一簇中。

#### 规范键生成规则

`canonicalKey` 必须可解释、可复现，并优先由确定性规则生成。统一辅助函数：

```typescript
normalize(input: string, maxChars?: number): string
// 规则：lowercase → 去标点 → 合并连续空白 → trim → 按 maxChars 截断
```

说明：不同 payload 的字段名可以映射为统一键语义。例如 `techName` 对应 `TechPreferencePayload.technology`；`category` 在 `work_style` 上对应 `WorkStylePayload.dimension`；`observation` 对应 `WorkStylePayload.claim`；`title` 对应 `PainPointPayload.problem`。

| SignalKind | canonicalKey 公式 | Example |
|---|---|---|
| tech_preference | `normalize(scope.projectPath ?? 'global') + ':' + normalize(techName) + ':' + stance` | `global:next.js:prefer` |
| work_style | `normalize(category) + ':' + normalize(first20chars(observation))` | `交互风格:指令式交互为主` |
| decision | `normalize(scope.projectName) + ':' + normalize(first30chars(topic))` | `aibuddy:wea-bot-appsecret-存储方式` |
| pain_point | `normalize(scope.projectName ?? 'global') + ':' + normalize(first30chars(title))` | `hlquant:mark-price-enrichment-延迟` |
| profile_fact | `normalize(dimension) + ':' + normalize(first20chars(claim))` | `role:产品经理兼量化开发者` |
| timeline_event | `normalize(scope.projectName) + ':' + normalize(date) + ':' + normalize(first20chars(summary))` | `aibuddy:2026-04-07:竞品情报模块v2数据源对接` |
| open_thread | `normalize(scope.projectName) + ':' + normalize(first30chars(title))` | `hlquant:mark-price-enrichment部署验证` |

补充约束：

- `scope.projectPath` 缺失时，对技术偏好回退为 `global`。
- `scope.projectName` 缺失时，`decision` 不得进入 project 级 canonical key；应显式降为 `cross_project` 或在质量关卡阶段以 `missing_required` 拒绝。
- `first20chars()` / `first30chars()` 的截断发生在 `normalize()` 之前，防止超长原文直接污染 key。

#### 定量阈值与隔离规则

以下阈值由质量关卡执行、在进入合并前落地；合并层只消费通过质量关卡的候选：

- `too_long`
  - `rationale` / `description` 超过 150 字符 → 进入 quarantine，不参与合并。
- `echo_raw_text`
  - payload 中包含超过 2 个换行，或超过 3 个 bullet point → 作为段落回显进入 quarantine。
- `too_vague`
  - `observation` / `claim` 少于 8 个字符 → 直接拒绝。
- `missing_required`
  - 按 §3.3 的各类硬规则检查必填字段；缺失则拒绝或隔离，不允许把缺字段候选带入 merge 再“碰碰运气”。

其中 quarantine 的含义是：记录到 `quality-log`，供调试与规则回放使用，但不进入 `CanonicalSignal` 主仓。

#### 第三步：合并策略

在簇内执行确定性合并：

- 选取最高信任、最高完整度的候选作为主骨架
- 将其他候选的理由、条件、替代方案并入
- 同义短语做标准化替换
- 对冲突信号保留条件化结果，而不是盲目覆盖

#### 第四步：可选 AI 小簇重写

只有在小簇内存在多条高质量、但措辞冗余或理由碎片化的候选时，才允许调用 AI 做小簇重写。限制条件：

- 单簇候选数不超过设定阈值
- 输入总长度受控
- 输出必须回填到结构化 payload，而不是只保留 prose

这样做的目标不是“让 AI 再总结一遍”，而是“帮助把确定性合并后的残余碎片收敛成更干净的单条规范信号”。

### 4.5 视图编译

目标：从 `CanonicalSignal` 生成可消费的 markdown 文件。

视图编译器只做四件事：

1. 取数
   - 按视图关注的 `SignalKind` 拉取规范化信号。

2. 排序
   - 综合 `trustScore`、`supportCount`、`lastSeenAt`、`confidence` 排序。

3. 预算截断
   - 应用 `ViewBudget`，只保留预算内最重要的信号。

4. markdown 输出
   - 进行轻量模板渲染，不承担去重、清洗、深度重写职责。

补充规则：视图编译器允许在渲染时生成“derived view metadata”——即仅服务于当次输出、受预算约束、非持久化的派生摘要。它们来源于 canonical signal 的再组合，不回写 canonical store。

具体约束：

- derived view metadata 只能在 render time 生成；不得作为新的 canonical signal 持久化。
- 其长度必须受视图预算约束，避免重新引入“长摘要挤爆视图”的问题。
- 最常见的载体是 HTML 注释元数据，如 `<!-- desc: ... -->`。

#### 工作画像视图编译规则

`工作画像.md` 在 Phase 2 起新增顶部结构化章节 `## 核心画像`，并按以下顺序渲染：

1. 角色
2. 主要职责
3. 副线
4. 关注领域
5. 活跃项目

来源规则：

- `角色` / `主要职责` / `关注领域`：来自 `profile_fact` canonical signal。
- `副线`：由 `profile_fact` 中次级职责、低支持度职责和稳定 `work_style` 衍生归纳。
- `活跃项目`：视图层 30 天聚合，不持久化。按最近 30 天 canonical signal 数量对项目排序，取前 5。

渲染约束：

- `核心画像` 必须位于文档最顶部，在其余行为型画像章节之前。
- 不再单列“记忆来源”分区；memory-derived 条目与会话-derived 条目统一混排。

#### 项目时间线视图的派生元数据

时间线视图编译器可为每个项目生成一行派生描述，格式固定为：

`<!-- desc: 一句话，不超过 40 字 -->`

规则：

- 放置在 `## 项目名` 下、首个 `### 日期` 之前。
- 由该项目的 `timeline_event` + `decision` canonical signal 在渲染时生成。
- 信息不足时输出 `<!-- desc: (unknown) -->`。

这一步必须是“薄编译器”，否则系统会再次滑回 file-centric 模式。

### 4.6 状态持久化

目标：把管道状态显式持久化到 `.state/`，支持增量、回滚和迁移。

持久化对象包括：

- 已处理证据索引
- 候选缓存
- 规范化信号仓
- 视图缓存
- 拒绝记录与质量问题

原则：

1. 允许重建，但不要求每次全量重跑。
2. 所有缓存都可通过指纹和时间戳判断是否失效。
3. 所有阶段状态都应可观察，便于调试“为什么这条没有进最终输出”。

---

## §5 Memory 自然集成

### 5.1 为什么“记忆来源”独立节是错误的

“记忆来源”独立节的问题在于：它把来源当成了用户真正关心的分类维度。事实上，下游消费方并不关心一条偏好来自 session 还是 memory 文件；下游只关心这条偏好是否可信、是否稳定、是否值得作为未来上下文持续注入。

一旦把 memory 放进独立节，系统就会出现以下副作用：

- 同一声明因来源不同被重复展示
- 高信任记忆不能自动抬升会话证据的可信度
- 读者被迫理解内部来源结构，增加认知负担

因此，“记忆来源”不应成为视图层的一级分类，而应成为证据层的元数据。

### 5.2 Memory 作为高信任证据进入同一管道

正确方式是：Memory 不是旁路输入，而是高信任 `EvidenceRecord`。

这意味着：

- `CLAUDE.md` 中的规则条目，与 session 中的行为证据进入同一个候选提取器
- Auto Memory 中的结构化决策，与 Layer 3 从对话中提取出的决策候选在合并层相遇
- Session Notes 不再被当作“额外补丁数据”，而是压缩后的证据来源

最终，来源差异只影响 `trustScore`、排序与合并策略，而不影响是否进入统一主干。

### 5.3 信任评分体系

建议的初始信任评分如下：

| 来源 | trustScore | 原因 |
|---|---:|---|
| `rule_file` | 5 | 人工明确写下的约束，最接近显式意图 |
| `memory_file` | 4 | 已经被 AI 或系统蒸馏过，信息密度高 |
| `session_note` | 4 | 会话压缩笔记，噪音显著低于原始消息 |
| `session_summary` | 3 | 摘要级证据，仍可能有压缩偏差 |
| `session_message` | 2-3 | 原始对话噪音高，但能提供细节与新鲜度 |
| `derived_note` | 2 | 系统中间产物，仅作辅助证据 |

补充规则：

- 若低信任来源被多个独立项目和多个时间点重复支持，可逐步抬升综合可信度。
- 若高信任来源过旧，且被新证据持续反驳，可在合并层降为 `conditional` 或标记 `superseded`。

### 5.4 合并示例

示例：

1. `CLAUDE.md` 中有一条规则：“优先使用 TypeScript 严格模式，避免隐式 any。”
2. 多个 session 中反复出现：
   - 主动开启 `strict`
   - 修改类型定义而不是绕过错误
   - 明确拒绝宽松类型修补

在旧架构中，这可能表现为：

- 一条来自“记忆来源”的偏好
- 三四条来自“技术偏好提取”的相似观察

在新架构中，这些证据应被合并成一条 `CanonicalSignal<tech_preference>`：

- `technology = TypeScript`
- `stance = prefer`
- `category = 类型系统`
- `rationale = 偏好严格类型约束，以减少隐式错误和后期修补成本`
- `trustScore = 5`
- `supportCount = 4+`

最终只发布这一条，而不是分别发布“规则条目”和“行为条目”。

---

## §6 现有层级职责变更

新架构不是简单新增 Layer 4，而是重构各层职责边界。

### Layer 0：产出证据 + 候选

当前定位：面向 memory/rules 的接入层。

新定位：

- 负责把 memory、rules、session notes 转成 `EvidenceRecord`
- 在适合的情况下直接产出高信任 `SignalCandidate`，包括部分 `tech_preference`、`profile_fact`
- 不再产出最终渲染条目

### Layer 1：证据收集器

当前定位：结构化提取时间线与 todo。

新定位：

- 专职收集对话、todo、系统元数据，形成基础证据
- 可为 timeline/open-thread 产出规则化候选
- 不再直接写 markdown 文件

### Layer 2：产出 tech_preference + work_style 候选

当前定位：半结构化提取并渲染工作模式与技术偏好。

新定位：

- 只负责从证据中产出 `tech_preference` 与 `work_style` 候选
- 共享质量关卡与合并引擎
- 不再维护自己的独立去重和最终文本组织逻辑

### Layer 3：只产出候选

当前定位：高价值 session 选择 + AI 提取 + 聚合 + consolidation + 渲染。

新定位：

- 只负责复杂信号的 AI 结构化提取
- 产出 `decision`、`pain_point`、部分 `work_style`、`profile_fact` 候选
- 不再负责去重、consolidation 大汇总、最终渲染

### Renderers：薄视图编译器

当前定位：部分承担组织与隐式清洗职责。

新定位：

- 仅按 `CanonicalSignal` 编译 markdown
- 不做深清洗、不做合并、不做智能兜底
- 变成真正的视图层，而不是事实上的知识处理层

---

## §7 状态存储

### 7.1 `.state/` 文件存储设计

建议新增统一状态目录：

```text
.state/
├── evidence-index.json
├── candidate-cache.json
├── canonical-signals.json
├── published-views.json
├── quality-log.json
├── merge-log.json
└── pipeline-meta.json
```

建议内容：

1. `evidence-index.json`
   - 记录每条证据的稳定 ID、内容哈希、来源、最后处理时间

2. `candidate-cache.json`
   - 按证据 ID 缓存候选信号，避免重复提取

3. `canonical-signals.json`
   - 系统主仓，保存规范化信号当前快照

4. `published-views.json`
   - 保存上次编译结果与预算信息，便于比较与调试

5. `quality-log.json`
   - 保存被拒绝候选及拒绝原因

6. `merge-log.json`
   - 保存候选如何被合并进规范化信号，便于追溯

7. `pipeline-meta.json`
   - 保存版本、模式、迁移标记、统计信息

### 7.2 增量更新策略

增量更新原则：

1. 新证据
   - 新建候选，走质量关卡与合并流程。

2. 证据内容变化
   - 使其关联候选失效并重提取。
   - 重新计算受影响规范化信号。

3. 预算或渲染模板变化
   - 不必重跑提取与合并，只需重编译视图。

4. 合并规则变化
   - 以 `canonical-signals.json` 为重建起点，必要时回溯到候选层重放。

### 7.3 从 `.last-extraction.json` 迁移

现有 `.last-extraction.json` 主要服务于“是否需要重新提取”。新架构中应将其职责拆分：

- 文件哈希与最后处理时间迁入 `evidence-index.json`
- memory 相关缓存迁入 `candidate-cache.json`
- 视图级状态迁入 `published-views.json`

迁移策略建议：

1. 首次引入 `.state/` 时读取旧状态。
2. 将可映射字段写入新结构。
3. 对无法精确映射的字段只做兼容读取，不继续写回。
4. 连续两个稳定版本后再废弃旧状态文件。

### 7.4 SQLite 升级触发条件

初期推荐继续使用 `.state/` 下的 JSON 文件，而不是立即切 SQLite。升级到 SQLite 的触发条件应明确，而不是“感觉变复杂了就迁移”。

建议触发条件：

- `CanonicalSignal` 数量达到数万级
- 合并日志与质量日志查询明显成为性能瓶颈
- 需要复杂查询：如“找出过去 90 天被更新且 supportCount 增长最快的 pain_point”
- 需要跨视图、跨项目的事务级更新一致性

在未满足这些条件前，文件存储更透明、可调试、迁移成本更低。

---

## §8 分阶段交付

### 8.x 过渡期双通道编排

迁移期内，`extract.ts` 必须明确运行在双通道模式：

1. 已迁移视图
   - 从 canonical `.state/` store 编译输出。
   - 其输入主干为 `EvidenceRecord → SignalCandidate → QualityGate → CanonicalSignal → View Compiler`。

2. 未迁移视图
   - 继续沿用现有 Layer 1 / Layer 2 / Layer 3 管道，不做行为改变。
   - 旧逻辑保持原样运行，避免“大爆炸”式替换。

3. 状态并存
   - `.state/` 与 `.last-extraction.json` 在迁移期并存。
   - `.state/` 服务已迁移视图；`.last-extraction.json` 继续服务未迁移流程与过渡代码。

4. 相位边界
   - 每个 phase 明确声明自己迁移哪些输出文件。
   - 非迁移文件必须保持 untouched，不允许顺手改成 canonical 半成品状态。

### Phase 1：最小可行切片（先技术偏好，再工作画像）

明确说明：Phase 1a 是最小可行切片（minimal viable slice），只打通一条最短闭环，先证明 canonical 主干能稳定修复最明显的坏输出，再扩展到第二个视图。

#### Phase 1a：`tech_preference`

#### 范围

- 仅覆盖 `tech_preference`
- 路径：Layer 0 + Layer 2 → candidates → quality gate → canonical store → `技术偏好.md` view compiler
- 新建质量关卡与最小确定性合并逻辑
- 将 `技术偏好.md` 改为从规范化信号编译

#### 改进预期

- 先修复当前回显最严重、最膨胀的一个文件
- 消除“整段文本回显”为技术偏好的主要问题
- 建立 claim-centric 主干的最小可行闭环

#### 依赖

- Layer 2 改造为候选产出器
- 基础 `.state/` 目录与预算机制落地
- `RelevanceClassifier` 已在 Phase 1 主干接入，用于 evidence 预筛选

#### 验收标准

- `技术偏好.md` 中，同一段文字不得在多个技术标题下重复出现（anti-echo check）
- `技术偏好.md` 总行数 `< 200`（原问题为 400+）
- `技术偏好.md` 显著收敛，同类偏好不重复出现
- 新文件由 `CanonicalSignal` 编译生成，而非直接拼接原始条目

#### Phase 1b：`work_style` + 最小 Layer 3 bridge

#### 范围

- 增加 `work_style` 信号类型的 canonical 化
- 通过最小 Layer 3 bridge，把现有 Layer 3 已提取的 preference / 画像类结果转换为 `work_style` candidates
- 走同一条 quality gate + canonical merge + view compiler 主干
- 将 `工作画像.md` 切到 canonical 编译

#### 改进预期

- 在不重写整个 Layer 3 的前提下，把工作画像从“长篇聊天残片拼装”改成“稳定模式声明集合”
- 去掉 memory 作为单独输出分区的展示方式

#### 依赖

- Phase 1a 主干稳定
- Layer 3 到 `work_style` candidate 的最小桥接完成

#### 验收标准

- `工作画像.md` 不再包含单独的“记忆来源”分节，memory-derived 条目必须与其他条目内联混排
- `工作画像.md` 总行数 `< 150`（原问题为 1140）
- `工作画像.md` 只包含稳定习惯，不再保留明显单次事件

### Phase 2：共享合并引擎 + memory 自然融合

#### 范围

- 引入统一合并引擎
- 将 memory/rules/session notes 统一作为高信任证据接入
- 取消输出侧“记忆来源”式独立表达
- 引入 `profile_fact` canonical kind，并为 `工作画像.md` 增加顶部 `## 核心画像` 结构化章节
- `核心画像` 的角色/主要职责/关注领域来自 `profile_fact`，活跃项目由视图层做最近 30 天 top 5 聚合

#### 改进预期

- 消除 memory 集成的“贴补感”
- 同类偏好、规则、行为观察自然归并
- 提高高信任信号在排序与预算中的优先级
- 将“这个人是谁、主要在做什么、最近活跃在哪些项目”从散落条目提升为结构化顶部摘要

#### 依赖

- Layer 0 改造完成
- 证据信任评分体系与合并日志落地

#### 验收标准

- 从 `CLAUDE.md`/`AGENTS.md` 与 session 中提取的同类信号只发布一次
- 输出中不再出现按来源区分的“记忆来源”逻辑结构
- 同一信号的证据链可追溯到 memory 与 session 双来源
- `工作画像.md` 顶部存在 `## 核心画像`，且角色/主要职责/关注领域来自 `profile_fact`

### Phase 3：替换 Layer 3 大 consolidation

#### 范围

- Layer 3 改为只产出 `decision`、`pain_point`、复杂 `work_style` 候选
- Layer 3 增补 `profile_fact` 提取，用于丰富 `工作画像.md` 的结构化顶部画像
- 用共享质量关卡与规范化合并替代单次大 consolidation
- AI 仅在小簇重写场景中可选启用

#### 改进预期

- 降低 Layer 3 成本
- 消除大 consolidation 的静默失败与零压缩问题
- 让 AI 只承担高价值、低歧义的小范围结构化工作

#### 依赖

- 共享合并引擎足够稳定
- `decision` 与 `pain_point` 的质量规则落地

#### 验收标准

- 即使关闭大 consolidation，`决策日志.md` 与 `反复痛点.md` 仍能稳定收敛
- 不再出现明显的“1102 → 1102”式零压缩结果
- 失败场景可定位到候选质量或合并策略，而不是黑盒式摘要失败

### Phase 4：统一 timeline/open-threads + 滚动窗口视图

#### 范围

- 将 timeline/open-thread 纳入统一 canonical model
- 在 timeline/open_thread 相关路径上复用同一套 `RelevanceClassifier`
- 新增 `weekly_focus` 视图（发布文件：`本周重点.md`）
- Timeline view compiler 为每个项目生成一行描述 `<!-- desc: ... -->`

#### 改进预期

- 消除各层各做过滤的重复逻辑
- timeline 与 open-thread 也获得去重、预算和证据追踪能力
- 全系统形成一套真正统一的信号流水线
- 新增面向近期消费的滚动窗口视图，避免所有信息都堆进长期文件

#### 依赖

- Phase 1-3 的 canonical 主干已经稳定
- 现有 noise filter 能抽象成共享分类器输入

#### 验收标准

- `项目时间线.md` 和 `未完成线索.md` 使用与其他文件一致的预算和排序机制
- 同一 session 的质量结论可被 Layer 1/2/3 共享复用
- 系统内部不再存在“直接从原始数据渲染最终文件”的主路径
- `项目时间线.md` 的每个 `## 项目名` 下、首个 `### 日期` 前都存在 `<!-- desc: ... -->` 或 `<!-- desc: (unknown) -->`
- `本周重点.md` 满足滚动窗口预算：总字符数受 6000 限制、总条目数不超过 30、单分区不超过 12

---

## §9 设计决策

### 9.1 文件存储 vs SQLite

决策：先采用 `.state/` 文件存储，延后 SQLite。

原因：

- 当前阶段最重要的是重建数据模型，不是优化复杂查询
- 文件存储更利于调试与观察中间状态
- 迁移成本低，适合快速迭代合并规则和质量关卡

只有当信号规模与查询复杂度明显上升时，再迁移 SQLite。

### 9.2 确定性去重优先 vs AI 去重

决策：确定性去重优先，AI 去重作为小范围增强。

原因：

- 重复判定需要稳定、可解释、可复现
- AI 去重容易出现错误合并、漏合并与不可预测漂移
- 真正适合 AI 的位置不是“判断是否重复”，而是“把已确定同簇的碎片重写成更好的单条表达”

### 9.3 Memory 作为证据 vs 独立节

决策：Memory 作为证据，不再作为视图中的独立节。

原因：

- 用户关心的是可信声明，不是内部来源类别
- 独立节会制造重复与结构割裂
- 把 memory 放进证据层，才能与 session 自然合并，形成更强信号

### 9.4 有界摘要 vs 全量输出

决策：所有发布视图都必须有预算，采用有界摘要。

原因：

- 无限增长的文件最终会降低真实可用性
- AI 冷启动场景对篇幅高度敏感
- 好的记忆系统不是“尽量都保留”，而是“尽量把最该被反复消费的内容保留在预算内”

### 9.5 薄编译器 vs 智能渲染器

决策：采用薄编译器。

原因：

- 一旦 renderer 承担太多智能逻辑，系统又会回到按文件拼装事实的旧路径
- 真正的知识处理应发生在候选提取、质量关卡、规范化合并阶段
- 视图层越薄，越容易验证输出质量问题究竟来自哪一层

---

## §10 风险与注意事项

1. 抽象升级风险
   - 若一次性改造所有信号类型，容易在接口和迁移上失控，因此必须按 Phase 逐步推进。

2. 规范键设计风险
   - `canonicalKey` 设计过粗会误合并，设计过细又起不到收敛效果。需要通过真实样本迭代校准。

3. 高信任来源过时风险
   - `CLAUDE.md` 或 rules 可能长期未更新，不能因为高信任就永久压制新事实，需要支持 superseded 状态。

4. 预算截断偏差风险
   - 若排序策略不合理，可能把更重要但较旧的信号截断掉。预算机制必须与优先级策略联动设计。

5. AI 小簇重写漂移风险
   - 即便缩小到小簇场景，AI 仍可能引入措辞漂移或遗漏关键信息，因此输出必须回填结构化字段并保留证据链。

6. 调试复杂度上升
   - 中间状态更多，意味着实现复杂度上升。但这是必要复杂度：过去的“简单”只是把复杂性隐藏在输出质量问题里。

7. 迁移期双轨负担
   - 新旧架构并存一段时间不可避免，需要明确哪些文件已切换到 canonical 模式，避免部分文件仍走旧逻辑导致行为不一致。

---

## §11 Changelog

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.2.1 | 2026-04-08 | 补全 `timeline_event` 和 `open_thread` 的 canonicalKey 公式（Oracle 终审反馈）。 |
| v0.2 | 2026-04-08 | 架构评审修订 + 下游需求补充。(1) 明确 supersede `PRD-memory-integration.md` 的旧目标架构，仅保留其数据源清单为参考，并将 Phase 3A 代码定义为过渡实现。(2) 在 §3 新增 `RelevanceClassifier`，并明确自 Phase 1 起接入主干，而非延后到 Phase 4。(3) 修正 QualityGate / merge 边界：重复检测移至 §4.4 合并阶段，质量关卡只评估单条候选内在质量。(4) 新增 `profile_fact` signal kind、质量规则、`工作画像.md` 顶部 `核心画像` 结构化编译规则。(5) 在 §4.4 补充 canonical key 生成规则、`normalize()` 规范、定量阈值与 quarantine 规则。(6) 缩窄 Phase 1 为 1a `tech_preference` 最小切片 + 1b `work_style` 最小桥接，并增加针对 `技术偏好.md` / `工作画像.md` 既有坏输出的验收标准。(7) 新增迁移期双通道编排，明确 `.state/` 与 `.last-extraction.json` 并存策略。(8) 在 §4.5 引入 derived view metadata，并为 `项目时间线.md` 增加项目级一行描述 `<!-- desc: ... -->` 规则。(9) 在 §3.5 新增 rolling-window 视图类型与 `weekly_focus` / `本周重点.md` 预算与编译规范。(10) 统一补充时间字段格式：时间戳用 Unix ms，字符串日期用 ISO `YYYY-MM-DD`。 |
| v0.1 | 2026-04-08 | 初版。提出 Canonical Signal Pipeline，定义 claim-centric 核心模型、质量关卡、规范化合并、预算编译与分阶段落地路径。 |
