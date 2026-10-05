import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import { windowsBaselineCases } from './tests/windows/cases';

process.env.NIDO_PACKAGED_EXE ||= resolve('dist/win-unpacked/nido.exe');

export default defineConfig({
    testDir: './tests',
    testMatch: [
        'windows/*.spec.ts',
        'electron.spec.ts',
        'theme.spec.ts',
        'scroll-boundary.spec.ts',
        'canvas-sharpness.spec.ts'
    ],
    grep: new RegExp(
        windowsBaselineCases
            .map((title) => title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$')
            .join('|')
    ),
    globalSetup: './tests/windows/setup.ts',
    timeout: 180000,
    globalTimeout: 20 * 60 * 1000,
    workers: 1,
    retries: 0,
    forbidOnly: true,
    outputDir: 'test-results/windows',
    reporter: [
        ['list'],
        ['html', { open: 'never', outputFolder: 'playwright-report/windows' }],
        ['junit', { outputFile: 'test-results/windows/results.xml' }],
        ['./tests/windows/reporter.ts', { listOnly: process.argv.includes('--list') }]
    ]
});
