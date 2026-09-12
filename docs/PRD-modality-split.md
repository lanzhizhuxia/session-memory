# PRD: Modality Split — 流水日志型 vs 快照总结型视图

> 把"同一种 view 处理两种本体不同的信号"这个隐藏假设显式化，修复 event-shaped 信号被 state-shaped top-N 挤出的结构性问题。

- 版本: v0.2.1 (Oracle re-reviewed, ACCEPTED)
- 日期: 2026-05-22
- 状态: Accepted, ready for Phase A1 implementation

> **v0.2.1 修订摘要（Oracle ACCEPT 后的 polish）**：
> - §4.5 strict mode 数据契约写实：用 `PolishSectionInput.entries[]` + 稳定 HTML marker 校验，而不是只数 bullet。
> - §5.2 pain_point 验收语句改为"observation"表述，明确不承诺真正 occurrence 完整性。
> - §3.2 补 occurrence-near 去重规则（`painSignalId + sessionId + observedAt`）。
> - §4.4 历史索引也是 bounded metadata，月份 > 36 按年折叠；新增 PublishedView additive-only schema 约束。
> - §6.2 工期改为 A2 2-3 天、总计 3-5 engineer-days。
>
> **v0.2 修订摘要**：吸收 Oracle 对 v0.1 的 12 条 critical/minor edits。主要变化：
> 1. **archive 可见性写实**：archive 文件升级为产品输出的一等公民，挂入既有 `publish-manifest.json`，主文件加"历史索引"section，README / CLAUDE include 指南需同步更新。
> 2. **work_style 重新定位**：保留为 `derived_claim`（持久化 + bounded snapshot），不再承诺"derived 不持久化"——尊重当前 codebase 现状。
> 3. **pain_point hybrid 改为渐进式**：v0.4 不新增 SignalKind，用现有 `PainPointPayload` 的 `recurrence + firstSeenAt + lastSeenAt + evidenceIds` 近似展开 occurrence log；真正的 occurrence schema 拆分留给 Phase B 决定。
> 4. **§6.3 migration 改为三阶段安全流程**：dry-run → 仅自动恢复无歧义信号 → 其余进 review report，不自动改。
> 5. **ViewBudget 字段权威性写明**：`retention` 是新 view compiler 的唯一权威，旧字段仅 legacy adapter 兼容。
> 6. **本周重点改标 hybrid rolling_window**（消费 timeline_event + open_thread + decision 三类）。
> 7. **conflicting event 语义占位**：event 不 supersede event；新事件可用 `relatedSignalIds` link 到旧事件。Phase A 不实现，PRD 保留语义位置。
> 8. **canonical store 长期增长边界**：补观测指标 + SQLite 触发条件。
> 9. **Layer 4 polish 对 event log 的约束**：event-log section 不得由 polish 合并/省略信号，只能改写措辞。
> 10. **工期改实**：Phase A 重估为 2-4 天，拆分 A1（决策日志 + modality headers）/ A2（反复痛点 hybrid）。
> 11. **验收标准用真实文件名**（`决策日志.md`，不是 `decisions.md`）。
> 12. **archive 默认窗口可配置**，决策建议 12 个月而非 6 个月。
- 关联:
  - 主 PRD (PRD.md) §1.4 "可积累 / 记忆越来越完整"
  - PRD-canonical-signal-pipeline.md (v0.3) §3.5 视图预算、§4.4 合并语义
  - PRD-output-quality-fixes.md (v0.2) §1 项目时间线全量重建（本文将其原则泛化）

---

## §0 一句话

> 当前 7 种 SignalKind 在本体上分属两类：**event fact（历史事实）** 与 **state claim（当前状态）**。前者不能被 top-N ranking 截断（会丢历史），后者必须 bounded（不收敛就没意义）。当前实现把这两类混用同一套 view 渲染策略，导致旧的合法决策被新的高 trustScore 决策从可见区挤出——用户感知为"记录都没了"。本文显式区分 modality，修复渲染语义，并定义最小迁移路径。

---

## §1 问题陈述

### 1.1 观察到的 symptom

`output/trial`（早期）→ `output/trial2`（近期）连续两次提取的 markdown 输出体积对比：

| 文件 | trial | trial2 | Δ | 类型 |
|---|---:|---:|---:|---|
| 决策日志.md | 340 KB | 41 KB | -88% | Layer 3，full_rebuild top-50 |
| 反复痛点.md | 118 KB | 13 KB | -89% | Layer 3，full_rebuild top-35 |
| 工作画像.md | 213 KB | 7.8 KB | -96% | Layer 3，full_rebuild top-30 |
| 项目时间线.md | 202 KB | 203 KB | ~0% | Layer 1，full_rebuild from raw |
| 未完成线索.md | 35 KB | 35 KB | ~0% | Layer 1 |
| 技术偏好.md | 2.2 KB | 2.2 KB | 0% | Layer 2 |
| 工作模式.md | 2.8 KB | 2.8 KB | 0% | Layer 2 |

用户主观感受：**"为什么我觉得总结下来的内容很少？之前的记录都没了。"**

### 1.2 错误归因排除

经过排查，以下几条**不是**根因：

1. ❌ 上游 session 被清理 —— `项目时间线.md` 体积稳定，证明 raw sessions 完整保留。
2. ❌ markdown 写入是覆盖而不是增量 —— 这是设计（PRD-canonical-signal-pipeline §6.3.2 聚合型文件每次全量重建），且 canonical store 是 upsert-by-id，旧 signal 不会消失。
3. ❌ `.last-extraction.json` 缩水 —— checkpoint metadata 格式变化，不代表内容丢失。

### 1.3 真正的根因：modality 错配

7 种 SignalKind 的**本体属性**：

| SignalKind | 本体 | 新数据对旧数据的关系 | 当前 view 渲染 | 是否错配 |
|---|---|---|---|---|
| `timeline_event` | Event fact | 并存（5 月里程碑不替代 3 月里程碑） | `项目时间线.md` 从 raw full rebuild | ✅ 已对（hotfix 已修） |
| `decision` | Event fact | 并存（5 月新决策不替代 3 月决策） | `决策日志.md` top-50 ranking | ❌ **错配** |
| `pain_point` (occurrence) | Event fact | 每次发生是独立事件 | `反复痛点.md` top-35 ranking | ❌ **错配** |
| `open_thread` | Thread / lifecycle | 有 open → close 生命周期 | `未完成线索.md` top-60 | ⚠️ 可接受，需明确语义 |
| `tech_preference` | State claim | 新证据可替代（不再用 Prisma → 改用 Drizzle） | `技术偏好.md` top-40 | ✅ 对 |
| `work_style` | State claim / derived | 稳定行为模式可演化 | `工作模式.md` top-24 | ✅ 对 |
| `profile_fact` | State claim | 角色 / 职责可演化 | `工作画像.md` top-30 | ✅ 对 |

