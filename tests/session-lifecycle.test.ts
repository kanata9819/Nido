import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Session } from '../src/main/session';
import type { NidoEvent } from '../src/shared/types';
import { SessionFiles } from '../src/main/sessionFiles';

// The neovim package replaces console methods for the process when its logger is created.
const consoleAtStart = { ...console };

async function referenceTo(session: Session, path: string, line = 1): Promise<void> {
	await session.client.request('nvim_exec_lua', [
		`local target, line = ...
local original = vim.lsp.get_clients
vim.lsp.get_clients = function(options)
  if options and options.method == 'textDocument/references' then
    return {{offset_encoding='utf-16', request=function(_, _, _, callback)
      callback(nil, {{uri=vim.uri_from_fname(target), range={start={line=line,character=0}, ['end']={line=line,character=1}}}})
      return true, 1
    end}}
  end
  return original(options)
end
require('nido_references').find()
vim.lsp.get_clients = original`,
		[path, line - 1]
	]);
	await session.client.request('nvim_eval', ['1']);
	assert.equal(session.state.references?.items.length, 1);
}

test('file tabs reorder, reopen in their original positions and retain their cursor', async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'nido-tab-order-')));
	let session: Session | undefined;
	try {
		for (const name of ['first.txt', 'second.txt', 'third.txt']) {
			await writeFile(join(root, name), 'first line\nsecond line\nthird line\n');
		}
		session = await Session.create(root, () => {});
		const buffers: number[] = [];
		for (const name of ['first.txt', 'second.txt', 'third.txt']) {
			await session.openFile(name);
			buffers.push((await session.client.request('nvim_eval', ['bufnr()'])) as number);
		}
		const [first, second, third] = buffers;
		await session.moveBuffer(third, first);
		await session.client.request('nvim_eval', ['1']);
		assert.deepEqual(
			session.state.buffers.map((buffer) => buffer.id),
			[third, first, second]
		);
		assert.deepEqual(
			(await session.snapshot()).files.map((file) => file.path),
			['third.txt', 'first.txt', 'second.txt'].map((name) => join(root, name))
		);
		await assert.rejects(session.moveBuffer(first, 999999), /Invalid target buffer/);
		await assert.rejects(session.moveBuffer(999999, first), /Invalid buffer/);
		await session.selectBuffer(first);
		await session.client.request('nvim_win_set_cursor', [0, [3, 4]]);
		await session.closeBuffer(first);
		await session.reopenBuffer();
		await session.client.request('nvim_eval', ['1']);
		assert.deepEqual(
			session.state.buffers.map((buffer) => buffer.name),
			['third.txt', 'first.txt', 'second.txt'].map((name) => join(root, name))
		);
		assert.deepEqual(await session.client.request('nvim_win_get_cursor', [0]), [3, 4]);
		const reopened = (await session.client.request('nvim_eval', ['bufnr()'])) as number;
		await session.closeBuffer(third);
		await session.closeBuffer(reopened);
		await session.reopenBuffer();
		assert.equal(
			await session.client.request('nvim_buf_get_name', [0]),
			join(root, 'first.txt')
		);
		await session.reopenBuffer();
		assert.equal(
			await session.client.request('nvim_buf_get_name', [0]),
			join(root, 'third.txt')
		);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('reopening tabs preserves live edits, retries missing files and never restores discarded edits', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-reopen-tab-'));
	let session: Session | undefined;
	try {
		const path = join(root, 'notes.txt');
		await writeFile(path, 'saved text\nsecond line\n');
		session = await Session.create(root, () => {});
		await session.openFile('notes.txt');
		let buffer = (await session.client.request('nvim_eval', ['bufnr()'])) as number;
		await session.client.request('nvim_buf_set_lines', [buffer, 0, -1, false, ['discard me']]);
		await assert.rejects(session.closeBuffer(buffer), /unsaved changes/);
		await session.reopenBuffer();
		assert.deepEqual(await session.client.request('nvim_buf_get_lines', [0, 0, -1, false]), [
			'discard me'
		]);
		await session.closeBuffer(buffer, true);
		await rm(path);
		await assert.rejects(session.reopenBuffer(), /File is unavailable/);
		await writeFile(path, 'new disk text\n');
		await session.reopenBuffer();
		assert.deepEqual(await session.client.request('nvim_buf_get_lines', [0, 0, -1, false]), [
			'new disk text'
		]);
		buffer = (await session.client.request('nvim_eval', ['bufnr()'])) as number;
		await session.closeBuffer(buffer);
		await session.openFile('notes.txt');
		const existing = (await session.client.request('nvim_eval', ['bufnr()'])) as number;
		await session.client.request('nvim_buf_set_lines', [
			existing,
			0,
			-1,
			false,
			['keep live edits']
		]);
		await session.reopenBuffer();
		assert.equal(await session.client.request('nvim_eval', ['bufnr()']), existing);
		assert.deepEqual(await session.client.request('nvim_buf_get_lines', [0, 0, -1, false]), [
			'keep live edits'
		]);
		assert.equal((await session.snapshot()).files.length, 1);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('literal file names open, reopen and restore without selecting a pattern match', async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'nido-literal-buffer-')));
	const name = 'file[1].txt';
	let session: Session | undefined;
	let restored: Session | undefined;
	try {
		await writeFile(join(root, name), 'literal first\nliteral second\n');
		await writeFile(join(root, 'file1.txt'), 'other first\nother second\n');
		session = await Session.create(root, () => {});
		await session.openFile('file1.txt');
		await session.client.request('nvim_buf_set_lines', [0, 0, -1, false, ['keep this draft']]);
		await session.openFile(name, 2, 3);
		assert.equal(await session.client.request('nvim_buf_get_name', [0]), join(root, name));
		assert.equal(await session.client.request('nvim_get_current_line', []), 'literal second');
		await session.client.request('nvim_buf_set_lines', [0, 1, 2, false, ['literal edit']]);
		await session.openFile(name, 2, 3);
		assert.equal(await session.client.request('nvim_get_current_line', []), 'literal edit');
		await session.save();
		const buffer = (await session.client.request('nvim_eval', ['bufnr()'])) as number;
		await session.closeBuffer(buffer);
		await session.reopenBuffer();
		assert.equal(await session.client.request('nvim_buf_get_name', [0]), join(root, name));
		assert.deepEqual(await session.client.request('nvim_win_get_cursor', [0]), [2, 2]);
		const snapshot = await session.snapshot();
		restored = await Session.create(root, () => {});
		assert.deepEqual(await restored.restore(snapshot), []);
		assert.equal(await restored.client.request('nvim_buf_get_name', [0]), join(root, name));
		await session.openFile('file1.txt');
		assert.equal(await session.client.request('nvim_get_current_line', []), 'keep this draft');
		assert.equal(
			await readFile(join(root, 'file1.txt'), 'utf8'),
			'other first\nother second\n'
		);
	} finally {
		await Promise.all([session?.stop(), restored?.stop()]);
		await rm(root, { recursive: true, force: true });
	}
});

