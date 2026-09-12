# Blog Brief: session-memory — 开发者的数据分身

> 给技术博客写手的素材包。你需要了解的都在这里。

---

## 1. 一句话定位

**从两个 AI 编码助手的历史对话中，持续提炼个人工作记忆，输出 8 个 markdown 文件。任何 AI 读取后即可理解你的偏好、决策脉络和未竟之事。**

用大白话说：把你和 AI 的聊天记录变成你的"个人说明书"，让新的 AI 工具第一天就懂你。

---

## 2. 写作角度（三选一，或组合）

### 角度 A：数据主权叙事（推荐）

> "你每天和 AI 聊了几十轮，但这些对话属于 AI 工具商，不属于你。session-memory 把数据所有权拿回来——你的决策、偏好、工作习惯，变成你自己的知识体。"

- 痛点：AI 助手数据锁死在各家平台里
- 解法：独立的提取管道，输出纯 markdown，任何工具都能消费
- 升华：不只是"记忆"，是 AI 时代的个人知识基建

### 角度 B：工程问题叙事

> "36,000 个 session、172,000 条消息——怎么从垃圾堆里炼金子？"

- 挑战：跨源数据（SQLite + JSONL）、噪音过滤（自动化 bot 占 95%）、三层提取控制成本
- 解法：Source Adapter 架构 + 噪音自动检测 + 三层提取（零成本 → 极低 → 低）
- 升华：AI 时代的 ETL 问题，方法论可复用

### 角度 C：AI UX 叙事

> "让 AI 第一天就懂你。session-memory 解决的是 AI 工具最烦人的问题：每次开新 session 都从零开始。"

- 痛点：冷启动成本——每次都解释"我用的是 Drizzle 不是 Prisma"
- 解法：8 个 markdown 文件直接注入 system prompt / CLAUDE.md / deep-daily-report
- 升华：personalization at scale — 不依赖厂商做记忆，自己掌控

> 💡 **已有真实消费者**：deep-daily-report（个人深度日报）已经在生产环境中基于 session-memory 的工作画像生成个性化日报——这是一个独立的消费端，证明了产出物确实能被下游 AI 工具直接消费。

---

## 3. 核心数据（可引用）

| 指标 | 数据 | 来源 |
|---|---|---|
| 数据源 | OpenCode (SQLite) + Claude Code (JSONL) | 双源架构 |
| 真实规模 | ~36,000 sessions, ~172,000 messages, 12 个项目 | 创始人生产数据 |
| 噪音过滤 | 自动检测 5 维信号，自动排除 ~95% bot session | config.example.yaml |
| 输出文件 | 8 个 markdown + archive 子目录 | README |
| 首次全量 | ~7 分钟（含 AI 调用） | README |
| 每次增量 | ~50 秒 | README |
| AI 成本 | 全量 < $3，增量 < $0.15 | PRD §5.4.4 |
| 定时更新 | cron 每 4 小时 | README |
| 技术栈 | TypeScript, better-sqlite3, Node.js | package.json |

---

## 4. 技术亮点（可展开的卖点）

### 4.1 Source Adapter 架构
同一套提取管道，通过 adapter 同时支持 OpenCode (SQLite) 和 Claude Code (JSONL)。未来可扩展 Cursor, Copilot 等。不是写死一种工具的 hack。

### 4.2 Canonical Signal Pipeline
内部数据模型从"渲染用文本"升级为"结构化知识声明"。7 种信号类型（tech_preference, decision, pain_point, timeline_event...），经过统一质量关卡 → 确定性去重 → 输出预算控制，才最终渲染为 markdown。

### 4.3 三层提取 + 成本控制
- Layer 1 (零成本): SQL 查询 → 项目时间线、未完成线索
- Layer 2 (极低): 文本匹配 → 工作模式、技术偏好
- Layer 3 (低): AI batch 提取 → 决策日志、反复痛点、工作画像
- Layer 4 (可选): LLM polish → 中文输出润色

### 4.4 Modality Split (v0.2)
识别到 event-shaped 信号（决策、时间线）不能被 top-N ranking 截断，否则 3 月份的决策会被 5 月份的挤掉。引入 `archive_by_month` 视图，保证历史完整性 → 900 条决策从 5.6% 覆盖率提升到 **100%**。

### 4.5 噪音自动检测
不用硬编码排除项目名。5 维信号自动识别 bot（时段均匀分布、首条消息重复、session 极短、单项目占比异常、用户参与度低），命中 2 条即过滤。

---

## 5. 真实应用场景

这 8 个 markdown 文件不是"生成完就放着的档案"——它们已经在实际工作流中被消费：

| 场景 | 触发 | 消费文件 | 效果 |
|---|---|---|---|
| **AI 冷启动消除** | 新开 session 开发某项目 | 工作画像 + 技术偏好 | AI 直接理解你的偏好，不再问"想用什么 ORM" |
| **决策追溯** | "上次为什么不用 Postgres？" | 决策日志 | 直接定位到决策记录和 session 来源 |
| **新项目技术选型** | 启动一个新项目 | 技术偏好 | 技术栈不用再解释一遍 |
| **周五回顾** | 每周五下午 | 未完成线索 | 清理过期 todo，不遗忘承诺 |
| **跨项目经验复用** | B 项目遇到类似问题 | 反复痛点 | A 项目踩过的坑直接复用解法 |
| **季度汇报** | 回顾过去做了什么 | 项目时间线 | 每个项目的里程碑一目了然 |

