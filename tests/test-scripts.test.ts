import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

test('every unit test file is run by a package script', () => {
	// The test scripts name their files one by one, so a new file is easy to leave out of
	// them, and then it never runs, locally or in CI.
	const scripts = Object.values(
		(JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> })
			.scripts
	).join(' ');
	const listed = new Set(scripts.match(/tests\/[\w.-]+\.test\.ts/g));
	const files = readdirSync('tests').filter((name) => name.endsWith('.test.ts'));
	assert.ok(files.length > 30, `Found only ${files.length} test files; check the path.`);
	assert.deepEqual(
		files.filter((name) => !listed.has(`tests/${name}`)),
		[],
		'Add these files to a script in package.json, such as "test".'
	);
	// A script that names a file that no longer exists runs nothing for it.
	assert.deepEqual(
		[...listed].filter((path) => !files.includes(path.slice('tests/'.length))),
		[]
	);
});

test('every renderer spec takes test from the renderer helper', () => {
	// The renderer config retries failed tests on CI, and the helper's fixture stops every
	// retry that does not follow net::ERR_NO_BUFFER_SPACE. A spec that takes test straight
	// from Playwright would retry any failure, and pass a flaky test unseen.
	const config = readFileSync('playwright.renderer.config.ts', 'utf8');
	const specs = config.match(/[\w-]+\.spec\.ts/g) ?? [];
	assert.ok(specs.length > 5, `Found only ${specs.length} renderer specs; check the config.`);
	assert.deepEqual(
		specs.filter(
			(name) =>
				!/import \{[^}]*\btest\b[^}]*\} from '\.\/helpers\/renderer-test';/.test(
					readFileSync(`tests/${name}`, 'utf8')
				)
		),
		[],
		"Import test from './helpers/renderer-test' in these specs."
	);
});
