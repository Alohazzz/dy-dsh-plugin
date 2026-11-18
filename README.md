# dy-dsh-plugin

面向 DeepSeek Harness 的公司工作流插件。首版提供云效议题列表与筛选、交付计划、单议题开工、评论回写和状态流转。单条与多选「发起讨论」可查看议题清单，讨论工作流待定。

[首版 Spec](docs/specs/yunxiao-v1.md) · [Nezha 移植清单](docs/migration-checklist.md)

## 插件索引与发版

在支持自定义插件索引的 DSH 中启用「自定义插件索引」，然后在「插件 → 发现」添加 [云效议题插件索引](https://alohazzz.github.io/dy-dsh-plugin/index.json)。从该索引安装，后续在插件页查看并确认兼容版本的更新。也可以从 [GitHub Releases](https://github.com/Alohazzz/dy-dsh-plugin/releases) 下载预构建安装包。

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

重启 Desktop，在左侧「云效议题」打开面板。先在应用中配置可用的模型提供方，并在工作区列表添加实际开发目录。创建交付计划时填写该工作区已存在的本地分支。

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

`npm pack` 生成可本地安装的 `dy-dsh-plugin-0.1.5.tgz`。开发调试也可用兼容运行时的 `web` profile 安装该包。