**核心机制**：当 `决策日志.md` 用 trustScore / supportCount / lastSeenAt 排序后取 top-50：

1. 3 月份做的合法决策仍在 `.state/signals.json` 中，`status: 'active'`，**未被 supersede**。
2. 5 月份新决策因为更新、证据更多，rank 更高。
3. top-50 边界把 3 月决策挤出可见区。
4. markdown 全量覆盖写入 → 用户感知"3 月那条消失了"。

`trial` 时代 top-N 边界还没爆（决策总数 < 50），所以一切都看得见；`trial2` 时代质量门收紧 + 新决策累积，越界了，旧的开始溢出。**质量门收紧不是错，是它让长期存在的 modality 错配第一次浮出水面。**

### 1.4 为什么这是结构性问题

PRD §1.4 承诺"可积累 / 记忆越来越完整"。  
PRD-canonical-signal-pipeline §9.4 决定"所有发布视图必须有预算"。

这两条**并不矛盾**：
- "完整"应该发生在 canonical store；
- "有界"应该发生在 view。

但当前实现把二者混在了一起——**对 event-shaped 信号也用 state-shaped 的 bounded top-N**，等于让 trustScore 排名决定"历史是否存在"。这违反了 event 信号的本体语义。

---

## §2 modality 分类

### 2.1 四类 modality

| Modality | 含义 | 示例（系统内） | 渲染原则 | 是否持久化 |
|---|---|---|---|---|
| **event** | 在 T 时刻发生的不可替代事实 | timeline_event, decision, pain_point occurrence（v0.4 暂用 pattern 近似） | 主排序 = **时间**；不 top-N 截断；可分页 / 归档 | 是 |
| **state** | 当前的状态判断 | tech_preference, profile_fact | 主排序 = trustScore / supportCount；bounded top-N；支持 supersession | 是 |
| **thread** | 有生命周期的事项（open → updated → close） | open_thread | 主视图 = current open；history 进 archive 或 timeline | 是 |
| **derived_claim** | 从 event 聚合出的稳定模式声明（持久化版） | work_style，反复痛点的"模式"层 | bounded top-N；保留 evidence links；可被新数据 supersede | **是**（与 v0.1 不同；尊重当前 codebase）|
| **derived_view** | 仅在渲染时聚合的派生视图 | 项目时间线项目级一行描述（PRD-canonical-pipeline §4.5） | 不持久化，每次重算 | 否 |

> **v0.1 → v0.2 修正**：v0.1 把 `derived` 一类整体定义为"不持久化、每次从 event 重算"。但当前 `WorkStylePayload` / `WorkStyleSignal` 已经在 CanonicalSignal store 中持久化（见 `src/canonical/types.ts` 的 SignalKind 定义和 store.ts 的 mergeIntoStore）。强行让它退化为不持久化等于把 Phase A 偷偷扩成 extractor/store 改造。v0.2 改为引入 `derived_claim` 和 `derived_view` 两层定义：前者覆盖 work_style 这种"已有 SignalKind 持久化"的现状；后者覆盖 PRD-canonical-pipeline §4.5 中真正的 render-time metadata（如 `<!-- desc: ... -->`）。

> **产品对外话术仍可简化为两类**：
> - **流水日志（log）**：event + thread.history
> - **快照总结（snapshot）**：state + derived + thread.current
>
> `thread` 和 `derived` 是实现层细分，不强求暴露给消费者。

### 2.2 替代关系不对称

这是 modality 区分最关键的一条 invariant：

> **event 永远不替代 event；state 可以替代 state。**

具体含义：

- 一条 `decision` 信号永远不应该让另一条 `decision` 进入 `superseded` 状态。它们是不同时间点的并存事实。两条 decision 之间唯一合法的关系是 **dedup**（指纹一致 = 同一事件的重复观测）或 **link**（一条决策推翻了之前的决策——但这是新事件，不是旧事件被删除）。
- 一条 `tech_preference` 信号可以 supersede 同 canonicalKey 的旧 preference。这是 state 演化。
- 一条 `open_thread` 在被 close event 触发后从 `open` → `closed`，主视图不再展示，但历史进入 timeline。

### 2.3 为什么 thread 单独成类

`open_thread` 出生时是 event（"某天提了一个待办"），但它**当前是否仍开放**是 state（"今天是否还在 open 列表里"）。所以它需要 lifecycle 建模：

```
opened (event) → [updated (event)] → closed (event)
                                       │
                                       └→ derived current_status: open | blocked | closed
```

主视图 `未完成线索.md` 只渲染 `current_status ∈ {open, blocked, in_progress}`；close 历史进入 `项目时间线.md` 或 archive。

### 2.4 为什么 derived_claim 持久化、derived_view 不持久化

二者都是"从底层证据派生"，但落点不同：

- **derived_claim**（如 `work_style`）：派生结果本身具有稳定主张、需要参与跨 view 的引用与合并、需要历史轨迹（什么时候第一次观察到、近期是否衰退），所以持久化为 CanonicalSignal。新证据可以 supersede 旧 claim。
- **derived_view**（如 `项目时间线.md` 的 `<!-- desc: 一句话 -->`）：仅服务单次输出，受视图预算约束，下次重新生成；持久化没有意义。详见 PRD-canonical-pipeline §4.5。

> 取舍逻辑：**派生结果是否需要在多个视图、多次运行间被引用**。是 → derived_claim；否 → derived_view。

---

## §3 8 个输出文件的目标语义

### 3.1 完整分类（按 Signal modality + View modality 双列）

