# dy-dsh-plugin

面向 DeepSeek Harness 的公司工作流插件。首版提供云效议题列表与筛选、交付计划、单议题开工、评论回写和状态流转。单条与多选「发起讨论」可查看议题清单，讨论工作流待定。

[首版 Spec](docs/specs/yunxiao-v1.md) · [Nezha 移植清单](docs/migration-checklist.md)

## 在 Windows DSH Desktop 安装

使用 Desktop 内置 DSH `0.2.2-rc.3` 或兼容的 `0.2.x` 运行时。先打开一次 DeepSeek Harness Desktop 初始化 profile，从托盘完全退出后，在 PowerShell 运行下面的命令。将包路径替换为实际下载位置。

```powershell
$desktopCli = Join-Path $env:LOCALAPPDATA 'Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'
$bundle = (Resolve-Path './dy-dsh-plugin-0.1.0.tgz').Path
& $desktopCli --version
& $desktopCli plugin --profile desktop add $bundle
```

重启 Desktop，在左侧「云效议题」打开面板。先在应用中配置可用的模型提供方，并在工作区列表添加实际开发目录。创建交付计划时填写该工作区已存在的本地分支。

卸载时先完全退出 Desktop，然后运行 `& $desktopCli plugin --profile desktop remove dy-dsh-plugin` 并重启。已保存的计划、会话绑定与回执仍可在重新安装后使用。

## 云效连接

首版接入云效中心版。DSH Desktop 进程需能读取 `YUNXIAO_TOKEN`（个人访问令牌）和 `YUNXIAO_ORG_ID`（组织 ID）。可额外设置 `YUNXIAO_PROJECT_ID`，用作面板默认项目和斜杠命令按显示编号查询的项目。

建议首次验证使用专门的测试议题。设置环境变量后完全退出旧实例，再从同一 PowerShell 启动 Desktop。以下命令将令牌留在启动进程的环境中。

```powershell
$env:YUNXIAO_TOKEN = Read-Host '云效个人访问令牌' -MaskInput
$env:YUNXIAO_ORG_ID = Read-Host '云效组织 ID'
$desktopApp = Join-Path $env:LOCALAPPDATA 'Programs/DeepSeek Harness/DeepSeek Harness.exe'
Start-Process -FilePath $desktopApp
Remove-Item Env:YUNXIAO_TOKEN
```

令牌需要读取项目、工作项、附件及工作流的权限，并在回写阶段具备评论和修改工作项的权限。预览确认后才执行相应的云效写入。

## 斜杠命令

| 命令 | 作用 |
| --- | --- |
| `/yunxiao read PROJ-123` | 读取正文、附件及正文图片链接 |
| `/yunxiao start PROJ-123` | 绑定空闲会话并开工，已开工时返回原会话 ID |
| `/yunxiao preview` | 预览开发向与测试向评论 |
| `/yunxiao publish <预览码>` | 发布预览的两条评论，重试时复用回执 |
| `/yunxiao statuses` | 查看当前状态与可选状态 ID |
| `/yunxiao transition <状态 ID>` | 预览状态流转 |
| `/yunxiao transition <状态 ID> <预览码>` | 确认流转并查看核对结果 |

议题材料和交付稿保存在当前工作区的 `.dsh/yunxiao/`，请在业务仓库配置本地 Git 排除。计划、会话绑定和回写回执保存在 DSH 用户目录的 `dy-yunxiao/` 下。

## 构建

使用 Node.js 24 或更新版本。

```powershell
npm ci
npm run typecheck
npm test
npm pack
```

`npm pack` 生成可本地安装的 `dy-dsh-plugin-0.1.0.tgz`。开发调试也可用兼容运行时的 `web` profile 安装该包。
