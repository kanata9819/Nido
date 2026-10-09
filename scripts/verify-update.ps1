$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Update verification requires Windows.' }

Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    # Package the current build without publishing or touching an installed app.
    & pnpm.cmd exec electron-builder --win --publish never --config.directories.output=dist/auto-update
    if ($LASTEXITCODE -ne 0) { throw 'Unable to package the updater fixture.' }
    & pnpm.cmd test:update
    if ($LASTEXITCODE -ne 0) { throw 'Packaged update verification failed.' }
} finally {
    Pop-Location
}
