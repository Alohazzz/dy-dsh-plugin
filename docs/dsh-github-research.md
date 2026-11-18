# DeepSeek Harness 插件开发调研

调研日期为 2026 年 11 月 18 日。范围为 DeepSeek Harness 的公开开发文档、GitHub 源码和 npm 包说明。功能依据公开材料核对，运行兼容性和公司环境接入待实测。

## 最接近公司工作流的项目

| 项目 | 公开材料能确认的能力 | 对应移植清单 |
| --- | --- | --- |
| [dsh-yunxiao-taskboard](https://github.com/btboys/dsh-yunxiao-taskboard) | 云效需求和缺陷看板、按编号检索、详情与图片、一键选择 DSH 工作区并起会话、读写评论、创建和编辑工作项、状态流转。也能在推送后关联 Codeup 提交。 | Y1、Y2、Y4、Y6、Y7 的基础能力，可以优先对照公司流程。 |
| [@qzsy/dsh-yunxiao-panel](https://www.npmjs.com/package/@qzsy/dsh-yunxiao-panel) | npm 说明包含 Projex 工作项查询和状态更新、工作区选择以及按仓库查看 Codeup MR 和详情。源码地址指向 Codeup。[npm 包元数据](https://registry.npmjs.org/@qzsy%2fdsh-yunxiao-panel) | M3 中的 MR 查询和详情。 |
| [dsh-workhub](https://github.com/ahao430/dsh-workhub) | 在 DSH 里同步和查看云效数据，并涵盖流水线和应用部署操作。 | 可参考云效接口和数据同步的组织方式。 |
| [dsh-commit-journal](https://github.com/yu-bobo/dsh-commit-journal) | 同步 Codeup 仓库和提交记录，文档描述了中心版和地域版的接入参数。 | 可参考 Codeup API 接入和版本差异处理。 |

阅读 `dsh-yunxiao-taskboard` 时，可以从宿主插件入口看配置和工具注册，再看云效 API 封装，最后看前端如何实现工具之外的看板与交互。项目声明 DSH 最低版本为 `0.2.1-rc.3`，以 npm 组合包分发。[宿主入口](https://github.com/btboys/dsh-yunxiao-taskboard/blob/main/index.js) · [云效 API 封装](https://github.com/btboys/dsh-yunxiao-taskboard/blob/main/server/yunxiao.js) · [客户端入口](https://github.com/btboys/dsh-yunxiao-taskboard/blob/main/client.js) · [项目说明](https://github.com/btboys/dsh-yunxiao-taskboard#readme)

## 插件怎么开发

- 官方教程先通过 `--patch` 把一个导出 `apply(ctx)` 的 TypeScript 模块加载到 Web profile。工具可用 `ctx.tools.register()` 注册。需要分发时，可在 `package.json` 用 `dsh.bundle` 指向配置补丁，再安装到指定 profile。 [官方源码](https://github.com/deepseek-ai/deepseek-harness) · [第一个插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/) · [工具编写参考](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-tool) · [打包与安装插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish.html)
- `dsh-plugin-template` 把多种插件形态、浏览器扩展位置和斜杠命令放在一个可安装的示例组合包内。可以结合官方文档选择项目需要的入口。 [模板源码](https://github.com/kun2-5code/dsh-plugin-template)
- DSH 原生就能从工作区 `.dsh/skills`、`.agents/skills` 和额外配置的 `customSkillDirs` 发现技能，可先用现有 `SKILL.md` 验证 S1。腾讯公开的 SkillHub 仓库还有一个 DSH 插件示例，可用于理解技能市场接入。公司 SkillHub 的技能源、同步和分发仍需按现有内部接口评估。 [官方技能文档](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/skills) · [腾讯 SkillHub DSH 插件](https://github.com/Tencent/skillhub/tree/main/dsh-plugin)

## 与现有移植清单对照

本项目可以先用 `dsh-yunxiao-taskboard` 核对云效议题闭环，用 DSH 原生技能目录验证首批公司技能。派发时沿用哪些执行约定、如何从 `discussion.md` 生成待预览评论、是否同步价值评分，都由公司流程决定。第三方插件的工作项能力与这些内部约定需要逐项对照。[Nezha → DSH 移植清单](migration-checklist.md) · [云效看板源码](https://github.com/btboys/dsh-yunxiao-taskboard)

本次公开检索确认了 Codeup 提交关联、仓库和提交同步，以及 MR 查询和详情。Codeup MR 的创建、批准和合并，以及跨议题依赖调度，仍需单独核验。`dsh-git-workbench` 的 GitHub PR 工具可作为 DSH 侧交互和审批的源码参考。 [云效看板](https://github.com/btboys/dsh-yunxiao-taskboard) · [MR 面板](https://www.npmjs.com/package/@qzsy/dsh-yunxiao-panel) · [提交同步](https://github.com/yu-bobo/dsh-commit-journal) · [GitHub PR 工作台](https://github.com/FlutterSoul/dsh-git-workbench)
