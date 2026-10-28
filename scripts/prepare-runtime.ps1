$ErrorActionPreference = 'Stop'
$nidoRoot = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
if (![Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
    throw 'The bundled Windows runtime requires x64 Windows.'
}
foreach ($script in @('prepare-neovim.ps1', 'prepare-debugger.ps1')) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot $script)
    if ($LASTEXITCODE -ne 0) { throw "$script failed." }
}

$nidoCrt = Join-Path $nidoRoot 'resources/debug/codelldb/extension/lldb/bin/vcruntime140.dll'
if (!(Test-Path $nidoCrt)) { throw 'CodeLLDB archive is missing the Neovim C runtime dependency.' }
Copy-Item -LiteralPath $nidoCrt -Destination (Join-Path $nidoRoot 'resources/nvim-win64/bin/vcruntime140.dll') -Force
# Windows resolves the adapter's CRT before CodeLLDB can load its LLDB directory.
foreach ($name in @('vcruntime140.dll', 'vcruntime140_1.dll', 'vcruntime140_threads.dll', 'msvcp140.dll')) {
    $nidoAdapterCrt = Join-Path $nidoRoot "resources/debug/codelldb/extension/lldb/bin/$name"
    if (!(Test-Path $nidoAdapterCrt)) { throw "CodeLLDB archive is missing $name." }
    Copy-Item -LiteralPath $nidoAdapterCrt -Destination (Join-Path $nidoRoot 'resources/debug/codelldb/extension/adapter') -Force
}

$nidoVersion = '24.22.0'
$nidoHash = 'f9683a19877e12a9b167305c8db71040d812876359de21f0d2e97c3f321f80c3'
$nidoResources = Join-Path $nidoRoot 'resources'
$nidoBundle = Join-Path $nidoResources 'node'
$nidoMarker = Join-Path $nidoBundle 'nido-version.txt'
if (!(Test-Path $nidoMarker) -or (Get-Content $nidoMarker -Raw).Trim() -ne $nidoHash -or
    !(Test-Path (Join-Path $nidoBundle 'node.exe'))) {
    $nidoDownloads = Join-Path $nidoRoot '.downloads'
    New-Item -ItemType Directory -Force -Path $nidoDownloads | Out-Null
    $nidoArchive = Join-Path $nidoDownloads "node-v$nidoVersion-win-x64.zip"
    if (!(Test-Path $nidoArchive)) {
        Invoke-WebRequest "https://nodejs.org/dist/v$nidoVersion/node-v$nidoVersion-win-x64.zip" -OutFile $nidoArchive
    }
    if ((Get-FileHash -LiteralPath $nidoArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $nidoHash) {
        throw 'Node runtime checksum mismatch.'
    }
    $nidoStage = Join-Path $nidoResources ('.node-' + [Guid]::NewGuid().ToString('N'))
    $nidoBackup = "$nidoStage-backup"
    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [IO.Compression.ZipFile]::ExtractToDirectory($nidoArchive, $nidoStage)
        $nidoExtracted = Join-Path $nidoStage "node-v$nidoVersion-win-x64"
        foreach ($name in @('node.exe', 'LICENSE')) {
            if (!(Test-Path (Join-Path $nidoExtracted $name))) { throw "Node archive is missing $name." }
        }
        $nidoPrepared = Join-Path $nidoStage 'runtime'
        New-Item -ItemType Directory -Path $nidoPrepared | Out-Null
        Copy-Item -LiteralPath (Join-Path $nidoExtracted 'node.exe'), (Join-Path $nidoExtracted 'LICENSE') -Destination $nidoPrepared
        Set-Content -LiteralPath (Join-Path $nidoPrepared 'nido-version.txt') -Value $nidoHash -Encoding ascii
        if (Test-Path $nidoBundle) { Move-Item -LiteralPath $nidoBundle -Destination $nidoBackup }
        try { Move-Item -LiteralPath $nidoPrepared -Destination $nidoBundle }
        catch {
            if (Test-Path $nidoBackup) { Move-Item -LiteralPath $nidoBackup -Destination $nidoBundle }
            throw
        }
    } finally {
        foreach ($path in @($nidoStage, $nidoBackup)) {
            $resolved = [IO.Path]::GetFullPath($path)
            if (!$resolved.StartsWith("$nidoResources\", [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe runtime cleanup path.' }
            if (Test-Path $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
        }
    }
}
& npm.cmd ci --prefix (Join-Path $nidoResources 'languages') --ignore-scripts --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'Language server installation failed.' }
& (Join-Path $nidoBundle 'node.exe') --version
if ($LASTEXITCODE -ne 0) { throw 'Bundled Node runtime did not start.' }
Write-Output 'Native runtime prepared; Node is used only by external language servers.'
