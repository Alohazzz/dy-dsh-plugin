# 研发工作台快速调试

日常开发用 Desktop 自带的 CLI 启动独立 Web 实例，通过一次性 `--patch` 直接加载当前工作区的 `dist/host.js`。这样可以用真实的 DSH 插槽、连接和 API 验证面板，日常迭代省去制作 tgz、重装插件和重启 Desktop 的步骤。以下命令适用于 Windows PowerShell、Node.js 24 及本机验证的 DSH `0.2.2-rc.3`。[官方本地插件教程](https://deepseek-harness.github.io/deepseek-harness/develop/basic/) · [项目入口与版本约束](../package.json)

## 启动开发实例

日常验证在仓库根目录运行 `npm run dev`。它构建当前源码、启动监听，并在默认浏览器打开独立的 DSH Web。首次使用时，在「云效议题 → 连接设置」配置测试账号。之后复用同一开发目录和登录配置。界面修改自动重建，CSS 改动后刷新页面，宿主逻辑改动后重启此命令。在终端按 Ctrl+C 结束开发实例。

在仓库根目录打开一个专用 PowerShell。首次安装依赖后构建一次，给开发实例使用独立的 DSH 用户目录。该目录可以跨次启动复用，所以第二次调试还能看到此前添加的测试工作区。

```powershell
npm ci
npm run build

$cli = Join-Path $env:LOCALAPPDATA 'Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'
& $cli --version
$env:DSH_HOME = Join-Path $env:LOCALAPPDATA 'dy-dsh-plugin-dev'
New-Item -ItemType Directory -Force -Path $env:DSH_HOME | Out-Null
$entry = (Resolve-Path './dist/host.js').Path.Replace('\', '/').Replace("'", "''")
$patch = Join-Path $env:DSH_HOME 'local-plugin.yml'
Set-Content -LiteralPath $patch -Encoding utf8 -Value "- insert:`n    - id: dy-yunxiao`n      name: '$entry'"
& $cli web --patch $patch --host 127.0.0.1 --port 18744
```

从 CLI 打开的浏览器页面进入「研发工作台」，再切换到要验证的模块。开发实例有自己的 profile 和插件数据。这个仓库的发行补丁按包名查找已安装依赖，开发补丁则指向刚生成的文件。DSH 根据该文件所属的包读取 `dsh.client` 和 `exports["./client"]`，让页面加载同一工作区的 `dist/client.js`。本机 PATH 中的 `dsh` 实测为 `0.1.5-rc.2`，因此命令里指定了 Desktop 内置 CLI。[发行补丁](../cordis.patch.yml) · [rc.3 客户端模块发现](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.3/docs/subsystems/client-modules.zh.md)

在隔离实例中验证工作台导航和本地技能源操作时，可使用现有运行器。

```powershell
$runner = Join-Path $env:USERPROFILE '.codex/skills/dsh-plugin-test/scripts/run.py'
python -X utf8 $runner --project . --scenario test/workbench.py
```

项目与 .dsh Agent 的分发验收在隔离实例中创建两个项目和三个会话，验证项目范围、跨项目发现、读取说明、执行示例脚本及卸载。追加测试宿主时，将夹具复制到临时目录，使它与工作台分别作为宿主插件解析。

```powershell
$runner = Join-Path $env:USERPROFILE '.codex/skills/dsh-plugin-test/scripts/run.py'
$temp = Join-Path ([IO.Path]::GetTempPath()) ('dy-skill-test-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $temp | Out-Null
$fixture = Join-Path $temp 'fixture.mjs'
$patch = Join-Path $temp 'test.yml'
try {
  Copy-Item test/skill-distribution-fixture.mjs $fixture
  $hostEntry = (Resolve-Path 'dist/host.js').Path.Replace('\','/')
  $fixtureEntry = $fixture.Replace('\','/')
  [IO.File]::WriteAllText($patch, "- insert:`n    - id: dy-yunxiao`n      name: '$hostEntry'`n    - id: skill-distribution-fixture`n      name: '$fixtureEntry'`n")
  python -X utf8 $runner --project . --patch $patch --scenario test/skill-distribution.py
} finally {
  Remove-Item -LiteralPath $fixture,$patch
  Remove-Item -LiteralPath $temp
}
```

## 根据改动选择最短反馈路径

日常同时修改 TSX、CSS 和服务端时，在第二个终端运行 `node --watch-path=src build.mjs`。它复用项目现有构建，首次运行和后续保存都会更新 `dist`。本机 Windows、Node.js 24.14.1 的临时样例已验证一次性构建脚本会在源码变化后再次运行。此模式下，CSS 改完刷新页面，服务端改完重启开发 Web 实例；只有需要 TSX 源码断点时才切换到下表的专用 esbuild 命令，两个构建监听器择一运行。[项目构建](../build.mjs)

| 改动 | 在第二个 PowerShell 中运行 | 如何看到结果 |
| --- | --- | --- |
| 工作流、回执或云效数据处理 | `node --test --watch test/workflow.test.mjs`，或指定 `test/yunxiao.test.mjs` | 测试直接导入源码并注入测试数据，保存后查看测试结果。[工作流测试](../test/workflow.test.mjs) · [云效测试](../test/yunxiao.test.mjs) |
| `src/panel.tsx` | `& .\node_modules\.bin\esbuild.cmd src/panel.tsx --bundle --platform=browser --format=iife --outfile=dist/client.js --sourcemap=inline --watch` | 保持浏览器打开。宿主监视客户端产物，重建后通过 SSE 通知页面重新挂载插件，面板内部 React 状态随之重置。内联 source map 随脚本送达浏览器，可在 DevTools 的 Sources 中给 TSX 下断点。[项目构建](../build.mjs) · [rc.3 客户端热重载](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.3/packages/client/hmr/README.zh.md) |
| `src/panel.css` | `Copy-Item ./src/panel.css ./dist/panel.css -Force` | 刷新浏览器；若看到旧样式，在 DevTools 的 Network 中禁用缓存后刷新。插件通过独立的 CSS URL 按请求读磁盘。[样式路由](../src/host.ts) · [面板加载样式](../src/panel.tsx) |
| `src/host.ts`、服务端依赖、命令或 RPC | `npm run build` | 在运行 Web 的终端按 Ctrl+C，再执行上面的最后一条启动命令并刷新页面。这个流程保证 Node 进程装入新代码。调试服务端逻辑也可以先在对应的 Node 测试里下断点。[服务端入口](../src/host.ts) · [项目构建](../build.mjs) |
| Desktop 安装、发行包或桌面特有行为 | `npm pack` | 使用实际生成的 tgz 按 README 安装并重启 Desktop，检查用户收到的包能否加载。[Desktop 安装步骤](../README.md) · [官方组合包说明](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish.html) |

## 从哪一层查问题

2026 年 11 月 18 日在本机复核了整条前端链路。隔离的 DSH 用户目录通过开发补丁加载构建产物副本；从终端给出的启动链接进入 Chrome 后，页面显示「云效议题」，`/plugins/events` 返回 200，同源 `POST /api/dy-yunxiao` 的 `meta` 请求也返回 200，并在未配置云效时给出 `setupError`。随后只改副本中的 `dist/client.js` 加入可观察标记，原页面自动执行了新代码，全程无需刷新或重启。此次实测覆盖面板、RPC 和客户端热重载，真实云效读写仍需测试账号验证。

- **看不到入口**。先访问开发实例的 `/dy-yunxiao/panel.css`。返回插件样式说明服务端路由已注册。再在 DevTools 的 Network 搜索 `dy-dsh-plugin/client.js`，它可能出现在多个插件合并的脚本请求中。检查 Console 的模块或插槽注册错误。[服务端路由](../src/host.ts) · [rc.3 客户端脚本路由](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.3/docs/subsystems/client-modules.zh.md)
- **面板还显示旧代码**。确认写入的是开发工作区的 `dist/client.js`。Network 中查看 `/plugins/events` 的 EventStream，正常重建应出现 `rebuilt` 和新的 revision。rc.3 的默认轮询间隔是 500 毫秒。单改 CSS 或 source map 应分别检查 CSS 路由或生成的 JS 是否也有更新。[rc.3 轮询与 SSE 实现](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.3/packages/client/hmr/src/index.ts)
- **能打开面板，业务操作失败**。在已连接的页面执行操作，检查 Network 中 `POST /api/dy-yunxiao` 的状态、请求里的 `method` 及 JSON 错误消息。该路由首先执行 DSH 连接检查；匿名请求返回 401 只能验证连接保护。真实云效读写还需要测试组织、凭据和适当权限。[面板请求](../src/panel.tsx) · [服务端连接与方法分派](../src/host.ts)