for (const navigation of ['selectBuffer', 'openFile', 'openReference', 'openProblem'] as const) {
	test(`${navigation} cannot redirect pending input or line-ending changes into another file`, async () => {
		const root = await mkdtemp(join(tmpdir(), 'nido-tab-input-order-'));
		let session: Session | undefined;
		let release!: (text: string) => void;
		const contents = new Promise<string>((resolve) => {
			release = resolve;
		});
		let entered!: () => void;
		const reading = new Promise<void>((resolve) => {
			entered = resolve;
		});
		try {
			await writeFile(join(root, 'first.txt'), 'first\n');
			await writeFile(join(root, 'second.txt'), 'second\n');
			session = await Session.create(root, () => {});
			await session.openFile('second.txt');
			const second = (await session.client.request('nvim_get_current_buf', [])) as number;
			if (navigation === 'openProblem') {
				await session.client.request('nvim_exec_lua', [
					"vim.diagnostic.set(vim.api.nvim_create_namespace('navigation-fixture'), 0, {{lnum=0,col=0,severity=1,message='Fixture diagnostic'}})",
					[]
				]);
				await session.client.request('nvim_eval', ['1']);
			}
			await session.openFile('first.txt');
			if (navigation === 'openReference') {
				await referenceTo(session, join(root, 'second.txt'));
			}
			await session.input('i');
			await session.inputMode();
			const pasting = session.paste(() => {
				entered();
				return contents;
			});
			await reading;
			const switching =
				navigation === 'selectBuffer'
					? session.selectBuffer(second)
					: navigation === 'openFile'
						? session.openFile('second.txt')
						: navigation === 'openReference'
							? session.openReference(1, session.state.references!.version)
							: session.openProblem(1, session.state.diagnosticsVersion!);
			const converting = session.setLineEnding('CRLF');
			await session.client.request('nvim_eval', ['1']);
			release('日本語<clipboard>');
			await Promise.all([pasting, switching, converting]);
			await session.input('<Esc>');
			await session.saveAll();
			assert.equal(
				await readFile(join(root, 'first.txt'), 'utf8'),
				'日本語<clipboard>first\n'
			);
			assert.equal(await readFile(join(root, 'second.txt'), 'utf8'), 'second\r\n');
			await assert.rejects(session.selectBuffer(1000000), /Invalid buffer/);
			await session.input('A!<Esc>');
			await session.save();
			assert.equal(await readFile(join(root, 'second.txt'), 'utf8'), 'second!\r\n');
		} finally {
			release('');
			await session?.stop();
			await rm(root, { recursive: true, force: true });
		}
	});
}

