# 中文技术方案写作 Skill 调研

截至 2026 年 11 月 19 日，首选 **Fenng 的 `tech-doc-style-chinese`**，用它审校现有方案。它把事实、逻辑和限制放在篇幅之前，允许删去重复表述，并要求改写后对照原文核查条件、因果和确定程度。需要从头起草轻量工程方案时，参考 `drafting-plans`。本次核对了公开源码和说明，未在同一批实际方案上对比运行效果。[Fenng 的 Skill](https://github.com/Fenng/Tech-Doc-Style-Chinese/blob/main/SKILL.md) · [drafting-plans](https://github.com/lox/agent-skills/blob/main/drafting-plans/SKILL.md)

## 候选对照

| GitHub 候选 | 适用场景 | 具体做法和取舍 |
| --- | --- | --- |
| `tech-doc-style-chinese` | 中文方案起草和审校。优先试用。 | 删重复信息，保留范围、前置条件、例外、兼容性和失败处理。术语随项目，字段、命令、路径和链接目标保持准确，改后逐项核对。仓库约 1.6k stars，目录显示 942 次安装。[规则](https://github.com/Fenng/Tech-Doc-Style-Chinese/blob/main/SKILL.md) · [仓库](https://github.com/Fenng/Tech-Doc-Style-Chinese) |
| `drafting-plans` | 从头起草或维护工程方案。 | 先查仓库证据，按需组织问题、做法、范围、交付步骤和关键决策。省略空章节，修订时保留已定边界、承诺和未决状态。仓库 15 stars，目录显示 2 次安装，适合先借鉴规则。[规则](https://github.com/lox/agent-skills/blob/main/drafting-plans/SKILL.md) · [仓库](https://github.com/lox/agent-skills) |
| Vercel `technical-writer` | 复核技术事实和依据。 | 条件写在其限定的结论旁边，重复的参数信息引用权威来源，已接受的修订要继续保留。Skill 针对 `agent-desktop` 内部文档，适合借鉴通用规则。[规则](https://github.com/vercel-labs/agent-desktop/blob/main/.agents/skills/technical-writer/SKILL.md) |
| GitHub Docs `Readability-Editor` | 借鉴逐项复核规则。 | 编辑后逐处复核原意，保留默认值、范围、权限、警告和建议强度。源文件是 GitHub Docs 的自定义 Agent，写法和交付步骤面向其文档工作流。[Agent 定义](https://github.com/github/docs/blob/main/.github/agents/readability-editor.md) |

OpenSpec 自带 CLI，默认将变更提案、规格、设计和任务分成多个产物。Superpowers `writing-plans` 面向开发交接，要求写清文件、接口、测试和验证命令，目录显示约 30.9 万次安装。单纯精炼方案时，引入它们会增加产物或细节。本文的安装量取自调研当日的 Skills CLI 或目录查询。[OpenSpec](https://github.com/Fission-AI/OpenSpec/blob/main/skills/openspec-propose/SKILL.md) · [Superpowers](https://github.com/obra/superpowers/blob/main/skills/writing-plans/SKILL.md) · [安装量](https://skills.sh/obra/superpowers/writing-plans)

## 用在现有方案上

`dy-dev-overall-design` 已要求删除重复背景、保留必要条件及例外。`dy-dev-topic-design` 已要求每项决定和任务有唯一维护位置。建议在现有方案出稿后加一次审校，沿用原有术语、文档结构和验收依据。审校只需合并同义复述、删去套话并理清句子，再对照原稿核对需求、决策及理由、限制、例外、失败处理、验收口径和链接。篇幅由实际信息量决定。[仓库术语与 ADR 约定](agents/domain.md) · [中文审校流程](https://github.com/Fenng/Tech-Doc-Style-Chinese/blob/main/SKILL.md#编辑流程)

改写示例（示意文本）

> 原稿：考虑到需要避免重复提交，在用户已经有待审核记录的情况下，本次会继续使用已有待审核记录。对于当前没有待审核记录的用户，系统会创建一条新的待审核记录。若创建失败，则保留草稿以便后续重试。
>
> 精炼：为避免重复提交，有待审核记录时复用该记录，否则新建。新建失败时保留草稿，供重试。

Codex 项目级安装命令如下。已核对上游安装说明，未执行安装。[安装说明](https://github.com/Fenng/Tech-Doc-Style-Chinese#如何在-codex-中使用)

```powershell
npx skills add https://github.com/Fenng/tech-doc-style-chinese -a codex
```
