import { defineConfig } from '@playwright/test';
export default defineConfig({
    testDir: './tests',
    testMatch: '**/*.spec.ts',
    testIgnore: [
        '**/renderer-lifecycle.spec.ts',
        '**/renderer-performance.spec.ts',
        '**/windows/**'
    ],
    timeout: 60000,
    workers: 1,
    reporter: 'list'
});