| 文件 | 输入 SignalKind | View modality | Retention 模式 | 主排序 | 是否需要 archive |
|---|---|---|---|---|---|
| `项目时间线.md` | timeline_event | event | `archive_by_month(currentMonths=12)` | 时间倒序 | 是 |
| `决策日志.md` | decision | event | `archive_by_month(currentMonths=12)` | 时间倒序 | 是 |
| `反复痛点.md` | pain_point（pattern 形态） | hybrid | 顶部 `bounded(N=10)` + 底部 `archive_by_month(currentMonths=6)` 近似 occurrence log | 顶部按 recurrence + 底部按 lastSeenAt | 是 |
| `未完成线索.md` | open_thread（filter status ∈ open/in_progress/blocked） | thread.current | `bounded(60)` | 优先级 + 最后活跃时间 | 否（close 历史进项目时间线） |
| `本周重点.md` | timeline_event + open_thread + decision | hybrid | `rolling_window(7)` | 重要度 | 否（窗口外自然退出） |
| `技术偏好.md` | tech_preference | state | `bounded(40, maxChars=12000)` | trustScore + supportCount | 否（supersede 即归档） |
| `工作画像.md` | profile_fact + work_style | state | `bounded(30, maxChars=10000)` | trustScore + supportCount | 否 |
| `工作模式.md` | work_style | derived_claim | `bounded(24, maxChars=8000)` | 频次 / 显著度 | 否 |

> **v0.1 → v0.2 修正**：
> - 把"输入 signal 类型"和"view 渲染策略"拆成两列。例如 `本周重点.md` 输入横跨三种 SignalKind，只能是 hybrid；v0.1 标 `event slice` 不准。
> - `决策日志.md` archive 默认窗口从 6 月扩到 12 月——决策追溯的核心价值常来自半年前以上的 why。窗口可在 config.yaml 中覆盖。
> - `项目时间线.md` archive 默认 12 月（与决策日志一致）。注意：本 PRD 把 PRD-output-quality-fixes §1 的"timeline 全量重建"原则**显式扩展**为"event-modality 不被 top-N 截断，但允许按月归档"。这不是回退（仍是 full retention），而是把"主文件 + archive"作为渲染层的可见性策略。

### 3.2 反复痛点的双层结构（v0.4 渐进版）

⚠️ **当前数据契约现状**：`PainPointPayload` 字段是 `{ problem, symptoms?, diagnosis?, workaround?, recurrence: 'low'|'medium'|'high' }`——**这本来就是 pattern/聚合形态，不是单次 occurrence**。当前 store 中没有 occurrence 级数据。

**v0.4 不新增 SignalKind**，用现有 pattern signal 的 metadata 近似展开 occurrence log：

- 顶部"当前反复出现的痛点模式"——直接用 `pain_point` signal，bounded top-10，按 `recurrence + supportCount + lastSeenAt` 排序。
- 底部"痛点发生日志"——把同一组 signal 按 `lastSeenAt` 月份分桶；每条展开 `evidenceIds` 中可定位到 session/date 的 evidence 作为"近似 occurrence"（不是真 occurrence，是"该模式在何时被观察到"）。

#### Observation 去重规则（v0.2.1 新增）

底部日志条目按以下 key 去重：

```
occurrenceKey = painSignalId + "|" + evidence.sessionId + "|" + (evidence.observedAt ?? formatYMD(evidence.capturedAt))
```

判定规则：

- 同一 pain signal 在同一 session 同一日（observedAt 优先；无则取 capturedAt 的 YYYY-MM-DD）下，只生成 **1 条** observation 条目。
- evidence 缺少 `sessionId`（如来自 `memory_file` / `rule_file` / `derived_note`）→ 不生成 observation 条目，但 supportCount 计入顶部模式。
- 渲染时按 `observedAt`（无则 `capturedAt`）倒序。

```markdown
<!-- generated: ... -->
<!-- modality: hybrid -->
<!-- retention: top=bounded(10); bottom=archive_by_month(currentMonths=6) -->
# 反复痛点

## 当前反复出现的痛点模式

> 顶部为 derived_claim 视图，bounded top-10，按 recurrence + supportCount 排序。

### 历史记录消失感
- **recurrence**: high
- **首次观察**: 2026-03-15
- **最近观察**: 2026-05-21
- **支持证据**: 4 sessions
- **代表 session**: abc-123, def-456

---

## 痛点发生日志（近似 occurrence — 由 evidence 反推）

> 底部为 event-shaped 视图，按月聚合，最近 6 个月完整保留，更早进 archive。

### 2026-05
- **2026-05-21** [OC] 历史记录消失感 — *session abc-123*
- **2026-05-15** [CC] MCP SSE 重连失败 — *session ghi-789*

### 2026-04
- ...

### 2026-03 及更早 → 见 archive/反复痛点-archive.md
```

> **真正的 occurrence schema 拆分**（新增 `pain_occurrence` SignalKind 与 `pain_pattern` SignalKind 区分）留给 Phase B 决定。Phase A 不引入新 SignalKind。

### 3.3 决策日志改为 time-ordered log

去除 top-50 ranking，改为按月分组：

```markdown
<!-- generated: ... -->
<!-- modality: event-log -->
<!-- retention: archive_by_month(currentMonths=12) -->
# 决策日志

## 2026-05

### 2026-05-21: ... 决策标题
- **背景**: ...
- **考虑过的方案**: ...
- **决定**: ...
- **理由**: ...
- **来源**: session ... [OC] — "..." (2026-05-21)

## 2026-04

...

## 历史索引

- 2026-04 → 主文件本节
- 2026-03 → archive/决策日志-archive.md (15 entries)
- 2026-02 → archive/决策日志-archive.md (8 entries)
- 2026-01 及更早 → archive/决策日志-archive.md
```

主文件末尾的"历史索引"section 是 v0.2 新增的关键设计——见 §4.4。它让 AI 消费者即使只读主文件也能知道 archive 存在与位置，而不是通过 manifest 才能发现。

### 3.4 未完成线索明确语义

文件顶部加注：

```markdown
<!-- modality: thread.current -->
<!-- retention: bounded(60); shows current open/in_progress/blocked only -->
# 未完成线索（仅显示当前未完成）

## 历史索引

- 已关闭的 thread → 见 项目时间线.md（按 close event 渲染）
- archive 不在本文件
```

closed thread 不进此文件；进入 `项目时间线.md` 作为 close event。

### 3.5 snapshot 三件套保持现状

`技术偏好.md` / `工作画像.md` / `工作模式.md` 的 bounded top-N 是对的，**不动**。仅在文件顶部加 modality 注释：

```markdown
<!-- modality: state -->     <!-- 或 derived_claim 对 工作模式.md -->
<!-- retention: bounded(40, maxChars=12000) -->
```

---

## §4 类型 / 接口变更

变更分两批：**Phase A（view 层最小改动）** 与 **Phase B（schema 下沉）**。Phase A 优先落地，Phase B 验证 A 体感后再做。

### 4.1 Phase A: 仅扩展 ViewBudget

`src/canonical/types.ts`:

