import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: './tests',
	// Two projects of about the same length, so CI can run them on separate machines with
	// --project. Without --project, both run, as before. A new renderer spec goes in one.
	projects: [
		{
			name: 'lifecycle',
			testMatch: [
				'renderer-lifecycle-file-tabs.spec.ts',
				'renderer-lifecycle-folder-picker.spec.ts',
				'renderer-lifecycle-git.spec.ts',
				'renderer-lifecycle-input.spec.ts',
				'renderer-lifecycle-layout-settings.spec.ts',
				'renderer-lifecycle-neovim-ui.spec.ts',
				'renderer-lifecycle-panels-focus.spec.ts',
				'renderer-lifecycle-popups.spec.ts',
				'renderer-lifecycle-rendering.spec.ts',
				'renderer-lifecycle-state.spec.ts',
				'renderer-lifecycle-workspaces.spec.ts',
				'history-renderer.spec.ts',
				'github-renderer.spec.ts',
				'workspace-search-renderer.spec.ts',
				'workspace-actions-renderer.spec.ts'
			]
		},
		{
			name: 'performance',
			testMatch: [
				'renderer-performance-paint.spec.ts',
				'renderer-performance-scroll.spec.ts',
				'renderer-performance-ui.spec.ts',
				'renderer-horizontal.spec.ts',
				'feature-performance.spec.ts',
				'document-symbols.spec.ts',
				'terminal-shells.spec.ts',
				'overlay-motion.spec.ts',
				'references-panel-layout.spec.ts'
			]
		}
	],
	timeout: 30000,
	// On CI, a test that failed after net::ERR_NO_BUFFER_SPACE runs once more. Every other
	// failure still fails: tests/helpers/renderer-test.ts stops its retry at the start.
	retries: process.env.CI ? 1 : 0,
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
