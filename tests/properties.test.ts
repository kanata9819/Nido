// Property tests: each checks a rule that must hold for every input, against many generated
// inputs (see helpers/property.ts). They run in milliseconds and need no Neovim or Electron.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forAll, forAllAsync, trickyCharacters, type Random } from './helpers/property';
import { splitDiff } from '../src/renderer/src/gitDiff';
import { isAltGraph, vimKey } from '../src/renderer/src/keyboard';
import { editorPath, hostPath, parseWslPath, wslHostPath } from '../src/shared/wsl';
import { accumulateScroll, ScrollQueue, scrollOffset } from '../src/renderer/src/scroll';
import { japanese, translate, translateMessage } from '../src/shared/i18n';
import { fileDecorations, gitFileKey } from '../src/renderer/src/fileDecorations';
import { listIndex } from '../src/renderer/src/listNavigation';
import { navigateSearchList } from '../src/renderer/src/components/workspaceSearchNavigation';
import { getVisibleEntries } from '../src/renderer/src/sidebarTree';
import { stickyRows } from '../src/renderer/src/stickyScroll';
import { emptyNeovimUI, patchNeovimUI, type NeovimUIState } from '../src/shared/neovimUI';
import { explorerFilePath } from '../src/renderer/src/explorerState';
import { searchLineEnding } from '../src/main/searchLines';
import { SearchMatcher } from '../src/main/searchMatcher';
import { defaultSearchOptions } from '../src/shared/search';
import type { FileEntry, StickyScrollState } from '../src/shared/types';

const word = (random: Random): string => random.string(1, 8, 'abcdefghij');
const line = (random: Random): string => random.string(0, 12, trickyCharacters);

// --- Git diff -------------------------------------------------------------------------------

/** A random unified diff, with the old and new texts its hunks describe. */
function unifiedDiff(random: Random): { diff: string; before: string[]; after: string[] } {
	const output = ['diff --git a/f b/f', 'index 1..2 100644', '--- a/f', '+++ b/f'];
	const before: string[] = [];
	const after: string[] = [];
	let oldLine = 1;
	let newLine = 1;
	for (let hunk = random.int(1, 4); hunk > 0; hunk--) {
		oldLine += random.int(0, 5);
		newLine = oldLine + (newLine - oldLine);
		const body: string[] = [];
		let oldCount = 0;
		let newCount = 0;
		for (let index = random.int(1, 12); index > 0; index--) {
			const kind = random.pick([' ', '-', '+'] as const);
			const text = line(random).replaceAll('\r', '');
			body.push(kind + text);
			if (kind !== '+') {
				before.push(text);
				oldCount++;
			}
			if (kind !== '-') {
				after.push(text);
				newCount++;
			}
		}
		output.push(`@@ -${oldLine},${oldCount} +${newLine},${newCount} @@`, ...body);
		if (random.chance(0.2)) {
			output.push('\\ No newline at end of file');
		}
		oldLine += oldCount;
		newLine += newCount;
	}
	return { diff: output.join('\n'), before, after };
}

test('a split diff keeps every old and new line, in order, with consecutive numbers', () => {
	forAll(unifiedDiff, ({ diff, before, after }) => {
		const rows = splitDiff(diff);
		const left = rows.flatMap((row) => (row.before ? [row.before] : []));
		const right = rows.flatMap((row) => (row.after ? [row.after] : []));
		assert.deepEqual(
			left.map((entry) => entry.text),
			before
		);
		assert.deepEqual(
			right.map((entry) => entry.text),
			after
		);
		// Within a hunk, line numbers grow by one on each side.
		let previous: { before?: number; after?: number } = {};
		for (const row of rows) {
			if (row.heading) {
				previous = {};
				continue;
			}
			for (const side of ['before', 'after'] as const) {
				const number = row[side]?.number;
				if (number !== undefined && previous[side] !== undefined) {
					assert.ok(number > previous[side]!, `${side} numbers must increase`);
				}
				if (number !== undefined) {
					previous[side] = number;
				}
			}
		}
		// A row never pairs an unchanged line with a changed one.
		for (const row of rows) {
			if (row.before && row.after) {
				assert.equal(!!row.before.changed, !!row.after.changed);
			}
		}
	});
});