```typescript
export type ViewModality =
  | 'event'           // 历史日志
  | 'state'           // 当前快照
  | 'thread'          // 生命周期事项（主视图为 current）
  | 'derived_claim'   // 持久化的派生模式（如 work_style）
  | 'derived_view'    // render-time 派生（不持久化）
  | 'hybrid';         // 文件内分区，混合多种 modality

export type ViewRetention =
  | { mode: 'full' }
  | { mode: 'bounded'; maxItemsTotal: number; maxChars?: number }
  | { mode: 'rolling_window'; days: number; maxChars?: number }
  | { mode: 'archive_by_month'; currentMonths: number; archivePath?: string; maxCharsCurrent?: number };

export interface ViewBudget {
  viewId: string;
  modality: ViewModality;          // NEW (v0.4)
  retention: ViewRetention;         // NEW (v0.4) — see precedence note below
  // === Legacy fields, kept for backward compat in Phase A ===
  buildMode?: ViewBuildMode;        // Phase A 接受但不再驱动新 compiler
  maxSignals?: number;              // 同上
  maxChars?: number;                // 同上（被 retention.maxChars / maxCharsCurrent 取代）
  maxSections?: number;
  maxItemsTotal?: number;           // 同上（被 retention.bounded.maxItemsTotal 取代）
  maxItemsPerSection?: number;
  sections?: string[];
  overflowPolicy?: 'truncate' | 'summarize' | 'drop_low_score';
  // ⚠️ 注意：v0.1 提到的 `overflow_to_archive` 不再单独枚举；
  //   "溢出到 archive"是 `retention.mode='archive_by_month'` 的内在行为，不是 overflowPolicy 的一种。
}
```

#### Retention precedence（重要）

> **Phase A 中 `retention` 是新 view compiler 的唯一权威；`buildMode / maxItemsTotal / maxChars` 仅用于 legacy compiler 与 publish-manifest 兼容。** 若两者同时出现且冲突，以 `retention` 为准，并在 extract 启动时打印 warning。
>
> 迁移期所有新 view（决策日志、反复痛点、项目时间线 archive 化）都通过 `retention` 配置；其他文件保留旧字段直到 §6.4 触发 Phase B 后再统一清理。

每个 view 的具体配置（v0.4 推荐值）：

| viewId | modality | retention |
|---|---|---|
| `project_timeline` | event | `archive_by_month(currentMonths=12, archivePath='archive/项目时间线-archive.md')` |
| `decisions` | event | `archive_by_month(currentMonths=12, archivePath='archive/决策日志-archive.md')` |
| `pain_points` | hybrid | top: `bounded(maxItemsTotal=10)` + bottom: `archive_by_month(currentMonths=6, archivePath='archive/反复痛点-archive.md')` |
| `open_threads` | thread | `bounded(maxItemsTotal=60)` (filter status ∈ open/in_progress/blocked) |
| `weekly_focus` | hybrid | `rolling_window(days=7, maxChars=6000)` |
| `tech_preferences` | state | `bounded(maxItemsTotal=40, maxChars=12000)` |
| `work_profile` | state | `bounded(maxItemsTotal=30, maxChars=10000)` |
| `work_patterns` | derived_claim | `bounded(maxItemsTotal=24, maxChars=8000)` |

### 4.2 Phase B: SignalKind 下沉 temporality

`src/canonical/types.ts`:

```typescript
export type SignalTemporality = 'event' | 'state' | 'thread' | 'derived_claim';

export const SIGNAL_TEMPORALITY: Record<SignalKind, SignalTemporality> = {
  timeline_event: 'event',
  decision: 'event',
  pain_point: 'event',          // ⚠️ Phase B 决定是否拆为 pain_occurrence + pain_pattern
  open_thread: 'thread',
  tech_preference: 'state',
  profile_fact: 'state',
  work_style: 'derived_claim',
};
```

> **静态 map vs per-instance 字段的取舍**：v0.2 选用静态 map。原因：当前 7 种 SignalKind 的 temporality 与 kind 是 1:1 关系，没有 per-instance override 需求；如果未来出现"同一 kind 但不同 instance 有不同 temporality"的情况（极少见），可在 `CanonicalSignal.metadata.temporalityOverride?` 上加 escape hatch，无需改动主 schema。

### 4.3 merge.ts 按 temporality 分语义

Phase B 才做。当前 merge.ts 对所有 SignalKind 用同一套逻辑（fingerprint dedup + canonicalKey upsert + lastSeenAt 更新）。按 temporality 应分为：

| Temporality | merge 行为 |
|---|---|
| `event` | fingerprint 完全一致 → dedup（合并 evidence、累加 supportCount、更新 lastSeenAt）。**不允许 supersede**。canonicalKey 不同的 event 永远是不同事件。 |
| `state` | 同 canonicalKey → 新证据 win，旧的 status='superseded'。允许 supersede chain（A → B → C）。 |
| `thread` | 同 canonicalKey → 合并到同一 thread；遇到 close event → status='closed'。 |
| `derived_claim` | 同 state，但合并需保留 evidence 数量阈值（避免一条新 evidence 直接 supersede 长期累积的模式）。 |

#### Conflicting event 语义（Phase A 不实现，PRD 占位）

两条相反的 event 不能互相 supersede——它们都是历史事实。例如：

> 2026-03 决定: 选 SQLite  
> 2026-05 决定: 改回 Postgres

两条都应保持 active，但需要表达 link：

```typescript
export interface CanonicalSignalBase {
  // ... existing fields ...
  /** Phase B 新增：同 modality 的关联引用 */
  relatedSignalIds?: string[];
  /** Phase B 新增：明确表达"本 event 推翻/取代了某历史 event"，用于渲染 hint */
  reversesSignalId?: string;
}
```

渲染时（Phase B），决策日志的"2026-05 决定"那条会带一个 callout：

```markdown
### 2026-05-30: 改回 Postgres
- **背景**: ...
- **理由**: ...
- ⚠️ **推翻历史决定**: 2026-03-17 选 SQLite（[查看](#2026-03-17)）
```

旧 event 仍 active，因为"当时做过该决定"仍是历史事实——只是被新事件 link 标注。

### 4.4 archive_by_month 渲染细节（v0.2 加强）

#### 数据结构

