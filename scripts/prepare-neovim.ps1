$ErrorActionPreference = 'Stop'
$nidoRoot = Split-Path $PSScriptRoot -Parent
$nidoResources = Join-Path $nidoRoot 'resources'
$nidoBundle = Join-Path $nidoResources 'nvim-win64'
$nidoVersion = '0.11.5'
$nidoHash = '718e731326e7759cf17bbbb33f38975707a2ac85642614686b818ef5fde38f48'
$nidoMarker = Join-Path $nidoBundle 'nido-version.txt'
if ((Test-Path $nidoMarker) -and ((Get-Content $nidoMarker -Raw).Trim() -eq $nidoHash) -and
    (Test-Path (Join-Path $nidoBundle 'bin/nvim.exe')) -and
    (Test-Path (Join-Path $nidoBundle 'share/nvim/runtime/doc')) ) { exit 0 }

$nidoDownloads = Join-Path $nidoRoot '.downloads'
New-Item -ItemType Directory -Force -Path $nidoDownloads | Out-Null
$nidoArchive = Join-Path $nidoDownloads "nvim-win64-$nidoVersion.zip"
if (!(Test-Path $nidoArchive)) {
    Invoke-WebRequest "https://github.com/neovim/neovim/releases/download/v$nidoVersion/nvim-win64.zip" -OutFile $nidoArchive
}
$nidoSha = [System.Security.Cryptography.SHA256]::Create()
$nidoStream = [System.IO.File]::OpenRead($nidoArchive)
try { $nidoActualHash = [BitConverter]::ToString($nidoSha.ComputeHash($nidoStream)).Replace('-', '').ToLowerInvariant() }
finally { $nidoStream.Dispose(); $nidoSha.Dispose() }
if ($nidoActualHash -ne $nidoHash) {
    throw "Neovim archive checksum mismatch: $nidoArchive"
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$nidoTemporary = Join-Path $nidoResources ('.nvim-' + [Guid]::NewGuid().ToString('N'))
$nidoBackup = Join-Path $nidoResources ('.nvim-backup-' + [Guid]::NewGuid().ToString('N'))
try {
    [System.IO.Compression.ZipFile]::ExtractToDirectory($nidoArchive, $nidoTemporary)
    $nidoPrepared = Join-Path $nidoTemporary 'nvim-win64'
    if (!(Test-Path (Join-Path $nidoPrepared 'bin/nvim.exe')) -or
        !(Test-Path (Join-Path $nidoPrepared 'share/nvim/runtime/doc'))) {
        throw 'Neovim archive is missing required editor resources.'
    }
    Set-Content -LiteralPath (Join-Path $nidoPrepared 'nido-version.txt') -Value $nidoHash -Encoding ascii
    if (Test-Path $nidoBundle) {
        Move-Item -LiteralPath $nidoBundle -Destination $nidoBackup
    }
    try {
        Move-Item -LiteralPath $nidoPrepared -Destination $nidoBundle
    } catch {
        if (Test-Path $nidoBackup) {
            Move-Item -LiteralPath $nidoBackup -Destination $nidoBundle
        }
        throw
    }
    if (Test-Path $nidoBackup) {
        Remove-Item -LiteralPath $nidoBackup -Recurse -Force
    }
} finally {
    if (Test-Path $nidoTemporary) {
        Remove-Item -LiteralPath $nidoTemporary -Recurse -Force
    }
}
Write-Output "Bundled Neovim $nidoVersion (Windows x64), SHA256 verified."