// --- Keyboard -------------------------------------------------------------------------------

const keyNames = [
	'a',
	'Z',
	'<',
	'>',
	' ',
	'1',
	'日',
	'😀',
	'Escape',
	'Enter',
	'Tab',
	'Backspace',
	'ArrowUp',
	'F1',
	'F12',
	'Shift',
	'Control',
	'Alt',
	'Meta',
	'Dead',
	'Process',
	'CapsLock',
	'Convert',
	'Unidentified'
];

function keyEvent(random: Random): Parameters<typeof vimKey>[0] & { altGraph: boolean } {
	const altGraph = random.chance(0.1);
	return {
		key: random.pick(keyNames),
		ctrlKey: random.chance(0.3),
		altKey: random.chance(0.2),
		shiftKey: random.chance(0.3),
		metaKey: random.chance(0.1),
		isComposing: random.chance(0.05),
		altGraph,
		getModifierState: (name: string) => name === 'AltGraph' && altGraph
	};
}

test('every key becomes nothing, one character, or one well-formed <...> notation', () => {
	forAll(keyEvent, (event) => {
		const key = vimKey(event);
		if (event.isComposing || ['Shift', 'Control', 'Alt', 'Meta', 'Dead'].includes(event.key)) {
			assert.equal(key, null);
			return;
		}
		if (key === null) {
			return;
		}
		if (key.startsWith('<')) {
			// Neovim reads <C-<> and <C->> as one key each, so the key itself may be < or >.
			assert.match(key, /^<(?:[CMDS]-)*(?:[^<>]+|<|>)>$/u);
		} else {
			// A plain key is typed as itself and is never a raw <, which Neovim would parse.
			assert.equal([...key].length, 1);
			assert.notEqual(key, '<');
		}
		// AltGr is a character modifier, never Ctrl+Alt.
		if (isAltGraph(event)) {
			assert.ok(!key.includes('C-') && !key.includes('M-'));
		}
	});
});

// --- WSL paths ------------------------------------------------------------------------------

function linuxPath(random: Random): string {
	return '/' + random.array(0, 5, (r) => r.pick(['.', '..', word(r), 'a b', '日本'])).join('/');
}

function normalizedLinux(path: string): string {
	const parts: string[] = [];
	for (const part of path.split('/')) {
		if (part === '..') {
			parts.pop();
		} else if (part && part !== '.') {
			parts.push(part);
		}
	}
	return '/' + parts.join('/');
}

test('a WSL host path parses back to its distribution and resolved Linux path', () => {
	forAll(
		(random) => ({
			distribution: random.pick(['Ubuntu', 'Debian-12', 'arch']),
			path: linuxPath(random)
		}),
		({ distribution, path }) => {
			const host = wslHostPath(distribution, path);
			const parsed = parseWslPath(host);
			assert.ok(parsed);
			assert.equal(parsed.distribution, distribution);
			assert.equal(parsed.path, normalizedLinux(path));
			// hostPath and editorPath convert between the two forms.
			const root = wslHostPath(distribution, '/');
			assert.equal(editorPath(root, host), parsed.path);
			assert.equal(hostPath(root, parsed.path), host);
		}
	);
});

test('paths that are not WSL shares stay as they are', () => {
	forAll(
		(random) =>
			random.pick(['C:\\', '/home/', 'D:/', '\\\\server\\share\\']) +
			linuxPath(random).slice(1),
		(path) => {
			assert.equal(parseWslPath(path), undefined);
			assert.equal(editorPath('C:\\project', path), path);
			assert.equal(hostPath('C:\\project', path), path);
		}
	);
});

// --- Scrolling ------------------------------------------------------------------------------

test('wheel accumulation conserves distance and keeps less than a line in reserve', () => {
	forAll(
		(random) => ({
			lineHeight: random.int(8, 40),
			deltas: random.array(1, 30, (r) => (r.chance(0.5) ? -1 : 1) * r.int(0, 200) * r.next())
		}),
		({ lineHeight, deltas }) => {
			let remainder = 0;
			let total = 0;
			let scrolled = 0;
			for (const delta of deltas) {
				// A change of direction drops the leftover, so track from there.
				if (delta && Math.sign(delta) !== Math.sign(remainder)) {
					total = scrolled * lineHeight;
				}
				const result = accumulateScroll(remainder, delta, 0, lineHeight, 600);
				remainder = result.remainder;
				scrolled += result.lines;
				total += delta;
				assert.ok(Number.isInteger(result.lines));
				assert.ok(Math.abs(remainder) < lineHeight);
				assert.ok(Math.abs(scrolled * lineHeight + remainder - total) < 1e-6);
			}
		}
	);
});

