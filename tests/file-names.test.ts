import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

test('no two tracked files differ only in letter case', () => {
	// Windows and macOS file systems ignore case, so Foo.tsx and foo.ts in one folder collide:
	// TypeScript resolves an import of './foo' to either file and fails with TS1149 on Windows,
	// while Linux, which is case-sensitive, does not notice. Extensions are compared without,
	// since './GitDiff' and './gitDiff' resolve to .ts and .tsx alike.
	const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
		.split('\0')
		.filter(Boolean);
	const stem = (file: string): string => file.replace(/\.(d\.ts|tsx?|mts|cts|jsx?|mjs|cjs)$/, '');
	const byName = new Map<string, string[]>();
	for (const file of files) {
		const key = stem(file).toLowerCase();
		byName.set(key, [...(byName.get(key) ?? []), file]);
	}
	// index.ts beside index.d.ts is fine; GitDiff.tsx beside gitDiff.ts is not.
	const collisions = [...byName.values()].filter((names) => new Set(names.map(stem)).size > 1);
	assert.deepEqual(collisions, [], 'Rename one file of each pair.');
});
