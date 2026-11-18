param([int]$Port = 18743)
$module = (Join-Path $PSScriptRoot 'host.mjs').Replace('\','/').Replace("'","''")
$patch = Join-Path ([IO.Path]::GetTempPath()) ("yunxiao-prototype-" + [guid]::NewGuid() + ".yml")
try {
  Set-Content -LiteralPath $patch -Encoding utf8 -Value "- insert:`n    - id: dy-yunxiao-prototype`n      name: '$module'"
  dsh web --patch $patch --host 127.0.0.1 --port $Port --no-open
} finally { Remove-Item -LiteralPath $patch }
