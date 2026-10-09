import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

// Keep update tests isolated from both installed apps and the baseline package.
process.env.NIDO_PACKAGED_EXE = resolve('dist/auto-update/win-unpacked/nido.exe');
process.env.NIDO_UPDATER_FIXTURE = '1';

export default defineConfig({
    testDir: './tests',
    testMatch: 'update.spec.ts',
    grep: /a packaged update downloads and verifies an installer/,
    workers: 1,
    retries: 0,
    forbidOnly: true,
    timeout: 120000,
    outputDir: 'test-results/updater',
    reporter: [
        ['list'],
        ['html', { open: 'never', outputFolder: 'playwright-report/updater' }],
        ['junit', { outputFile: 'test-results/updater/results.xml' }]
    ]
});
