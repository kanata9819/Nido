// Helpers shared by the renderer-lifecycle test files.
import type { Page } from '@playwright/test';
import type {} from '../renderer/harness';

export async function pauseRendererClock(page: Page): Promise<void> {
	// Installing the clock alone still lets CI wall time advance timers. Pause before mounting.
	await page.clock.install({ time: new Date(0) });
	await page.clock.pauseAt(new Date(1000));
}

export async function recordedWindowActions(page: Page): Promise<unknown[][]> {
	return page.evaluate(() =>
		window.rendererTest.calls
			.filter((call) => call.method === 'windowAction')
			.map((call) => call.args)
	);
}
