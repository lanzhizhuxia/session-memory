# PRD: 输出质量修复 — 4 个 Critical Issues

> 修复 Oracle 验收中发现的 4 个阻塞性输出质量问题

- 版本: v0.2 (Oracle reviewed)
- 日期: 2026-04-09
- 状态: Approved
- 关联: PRD-canonical-signal-pipeline.md (v0.2) §4.5
- 审核: Oracle v0.1 NEEDS REVISION → v0.2 已修订

---

## §0 背景

Oracle 验收 session-memory 全部 8 个输出文件后，判定 **REJECT**。4 个 critical issues 阻塞下游 deep-daily-report 消费：

1. 增量跑可能产出空的 项目时间线.md
2. Timeline desc 是关键词拼接而非语义描述
3. 空决策/元评论泄露到决策日志和本周重点
4. 核心画像抽象层级太低（任务级而非职业级）

---

## §1 Issue 1: 增量跑产出空文件

### 1.1 问题

`.state/`（canonical store）和 `.last-extraction.json`（Layer 3 增量 checkpoint）不同步时，Layer 1 以增量模式运行（0 new sessions）→ 0 timeline candidates → 0 signals → 空文件。

### 1.2 方案

**Layer 1 canonical 提取改为全量重建（full rebuild）。**

Layer 1 是纯本地处理（~30s / 2700 sessions），不涉及 AI 调用，成本可忽略。`runLayer1` 中的 session 过滤路径不再受 `since` 约束影响 timeline/open-thread 候选生成。

### 1.3 实现

- `src/extractors/layer1.ts`:
  - `runLayer1` 中：`buildTimelineData()` 和 todo 收集总是基于全部 sessions，不受 `since` 过滤
  - `latestSessionTime` 从全部 sessions 计算（确保 `.last-extraction.json` 在 full rebuild 后仍一致）
  - `since` 参数仍传入，但仅用于 Layer 3 checkpoint bookkeeping，不影响 Layer 1 候选生成
- `scripts/extract.ts`:
  - 启动时检测 `.state/` 和 `.last-extraction.json` 一致性，不一致时打印 warning
  - merge 是幂等的（same fingerprint → update, not duplicate），无需额外处理
- 增量模式对 Layer 3（AI 提取）仍然有效，不受影响

### 1.4 验收标准

- 删除 `.state/` 但保留 `.last-extraction.json`，跑 `npm run extract`：项目时间线.md 非空
- 删除 `.last-extraction.json` 但保留 `.state/`，跑 `npm run extract`：项目时间线.md 非空
- 两者都存在、0 new sessions 的增量跑：项目时间线.md 仍非空
- Layer 1 耗时 < 60s

---

## §2 Issue 2: Timeline desc 关键词拼接

### 2.1 问题

`deriveProjectDescription()` 用 regex theme matching + 关键词提取。结果如 "Kronos / financial / GitHub"——不是项目描述。

### 2.2 方案

**在 extract.ts 的 "Final views" 阶段，用 AI 生成 per-project 描述，传入 view compiler 作为 render-time derived metadata。**

符合 PRD-canonical-signal-pipeline.md §4.5 的设计——desc 是 render-time 生成的 view metadata，不是持久化 canonical signal。AI 调用在 extract.ts 编排层而非 view compiler 内部。View compiler 只接收 `Map<string, string>` 描述映射，保持 thin compiler 原则。

### 2.3 实现

- `src/canonical/extractors/project-summary.ts`（新文件）:
  - `generateProjectDescriptions(projectContexts, aiConfig): Promise<Map<string, string>>`
  - 输入：per-project 上下文（从 canonical store 构建）
    - top 10 timeline_event titles
    - top 5 decision topics
    - top 3 open_thread titles
  - per-project 证据阈值：至少 3 个 signals（任何 kind），否则该项目跳过，desc = `(unknown)`
  - 一次 gpt-5.4-mini 调用处理所有项目（batch prompt）
  - AI 失败 → 全部返回 `(unknown)`
  - 输出验证（per project）：
    - 拒绝包含 `/` 的关键词拼接
    - 拒绝与项目名完全相同的
    - 拒绝 < 5 chars 或 > 40 chars
    - 拒绝无动词/无目的语义的纯名词列表
    - 验证失败 → 该项目 desc = `(unknown)`
