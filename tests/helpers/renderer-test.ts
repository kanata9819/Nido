import { test as base, type TestInfo } from '@playwright/test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export { expect } from '@playwright/test';

/**
 * Windows CI runners now and then fail a request to the harness's Vite server with
 * net::ERR_NO_BUFFER_SPACE (WSAENOBUFS). Reports taken at the failure found ports, memory
 * and handles all well within limits, and the failing file differed each time, so it is
 * the runner, not a renderer bug. The renderer config retries a failed test once, but only
 * a test whose failed attempt saw this error: any other failure fails at the start of its
 * retry, so a retry never hides it.
 *
 * The record is a file, since Playwright replaces the worker after a failed test.
 */
function bufferSpaceRecord(testInfo: TestInfo): string {
	return join(testInfo.project.outputDir, '.no-buffer-space', testInfo.testId);
}

/** Record that the running test, or the beforeAll hook it started, saw the error. */
export function noteBufferSpaceFailure(): void {
	let testInfo: TestInfo;
	try {
		testInfo = base.info();
	} catch {
		return;
	}
	const record = bufferSpaceRecord(testInfo);
	mkdirSync(join(record, '..'), { recursive: true });
	writeFileSync(record, `${testInfo.titlePath.join(' › ')}\n`);
}

export const test = base.extend<{ bufferSpaceRetry: void }>({
	bufferSpaceRetry: [
		// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured first argument.
		async ({}, use, testInfo) => {
			const record = bufferSpaceRecord(testInfo);
			if (testInfo.retry > 0) {
				if (!existsSync(record)) {
					throw new Error(
						'Not retried: only a failure after net::ERR_NO_BUFFER_SPACE is retried, ' +
							'and the previous attempt failed for another reason. See its error above.'
					);
				}
				rmSync(record);
				console.log(`[harness] retrying after net::ERR_NO_BUFFER_SPACE: ${testInfo.title}`);
			}
			await use();
			if (testInfo.status === testInfo.expectedStatus) {
				rmSync(record, { force: true });
			}
		},
		{ auto: true }
	]
});
