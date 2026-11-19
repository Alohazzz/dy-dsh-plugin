# 云效议题如何启动 DSH 执行任务

调研于 2026 年 11 月 19 日。针对当前「直接开工」入口，建议保留 DSH 创建会话和投递首轮消息的 API，将每次开工的输入固定下来，再由 DSH 原生技能加载执行流程。下面的宿主结论按插件声明的最低版本 `dsh-v0.2.2-rc.3` 核验，未在实际 Web profile 触发开工。[版本约束](../package.json)

## 当前实现已经具备什么

面板与命令复用开工逻辑。按工作区、组织、项目和议题查找绑定，提前保存 `sessionId` 与 `requestId`，写入工作区内的 `issue.md`，创建或复用会话，最后投递首轮消息。提示词负责指定执行方式、补充说明、技能和交付格式。再次开工可返回已派发会话，回写前另有预览确认。[开工实现](../src/workflow.ts) · [宿主适配](../src/host.ts) · [产品规格](specs/yunxiao-v1.md)

目前有一个实际的改进点。若宿主已接收消息，但插件在记录 `dispatched` 前退出，再试时会复用请求 ID，却重新读取云效并覆盖 `issue.md`。如果期间议题变化，首条消息和磁盘材料可能对应两次不同的开工输入。宿主按请求 ID 从会话记录判重，因此同一个请求 ID 应始终对应同一份材料、执行模式和发起人补充。[本地准备与派发顺序](../src/workflow.ts) · [DSH 接收与去重](https://github.com/deepseek-ai/deepseek-harness/blob/38a6a5c965aa99ab525161efb7cc5cf1fe62fced/packages/api/session-controller/src/commands.ts)

## GitHub 上的两种实现

### Vibe Kanban：点击议题启动工作区

Vibe Kanban 与本插件的操作起点最接近。调用方传入议题 ID、仓库、目标分支和执行器。服务按 ID 读取议题，把项目和议题 ID 写入结构化请求。调用方可以提供首轮指令，省略时由标题和描述生成。这样即使用户重写全部提示词，系统仍知道工作区关联哪条议题。[启动工具源码](https://github.com/BloopAI/vibe-kanban/blob/3f095f0186f6e68d67143d38b02da2238f6524d8/crates/mcp/src/task_server/tools/task_attempts.rs#L145-L205)

服务端先创建工作区、关联仓库和附件，再启动执行器，返回工作区和执行进程。MCP 工具随后把工作区 ID 回链到远端议题，再把 ID 返回调用方。源码暴露了一个值得处理的失败场景：执行器已启动时，回链仍可能失败，此时工具返回错误。本插件若采用类似设计，可保留已经创建的任务或会话 ID，允许单独重试关联，避免再次启动。[服务端创建流程](https://github.com/BloopAI/vibe-kanban/blob/3f095f0186f6e68d67143d38b02da2238f6524d8/crates/server/src/routes/workspaces/create.rs#L212-L320) · [回链与返回值](https://github.com/BloopAI/vibe-kanban/blob/3f095f0186f6e68d67143d38b02da2238f6524d8/crates/mcp/src/task_server/tools/task_attempts.rs#L195-L221)

### OpenAI Symphony：按议题运行和续跑

Symphony 的执行器接收结构化的议题对象，按议题准备工作区，再显式启动 Codex 会话。每轮执行都单独传入提示词和议题对象，运行事件带原始议题 ID。轮次完成后，执行器按 ID 重新读取议题，结合最新状态、标签和轮数决定是否在同一会话继续。若插件以后需要让议题状态控制多轮执行，可以借鉴这个时序；保留人工点击时，无需引入常驻调度服务。[工作区与事件关联](https://github.com/openai/symphony/blob/be10a1b79df723d6d7612b5651c8522704dafb2e/elixir/lib/symphony_elixir/agent_runner.ex#L38-L85) · [会话启动及继续条件](https://github.com/openai/symphony/blob/be10a1b79df723d6d7612b5651c8522704dafb2e/elixir/lib/symphony_elixir/agent_runner.ex#L88-L185)


## DSH 内的落地建议

1. **在现有绑定旁保存开工参数。** 首次确认时生成一份带版本的任务清单，记录议题标识、执行方式（直接执行、先澄清或缺陷诊断）、发起人补充、材料路径及交付路径。准备完整后才能投递。相同请求重试读取这份清单和原材料，沿用已有会话与请求 ID。现有绑定已承担唯一性约束，首版可继续按工作区和议题查找，无需新增任务数据库。[现有工作流](../src/workflow.ts)
2. **第一条消息显式调用适配 DSH 的技能。** 例如用 `/yunxiao-dsh-execute`（拟议名称）和任务清单路径开工。此版本的 Host 会将非空 prompt 标记为用户输入，技能插件会识别其中可由用户调用的技能名并注入完整正文。应先确认目标工作区能发现该技能，延续现有无技能工作区的简短后备指令。技能需遵循本插件的产物目录和两段回写契约。本机现有 Nezha 同名执行技能另有评分与草稿目录约定，直接启用会带入额外流程。把补充和议题原文留在材料中，也能避免其中的斜杠文本被当作显式技能调用。[宿主消息来源](https://github.com/deepseek-ai/deepseek-harness/blob/38a6a5c965aa99ab525161efb7cc5cf1fe62fced/packages/api/session-controller/src/index.ts) · [技能识别与注入](https://github.com/deepseek-ai/deepseek-harness/blob/38a6a5c965aa99ab525161efb7cc5cf1fe62fced/packages/skill/tool-skill/src/index.ts) · [交付稿解析](../src/yunxiao.mjs)
3. **继续由插件判断交付状态。** DSH 收到首轮消息只表示派发成功，云效评论预览、发布与工作项状态流转仍走现有入口。宿主自带 Schedule 可持久化任务并立即或定时向会话投递指令，但其回执也只确认进入收件箱。以后有定时触发需求时再评估它。多议题自动领取和重调度则可参考 Symphony。[DSH Schedule](https://github.com/deepseek-ai/deepseek-harness/blob/38a6a5c965aa99ab525161efb7cc5cf1fe62fced/packages/schedule/schedule/README.md) · [Symphony 调度规格](https://github.com/openai/symphony/blob/be10a1b79df723d6d7612b5651c8522704dafb2e/SPEC.md)

首个验证场景可以选同一条测试议题：确认开工后模拟投递应答丢失，修改云效正文再重试，检查仍使用原材料、同一会话和同一条首轮消息。再分别在已加载和缺少技能的工作区核对执行方式，以及生成的交付稿能否通过现有预览。这两组验证能直接判断改造是否值得落地。