- `scripts/extract.ts`:
  - 在 "Final views" section：
    1. 从 store 构建 per-project context
    2. 调用 `generateProjectDescriptions()`
    3. 传入 `compileTimelineView(..., projectDescriptions)`
- `src/canonical/views/timeline.ts`:
  - `compileTimelineView()` 新增 `projectDescriptions: Map<string, string>` 参数
  - 删除 `deriveProjectDescription()` 及所有 regex/theme/keyword 逻辑
  - `desc = projectDescriptions.get(projectName) ?? '(unknown)'`
  - 不存储、不缓存——每次 render 时由 extract.ts 提供

### 2.4 Prompt 设计

```
你是一个项目分析助手。根据以下项目的工作记录，为每个项目写一句话描述（中文，≤40字）。
描述应该说明项目的用途、目标或服务对象。

规则：
- 不要重复项目名
- 不要列举关键词或用 / 分隔
- 不要总结最近任务，而是描述项目本身的定位
- 如果证据不足以判断项目用途，返回空字符串 ""

项目列表：
1. aibuddy
   - 工作记录：PRD-pipeline需求审查, 知识库架构重设计, heartbeat健康检查优化, ...
   - 关键决策：采用 Embedding + Reranker 两阶段检索, 行动看板交互改为删除确认, ...
2. HLQUANT
   - 工作记录：资金费率套利回测, paper trade 模拟开仓, 因子计算修复, ...
   - 关键决策：10万美金资金分配策略, 当前市场转向反向套利思路, ...

输出 JSON（严格格式）：
[{"project": "aibuddy", "summary": "..."}, {"project": "HLQUANT", "summary": "..."}]
```

**好的 desc 示例：**
- ✅ `AI 驱动的企业知识库整理与检索助手`
- ✅ `加密货币资金费率套利回测与执行系统`
- ✅ `语音会议记录自动转录与摘要工具`

**坏的 desc 示例（应被验证拒绝）：**
- ❌ `Kronos / financial / GitHub`（关键词拼接）
- ❌ `aibuddy`（与项目名相同）
- ❌ `PRD 审查和知识库优化`（描述最近任务而非项目定位）
- ❌ `工具`（太短，无语义）

### 2.5 验收标准

- 每个有 3+ signals 的项目都有 `<!-- desc: ... -->` 且内容是语义描述
- 描述不包含 `/` 分隔的关键词拼接
- AI 调用失败时，desc 显示 `(unknown)` 而非关键词
- 描述说明项目用途/目标，不是最近任务列表

---

## §3 Issue 3: 空决策/元评论泄露

### 3.1 问题

gpt-5.4-mini 在 session 无决策时返回 "无法确认对话中做出了任何明确的技术/产品决策"。这个元评论通过提取器和 quality gate 进入了决策日志和本周重点。

### 3.2 方案

**双层过滤：extractor + quality gate（defense-in-depth）。**

### 3.3 实现

- 新增共享 helper `isMetaCommentary(text: string): boolean`:
  - 匹配模式（应用于 decision text 和 rationale text）：
    - `/无法确认.*决策/`
    - `/未发现.*决策/`
    - `/没有.*明确.*决策/`
    - `/insufficient\s+context/i`
    - `/no\s+explicit\s+decision/i`
    - `/未提取到.*决策/`
    - `/无法从.*中提取/`
  - 放在 `src/canonical/extractors/decision.ts` 并 export
- `src/canonical/extractors/decision.ts`:
  - 在 candidate 生成前检查 `isMetaCommentary(what)`，匹配则跳过
- `src/canonical/quality-gate.ts`:
  - `evaluateDecision()` 中对 decision text 和 rationale 都检查 `isMetaCommentary`，匹配则 reject
  - issue code: `meta_commentary`
- `src/canonical/types.ts`:
  - `QualityIssue['code']` 联合类型增加 `'meta_commentary'`

### 3.4 验收标准

- **拒绝示例**（不得出现在任何输出文件中）：
  - "无法确认对话中做出了任何明确的技术/产品决策"
  - "未发现明确的技术决策"
  - "No explicit decision was made"
- **允许示例**（不得被误杀）：
  - "在不确定 X 的情况下，先采用 Y"
  - "因为对 Z 不确定，决定先用保守方案"
