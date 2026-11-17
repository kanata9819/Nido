import assert from 'node:assert/strict';
import { test } from 'node:test';
import { headingSlug, resolveMarkdownLink } from '../src/renderer/src/panels/markdownLinks';

test('Markdown preview links resolve to web pages, headings or workspace files', () => {
	const root = 'C:\\work\\nido';
	const doc = 'C:\\work\\nido\\docs\\guide.md';
	assert.deepEqual(resolveMarkdownLink('https://example.com/a', doc, root), {
		kind: 'web',
		url: 'https://example.com/a'
	});
	assert.deepEqual(resolveMarkdownLink('#Getting%20started', doc, root), {
		kind: 'heading',
		id: 'getting started'
	});
	assert.deepEqual(resolveMarkdownLink('setup.md', doc, root), {
		kind: 'file',
		path: 'docs/setup.md'
	});
	assert.deepEqual(resolveMarkdownLink('../src/main.ts#L12', doc, root), {
		kind: 'file',
		path: 'docs/../src/main.ts',
		line: 12
	});
	assert.deepEqual(resolveMarkdownLink('my%20notes.md#usage', doc, root), {
		kind: 'file',
		path: 'docs/my notes.md'
	});
	// A WSL document and a document at the workspace root.
	assert.deepEqual(
		resolveMarkdownLink(
			'./b.md',
			'\\\\wsl.localhost\\Ubuntu\\home\\me\\p\\README.md',
			'\\\\wsl.localhost\\Ubuntu\\home\\me\\p'
		),
		{ kind: 'file', path: './b.md' }
	);
	for (const href of [
		'mailto:me@example.com',
		'javascript:alert(1)',
		'file:///etc/passwd',
		'/etc/passwd',
		'\\\\server\\share'
	]) {
		assert.deepEqual(resolveMarkdownLink(href, doc, root), { kind: 'none' }, href);
	}
	// A document outside the workspace follows no file links.
	assert.deepEqual(resolveMarkdownLink('a.md', 'D:\\other\\a.md', root), { kind: 'none' });
});

test('heading ids follow GitHub: lower case, hyphens for spaces, punctuation dropped', () => {
	assert.equal(headingSlug('Getting Started!'), 'getting-started');
	assert.equal(headingSlug('API: v2.0'), 'api-v20');
	assert.equal(headingSlug('はじめに 使い方'), 'はじめに-使い方');
	assert.equal(headingSlug('snake_case and-dash'), 'snake_case-and-dash');
});