test('an eased scroll starts at its distance and only shrinks towards zero', () => {
	forAll(
		(random) => ({ distance: (random.next() - 0.5) * 2000, duration: random.int(0, 400) }),
		({ distance, duration }) => {
			let previous = Math.abs(scrollOffset(distance, 0, duration));
			assert.ok(
				duration === 0 ? previous === 0 : Math.abs(previous - Math.abs(distance)) < 1e-9
			);
			for (let elapsed = 0; elapsed <= duration + 50; elapsed += 7) {
				const offset = Math.abs(scrollOffset(distance, elapsed, duration));
				assert.ok(offset <= previous + 1e-9);
				previous = offset;
			}
			// -0 and 0 are the same distance.
			assert.ok(scrollOffset(distance, duration, duration) === 0);
		}
	);
});

test('the scroll queue sends exactly the movement it was given, one request at a time', () => {
	forAll(
		(random) =>
			random.array(1, 40, (r) =>
				r.pick([
					{ op: 'enqueue', lines: r.int(-1500, 1500), columns: r.int(-50, 50) },
					{ op: 'start' },
					{ op: 'acknowledge' },
					{ op: 'complete' },
					{ op: 'finish' }
				] as const)
			),
		(operations) => {
			const queue = new ScrollQueue();
			let given = 0;
			let sent = 0;
			// The request in flight, as far as the preview still shows it.
			let inFlight = 0;
			for (const operation of operations) {
				if (operation.op === 'enqueue') {
					queue.enqueue(operation.lines, true, operation.columns);
					given += operation.lines;
				} else if (operation.op === 'start') {
					const pending = queue.pending;
					const command = queue.start();
					if (pending) {
						assert.equal(command, undefined, 'only one request is in flight');
					}
					if (command) {
						assert.ok(Math.abs(command.lines) <= 1000);
						sent += command.lines;
						inFlight = command.lines;
					}
				} else {
					if (operation.op === 'acknowledge') {
						// Once Neovim redrew, the request's movement is no longer previewed.
						inFlight = 0;
					}
					queue[operation.op]();
				}
				// The preview is what was not sent yet plus the unacknowledged request.
				const waiting = queue.preview - (queue.pending ? inFlight : 0);
				assert.equal(sent + waiting, given);
			}
		}
	);
});

// --- Translations ---------------------------------------------------------------------------

