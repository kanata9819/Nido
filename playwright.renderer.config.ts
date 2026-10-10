import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './tests',
    testMatch: [
        'renderer-lifecycle.spec.ts',
        'renderer-performance.spec.ts',
        'history-renderer.spec.ts',
        'overlay-motion.spec.ts'
    ],
    timeout: 30000,
    outputDir: 'test-results/renderer',
    workers: 1,
    reporter: 'list'
});