for (const inspection of ['modified', 'bufferModified', 'closeBuffer', 'fileAction'] as const) {
	test(`${inspection} accounts for input already waiting on the clipboard`, async () => {
		const root = await mkdtemp(join(tmpdir(), 'nido-close-input-order-'));
		let session: Session | undefined;
		let release!: (text: string) => void;
		const contents = new Promise<string>((resolve) => {
			release = resolve;
		});
		let entered!: () => void;
		const reading = new Promise<void>((resolve) => {
			entered = resolve;
		});
		try {
			await writeFile(join(root, 'first.txt'), 'first\n');
			session = await Session.create(root, () => {});
			await session.openFile('first.txt');
			const buffer = (await session.client.request('nvim_get_current_buf', [])) as number;
			const pasting = session.paste(() => {
				entered();
				return contents;
			});
			await reading;
			const checking =
				inspection === 'closeBuffer'
					? assert.rejects(session.closeBuffer(buffer), /modified|changes/i)
					: inspection === 'fileAction'
						? assert.rejects(
								session.fileAction('delete', 'first.txt', '', (file) =>
									rename(file, join(root, 'trashed.txt'))
								),
								/unsaved changes/i
							)
						: inspection === 'modified'
							? session.modified()
							: session.bufferModified(buffer);
			void checking.catch(() => {});
			await new Promise((resolve) => setTimeout(resolve, 80));
			await session.client.request('nvim_eval', ['1']);
			release('日本語<clipboard>');
			await pasting;
			const result = await checking;
			if (inspection === 'modified' || inspection === 'bufferModified')
				assert.equal(result, true);
			assert.equal(
				await session.client.request('nvim_get_option_value', [
					'modified',
					{ buf: buffer }
				]),
				true
			);
			assert.equal(await readFile(join(root, 'first.txt'), 'utf8'), 'first\n');
			await session.save();
			assert.match(await readFile(join(root, 'first.txt'), 'utf8'), /日本語<clipboard>/);
		} finally {
			release('');
			await session?.stop();
			await rm(root, { recursive: true, force: true });
		}
	});
}