test('English messages pass through unchanged, and Japanese keeps every placeholder value', () => {
	const keys = Object.keys(japanese);
	forAll(
		(random) => ({ key: random.pick(keys), value: word(random) }),
		({ key, value }) => {
			const names = [...key.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
			const values = Object.fromEntries(names.map((name) => [name, value]));
			assert.equal(translateMessage('en', key), key);
			const japaneseText = translate('ja', key, values);
			for (const name of names) {
				assert.ok(!japaneseText.includes(`{${name}}`), `{${name}} is filled in`);
			}
			// The Japanese template uses the same placeholders as the English one.
			const japaneseNames = [...japanese[key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
			assert.deepEqual([...new Set(japaneseNames)].sort(), [...new Set(names)].sort());
		}
	);
});

test('translating unknown text, line by line, leaves it as it is', () => {
	forAll(
		(random) => random.array(1, 4, (r) => 'zz ' + line(r)).join('\n'),
		(text) => assert.equal(translateMessage('ja', text), text)
	);
});

// --- Explorer -------------------------------------------------------------------------------

function tree(random: Random): Record<string, FileEntry[]> {
	const entries: Record<string, FileEntry[]> = {};
	const visit = (path: string, depth: number): void => {
		const names = [...new Set(random.array(0, 4, word))];
		entries[path] = names.map((name) => {
			const child = path ? `${path}/${name}` : name;
			const directory = depth < 3 && random.chance(0.4);
			if (directory) {
				visit(child, depth + 1);
			}
			return { name, path: child, directory };
		});
	};
	visit('', 0);
	return entries;
}

test('the explorer shows a folder’s entries only when it and its parents are expanded', () => {
	forAll(
		(random) => {
			const entries = tree(random);
			const folders = Object.keys(entries).filter(Boolean);
			return { entries, expanded: folders.filter(() => random.chance(0.6)) };
		},
		({ entries, expanded }) => {
			const open = new Set(expanded);
			const visible = getVisibleEntries(entries, open);
			const shown = new Set(visible.map((entry) => entry.path));
			for (const entry of visible) {
				const parent = entry.path.includes('/')
					? entry.path.slice(0, entry.path.lastIndexOf('/'))
					: '';
				assert.ok(parent === '' || (open.has(parent) && shown.has(parent)));
				assert.equal(entry.depth, entry.path.split('/').length - 1);
				assert.ok(entry.position >= 1 && entry.position <= entry.siblings);
			}
			assert.equal(shown.size, visible.length, 'no entry appears twice');
		}
	);
});

test('a file inside the workspace gets a safe relative path, anything else an empty one', () => {
	forAll(
		(random) => {
			const root = random.pick(['C:\\Projects\\App', 'C:/Projects/App', '/home/me/app']);
			const parts = random.array(1, 4, (r) => r.pick([word(r), '..', '.', '日本']));
			const separator = root.includes('\\') ? '\\' : '/';
			const inside = random.chance(0.7);
			const file =
				(inside ? root : random.pick(['C:\\Other', '/srv'])) +
				separator +
				parts.join(separator);
			return { root, file };
		},
		({ root, file }) => {
			const relative = explorerFilePath(root, file);
			if (relative) {
				assert.ok(!relative.split(/[\\/]/).some((part) => part === '..' || part === '.'));
				assert.ok(!/^[\\/]|^[a-z]:/i.test(relative));
			}
		}
	);
});

test('file decorations count each problem once in every folder above it', () => {
	forAll(
		(random) => {
			// File names end in .ts, so a file is never also a folder of another file.
			const files = random.array(1, 8, (r) => r.array(1, 3, word).join('/') + '.ts');
			const problems = random.array(0, 15, (r) => ({
				path: 'C:/root/' + r.pick(files),
				line: 1,
				column: 1,
				severity: r.int(1, 4),
				message: 'm',
				source: ''
			}));
			return { problems };
		},
		({ problems }) => {
			const decorations = fileDecorations('C:/root', {}, {}, problems);
			const errors = problems.filter((problem) => problem.severity === 1).length;
			const warnings = problems.filter((problem) => problem.severity === 2).length;
			const root = decorations[gitFileKey('C:/root')];
			assert.equal(root?.errors ?? 0, errors);
			assert.equal(root?.warnings ?? 0, warnings);
		}
	);
});

// --- List navigation ------------------------------------------------------------------------

test('list navigation always lands inside the list', () => {
	const keys = ['j', 'k', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'g', 'G'];
	forAll(
		(random) => ({
			length: random.int(1, 50),
			index: random.int(-3, 60),
			key: random.pick(keys),
			ctrl: random.chance(0.2)
		}),
		({ length, index, key, ctrl }) => {
			const next = listIndex(key, Math.min(index, length - 1), length);
			assert.ok(next >= 0 && next < length);
			// Start from a valid selection; keys the list does not handle leave it there.
			let moved = Math.min(Math.max(index, 0), length - 1);
			navigateSearchList(
				{
					key,
					altKey: false,
					metaKey: false,
					ctrlKey: ctrl,
					preventDefault: () => {}
				} as never,
				length,
				(value) => {
					moved =
						typeof value === 'function'
							? value(Math.min(Math.max(index, 0), length - 1))
							: value;
				}
			);
			assert.ok(moved >= 0 && moved < length);
		}
	);
});

// --- Sticky scroll --------------------------------------------------------------------------

test('sticky headers are nested scopes, at most the line limit, pushed up but never down', () => {
	forAll(
		(random) => {
			const scopes = random
				.array(0, 12, (r) => {
					const line = r.int(1, 200);
					return { line, ending: line + r.int(1, 120) };
				})
				.sort((a, b) => a.line - b.line || b.ending - a.ending);
			const top = random.int(1, 250);
			return { scopes, top, height: random.int(4, 60), maxLines: random.int(1, 10) };
		},
		({ scopes, top, height, maxLines }) => {
			const state: StickyScrollState = {
				window: 1,
				buffer: 1,
				top: 0,
				left: 0,
				width: 80,
				height,
				gutter: 4,
				tabstop: 4,
				leftcol: 0,
				scopes: scopes.map((scope) => ({
					...scope,
					top: scope.line - top,
					bottom: scope.ending - top + 1,
					text: [],
					endText: []
				}))
			};
			const rows = stickyRows(state, (row) => row * 20, 0, 20, maxLines);
			assert.ok(rows.length <= maxLines);
			assert.ok(rows.length <= Math.max(1, Math.floor(height / 4)));
			for (const [index, row] of rows.entries()) {
				assert.ok(row.offset <= 0);
				if (index > 0) {
					const outer = rows[index - 1].scope;
					assert.ok(row.scope.line > outer.line && row.scope.ending <= outer.ending);
				}
			}
		}
	);
});

// --- Neovim UI patches ----------------------------------------------------------------------

test('applying the changed fields of a UI state as a patch reproduces that state', () => {
	const chunks = (random: Random): [number, string][] =>
		random.array(0, 3, (r) => [r.int(0, 5), line(r)] as [number, string]);
	const state = (random: Random): NeovimUIState => ({
		...emptyNeovimUI(),
		showmode: chunks(random),
		messages: random.array(0, 3, (r) => ({
			kind: r.pick(['emsg', '', 'wmsg']),
			content: chunks(r)
		})),
		messageVersion: random.int(0, 5),
		completion: random.chance(0.5)
			? {
					items: random.array(
						0,
						4,
						(r) => [word(r), '', '', ''] as [string, string, string, string]
					),
					selected: random.int(-1, 3)
				}
			: null
	});
	forAll(
		(random) => ({
			before: state(random),
			after: state(random),
			sameItems: random.chance(0.5)
		}),
		({ before, after, sameItems }) => {
			if (sameItems && before.completion && after.completion) {
				after = {
					...after,
					completion: { ...after.completion, items: before.completion.items }
				};
			}
			const patch = Object.fromEntries(
				Object.entries(after).filter(
					([key, value]) => value !== before[key as keyof NeovimUIState]
				)
			) as Record<string, unknown>;
			// The main process leaves out unchanged completion items.
			if (sameItems && before.completion && after.completion) {
				patch.completion = { selected: after.completion.selected };
			}
			assert.deepEqual(patchNeovimUI(before, patch), after);
		}
	);
});

// --- Text search ----------------------------------------------------------------------------

test('every literal search match points at the query, as Neovim counts lines and bytes', async () => {
	await forAllAsync(
		(random) => {
			const query = random.string(1, 3, 'ab日😀');
			const ending = random.pick(['\n', '\r\n', '\r']);
			const lines = random.array(1, 8, (r) =>
				r.string(0, 10, ['a', 'b', 'c', '日', '😀', ' ', '\t'])
			);
			return { query, text: lines.join(ending) + (random.chance(0.5) ? ending : '') };
		},
		async ({ query, text }) => {
			const matcher = new SearchMatcher(query, defaultSearchOptions);
			try {
				const matches = await matcher.find(text);
				const rows = text.split(searchLineEnding(text));
				for (const match of matches) {
					const row = rows[match.line - 1];
					assert.ok(row !== undefined, 'the line exists');
					const bytes = Buffer.from(row);
					const start = match.column - 1;
					assert.equal(
						bytes.subarray(start, start + Buffer.byteLength(query)).toString(),
						query
					);
				}
				// Every line that contains the query has exactly one match.
				const expected = rows.filter(
					(row, index) =>
						row.includes(query) && !(index === rows.length - 1 && row === '')
				);
				assert.equal(matches.length, Math.min(expected.length, 201));
			} finally {
				matcher.close();
			}
		},
		60
	);
});
