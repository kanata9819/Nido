$ErrorActionPreference = 'Stop'
$nidoRoot = Split-Path $PSScriptRoot -Parent
$testDir = Join-Path $nidoRoot ".downloads/installer-tests/$([guid]::NewGuid().ToString('N'))"
$unicodeName = -join ([char[]]@(0x65e5, 0x672c, 0x8a9e))
New-Item -ItemType Directory -Force -Path "$testDir/source/resources", "$testDir/source/space $unicodeName" | Out-Null

# Use the same compiler, extractor plugin, and archiver as electron-builder.
Push-Location $nidoRoot
try {
    [IO.File]::WriteAllText("$testDir/tools.cjs", @'
const { createRequire } = require('node:module');
const r = createRequire(require.resolve('electron-builder'));
const w = r('app-builder-lib/out/toolsets/windows');
const z = r('app-builder-lib/out/toolsets/7zip');
const path = require('node:path');
(async () => {
    const [nsis, plugins, sevenZip] = await Promise.all([
        w.getMakeNsisPath(), w.getNsisPluginsPath(), z.getPath7za()
    ]);
    const templates = path.join(path.dirname(r.resolve('app-builder-lib/package.json')), 'templates/nsis/include');
    require('node:fs').writeFileSync(process.argv[2], JSON.stringify({ nsis, plugins, sevenZip, templates }));
})().catch(e => { console.error(e); process.exitCode = 1; });
'@)
    & node "$testDir/tools.cjs" "$testDir/tools.json"
    if ($LASTEXITCODE -ne 0) { throw 'Unable to locate installer tools. Run pnpm build:win first.' }
    $tools = Get-Content -LiteralPath "$testDir/tools.json" -Raw | ConvertFrom-Json
    [IO.File]::WriteAllText("$testDir/source/nido.exe", 'fixture executable')
    [IO.File]::WriteAllText("$testDir/source/resources/app.asar", 'fixture application')
    [IO.File]::WriteAllText("$testDir/source/space $unicodeName/$unicodeName.txt", 'nested unicode file')
    $payload = Join-Path $testDir 'fixture.7z'
    & $tools.sevenZip a '-bd' '-bso0' '-bsp0' $payload "$testDir/source/*"
    if ($LASTEXITCODE -ne 0) { throw 'Unable to create installer fixture.' }

    foreach ($case in @('move', 'copy', 'locked', 'missing')) {
        $target = Join-Path $testDir "target-$case"
        New-Item -ItemType Directory -Force -Path $target | Out-Null
        if ($case -ne 'move') {
            [IO.File]::WriteAllText("$target/keep.txt", 'keep existing content')
        }
        $archive = if ($case -eq 'missing') { "$testDir/missing.7z" } else { $payload }
        & $tools.nsis.path '-V2' "-DTEST_DIR=$testDir" "-DNIDO_TEST_CASE=$case" "-DPAYLOAD=$archive" "-DBUILD_RESOURCES_DIR=$nidoRoot/build" "-DPLUGIN_DIR=$($tools.plugins)/x86-unicode" "-DTEMPLATE_DIR=$($tools.templates)" "$nidoRoot/tests/installer.nsi"
        if ($LASTEXITCODE -ne 0) { throw "Unable to build installer fixture: $case" }
        $lockedFile = $null
        try {
            if ($case -eq 'locked') {
                [IO.File]::WriteAllText("$target/nido.exe", 'locked existing executable')
                $lockedFile = [IO.File]::Open("$target/nido.exe", [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
            }
            $process = Start-Process -FilePath "$testDir/fixture-$case.exe" -WindowStyle Hidden -PassThru
            if (!$process.WaitForExit(20000)) {
                $process.Kill()
                throw "Installer fixture timed out: $case"
            }
            $expectedExit = if ($case -in @('locked', 'missing')) { 2 } else { 0 }
            if ($process.ExitCode -ne $expectedExit) { throw "Unexpected exit code in ${case}: $($process.ExitCode)" }
        } finally {
            if ($null -ne $lockedFile) { $lockedFile.Dispose() }
        }
        if ($case -in @('move', 'copy')) {
            foreach ($file in Get-ChildItem -LiteralPath "$testDir/source" -Recurse -File) {
                $relative = $file.FullName.Substring("$testDir/source".Length + 1)
                $actual = Join-Path $target $relative
                # The fixture files are tiny; compare all bytes without optional PS modules.
                if (!(Test-Path -LiteralPath $actual) -or [Convert]::ToBase64String([IO.File]::ReadAllBytes($actual)) -ne [Convert]::ToBase64String([IO.File]::ReadAllBytes($file.FullName))) {
                    throw "Installed content differs: $case/$relative"
                }
            }
            if (!(Test-Path -LiteralPath "$target/installed.txt")) { throw "Installation did not finish: $case" }
            $expectedTransfer = if ($case -eq 'move') { 'moved' } else { 'copied' }
            if ([IO.File]::ReadAllText("$target/installed.txt") -ne $expectedTransfer) { throw "Unexpected transfer method: $case" }
        } elseif (Test-Path -LiteralPath "$target/installed.txt") {
            throw "Failed installation reported success: $case"
        }
        if ($case -ne 'move' -and [IO.File]::ReadAllText("$target/keep.txt") -ne 'keep existing content') {
            throw "Existing content was lost: $case"
        }
        if ($case -eq 'locked' -and [IO.File]::ReadAllText("$target/nido.exe") -ne 'locked existing executable') {
            throw 'A locked executable was overwritten.'
        }
        Write-Output "Installer fixture passed: $case"
    }
} finally {
    Pop-Location
}
