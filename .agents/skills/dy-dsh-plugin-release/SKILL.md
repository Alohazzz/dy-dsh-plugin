---
name: dy-dsh-plugin-release
description: 发布 Alohazzz/dy-dsh-plugin 的正式版本。用于准备发版、编写发布说明、推送版本标签、核查 npm 和 GitHub Releases 产物、同步 npmmirror、验证 DSH Desktop 更新提示，或恢复失败的发版流水线。
---

# 发布研发工作台插件

从 `Alohazzz/dy-dsh-plugin` 的默认分支发布已合并的变更。以仓库根目录的 [发版说明](../../../README.md#插件索引与发版)、[发布工作流](../../../.github/workflows/release.yml)和[索引脚本](../../../scripts/plugin-index.mjs)为准。准备发版或编写发布说明时，只执行请求覆盖的步骤。推送版本标签会启动公开发布，仅在用户授权正式发版时执行。

## 核查发布范围与版本号

1. 核对 `origin` 的推送地址与目标仓库一致。执行 `git fetch origin --tags`，通过 `gh repo view Alohazzz/dy-dsh-plugin --json defaultBranchRef` 确认默认分支。基于最新远端默认分支准备发版。工作区有无关改动时保留原工作区，必要时使用独立工作区。已存在的未推送提交也要核实是否属于本次发布范围。
2. 核对最近的正式 GitHub Release、npm 版本和对应标签。以已发布版本和拟发布提交为边界，检查 `git log <上一版本标签>..HEAD` 的提交正文和差异。合并提交信息不足时，核对实际差异和关联 PR 或议题。
3. 优先采用用户指定且可发布的版本号。需要建议版本号时，根据用户可见影响选择版本。兼容修复、文档或维护变更使用补丁版本，兼容的新功能使用次版本。遇到破坏性变更、数据迁移或宿主兼容范围收窄时，先说明影响并确认版本号。
4. 确认拟发布版本高于上一正式版本，并检查本地和远端是否已有同名标签、GitHub Release 或 npm 版本。查询失败时区分版本不存在与认证或网络错误。已推送的标签对应固定提交。发现同版本已有发布记录时，按恢复流程核对原提交和产物。

## 准备发版提交

1. 使用仓库工作流要求的 Node.js 24 和 npm 11。在仓库根目录运行 `npm version X.Y.Z --no-git-tag-version --ignore-scripts`。核对 `package.json` 的 `version`、`package-lock.json` 的顶层 `version` 和 `packages[""].version` 均为目标版本。核查差异，避免引入无关依赖变更。
2. 编写 `docs/release-notes-vX.Y.Z.md`，使用仓库的[中文技术写作技能](../../../skills/tech-doc-style-chinese/SKILL.md)。根据实际变更组织新功能、修复、行为变更和兼容性说明。写清用户可见影响、移除功能及必要的升级操作，保留能够佐证的提交短哈希和议题编号。安装说明引用项目的插件索引和 GitHub Releases，版本对比链接使用实际的前后版本标签。
3. 运行 `npm ci`、`npm run typecheck`、`npm test` 和 `npm pack --dry-run`。打包会通过 `prepack` 构建。核查打包清单包含 `package.json` 的 `exports` 指向的文件、`cordis.patch.yml` 和随包分发的技能。
4. 仅暂存版本文件及本次发布说明。可沿用 Nezha 的提交方式，分别使用 `chore(version): release vX.Y.Z` 和 `docs(release): announce vX.Y.Z` 提交。推送前重新检查默认分支的远端更新和待推送差异。

## 推送标签并验证发布

1. 在正式发版获授权后，按仓库规则先将发版提交送入远端默认分支。确认实际入库的提交包含预期变更和版本，再对该提交创建附注标签 `vX.Y.Z`，显式推送这一标签。标签必须与 `package.json` 中的版本一致。
2. 查找仓库 `Alohazzz/dy-dsh-plugin` 中 `release.yml` 对应标签的 `push` 运行，核对运行引用和目标提交。用 `gh run watch <run-id> --repo Alohazzz/dy-dsh-plugin --exit-status` 等待完成。流水线负责发布 npm、创建带 `.tgz` 的 GitHub Release，以及生成并部署 GitHub Pages 插件索引。
3. 验证 `release` 和 `index` 两个作业均成功。使用 `npm view dy-dsh-plugin@X.Y.Z version dist.integrity engines --registry https://registry.npmjs.org` 核查公开包。使用 `gh release view vX.Y.Z --repo Alohazzz/dy-dsh-plugin --json url,assets,isDraft` 确认公开 Release 附有 `dy-dsh-plugin-X.Y.Z.tgz`。
4. 读取 [公开插件索引](https://alohazzz.github.io/dy-dsh-plugin/index.json)，确认 `dy-dsh-plugin` 条目包含目标版本，包来源为 npm 且 `engines.dsh` 与 npm 包一致。Pages 刚部署时可短时重查。
5. 流水线生成 Release 后，检查 Release 正文。若已获授权发布本次说明，使用 `gh release edit vX.Y.Z --repo Alohazzz/dy-dsh-plugin --notes-file docs/release-notes-vX.Y.Z.md` 写入已审核的说明。

## 同步 npmmirror 并验证 DSH 更新

1. npm 官方源可查到目标版本后，查询 npmmirror 的包级版本列表。优先使用 Desktop 自带的 CLI，复用 Desktop 的包管理器和 profile。无 Desktop CLI 时，用 `npm view dy-dsh-plugin versions dist-tags --json --prefer-online --registry https://registry.npmmirror.com/` 检查镜像。

   ```powershell
   $dshCli = Join-Path $env:LOCALAPPDATA 'Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'
   & $dshCli plugin --profile desktop view dy-dsh-plugin versions dist-tags --json --registry https://registry.npmmirror.com/
   ```

2. 如果 `versions` 缺少目标版本，通过 [npmmirror 单包同步页](https://npmmirror.com/sync/dy-dsh-plugin)提交一次同步任务，或使用同一接口。记录响应中的任务 `id`。在 `https://registry.npmmirror.com/-/package/dy-dsh-plugin/syncs/<id>` 查询状态，追加 `/log` 查看同步日志。

   ```powershell
   Invoke-RestMethod -Method Put `
     -Uri 'https://registry-direct.npmmirror.com/-/package/dy-dsh-plugin/syncs' `
     -Headers @{ Origin = 'https://npmmirror.com'; Referer = 'https://npmmirror.com/' }
   ```

3. 同步成功后继续查询包级列表，直到 `versions` 包含目标版本。任务可能已成功，单版本接口也已可查，但包级列表仍在返回旧缓存。等待期间复用原任务，避免重复提交。若任务失败则查看日志，处理可恢复原因后再重试。镜像持续缺少目标版本时，报告同步任务状态和最后一次查询结果。
4. 镜像列表出现目标版本后，在 DSH Desktop 打开「插件 → 已安装 → dy-dsh-plugin」。确认宿主与目标版本兼容，且当前安装了较早的插件版本。点击「重新检查」，等待页面显示「更新到 X.Y.Z」或「可更新到 X.Y.Z」。若结果仍显示「已是最新版本」，核对 Desktop 实际查询的注册表及其版本列表。只有已装旧版且页面提示目标版本时，才记录更新发现验证通过。
5. 正式发版验收包含 npm、GitHub Release、公开插件索引、npmmirror 版本列表和 DSH 更新发现。交付时提供目标版本、标签、工作流、Release、索引和验证结果。镜像仍在等待、Desktop 不可用或本机已装目标版本时，标记对应验收项待验证。若另有授权安装更新，完成后还要直接查看工作台画面，确认内容区在可视区域内正常渲染。

## 恢复失败的发布

- 先查看失败作业日志，再核对远端标签、npm 版本、GitHub Release 和公开索引的现状。网络或服务故障可在恢复后重跑原标签的工作流。重跑前确认标签与归档产物仍对应同一提交。
- npm 已发布时，工作流会比较 `dist.integrity` 与重新打包的 `.tgz`。完整性一致时，工作流可以继续补齐 GitHub Release 与 Pages 索引。完整性冲突时停止重试，查明差异。需要修改发布内容或已推送标签指向的提交时，修复后发布新版本。
- 若首次 npm 发布需由维护者完成认证，使用对应工作流的 `npm-package` 产物中的原始 `.tgz`。由维护者在 npm 为 `Alohazzz/dy-dsh-plugin` 的 `release.yml` 配置 Trusted Publishing 后，重跑原标签的工作流。记录已完成的步骤及仍需维护者处理的事项。
- 仅需重建 Pages 索引时，可按现有工作流在远端默认分支手动运行 `release.yml`。工作流会跳过发包，从 npm 重建索引。部署后复查目标版本是否出现在公开索引中。
