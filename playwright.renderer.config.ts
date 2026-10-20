import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './tests',
    testMatch: [
        'renderer-lifecycle.spec.ts',
        'renderer-performance.spec.ts',
        'feature-performance.spec.ts',
        'history-renderer.spec.ts',
        'workspace-search-renderer.spec.ts',
        'overlay-motion.spec.ts'
    ],
    timeout: 30000,
    use: {
        launchOptions: {
            // Use SwiftShader only for the dedicated WebGL checks. Other tests
            // retain the browser's normal Canvas2D backend and pixel comparisons.
            args:
                process.env.NIDO_TEST_SOFTWARE_GPU === '1'
                    ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
                    : ['--enable-gpu']
        }
    },
    outputDir: 'test-results/renderer',
    workers: 1,
    reporter: 'list'
});
