# 研发工作台

面向 DeepSeek Harness 的公司研发工作台，提供「云效议题」「交付计划」「合并请求」和「技能管理」四个入口。「云效议题」支持筛选、加入交付计划、评论回写和状态流转。「技能管理」支持绑定公司 Git 技能仓库和本地目录，刷新目录并查阅技能说明及配套文件。

[首版 Spec](docs/specs/yunxiao-v1.md) · [Nezha 移植清单](docs/migration-checklist.md)

插件内置 Fenng 的中文技术写作技能 v0.3.2。议题方案初稿与修订稿、交付稿中的修改汇总与测试说明、MR 审查报告均自动使用其写作规则。[上游技能](https://github.com/Fenng/Tech-Doc-Style-Chinese/tree/v0.3.2)

## 插件索引与发版

在支持自定义插件索引的 DSH 中启用「自定义插件索引」，然后在「插件 → 发现」添加研发工作台插件索引。从索引安装后，可在插件页查看并确认兼容版本的更新，也可下载预构建安装包。[插件索引](https://alohazzz.github.io/dy-dsh-plugin/index.json) · [GitHub Releases](https://github.com/Alohazzz/dy-dsh-plugin/releases)

发版时同步更新 `package.json` 与 `package-lock.json` 的版本，提交后推送对应的 `vX.Y.Z` 标签。GitHub Actions 校验、测试与打包后发布至 npm，创建 GitHub Release，再从 npm 生成 Pages 索引。

npm Trusted Publishing 使用仓库 `Alohazzz/dy-dsh-plugin` 和工作流 `release.yml`，允许 `npm publish`。首次发布需要由 npm 维护者完成账号认证。如果流水线已生成 `npm-package` 产物，首次发布使用其中的原始 tgz。配置 Trusted Publishing 后重跑工作流，流水线会核对 npm 已发布包的完整性，再更新 GitHub Release 与索引。

## 在 Windows DSH Desktop 安装

使用 Desktop 内置 DSH `0.2.2-rc.3` 或兼容的 `0.2.x` 运行时。先打开一次 DeepSeek Harness Desktop 初始化 profile，从托盘完全退出后，在 PowerShell 运行下面的命令。将包路径替换为实际下载位置。

```powershell
$desktopCli = Join-Path $env:LOCALAPPDATA 'Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'
$bundle = (Resolve-Path './dy-dsh-plugin-0.1.5.tgz').Path
& $desktopCli --version
& $desktopCli plugin --profile desktop add $bundle
```

重启 Desktop，从左侧「研发工作台」进入。执行交付计划前，在应用中配置可用的模型提供方，并在工作区列表添加实际开发目录。创建交付计划时选择目标仓库和计划类型，填写名称与完成日期。源分支根据类型、版本、合并目标和名称生成，可手动修改并检测同名分支。默认从所选仓库的当前分支切出，也可以修改基础分支或另建 worktree。

打开交付计划详情，确认 Codeup 仓库和目标分支。创建时填写的合并目标会预填。计划分支匹配已有开放 MR 时，可直接关联。发起新 MR 前，在计划的主工作区或独立 worktree 中检出源分支，再在工作台核对提交并确认推送。计划列表显示 Codeup 返回的合并状态。

在「云效议题」确认加入计划后，插件同步负责人、计划开始时间和「待开发」状态。已待开发的议题保留已有负责人和开始时间，并补齐空值。计划完成时间沿用云效已有值，工作流要求且为空时使用计划完成日期。在计划详情的议题行确认「移出计划」后，插件将云效状态回退到「已确认」，清空计划开始时间，保留负责人和计划完成时间。插件回查云效成功后更新计划归属。

在交付计划的「计划议题」区点击「方案调研」。有待确认事项时，通过「批量答疑」或方案预览提交意见。确认最新方案后点击「标记定稿」，再点击「开始执行」。执行会话使用计划的代码目录和宿主默认权限。开始前，代码目录需检出计划的源分支。执行已派发后，可从计划或云效议题打开绑定会话。

「合并请求」支持单仓发起、按仓库查询和「待我审核」。从计划和待审队列打开的是同一份 MR 详情。读取 MR 需要合并请求读取权限，创建还需要写权限和 Git 推送权限。

在 MR 详情点击「拉取 MR 到本地」，将 Codeup 补丁集的源和目标提交固定到独立的本地快照。绑定含 `merge-code-review` 和 C# 开发手册的技能源，确认快照后点击「运行只读审查」。报告展示在 MR 详情，并写入快照上级目录的 `.nezha`。审查会话仅使用插件提供的 Git 证据和公司规则。生成报告后，可在「预览回写评论」检查和编辑正文，再确认发布到 Codeup。发布需要合并请求写权限。

MR 详情按 Codeup 状态提供「批准」「合并」和「关闭 MR」。批准前核对操作账号和源补丁集。合并时选择合并方式并确认目标分支，源分支会保留。操作需要 Codeup 合并请求写权限，并受仓库评审规则和分支保护约束。提交后工作台回查 Codeup，并刷新关联交付计划的 MR 状态。结果未确认时，点击「核对结果」重新查询。

在「研发工作台 → 技能管理」添加本地绝对目录，或绑定 HTTPS、SSH 技能仓库。Git 仓库使用运行 DSH 的本机用户已配置的 Git 凭据。分支留空时跟随远端默认分支。点击「刷新」可更新当前来源。

从左侧目录选择技能，在右侧详情点「安装到…」。选择项目时，该项目的会话能发现技能。选择「会话 Agent」下的一条会话时，技能只在该会话的 Agent 启动后可用。选择「.dsh Agent（实例共享）」时，当前 DSH 实例的 Agent 均可发现技能。安装由研发工作台管理，并保留当时的说明、配套文件及来源版本。可从技能详情或「已安装」按目标查看和卸载。

卸载时先完全退出 Desktop，然后运行 `& $desktopCli plugin --profile desktop remove dy-dsh-plugin` 并重启。已保存的计划、会话绑定与回执仍可在重新安装后使用。

## 云效连接

接入云效中心版。在「云效议题」页面右上角打开「连接设置」，填写个人访问令牌后点击「获取组织」，选好组织再点击「获取项目」，按名称选择默认项目。只有一个组织时会自动选中并获取项目。也可展开「手动填写 ID」。

- 「测试连接」检查当前表单并显示账号和可访问项目数。
- 「保存并连接」先验证，再保存至 DSH 本机凭据存储并刷新项目。连接设置保存后即时生效。
- 重新打开设置时，Token 输入框为空。留空可继续使用现有令牌，填入新令牌可更换。验证失败时保留原配置。
- 「清除已保存设置」可移除插件保存的本地凭据。已有的宿主环境变量 `YUNXIAO_TOKEN`、`YUNXIAO_ORG_ID`、`YUNXIAO_PROJECT_ID` 会作为回退。

获取组织需要组织管理的组织读取权限。令牌还需读取项目、工作项、附件及工作流。回写时也需要评论及修改工作项的权限。首次验证建议使用专用测试议题。

## 斜杠命令

| 命令 | 作用 |
| --- | --- |
| `/yunxiao read PROJ-123` | 读取正文、附件及正文图片链接 |
| `/yunxiao preview` | 预览测试评论 |
| `/yunxiao publish <预览码>` | 发布已确认的测试评论，重试时复用回执 |
| `/yunxiao statuses` | 查看当前状态与可选状态 ID |
| `/yunxiao transition <状态 ID>` | 预览状态流转 |
| `/yunxiao transition <状态 ID> <预览码>` | 确认流转并查看核对结果 |

开始执行时，插件在计划代码目录的 `.dsh/yunxiao/` 会话目录保存定稿 `plan.md`、议题原文 `issue.md` 和任务清单 `task.json`。派发中断时，从计划重试可沿用原定稿、原会话和首条消息。

目标会话可用时，插件调用自带的 `/yunxiao-dsh-execute` 技能。技能不可用时，首条消息携带执行约定。完成后从 `discussion.md` 预览测试回写。修改方法和实际结果保存在 `execution.md`，通过计划内的「归档执行成果」确认并归档。提交信息带议题编号后，可按 SHA 关联变更记录。

请在业务仓库为 `.dsh/yunxiao/` 配置本地 Git 排除。会话绑定和发布状态由 DSH 用户目录下的 `dy-yunxiao/` 管理。创建计划后，调研报告、方案、执行成果、最终测试正文和回执按阶段归档到计划所绑定工作区的 `docs/workbench/`。跨计划调研可按议题、模块和关键字查档。版本化模板和文档 Skill 随插件安装，价值评分由 GitHub #5 后续接入。

## 构建

使用 Node.js 24 或更新版本。

```powershell
npm ci
npm run typecheck
npm test
npm pack
```

`npm pack` 生成可本地安装的 `dy-dsh-plugin-0.1.5.tgz`。开发调试也可用兼容运行时的 `web` profile 安装该包。