### 5.1 真实下游消费者

session-memory 不是停留在"生成文件"就结束的 demo——它已经在生产环境被真实产品消费：

| 消费者 | 接入方式 | 说明 |
|---|---|---|
| **deep-daily-report**（个人深度日报） | 读取 8 个 markdown 文件 | 利用工作画像中的交互风格和技术审美，生成高度个性化的日报——知道你的角色、偏好、项目上下文，日报不再是泛泛的摘要 |
| **OpenCode / Claude Code** | CLAUDE.md 中 include 文件路径 | 每个 session 自动加载你的画像，消除冷启动 |
| **你自己** | 直接打开 review | 周五回顾、季度总结、新人 onboarding |

> **写手指南**：deep-daily-report 是最有说服力的案例——它不是 session-memory 的同作者项目，而是一个独立的消费端。这证明了 session-memory 产出的 markdown 文件**确实能被其他 AI 工具直接消费**，不是闭门造车。

---

## 6. 竞品对比（给写手做 positioning）

| 方案 | 类型 | session-memory 的差异 |
|---|---|---|
| 各 AI 工具内置记忆 | 厂商锁定、不可跨工具 | session-memory 独立于工具，输出通用 markdown |
| mem0 / LangMem | API 服务、向量检索 | session-memory 本地运行，隐私友好，输出结构化而非向量 |
| Cursor Rules / CLAUDE.md | 手动编写静态文件 | session-memory **自动**从历史对话提炼，不需手写 |
| 手动整理笔记 | 纯人工 | 自动化、持续、增量 |

**session-memory 的独特定位**：本地运行 + 自动提取 + 跨工具 + 输出通用 markdown。不是"又一个记忆工具"，是"把你已有数据炼成可消费的知识"。

---

## 7. 输出物一览（写手可以截图/展示）

运行后 `~/.local/share/session-memory/` 下生成：

```
工作画像.md          # 你的角色、职责、交互风格、技术审美
项目时间线.md        # 每个项目从创建到现在的关键里程碑
本周重点.md          # 滚动窗口：进行中/已完成/关键决策
未完成线索.md        # 跨项目未完成 todo 汇总
决策日志.md          # 技术/产品决策（含替代方案和理由）
反复痛点.md          # 反复出现的工程问题及解决模式
技术偏好.md          # 跨项目技术偏好（框架/工具/部署）
工作模式.md          # 高频任务类型 + 时段分布 + 首条消息模式
```

每个文件都有标准格式头：`<!-- generated: ISO8601 -->` + `<!-- sources: opencode(N) + claude_code(M) -->`

---

## 8. 快速体验（给读者 try it yourself 用）

```bash
git clone <repo-url>
cd session-memory
npm install
cp config.example.yaml config.yaml
# 编辑 config.yaml，配置 layer3.api_key 和 api_base_url
npm run build
npm run extract
```

首次全量 ~7 分钟，输出到 `~/.local/share/session-memory/`。

---

## 9. 写作禁忌（Don't）

- ❌ **不要把它写成"又一个大模型应用"** — 它的卖点是**数据管道**，不是 AI API wrapper。AI 只在 Layer 3 用了 1/3 的工作量。
- ❌ **不要比作 RAG 或向量数据库** — 输出是结构化 markdown 文件，不是 embedding。消费者是 AI 工具直接读文本。
- ❌ **不要过度技术化** — 核心读者是想提升 AI 协作效率的开发者，不是 LLM 研究员。架构细节挑 1-2 个亮点讲，不要全列。
- ❌ **不要贴一堆代码** — 输出示例比代码片段更有说服力。让人看到它能产出什么，比展示怎么产出的更有吸引力。
- ❌ **不要用 STATUS.md 或 DELIVERY.md 的任何内容** — 这两个文件已删除，是内部实施日志，与产品价值无关。

## 10. 推荐结构

```
1. 引子：一个开发者的日常（和 AI 聊了 300 个 session 后，"我当时为什么选 SQLite 来着？"）
2. 问题：AI 助手的记忆断层症（每次新 session 从零开始，跨项目经验无法复用）
3. 解法：session-memory 是什么（8 个 markdown 文件 = 你的数据分身）
4. 架构亮点：挑 1-2 个（推荐 Source Adapter + 三层提取控制成本）
5. 场景：不只是生成文件——有人已经在用（AI 冷启动消除、决策追溯、deep-daily-report 个性化日报）
6. 效果：输出示例 + 真实数据（那 850 条被找回的 3 月决策）
7. 对比：和内置记忆/mem0/Cursor Rules 有什么不同
8. 快速上手
```

---

## 11. 元信息

- 项目名称：session-memory
- 口号：开发者的数据分身
- 语言：TypeScript, Node.js
- 许可证：（待定，如果你还没加 LICENSE）
- 仓库状态：v0.1.0，39 commits，活跃开发中