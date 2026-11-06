import { expect, type Page } from '@playwright/test';
import type {} from '../renderer/harness';

// The harness defines window.rendererTest while its module loads, so page.goto can resolve first.
export async function waitForRendererHarness(page: Page): Promise<void> {
	await page.waitForFunction(() => window.rendererTest !== undefined);
}

// Deferred calls are queued by effects after the first render; wait before settling one.
export async function waitForPendingCall(page: Page, method: string): Promise<void> {
	await expect
		.poll(() =>
			page.evaluate(
				(method) =>
					window.rendererTest?.pending.some((call) => call.method === method) ?? false,
				method
			)
		)
		.toBe(true);
}