- quarantine.json 中有对应的 `meta_commentary` 记录
- 决策日志.md **和** 本周重点.md 都不包含元评论文本

---

## §4 Issue 4: 核心画像抽象层级

### 4.1 问题

AI-backed profile-fact extractor 只接收 7 条 memory entries，缺乏跨源上下文。结果："角色: 产品经理"（太泛）、"主要职责: 验证套利效果"（任务级而非职业级）。

### 4.2 方案

**丰富 AI 输入上下文 + 收紧渲染侧 scope 过滤。不依赖 project_summary（§2 是 render-time metadata，不存入 store）。**

### 4.3 实现

**A) 丰富 AI 输入**

- `src/canonical/extractors/profile-fact.ts`:
  - `extractProfileFactsWithAI()` 新增参数：
    - `projectNames: string[]`（活跃项目 top 5）
    - `decisionTopics: string[]`（top 10 decision topics）
    - `focusAreaHits: Map<string, number>`（domain → hit count）
  - 将这些上下文拼入 prompt user message（格式见 §4.4）
- 更新 `PROFILE_SYSTEM_PROMPT`:
  - "角色必须是稳定的 6-12 个月职业角色，不是当前任务或一次性目标"
  - "职责必须是循环发生的职责，不是本周的具体任务"
  - "职责中不要出现具体项目名"
  - "如果信息不足以推断，省略该字段"
  - "不要使用执行任务动词如 验证/修复/处理/跟进/上线"
- `scripts/extract.ts`:
  - 从 canonical store 中提取 project names、decision topics、focus area hits
  - 传入 `extractProfileFactCandidates(..., aiConfig, context)`

**B) 渲染侧 scope 过滤**

- `src/canonical/views/work-profile.ts`:
  - 核心画像只使用 `payload.scope === 'global'` 的 profile facts
  - `scope: 'project'` 的 profile facts 不出现在核心画像
  - 如果某个 dimension 无 global scope 结果，显示 `(待提取)`

**C) AI 输出验证**

- `isValidRole()` 增加：
  - 拒绝包含执行任务动词（验证/修复/处理/跟进/推进/上线）的角色
  - 拒绝包含具体项目名的角色
- `isValidResponsibility()` 增加：
  - 拒绝包含具体项目名的职责
  - 拒绝长度 > 30 chars 的（可能是句子而非短语）

### 4.4 Prompt 上下文格式

```
你正在分析一个人的长期工作画像。根据以下信息，推断此人的稳定职业身份。

工作记录摘要（过去 6 个月）：
- 活跃项目：aibuddy, HLQUANT, openclaw, mynotebook, wallet-bench
- 主要决策主题：保证金打通方案设计, 资金费率套利策略, 知识库架构重设计, 语音转录优化, RWA 代币化调研
- 领域分布：量化交易(15次), DeFi 套利(12次), 知识库(8次), 加密货币(6次), AI Agent(5次)

用户记忆文件中的观察：
1. ...
2. ...
```

### 4.5 验收标准

- 角色: ≤20 chars，不包含执行任务动词，不包含项目名
- 主要职责: 描述循环职责而非一次性任务，不包含项目名
- 关注领域: 3-5 个短标签，每个 ≤15 chars
- 信息不足时显示 `(待提取)` 而非低质量文本
- **好的示例**: `角色: 加密货币交易产品经理兼量化开发者`
- **坏的示例**: `角色: 产品经理`（太泛）、`角色: 验证套利效果的人`（任务级）

---

## §5 实施顺序

1. **Issue 1 + Issue 3**（快速修，< 2h）：Layer 1 全量重建 + 元评论过滤
2. **Issue 4**（short，2-3h）：AI 上下文丰富 + scope 过滤（不依赖 Issue 2）
3. **Issue 2**（medium，3-4h）：project description AI 生成 + view compiler 改造

每完成一步后 build + smoke test 验证。

---

## §6 不做的事

- 不在 view compiler 内部加 AI 调用（AI 在 extract.ts 编排层）
- 不将 project_summary 作为持久化 canonical signal（保持 render-time metadata）
- 不为 Layer 3 AI 提取加全量重建（保持增量）
- 不修改 merge.ts 或 store.ts 的核心逻辑
- 不新增 npm 依赖
