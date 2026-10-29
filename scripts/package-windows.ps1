param([switch] $SkipBuild)
$ErrorActionPreference = 'Stop'
$nidoRoot = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
Push-Location $nidoRoot
try {
    if (!$SkipBuild) {
        $nidoOldFlags = $env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS
        try {
            # Include the C runtime so Nido starts without a separate VC++ redistributable.
            $env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS = "$nidoOldFlags -C target-feature=+crt-static".Trim()
            & cargo build -p nido --release --locked --target x86_64-pc-windows-msvc
            if ($LASTEXITCODE -ne 0) { throw 'Native release build failed.' }
        } finally { $env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS = $nidoOldFlags }
    }
    $nidoVersion = [regex]::Match((Get-Content Cargo.toml -Raw), '(?m)^version = "([^"]+)"').Groups[1].Value
    if ($nidoVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid Cargo package version.' }
    $nidoPayload = Join-Path $nidoRoot 'dist/native'
    $nidoRelease = Join-Path $nidoRoot 'dist/release'
    foreach ($path in @($nidoPayload, $nidoRelease)) {
        $resolved = [IO.Path]::GetFullPath($path)
        if (!$resolved.StartsWith("$nidoRoot\dist\", [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe package cleanup path.' }
        if (Test-Path $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
        New-Item -ItemType Directory -Path $resolved | Out-Null
    }
    Copy-Item -LiteralPath 'target/x86_64-pc-windows-msvc/release/nido.exe', 'LICENCE' -Destination $nidoPayload
    $nidoMetadataText = & cargo metadata --locked --format-version 1 --filter-platform x86_64-pc-windows-msvc
    if ($LASTEXITCODE -ne 0) { throw 'Unable to collect dependency notices.' }
    $nidoMetadata = $nidoMetadataText | ConvertFrom-Json
    $nidoNotices = [Text.StringBuilder]::new()
    foreach ($package in ($nidoMetadata.packages | Sort-Object name, version)) {
        [void]$nidoNotices.AppendLine("$($package.name) $($package.version) | $($package.license) | $($package.repository)")
        $nidoCrate = Split-Path $package.manifest_path -Parent
        $nidoLicenses = @(Get-ChildItem -LiteralPath $nidoCrate -File | Where-Object { $_.Name -match '^(LICEN[CS]E|COPYING|NOTICE)' } | Select-Object -ExpandProperty FullName)
        if ($package.license_file) { $nidoLicenses += Join-Path $nidoCrate $package.license_file }
        foreach ($license in ($nidoLicenses | Sort-Object -Unique)) {
            [void]$nidoNotices.AppendLine([IO.File]::ReadAllText($license))
        }
        [void]$nidoNotices.AppendLine('--------------------')
    }
    [IO.File]::WriteAllText("$nidoPayload/THIRD-PARTY-NOTICES.txt", $nidoNotices.ToString(), [Text.UTF8Encoding]::new($false))
    New-Item -ItemType Directory -Path "$nidoPayload/resources" | Out-Null
    foreach ($name in @('nido', 'nvim-win64', 'debug', 'languages', 'node')) {
        if (!(Test-Path "resources/$name")) { throw "Missing runtime: $name. Run scripts/prepare-runtime.ps1 first." }
        Copy-Item -LiteralPath "resources/$name" -Destination "$nidoPayload/resources/$name" -Recurse
    }
    foreach ($name in @('nvim-win64/bin/nvim.exe', 'nvim-win64/bin/vcruntime140.dll', 'node/node.exe', 'languages/node_modules/typescript-language-server/lib/cli.mjs', 'debug/codelldb/extension/adapter/codelldb.exe')) {
        if (!(Test-Path "$nidoPayload/resources/$name")) { throw "Incomplete package: $name" }
    }
    foreach ($name in @('vcruntime140.dll', 'vcruntime140_1.dll', 'vcruntime140_threads.dll', 'msvcp140.dll')) {
        if (!(Test-Path "$nidoPayload/resources/debug/codelldb/extension/adapter/$name")) {
            throw "Incomplete CodeLLDB runtime: $name. Run scripts/prepare-runtime.ps1 first."
        }
    }
    $nidoNsis = Get-Command makensis.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1
    if (!$nidoNsis) {
        $nidoNsis = Get-ChildItem "$env:USERPROFILE/AppData/Local/electron-builder/Cache/nsis-*", "${env:ProgramFiles(x86)}/NSIS", "$env:ProgramFiles/NSIS" -Filter makensis.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName -First 1
    }
    if (!$nidoNsis) { throw 'NSIS is required. Install NSIS and add makensis.exe to PATH.' }
    $nidoSetup = Join-Path $nidoRelease "nido-$nidoVersion-setup.exe"
    & $nidoNsis /V2 "/DVERSION=$nidoVersion" "/DPAYLOAD=$nidoPayload" "/DOUTPUT=$nidoSetup" 'build/installer.nsi'
    if ($LASTEXITCODE -ne 0) { throw 'NSIS installer compilation failed.' }
    $nidoSha256 = (Get-FileHash -LiteralPath $nidoSetup -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content -LiteralPath "$nidoSetup.sha256" -Value "$nidoSha256  $([IO.Path]::GetFileName($nidoSetup))" -Encoding ascii
    $nidoSha512 = [Security.Cryptography.SHA512]::Create()
    $nidoStream = [IO.File]::OpenRead($nidoSetup)
    try { $nidoBase64 = [Convert]::ToBase64String($nidoSha512.ComputeHash($nidoStream)) }
    finally { $nidoStream.Dispose(); $nidoSha512.Dispose() }
    $nidoName = [IO.Path]::GetFileName($nidoSetup)
    $nidoSize = (Get-Item -LiteralPath $nidoSetup).Length
    # Electron clients can download the same installer during the native migration.
    Set-Content -LiteralPath "$nidoRelease/latest.yml" -Encoding utf8 -Value @"
version: $nidoVersion
files:
  - url: $nidoName
    sha512: $nidoBase64
    size: $nidoSize
path: $nidoName
sha512: $nidoBase64
releaseDate: '$([DateTime]::UtcNow.ToString('o'))'
"@
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($nidoPayload, "$nidoRelease/nido-$nidoVersion-windows-x64.zip", [IO.Compression.CompressionLevel]::Optimal, $false)
    Write-Output "Native package: $nidoSetup"
} finally { Pop-Location }