test('reopening the active edited file preserves its draft, cursor and undo history', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-reopen-draft-'));
	let session: Session | undefined;
	try {
		await writeFile(join(root, 'first.txt'), 'first\n');
		session = await Session.create(root, () => {});
		await session.openFile('first.txt');
		await session.input('A draft<Esc>');
		await session.inputMode();
		const cursor = await session.client.request('nvim_win_get_cursor', [0]);
		await session.openFile('first.txt');
		assert.equal(await session.client.request('nvim_get_current_line', []), 'first draft');
		assert.deepEqual(await session.client.request('nvim_win_get_cursor', [0]), cursor);
		assert.equal(await session.modified(), true);
		await session.input('u');
		await session.save();
		assert.equal(await readFile(join(root, 'first.txt'), 'utf8'), 'first\n');
		await writeFile(join(root, 'first.txt'), 'changed outside Nido\n');
		await session.openFile('first.txt');
		assert.equal(
			await session.client.request('nvim_get_current_line', []),
			'changed outside Nido'
		);
		assert.equal(await session.modified(), false);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('reference jumps retain their target after detached touchpad scrolling', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-reference-scroll-'));
	let session: Session | undefined;
	try {
		const source =
			Array.from({ length: 150 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
		await writeFile(join(root, 'first.txt'), source);
		session = await Session.create(root, () => {});
		await session.attach(80, 25);
		await session.openFile('first.txt');
		await referenceTo(session, join(root, 'first.txt'), 80);
		await session.input('10G0');
		await session.inputMode();
		await session.scroll(15.5, false, true);
		await session.openReference(1, session.state.references!.version);
		assert.deepEqual(await session.client.request('nvim_win_get_cursor', [0]), [80, 0]);
		await session.input('ix<Esc>');
		await session.save();
		assert.equal(
			await readFile(join(root, 'first.txt'), 'utf8'),
			source.replace('line 80\n', 'xline 80\n')
		);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test(
	'pending Vim commands cannot trap tab operations or the following Escape key',
	{ timeout: 15000 },
	async () => {
		const root = await mkdtemp(join(tmpdir(), 'nido-pending-editor-command-'));
		let session: Session | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await writeFile(join(root, 'first.txt'), 'first\n');
			session = await Session.create(root, () => {});
			await session.openFile('first.txt');
			const current = session;
			const buffer = (await current.client.request('nvim_exec_lua', [
				'return vim.api.nvim_get_current_buf()',
				[]
			])) as number;
			const operations = [
				() => current.selectBuffer(buffer),
				() => current.openFile('first.txt'),
				() => current.modified(),
				() => current.bufferModified(buffer),
				() => current.closeBuffer(buffer),
				() => current.setLineEnding('CRLF'),
				() => current.openReference(1, 1),
				() => current.openProblem(1, 1),
				() => current.openSymbol(1, 1)
			];
			for (const keys of ['r', 'f', 'g']) {
				for (const operation of operations) {
					const input = current.input(keys);
					const rejected = assert.rejects(
						operation(),
						/Finish the current Neovim command/
					);
					const escaping = current.input('<Esc>');
					await Promise.race([
						Promise.all([input, rejected, escaping]),
						new Promise<never>((_, reject) => {
							timer = setTimeout(
								() =>
									reject(
										new Error('A pending Vim command trapped editor input.')
									),
								2000
							);
						})
					]);
					clearTimeout(timer);
					assert.equal(await current.inputMode(), 'n');
				}
			}
			await current.input('R');
			await current.selectBuffer(buffer);
			await current.input('<Esc>');
			assert.equal(await current.modified(), false);
		} finally {
			clearTimeout(timer);
			await session?.client.request('nvim_input', ['<Esc>']).catch(() => {});
			await session?.stop();
			await rm(root, { recursive: true, force: true });
		}
	}
);

test('closing a workspace cancels in-flight filesystem searches', { timeout: 15000 }, async () => {
	const session = await Session.create(process.cwd(), () => {});
	const files = SessionFiles.prototype.files;
	let release!: () => void;
	let entered!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	try {
		SessionFiles.prototype.files = async () => {
			entered();
			await gate;
			return [{ name: 'late.txt', path: 'late.txt', directory: false }];
		};
		const searching = session.findFiles('late');
		await started;
		await session.stop();
		release();
		assert.deepEqual(await searching, []);
	} finally {
		release();
		SessionFiles.prototype.files = files;
		await session.stop();
	}
});

test(
	'closing during terminal creation waits for child cleanup and rejects later opens',
	{ timeout: 15000 },
	async () => {
		const session = await Session.create(process.cwd(), () => {});
		const originalCreate = Session.create;
		let child: Session | undefined;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			Session.create = async (...args) => {
				child = await originalCreate(...args);
				await gate;
				return child;
			};
			const opening = assert.rejects(session.openTerminal('auto'), /Workspace was closed/);
			for (let i = 0; !child && i < 100; i++)
				await new Promise((resolve) => setTimeout(resolve, 10));
			assert.ok(child);
			let childClosed = false;
			child.process.once('close', () => {
				childClosed = true;
			});
			const stopping = session.stop();
			release();
			await Promise.all([opening, stopping]);
			assert.equal(childClosed, true);
			await assert.rejects(session.openTerminal('auto'), /Workspace was closed/);
		} finally {
			release();
			Session.create = originalCreate;
			await session.stop();
			await child?.stop();
		}
	}
);

test(
	'unexpected Neovim exit rejects pending and subsequent requests',
	{ timeout: 15000 },
	async () => {
		const session = await Session.create(process.cwd(), () => {});
		try {
			const pending = assert.rejects(
				session.client.request('nvim_exec_lua', ['vim.wait(10000)', []]),
				/session is closed/
			);
			await new Promise<void>((resolve) => setImmediate(resolve));
			const closed = once(session.process, 'close');
			session.process.kill();
			await closed;
			await pending;
			await assert.rejects(session.client.request('nvim_eval', ['1']), /session is closed/);
			await assert.rejects(session.input('ihello'), /session is closed/);
			await assert.rejects(session.setClipboardSharing(true), /session is closed/);
		} finally {
			await session.stop();
		}
	}
);

test(
	'starting a workspace leaves the console of the process in place',
	{ timeout: 15000 },
	async () => {
		const session = await Session.create(process.cwd(), () => {});
		try {
			// Handles such as this buffer are decoded with the package's default logger.
			await session.client.request('nvim_get_current_buf', []);
			assert.deepEqual({ ...console }, consoleAtStart);
		} finally {
			await session.stop();
		}
	}
);

test('an unexpected Neovim exit reports why the workspace closed', { timeout: 15000 }, async () => {
	const events: NidoEvent[] = [];
	const session = await Session.create(process.cwd(), (event) => events.push(event));
	try {
		const closed = once(session.process, 'close');
		session.process.kill();
		await closed;
		const errors = events.filter((event) => event.type === 'error');
		assert.equal(errors.length, 1);
		assert.match(errors[0].message, /stopped unexpectedly/);
		assert.ok(events.some((event) => event.type === 'exit'));
	} finally {
		await session.stop();
	}
});

test('quitting Neovim and stopping a workspace report no error', { timeout: 15000 }, async () => {
	const quitEvents: NidoEvent[] = [];
	const quit = await Session.create(process.cwd(), (event) => quitEvents.push(event));
	const stopEvents: NidoEvent[] = [];
	const stopped = await Session.create(process.cwd(), (event) => stopEvents.push(event));
	try {
		const closed = once(quit.process, 'close');
		void quit.client.request('nvim_command', ['qa!']).catch(() => {});
		await closed;
		await stopped.stop();
		assert.deepEqual(
			quitEvents.filter((event) => event.type === 'error'),
			[]
		);
		assert.deepEqual(
			stopEvents.filter((event) => event.type === 'error'),
			[]
		);
	} finally {
		await quit.stop();
		await stopped.stop();
	}
});

test(
	'a broken RPC writer reports once without an uncaught error or hung request',
	{ timeout: 15000 },
	async () => {
		const events: NidoEvent[] = [];
		const session = await Session.create(process.cwd(), (event) => events.push(event));
		try {
			const pending = assert.rejects(
				session.client.request('nvim_exec_lua', ['vim.wait(10000)', []]),
				/EPIPE/
			);
			await new Promise<void>((resolve) => setImmediate(resolve));
			const closed = once(session.process, 'close');
			// Deliver the same asynchronous stream error raised by a write to a broken pipe.
			session.process.stdin.destroy(
				Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
			);
			await pending;
			await closed;
			const errors = events.filter((event) => event.type === 'error');
			assert.equal(errors.length, 1);
			assert.match(errors[0].message, /Neovim connection closed: write EPIPE/);
			await assert.rejects(session.client.request('nvim_eval', ['1']), /EPIPE/);
		} finally {
			await session.stop();
		}
	}
);

test(
	'overlapping shutdowns share completion and cancel queued work',
	{ timeout: 15000 },
	async () => {
		const session = await Session.create(process.cwd(), () => {});
		let closed = false;
		session.process.once('close', () => {
			closed = true;
		});
		try {
			const queued = assert.rejects(session.input('iignored'), /session is closed/);
			const first = session.stop();
			assert.equal(session.stop(), first);
			await Promise.all([first, queued]);
			assert.equal(closed, true);
			await assert.rejects(session.client.request('nvim_eval', ['1']), /session is closed/);
		} finally {
			await session.stop();
		}
	}
);

test('prestarted workspace events wait for the renderer and keep their order', async () => {
	const { bufferedEmitter } = await import('../src/main/workspaceHandlers');
	const delivered: string[] = [];
	const events = bufferedEmitter((event) => delivered.push(event.type));
	events.emit({ type: 'notification', id: 'a', title: '', message: 'first', severity: 'info' });
	events.emit({ type: 'exit', id: 'a' });
	assert.deepEqual(delivered, []);
	events.release();
	assert.deepEqual(delivered, ['notification', 'exit']);
	events.emit({ type: 'exit', id: 'b' });
	events.release();
	assert.deepEqual(delivered, ['notification', 'exit', 'exit']);
});

test('only background editors without shells or untitled drafts start asleep', async () => {
	const { startsAsleep } = await import('../src/main/workspaceHandlers');
	const editor = { root: '/project', files: [], current: '' };
	assert.equal(startsAsleep(editor, 1, 0), true);
	assert.equal(startsAsleep(editor, 0, 0), false, 'The selected workspace starts');
	assert.equal(startsAsleep({ ...editor, kind: 'terminal' }, 1, 0), false);
	assert.equal(startsAsleep({ ...editor, terminal: true }, 1, 0), false);
	assert.equal(
		startsAsleep(
			{
				...editor,
				untitled: [
					{ lines: ['draft'], endOfLine: true, fileformat: 'unix', line: 1, column: 0 }
				]
			},
			1,
			0
		),
		false
	);
});

test(
	'a workspace sleeps only when stopping it loses nothing, and wakes under its ID',
	{ timeout: 30000 },
	async () => {
		const root = await mkdtemp(join(tmpdir(), 'nido-sleep-'));
		await writeFile(join(root, 'a.txt'), 'first\nsecond\n');
		let session = await Session.create(root, () => {});
		try {
			await session.openFile('a.txt', 2, 3);
			assert.equal(await session.canSleep(), true);
			await session.input('ix');
			await session.inputMode();
			assert.equal(await session.canSleep(), false, 'Insert mode is still editing');
			await session.input('<Esc>');
			assert.equal(await session.canSleep(), false, 'Unsaved edits need the running Neovim');
			await session.input('u');
			await session.inputMode();
			assert.equal(await session.canSleep(), true);
			const saved = await session.snapshot({ includeUntitled: true });
			const id = session.workspace.id;
			await session.stop();
			session = await Session.create(root, () => {}, undefined, undefined, id);
			assert.equal(session.workspace.id, id);
			assert.deepEqual(await session.restore(saved), []);
			assert.deepEqual(
				await session.client.request('nvim_exec_lua', [
					"return {vim.fn.expand('%:t'), vim.fn.line('.')}",
					[]
				]),
				['a.txt', 2]
			);
		} finally {
			await session.stop();
			await rm(root, { recursive: true, force: true });
		}
	}
);
