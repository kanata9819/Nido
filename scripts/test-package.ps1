$ErrorActionPreference = 'Stop'
$nidoRoot = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$nidoVersion = [regex]::Match((Get-Content "$nidoRoot/Cargo.toml" -Raw), '(?m)^version = "([^"]+)"').Groups[1].Value
$nidoSetup = Join-Path $nidoRoot "dist/release/nido-$nidoVersion-setup.exe"
$nidoExpected = (Get-Content "$nidoSetup.sha256" -Raw).Split(' ')[0]
if ((Get-FileHash -LiteralPath $nidoSetup -Algorithm SHA256).Hash.ToLowerInvariant() -ne $nidoExpected) { throw 'Installer checksum mismatch.' }
$nidoTestRoot = Join-Path $nidoRoot ('target/package-test-' + [Guid]::NewGuid().ToString('N'))
$nidoInstalled = Join-Path $nidoTestRoot 'installed'
if (![IO.Path]::GetFullPath($nidoInstalled).StartsWith("$nidoRoot\target\", [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe package test destination.' }
New-Item -ItemType Directory -Path $nidoInstalled | Out-Null
$nidoPreviousResources = $env:NIDO_RESOURCES
try {
    $nidoProcess = Start-Process -FilePath $nidoSetup -ArgumentList '/S', '/NOINTEGRATION', "/D=$nidoInstalled" -WindowStyle Hidden -Wait -PassThru
    if ($nidoProcess.ExitCode -ne 0) { throw "Installer failed: $($nidoProcess.ExitCode)" }
    if (!(Select-String -LiteralPath "$nidoInstalled/.nido-install.ini" -SimpleMatch 'NoIntegration=1')) { throw 'Installer did not respect isolated test mode.' }
    $nidoSentinel = Join-Path $nidoInstalled 'user-owned.txt'
    Set-Content -LiteralPath $nidoSentinel -Value 'preserve'
    Set-Content -LiteralPath "$nidoInstalled/resources/app.asar" -Value 'legacy fixture'
    Set-Content -LiteralPath "$nidoInstalled/chrome_100_percent.pak" -Value 'legacy fixture'
    New-Item -ItemType Directory -Path "$nidoInstalled/locales" | Out-Null
    Set-Content -LiteralPath "$nidoInstalled/locales/en.pak" -Value 'legacy fixture'
    $nidoProcess = Start-Process -FilePath $nidoSetup -ArgumentList '/S', '/NOINTEGRATION', "/D=$nidoInstalled" -WindowStyle Hidden -Wait -PassThru
    if ($nidoProcess.ExitCode -ne 0 -or (Test-Path "$nidoInstalled/resources/app.asar") -or (Test-Path "$nidoInstalled/chrome_100_percent.pak") -or (Test-Path "$nidoInstalled/locales") -or !(Test-Path $nidoSentinel)) { throw 'Upgrade did not remove the legacy Electron payload safely.' }
    $env:NIDO_RESOURCES = Join-Path $nidoInstalled 'resources'
    # Release GUI binaries have no console; capture output and inspect the exit code.
    $nidoProcess = Start-Process -FilePath "$nidoInstalled/nido.exe" -ArgumentList '--smoke-test' -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput "$nidoTestRoot/stdout.txt" -RedirectStandardError "$nidoTestRoot/stderr.txt"
    Get-Content "$nidoTestRoot/stdout.txt", "$nidoTestRoot/stderr.txt"
    if ($nidoProcess.ExitCode -ne 0) { throw "Packaged smoke test failed: $($nidoProcess.ExitCode). Logs: $nidoTestRoot" }
    if (!(Select-String -LiteralPath "$nidoTestRoot/stdout.txt" -SimpleMatch 'PASS: headless native UI')) { throw 'Packaged UI checks did not run.' }
    $nidoProcess.Dispose()
    # Windows can signal process exit before releasing its executable image.
    $nidoUnlockDeadline = [DateTime]::UtcNow.AddSeconds(10)
    while ($true) {
        try {
            $nidoImage = [IO.File]::Open("$nidoInstalled/nido.exe", [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
            $nidoImage.Dispose()
            break
        } catch {
            if ([DateTime]::UtcNow -ge $nidoUnlockDeadline) { throw }
            Start-Sleep -Milliseconds 100
        }
    }
    $nidoSentinel = Join-Path $nidoInstalled 'user-owned.txt'
    Set-Content -LiteralPath $nidoSentinel -Value 'preserve'
    $nidoProcess = Start-Process -FilePath "$nidoInstalled/Uninstall nido.exe" -ArgumentList '/S', "_?=$nidoInstalled" -WindowStyle Hidden -Wait -PassThru
    if ($nidoProcess.ExitCode -ne 0 -or (Test-Path "$nidoInstalled/nido.exe") -or (Test-Path "$nidoInstalled/resources") -or !(Test-Path $nidoSentinel)) { throw "Native uninstall failed ($($nidoProcess.ExitCode)); inspect $nidoInstalled." }
    Write-Output 'PASS: native installer, bundled runtime, packaged integration checks and isolated uninstall.'
} finally {
    $env:NIDO_RESOURCES = $nidoPreviousResources
    # Keep test logs and payload for diagnosis; no user data or registry integration is touched.
}
