$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'download-archive.ps1')
$nidoRoot = Split-Path $PSScriptRoot -Parent
$bundle = Join-Path $nidoRoot 'resources/debug'
$cache = Join-Path $nidoRoot '.downloads'
New-Item -ItemType Directory -Force -Path $bundle, $cache | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
$version = '1.12.3'
$hash = 'a916e509308dac817732f63ca604a8b93ed29cd16f38a2fa9f0b64ed58e8f51a'

if (!(Test-Path "$bundle/codelldb/extension/adapter/codelldb.exe")) {
  $archive = "$cache/codelldb-$version.vsix"
  Get-NidoVerifiedArchive -Uri "https://github.com/vadimcn/codelldb/releases/download/v$version/codelldb-win32-x64.vsix" -Path $archive -ExpectedHash $hash
  [IO.Compression.ZipFile]::ExtractToDirectory($archive, "$bundle/codelldb")
}
$revision = '9e848e09a697ee95302a3ef2dd43fd6eb709e570'
if (!(Test-Path "$bundle/nvim-dap-$revision/lua/dap.lua")) {
  $archive = "$cache/nvim-dap-$revision.zip"
  Get-NidoVerifiedArchive -Uri "https://github.com/mfussenegger/nvim-dap/archive/$revision.zip" -Path $archive -ExpectedHash '5b5085443ce67a9c09de7a2403ab6fb7c1e76d3a38bc2b80ba231acd2e886f2a'
  [IO.Compression.ZipFile]::ExtractToDirectory($archive, $bundle)
}
Write-Output 'Bundled CodeLLDB 1.12.3 and pinned nvim-dap.'