```typescript
// src/canonical/views/archive.ts (新)
export interface MonthlyBucket {
  yearMonth: string;          // "2026-05"
  signals: CanonicalSignal[];
  count: number;
}

export interface ArchiveRenderResult {
  /** 主文件 markdown（最近 N 月完整 + 历史索引 section） */
  current: string;
  /** archive 文件 markdown（更早全量） */
  archive: string;
  /** 历史索引数据（供 publish-manifest.json 使用） */
  index: { yearMonth: string; location: 'current' | 'archive'; count: number }[];
}

export function bucketByMonth(signals: CanonicalSignal[]): MonthlyBucket[];

export function renderArchiveByMonth(
  signals: CanonicalSignal[],
  budget: { currentMonths: number; archivePath: string },
  renderItem: (signal: CanonicalSignal) => string,
  options?: { maxCharsCurrent?: number },
): ArchiveRenderResult;
```

#### 主文件结构

```markdown
<!-- generated: ... -->
<!-- modality: event -->
<!-- retention: archive_by_month(currentMonths=12) -->
<!-- archive: archive/决策日志-archive.md -->
# 决策日志

## 2026-05
... (近 12 月每月一个 section)

## 2026-06
...

## 历史索引

| 月份 | 条目数 | 位置 |
|---|---:|---|
| 2026-05 | 8 | 本文件 §2026-05 |
| 2026-04 | 12 | 本文件 §2026-04 |
| ... | ... | ... |
| 2025-08 | 5 | archive/决策日志-archive.md |
| 2025-07 及更早 | 24 | archive/决策日志-archive.md |
```

> **关键**：v0.1 只在主文件末尾放一行 pointer（`## 2026-03 及更早 → 见 archive/...`），AI 消费者很可能跳过。v0.2 改为完整的"历史索引"表格，让任何只读主文件的消费者都能：
> 1. 知道历史的总规模（N 个月、M 条）
> 2. 找到 archive 文件的精确路径
> 3. 决定是否需要展开 archive

#### 历史索引自身也是 bounded metadata（v0.2.1 新增）

历史索引只携带月份/条目数/位置，不携带事件详情，所以不违背 PRD-canonical-pipeline §9.4 的预算原则。但索引本身也可能因系统使用年限增长而膨胀。约束：

- **月份数 ≤ 36**：当 archive 跨越超过 36 个月时，索引按年份折叠：
  ```markdown
  | 2024 全年 | 87 | archive/2024/决策日志-archive.md |
  | 2023 全年 | 142 | archive/2023/决策日志-archive.md |
  ```
- 折叠后单条索引引用一整年的 archive 文件；archive 文件可在文件系统中按年份分目录，避免单文件过大。
- 实施位置：`renderArchiveByMonth()` 在生成 `ArchiveRenderResult.index` 时检查月份数，超过阈值则触发折叠。

#### publish-manifest.json 集成

当前 `src/canonical/store.ts` 已有 `publishManifest: PublishedView[]`（见第 16/57/68/83/133/137/139 行）。v0.4 扩展 `PublishedView` 加入 archive 引用：

```typescript
export interface PublishedView {
  viewId: string;
  title: string;
  generatedAt: number;
  sourceSignalIds: string[];
  budget: ViewBudget;
  sections: PublishedViewSection[];
  markdown: string;
  // === v0.4 新增 ===
  /** archive 文件相对路径（仅 retention='archive_by_month' 时存在） */
  archiveFile?: string;
  /** 历史索引：每个月份的位置 */
  archiveIndex?: { yearMonth: string; location: 'current' | 'archive'; count: number }[];
}
```

消费者（CLAUDE.md include / deep-daily-report）可以：
1. 读 `publish-manifest.json` 获取所有 view 的 archiveFile 列表
2. 默认只 include 主文件（保持冷启动 token 预算）
3. 需要历史追溯时，按需加载 archive

> **Schema 兼容性约束（v0.2.1 新增）**：`archiveFile` 与 `archiveIndex` 必须为 optional 字段；旧消费者忽略这两个字段时仍能正常工作。本 PRD 不引入 schema-version，依赖 additive-only 演进。
>
> **README + CLAUDE include 模板必须同步更新**——见 §6.2 Phase A2 的实施步骤。

### 4.5 Layer 4 polish 对 event log 的约束

PRD-canonical-pipeline §4.5 + commit `3b68246`：当前所有 view sections 在渲染后会进入 Layer 4 LLM polish（`src/canonical/views/polish.ts`），用于中文化、术语统一、措辞改写。

⚠️ **对 event log 来说，polish 不得改变信号集合**。具体约束（在 polish.ts 中实现）：

| view modality | polish 允许做 | polish 不允许做 |
|---|---|---|
| `state` / `derived_claim` | 改写措辞、合并相邻条目、去除冗余 | 编造新事实 |
| `event` / `thread` / `hybrid (event log 区域)` | **仅改写每条事件的措辞** | **合并多条事件、省略事件、改写日期、改写 session 引用** |

#### Strict mode 数据契约（v0.2.1 加严）

仅靠 markdown 正则计 bullet 数无法稳健检测违规——polish 可能改写 bullet 结构而条目数恰好不变。`PolishSectionInput` 必须为 event-shaped section 携带机器可校验的 entry metadata：

```typescript
export interface PolishEntryRef {
  signalId: string;           // CanonicalSignal.id（必填）
  date?: string;              // 渲染时使用的 ISO 日期（如 timeline_event.payload.date）
  sessionRef?: string;        // 来源 session 引用（如 OC:abc-123）
}

export interface PolishSectionInput {
  sectionId: string;
  title: string;
  draftMarkdown: string;
  signalIdsKey?: string;
  /** v0.2.1 新增：event-shaped section 必填，state/derived_claim section 可省略 */
  entries?: PolishEntryRef[];
}
```

渲染器在生成 draft markdown 时，**为每条 entry 注入稳定 HTML marker**（不会被 polish prompt 当成 jargon 改写）：

```markdown
<!-- entry: signalId=sig_abc; date=2026-05-21; ref=OC:abc-123 -->
### 2026-05-21: 选择 SQLite
- 背景: ...
```

Polish strict mode 校验：

1. polish 返回的 markdown 中能解析出的 `<!-- entry: ... -->` marker 集合，必须与输入 `entries[]` 集合**严格相等**（按 `signalId` 比较，date/sessionRef 不变）。
2. 若 marker 集合不一致 → 该 section 整批 fallback 到未润色的 draft，不写入最终 markdown。
3. fallback 事件写入 `cron.log`，包含 sectionId + 期望/实际 marker 集合 diff。

> 实施位置：`src/canonical/views/polish.ts` 的 `polishSections()` 内部；entry marker 注入由各 event-shaped view compiler（decisions.ts、timeline.ts、pain-points.ts 底部、weekly-focus.ts）负责。

### 4.6 canonical store 长期增长边界

当前 `.state/signals.json` 是 JSON 文件全量加载/写入。event-modality 信号会随时间无限累积，需要观测和触发 SQLite 迁移的边界：

