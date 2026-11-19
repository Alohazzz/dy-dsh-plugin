## Agent skills

### Issue tracker

插件自身的需求、缺陷和开发任务使用 GitHub Issues 跟踪。见 `docs/agents/issue-tracker.md`。

### Triage labels

议题分类使用五个标准标签。见 `docs/agents/triage-labels.md`。

### Domain docs

本仓库采用单一领域上下文。术语和架构决策的读取规则见 `docs/agents/domain.md`。

## 插件过程文档

插件模块生成或修订方案稿、变更报告、测试说明、MR 审查报告等过程文档时，使用随插件分发的 [中文技术写作技能](skills/tech-doc-style-chinese/SKILL.md)。合并重复表述，保留需求、决定及理由、适用条件、例外、失败处理和验收标准。沿用各模块约定的章节、标识符和机器可读格式。新增文档生成入口时，接入同一套写作规则。

## 界面设计

新增或调整任何图形界面前，必须先阅读并遵循仓库根目录的 [Design.md](Design.md)。该规范同样适用于原型、实施和设计复核。布局、信息层级和交互状态参考 Ant Design，主题、组件和操作样式沿用目标宿主的共享规范。
