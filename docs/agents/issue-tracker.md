# 议题跟踪

本插件的开发议题和规格记录在 `Alohazzz/dy-dsh-plugin` 的 GitHub Issues。
插件运行时处理的公司业务议题使用云效。引用议题时写明来源，例如
“GitHub #12”或“云效议题 12345”。

在仓库目录使用 `gh`，由 Git 远端确定目标仓库。

| 技能操作 | 命令 |
| --- | --- |
| 发布需求或规格 | `gh issue create --title "<标题>" --body-file <文件>` |
| 读取议题和讨论 | `gh issue view <编号> --json number,title,body,labels,comments` |
| 查找待分类议题 | `gh issue list --state open --label needs-triage` |
| 发表评论 | `gh issue comment <编号> --body-file <文件>` |
| 更新分类 | `gh issue edit <编号> --add-label <新标签> --remove-label <旧标签>` |
| 关闭议题 | `gh issue close <编号>` |

拆分任务时优先使用 GitHub 子议题。无法建立子议题关系时，在子议题正文写
`Part of #<父议题编号>`，并在父议题中列出子任务。

使用 `/wayfinder` 时，以带 `wayfinder:map` 标签的议题保存全局进展和决策。
子任务优先使用 GitHub 原生阻塞关系，必要时在正文记录 `Blocked by: #<编号>`。
按计划顺序领取第一个无人负责且阻塞项均已关闭的任务。完成后把结论和链接写回总议题。

PRs as a request surface: no.
