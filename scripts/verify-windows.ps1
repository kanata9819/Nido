$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT' -or [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
    throw 'Windows verification requires Windows x64.'
}

function Invoke-Pnpm {
    param([string[]]$Arguments)
    & pnpm.cmd @Arguments
    if ($LASTEXITCODE -ne 0) { throw "pnpm $($Arguments -join ' ') failed with exit code $LASTEXITCODE." }
}

Push-Location (Split-Path -Parent $PSScriptRoot)
$previousExecutable = $env:NIDO_PACKAGED_EXE
try {
    Invoke-Pnpm -Arguments @('lint', '--max-warnings', '0')
    Invoke-Pnpm -Arguments @('typecheck')
    Invoke-Pnpm -Arguments @('typecheck:windows')
    Invoke-Pnpm -Arguments @('build:unpack')
    Invoke-Pnpm -Arguments @('test')
    Invoke-Pnpm -Arguments @('test:prefetch')
    Invoke-Pnpm -Arguments @('exec', 'playwright', 'install', 'chromium')
    Invoke-Pnpm -Arguments @('test:renderer')
    $env:NIDO_PACKAGED_EXE = Join-Path $PWD 'dist/win-unpacked/nido.exe'
    Invoke-Pnpm -Arguments @('test:windows')
    Invoke-Pnpm -Arguments @('verify:update')
} finally {
    $env:NIDO_PACKAGED_EXE = $previousExecutable
    Pop-Location
}