#### 观测指标（每次 extract 输出到 cron.log）

```
[store-stats]
  total signals: 1247
  by kind: decision=312, pain_point=89, timeline_event=518, ...
  by status: active=1102, superseded=98, archived=47
  store size: 2.3 MB
  load time: 84 ms
  save time: 142 ms
```

#### SQLite 迁移触发条件（继承 PRD-canonical-pipeline §7.4，本 PRD 加严）

满足任一即应启动 SQLite 迁移评估：

- `signals.json` 体积 > 50 MB
- load 时间 > 500ms
- save 时间 > 1s
- event-modality signals 总数 > 50,000
- archive 文件总数 > 30（说明跨月分桶查询会成为常态）

未触发前继续 JSON 存储。

---

## §5 验收标准

### 5.1 行为不变项（不应回退）

- `项目时间线.md` 主文件 + archive 合计内容量与 `trial2/项目时间线.md`（203KB）相当或更多。
- `技术偏好.md` / `工作画像.md` / `工作模式.md` 行数与 `trial2` 一致或更短（仍然 bounded）。
- 所有 markdown 文件顶部包含 `<!-- modality: ... -->` 和 `<!-- retention: ... -->` 注释。
- `publish-manifest.json` 对每个 view 都有有效记录；archive 化的 view 包含 `archiveFile` 和 `archiveIndex`。

### 5.2 修复项（应被验证）

- 删除 `output/决策日志.md` 与 `archive/决策日志-archive.md`，跑 extract → 文件再生，且 `决策日志.md` 主文件 + archive 合计包含 canonical store 中 status='active' 的**全部** decision，不再是 top-50 切片。
- 取一条已知存在于 canonical store 但**未出现在 trial2/决策日志.md** 中的 3 月决策 → 在 v0.4 实现下重跑 → 该决策必须出现在 `决策日志.md` 主文件（若在 12 月窗口内）或 `archive/决策日志-archive.md` 中。
- `决策日志.md` 主文件末尾的"历史索引"section 列出所有月份的位置，且其中 archive 文件路径在文件系统中实际存在。
- `反复痛点.md` 顶部"当前反复出现的痛点模式" section ≤ 10 条；底部"痛点发生日志" section 完整列出最近 6 个月所有**可由 evidenceIds 定位到 session/date 的 observation 条目**。同一 pain signal 在同一 (sessionId, observedAt) 下去重，仅显示一次；不可定位到 session/date 的 evidence（如 derived_note、memory_file）不生成日志条目，但仍计入顶部 supportCount。
- `反复痛点.md` 顶部和底部 sections 必须 round-trip：底部任意一条 observation 条目都能通过 evidenceIds 追溯到顶部某个模式 signal。
- 没有任何 event-modality 信号因为 trustScore 排名挤出 top-N 而丢失——event 类信号要么在主文件，要么在 archive 文件，**不允许在 canonical store 但任何输出都看不到**。
- `publish-manifest.json` 中 `archiveFile` 字段引用的所有路径在文件系统中存在。

### 5.3 Layer 4 polish strict mode 验证

- 在 polish 输入/输出的中间产物（`.state/view-polish-cache.json`）中，event-shaped section 的 entry 数 input == entry 数 output；若不一致 polish 必须 fallback 到原文。
- 给一段已知有 5 条 decision 的 sectiosn 故意输入恶意 polish prompt → 输出仍是 5 条。

### 5.4 体感项（用户可观察）

- 用户从 `trial2` 升级到 v0.4 后，重跑 extract，肉眼能在 `决策日志.md` 或其 archive 中找到 trial2 时丢失的 3 月份决策。
- 用户能通过文件顶部的 modality 注释，自己判断"这个文件是历史账本，还是当前快照"。
- 用户从主文件的"历史索引"section 能直接看到 archive 的总规模和路径，不需要查 manifest。

---

## §6 迁移路径

### 6.1 顺序原则

1. **不重写 canonical store**。
2. **不动 extraction / merge 主路径**（除非 §6.3 的修复需要）。
3. **从 view 层开始**，让用户感知问题最强的两个文件（决策日志、反复痛点）先得到修复。
4. **观察体感 1-2 周**后，再决定是否做 Phase B（temporality 下沉 + merge 分语义）。

### 6.2 Phase A 实施步骤（重估 3-5 engineer-days，理想 2-4 天，拆 A1 / A2）

#### Phase A1（1-2 天）：决策日志 + modality 基建

1. **加 ViewModality / ViewRetention 类型**（§4.1）。所有现有 ViewBudget 标注 modality；retention 在 A1 阶段对未迁移的 view 全部映射到 `bounded(maxItemsTotal, maxChars)`，行为不变。
2. **实现 `src/canonical/views/archive.ts`**：`bucketByMonth` + `renderArchiveByMonth` + `ArchiveRenderResult` 类型。
3. **`决策日志.md` 改为 `archive_by_month(currentMonths=12)`**：删除 top-50 截断；主文件按月渲染；末尾加"历史索引"section；写出 archive 文件。
4. **扩展 `PublishedView` 结构**：加 `archiveFile` / `archiveIndex` 字段；store.ts 写出时同步更新 publish-manifest.json。
5. **加 retention precedence 启动校验**：extract 启动时若发现某个 view 同时配了 `retention` 和 legacy `maxItemsTotal` 且数值不一致，warning 一条。
6. **所有 8 个文件顶部加 modality / retention 注释**（仅注释，不改其他渲染逻辑）。
7. **smoke test**：跑一次 extract，检查 `archive/决策日志-archive.md` 已生成、`publish-manifest.json` 包含 archive 引用、主文件历史索引非空。
8. **更新 README + CLAUDE include 模板说明**：明确 8 个主文件 + N 个 archive 文件的输出结构；archive 是 opt-in 消费。

#### Phase A2（2-3 天）：反复痛点 hybrid + 未完成线索语义

9. **`反复痛点.md` 改为 hybrid 双层**：顶部用现有 `pain_point` signal bounded top-10；底部按 `lastSeenAt` 月份分桶展开 occurrence-近似条目（用 evidenceIds 反推 session 引用）；archive 化更早月份。
10. **`未完成线索.md` 加 thread.current filter**：渲染时只取 `payload.status ∈ {open, in_progress, blocked}`；closed 的不在此文件出现。
11. **Layer 4 polish strict mode**：对 `modality ∈ {event, thread, hybrid 的 event-log 区域}` 的 section，要求 entry 数量 input==output；不一致则 fallback。
12. **回归测试**：用 §5.2 验收标准跑全套，特别验证"trial2 时丢失的 3 月决策"能再次出现。

