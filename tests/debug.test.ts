import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/main/session';

test(
    'Rust runnable lenses execute main, individual tests and modules using keyboard bindings',
    { timeout: 90000 },
    async () => {
        const root = await mkdtemp(join(tmpdir(), 'nido-runnables-'));
        let session: Session | undefined;
        const notices: string[] = [];
        try {
            await mkdir(join(root, 'src'));
            await writeFile(
                join(root, 'Cargo.toml'),
                '[package]\nname="nido_runnable_test"\nversion="0.1.0"\nedition="2021"\n'
            );
            await writeFile(
                join(root, 'src/main.rs'),
                [
                    'fn main() {',
                    '    println!("main-ran");',
                    '}',
                    '#[cfg(test)]',
                    'mod tests {',
                    '    #[test]',
                    '    fn first() {',
                    '        let value = 42;',
                    '        println!("first-ran={value}");',
                    '    }',
                    '    #[test]',
                    '    fn second() { println!("second-ran"); }',
                    '}',
                    ''
                ].join('\n')
            );
            session = await Session.create(root, (event) => {
                if (event.type === 'notification' || event.type === 'error')
                    notices.push(event.message);
            });
            await session.openFile('src/main.rs');
            const lua = (code: string): Promise<unknown> =>
                session!.client.request('nvim_exec_lua', [code, []]);
            const wait = async (condition: () => boolean | Promise<boolean>): Promise<void> => {
                for (let i = 0; i < 300; i++) {
                    if (await condition()) return;
                    if (session!.state.debug?.status === 'error')
                        throw new Error(session!.state.debug.output);
                    await new Promise((resolve) => setTimeout(resolve, 100));
                }
                throw new Error(JSON.stringify({ debug: session!.state.debug, notices }));
            };
            await wait(
                async () =>
                    Number(
                        await lua(
                            "return #vim.api.nvim_buf_get_extmarks(0, vim.api.nvim_create_namespace('nido_runnables'), 0, -1, {})"
                        )
                    ) >= 4
            );
            const run = async (line: number): Promise<void> => {
                const previous = session!.state.debug;
                await session!.input(`${line}GgR`);
                await wait(
                    () =>
                        session!.state.debug !== previous &&
                        session!.state.debug?.status === 'finished'
                );
            };
            await run(2);
            assert.match(session.state.debug!.output, /main-ran/);
            await run(8);
            assert.match(session.state.debug!.output, /first-ran=42/);
            assert.doesNotMatch(session.state.debug!.output, /second-ran/);
            await run(5);
            assert.match(session.state.debug!.output, /first-ran=42/);
            assert.match(session.state.debug!.output, /second-ran/);
            await session.input('9G');
            await wait(async () => (await lua('return vim.api.nvim_win_get_cursor(0)[1]')) === 9);
            await session.debug('breakpoint');
            await session.input('gD');
            await wait(
                () => session!.state.debug?.status === 'paused' && !!session!.state.debug.location
            );
            assert.match(session.state.debug!.location!, /main.rs:9$/);
            // println! can resolve to several breakpoint locations on the same source line.
            await session.debug('breakpoint');
            await session.debug('start');
            await wait(() => session!.state.debug?.status === 'finished');
            await wait(() => /first-ran=42/.test(session!.state.debug?.terminal || ''));
            assert.doesNotMatch(session.state.debug!.terminal || '', /second-ran/);
            await lua("vim.api.nvim_buf_set_lines(0, 0, -1, false, {'fn main() {}'})");
            await session.input('gggR');
            await wait(() => notices.some((message) => /Save modified files/.test(message)));
        } finally {
            await session?.stop();
            await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
    }
);

test(
    'CodeLLDB builds Rust, stops at a breakpoint, steps and reports variables',
    { timeout: 90000 },
    async () => {
        const root = await mkdtemp(join(tmpdir(), 'nido-debug-'));
        let session: Session | undefined;
        try {
            await mkdir(join(root, 'src'));
            await writeFile(
                join(root, 'Cargo.toml'),
                '[package]\nname="nido_debug_test"\nversion="0.1.0"\nedition="2021"\n'
            );
            await writeFile(
                join(root, 'src/main.rs'),
                'fn double(x: i32) -> i32 {\n    x * 2\n}\nfn main() {\n    let number = 21;\n    let answer = double(number);\n    println!("answer={answer}");\n}\n'
            );
            session = await Session.create(root, () => {});
            await session.openFile('src/main.rs');
            await session.client.request('nvim_win_set_cursor', [0, [6, 4]]);
            await session.debug('breakpoint');
            const wait = async (condition: () => boolean): Promise<void> => {
                for (let i = 0; i < 300; i++) {
                    if (condition()) return;
                    if (session!.state.debug?.status === 'error')
                        throw new Error(session!.state.debug.output);
                    await new Promise((resolve) => setTimeout(resolve, 100));
                }
                throw new Error(JSON.stringify(session!.state.debug));
            };
            await session.debug('start');
            await wait(
                () =>
                    session!.state.debug?.status === 'paused' &&
                    !!session!.state.debug?.variables.length
            );
            assert.match(session.state.debug!.location!, /main.rs:6$/);
            assert.ok(
                session.state.debug!.variables.some((v) => v.name === 'number' && v.value === '21')
            );
            await session.debug('into');
            await wait(() => /main.rs:2$/.test(session!.state.debug?.location || ''));
            await session.debug('out');
            await wait(() => /main.rs:[67]$/.test(session!.state.debug?.location || ''));
            await session.debug('over');
            await wait(
                () =>
                    session!.state.debug?.variables.some(
                        (v) => v.name === 'answer' && v.value === '42'
                    ) || false
            );
            await session.debug('start');
            await wait(() => session!.state.debug?.status === 'finished');
            await wait(() => /answer=42/.test(session!.state.debug?.terminal || ''));
            assert.equal(
                await session.modified(),
                false,
                'debug output is not an unsaved source file'
            );
            await session.debug('start');
            await wait(() => session!.state.debug?.status === 'paused');
            await session.debug('stop');
            for (let i = 0; i < 100; i++) {
                if (
                    await session.client.request('nvim_exec_lua', [
                        "return require('dap').session() == nil",
                        []
                    ])
                )
                    break;
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            assert.equal(
                await session.client.request('nvim_exec_lua', [
                    "return require('dap').session() == nil",
                    []
                ]),
                true
            );
            await session.client.request('nvim_exec_lua', [
                "vim.api.nvim_buf_set_lines(0, 0, -1, false, {'not valid rust'})",
                []
            ]);
            await assert.rejects(session.debug('start'), /Save modified files/);
            await session.save();
            await session.debug('start');
            for (let i = 0; i < 100 && session.state.debug?.status !== 'error'; i++)
                await new Promise((resolve) => setTimeout(resolve, 50));
            assert.equal(session.state.debug?.status, 'error');
            assert.match(session.state.debug!.output, /Cargo build failed/);
        } finally {
            await session?.stop();
            await rm(root, { recursive: true, force: true });
        }
    }
);
