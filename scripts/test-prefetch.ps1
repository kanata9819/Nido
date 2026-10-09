$ErrorActionPreference = 'Stop'
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    New-Item -ItemType Directory -Force -Path 'test-results/prefetch' | Out-Null
    for ($prefetchAttempt = 1; $prefetchAttempt -le 5; $prefetchAttempt++) {
        & pnpm.cmd exec tsx --test --test-name-pattern 'upper-row prefetch' tests/session-performance.test.ts |
            Tee-Object -FilePath "test-results/prefetch/attempt-$prefetchAttempt.txt"
        if ($LASTEXITCODE -ne 0) { throw "Prefetch verification failed on attempt $prefetchAttempt." }
    }
} finally {
    Pop-Location
}
