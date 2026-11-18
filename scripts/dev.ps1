$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot)
$cli = Join-Path $env:LOCALAPPDATA 'Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'
$env:DSH_HOME = Join-Path $env:LOCALAPPDATA 'dy-dsh-plugin-dev'
New-Item -ItemType Directory -Force $env:DSH_HOME | Out-Null
node build.mjs
if ($LASTEXITCODE) { exit $LASTEXITCODE }
$entry = (Resolve-Path 'dist/host.js').Path.Replace('\', '/').Replace("'", "''")
$patch = Join-Path $env:DSH_HOME 'local-plugin.yml'
Set-Content -LiteralPath $patch -Encoding utf8 -Value @(
    '- insert:'
    '    - id: dy-yunxiao'
    "      name: '$entry'"
)
$watcher = Start-Process node -ArgumentList '--watch-path=src','build.mjs' -PassThru -WindowStyle Hidden
try {
    & $cli web --patch $patch --host 127.0.0.1 --port 18744
} finally {
    if (!$watcher.HasExited) { $watcher.Kill() }
}