> **A1 / A2 可由不同人同时推进，但 A2 依赖 A1 的 ViewBudget 类型与 archive 渲染基建；建议串行。总工期估计 3-5 engineer-days，理想顺利情况下 2-4 天。若现有 polish.ts 改造或 entry marker 注入比预期复杂，A2 可能延长到 3 天，整体落入 4-5 ed。**

### 6.3 已存在数据的修复（三阶段安全 migration）

⚠️ **关键风险**：当前 `.state/signals.json` 中可能存在被早期 merge 错误标记为 `superseded` 的 event-temporality signal（decision / pain_point / timeline_event）。但**不能简单地全部 reset 回 active**——以下三种情况必须分开处理：

| 情况 | 例子 | 处理 |
|---|---|---|
| **真误 supersede**（modality 错配的次生损伤） | 2026-03 的 decision 因 canonicalKey 碰撞被 2026-05 的 decision 标 superseded | 自动恢复 active |
| **合法 dedup**（被早期 merge 当近重复合并） | 同一决策被两个 session 提及，merge 把后者标 superseded 并把 evidence 并入前者 | **不要恢复**——这是正确的 dedup 行为 |
| **质量门正常 reject 后转 superseded**（早期实现把 reject 错当 supersede） | 旧逻辑残留 | 进入 review report，人工确认 |

#### Migration 三阶段

`scripts/migrate-event-status.ts`（dry-run 优先）：

**阶段 1: dry-run scan**

```bash
npm run migrate:event-status -- --dry-run --output .state/migration-report.json
```

输出每条 `event-temporality + status='superseded'` 的信号 + 分类：

```json
{
  "auto_recoverable": [
    {
      "id": "sig_abc",
      "kind": "decision",
      "canonicalKey": "...",
      "reason": "no active sibling with same canonicalKey; fingerprint not duplicated; mergeNotes empty"
    }
  ],
  "needs_review": [
    {
      "id": "sig_xyz",
      "kind": "decision",
      "canonicalKey": "...",
      "reason": "has active sibling sig_def with same canonicalKey",
      "context": "可能是合法 dedup；评估两条 evidence 是否真的相同"
    }
  ],
  "skipped_legitimate_dedup": [
    {
      "id": "sig_pqr",
      "kind": "pain_point",
      "reason": "fingerprint matches active signal sig_stu; clean dedup, no action"
    }
  ]
}
```

判定规则（保守优先）：

- `auto_recoverable` ⟺ 同 canonicalKey 下没有 active sibling **且** 同 fingerprint 没有 active duplicate **且** mergeNotes 为空
- `skipped_legitimate_dedup` ⟺ 同 fingerprint 有 active duplicate（这是正确的 dedup，不动）
- `needs_review` ⟺ 其他情况，进 report，不自动改

**阶段 2: apply auto-recovery**

```bash
npm run migrate:event-status -- --apply --backup .state.backup-2026-05-22
```

仅恢复 `auto_recoverable` 中的信号；写入 mergeNotes:

```typescript
signal.mergeNotes = [
  ...(signal.mergeNotes ?? []),
  `restored-by-modality-split-v0.4 at ${new Date().toISOString()}; previous status='superseded'; reason: auto_recoverable per migration rule`,
];
```

backup `.state/` 到指定路径，然后写回。

**阶段 3: human review**

`needs_review` 进 `.state/migration-needs-review.md`，由用户审核后选择性 promote。本 PRD 不规定具体 UI，建议初版仅是 markdown 文件 + 手动编辑 signals.json。

### 6.4 Phase B 触发条件（量化）

Phase A 落地后观察 1-2 周。以下任一为真，启动 Phase B：

- **量化指标**：连续两次 extract 后，`migration-report.json` 中新增 `event + superseded` 数量 > 0（说明 merge.ts 还在错误地 supersede event）。
- **量化指标**：active event signals 在主文件 + archive 中的总出现率 < 100%（说明 view 层仍在丢历史）。
- **量化指标**：相同 canonicalKey 的 event signal 被 dedup 后 evidence 重叠率 < 80%（说明 dedup 把不同事件错误合并）。
- **使用反馈**：用户在 1 周内再次报告"看不到旧记录"。

否则 Phase B 可以推迟。

---

## §7 风险与边界

### 7.1 风险

1. **archive 文件无限增长** —— event log 本质就会随时间累积。  
   **缓解**：archive 通过 publish-manifest 可被消费者发现；主文件保留"历史索引"section + 总条目数；按年再分割（`archive/2026/决策日志-archive.md`）；§4.6 给出 SQLite 迁移触发条件。  
   **澄清 v0.1 的错误说法**：v0.1 写"archive 不参与 AI 默认消费"——这句话与 PRD §1.4 的"持续生长"承诺冲突。v0.2 改为：**主文件默认 AI 消费，archive 通过 manifest 可选消费**；若消费者不读 archive，主文件的"历史索引"section 必须保留足够的检索提示（月份范围、条目数、archive 路径）。

2. **migration 误改用户数据** —— §6.3 的 status reset 必须经过三阶段 dry-run + 人工 review；backup `.state/` 是必须的；自动恢复仅限 `auto_recoverable` 类。`needs_review` 一律不动，进 markdown 报告供用户审核。

3. **modality 分类争议** ——  
   - `work_style` 算 derived_claim 还是 state？v0.2 取 derived_claim（理由：从 event 聚合而来，但持久化），但渲染策略与 state 一样 bounded；语义差异主要影响 Phase B 的 merge 行为（derived_claim 合并需要 evidence 阈值，state 不需要）。  
   - `pain_point` 在 v0.4 仍是 pattern 形态。**真正的 occurrence schema 拆分**（新增 `pain_occurrence` 与 `pain_pattern` 两种 SignalKind）留给 Phase B 决定。Phase A 的 hybrid 渲染本质是"用 pattern 数据近似 occurrence 视图"，会有保真度损失，需要在文件顶部注释中提示用户。

4. **hybrid 文件复杂度** —— `反复痛点.md` 双层结构会让渲染代码更复杂。  
   **缓解**：双层用两个独立的 view compiler 函数 + 一个 stitcher，互不耦合；hybrid 文件唯一新增的 view 类型是它，其他文件继续单层。

5. **archive 文件被消费者忽视的风险** —— 即使 manifest 暴露了，下游工具（CLAUDE.md include / deep-daily-report）仍可能只读主文件。  
   **缓解**：主文件"历史索引"section 是兜底机制——任何只读主文件的消费者也能看到历史的存在和位置。**README + CLAUDE include 模板必须同步更新**，给出 archive 消费的最佳实践（如"周五回顾时手动加载 archive"）。

6. **Layer 4 polish 破坏 event log 完整性** —— 当前 polish 允许合并相邻 entries / 改写措辞。如果不加 strict mode，polish 可能在 event log 区域偷偷合并多条事件。  
   **缓解**：§4.5 定义 strict mode；polish.ts 检测 entry 数变化时整批 fallback；polish-cache 保留 input/output diff 供 audit。

7. **canonical store 长期体积** —— event 永不删除，store 会持续增长。  
   **缓解**：§4.6 定义观测指标 + SQLite 触发条件；JSON 存储在触发条件之前足够。

### 7.2 边界（本 PRD 不做）

- 不引入新的 SignalKind（特别是不拆 `pain_point` 为 occurrence + pattern；Phase B 决定）。
- 不改 extractor。
- 不改 quality gate 的 reject 规则（fuzzy date / incomplete pain point 仍然 reject）；quarantine recovery 由独立 PRD 处理。
- 不引入 SQLite（继续 JSON file store）。
- 不实现 ranking transparency / quarantine recovery / doctor 命令——这些属于"observability"主题，应另起 `PRD-observability.md`。
- 不实现 `relatedSignalIds` / `reversesSignalId` 的提取与渲染逻辑（Phase B）。

---

## §8 与既有 PRD 的对齐

| 既有 PRD | 受影响章节 | 修订指引 |
|---|---|---|
| PRD-canonical-signal-pipeline §3.5 | 视图预算表 | 本 PRD 取代旧预算表的 retention 定义；旧 maxItemsTotal/maxChars 在 Phase A 退化为 `bounded.maxItemsTotal/maxChars`；`retention` 是新 view compiler 的唯一权威（见 §4.1 precedence） |
| PRD-canonical-signal-pipeline §4.4 | 合并语义 | Phase B 实施时按 temporality 分流；Phase A 不动 merge 主路径 |
| PRD-canonical-signal-pipeline §4.5 | 视图编译器 | 引入 archive_by_month 渲染模式；薄编译器原则不变（archive 渲染仅做按月分桶，不引入新的智能逻辑）；`derived_view`（如项目时间线 `<!-- desc: -->`）的语义保留 |
| PRD-canonical-signal-pipeline §3.6 | RelevanceClassifier | 不动 |
| PRD-canonical-signal-pipeline §7.4 | SQLite 升级触发条件 | 本 PRD §4.6 加严：补充"archive 文件总数 > 30"和"event-modality signals > 50000"两个量化触发 |
| PRD-output-quality-fixes §1 | Layer 1 全量重建 | 本 PRD 把"timeline 全量重建"原则**泛化**为"event-modality 不被 top-N 截断"，但允许按月归档；与原 PRD §1 的"修复增量跑产出空文件"一致——主文件 + archive 合计仍是 full retention |
| PRD-output-quality-fixes §2 | Timeline desc | 不动；它是 derived_view（render-time），符合 v0.2 §2.1 的新分类 |
| PRD-output-quality-fixes §3 | 元评论过滤 | 不动 |
| PRD-output-quality-fixes §4 | 核心画像 scope 过滤 | 不动 |
| PRD.md §1.4 | 可积累 / 记忆越来越完整 | 本 PRD 是这条产品承诺的实现保障——区分 store 层"完整"与 view 层"有界 + archive 索引"，让二者共存而不冲突 |
| PRD.md §6.2 输出目录 | 输出目录结构 | 新增 `archive/` 子目录；publish-manifest.json 已存在（见 store.ts）；README 同步 |

---

## §9 Changelog

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.2.1 | 2026-05-22 | Oracle 第二轮 review ACCEPT 后的 polish。(1) §4.5 strict mode 数据契约写实——`PolishSectionInput.entries[]` 携带 signalId/date/sessionRef，渲染器注入稳定 HTML `<!-- entry: ... -->` marker；polish 校验 marker 集合不变，否则整批 fallback。(2) §5.2 pain_point 验收语句改为"observation"表述，明确不承诺真正 occurrence 完整性，去重 key 为 `painSignalId + sessionId + observedAt`。(3) §3.2 补 occurrence-near 去重规则。(4) §4.4 历史索引也是 bounded metadata，月份 > 36 时按年折叠。(5) §4.4 PublishedView 扩展加 additive-only schema 兼容性约束。(6) §6.2 工期改实——A2 改 2-3 天，总计 3-5 engineer-days，理想 2-4 天。 |
| v0.2 | 2026-05-22 | Oracle 评审后修订。(1) `derived` 拆为 `derived_claim`（持久化，如 work_style）和 `derived_view`（render-time 派生）；尊重 work_style 在 codebase 中已持久化的现状。(2) `pain_point` 改为渐进式 hybrid——v0.4 不新增 SignalKind，用现有 PainPointPayload 的 pattern 形态近似展开 occurrence log；真 occurrence schema 留给 Phase B。(3) `本周重点.md` 改标 hybrid rolling_window（消费 timeline_event + open_thread + decision 三类）。(4) ViewBudget retention precedence 写明：`retention` 权威，旧字段仅 legacy 兼容；删除 `overflow_to_archive`。(5) §4.4 archive 主文件加"历史索引" section + publish-manifest 集成；archive 升级为产品输出一等公民；明确 README + CLAUDE include 模板需同步。(6) §4.5 新增 Layer 4 polish strict mode 对 event log 的约束。(7) §4.3 新增 conflicting event 语义占位（`relatedSignalIds` / `reversesSignalId`，Phase B 实施）。(8) §4.6 新增 canonical store 长期增长观测指标 + SQLite 触发条件。(9) §6.2 工期改实，拆 A1（决策日志 + 基建）/ A2（反复痛点 hybrid + 未完成线索）。(10) §6.3 migration 改为三阶段安全流程（dry-run scan → auto-recovery 仅无歧义信号 → human review）。(11) §5 验收标准用真实文件名（决策日志.md），新增 polish strict mode 验证。(12) `决策日志.md` archive 默认窗口从 6 月扩到 12 月。 |
| v0.1 | 2026-05-22 | 初稿。定义 modality 二分（event / state / thread / derived），分类 8 个输出文件，定义 ViewRetention 类型与 archive_by_month 渲染模式，给出 Phase A / Phase B 迁移路径与 §6.3 一次性数据修复脚本。 |
