import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Session } from '../src/main/session';
import { SessionEvents } from '../src/main/sessionEvents';
import { applyNeovimUI, emptyNeovimUI, splitCommandContent } from '../src/shared/neovimUI';
import type { NidoEvent } from '../src/shared/types';

test('external messages preserve chunks, replace only the last entry and clear independently', () => {
    let state = emptyNeovimUI();
    state = applyNeovimUI(state, 'msg_show', [
        'echo',
        [
            [1, 'hello'],
            [2, '日本語\n  😀']
        ],
        false,
        true
    ]);
    state = applyNeovimUI(state, 'msg_show', ['emsg', [[3, 'old error']], false]);
    state = applyNeovimUI(state, 'msg_show', ['unknown-future-kind', [[4, 'new error']], true]);
    assert.deepEqual(state.messages, [
        {
            kind: 'echo',
            content: [
                [1, 'hello'],
                [2, '日本語\n  😀']
            ]
        },
        { kind: 'unknown-future-kind', content: [[4, 'new error']] }
    ]);
    state = applyNeovimUI(state, 'msg_showmode', [[[0, 'recording @a']]]);
    state = applyNeovimUI(state, 'msg_showcmd', [[[0, '3d']]]);
    state = applyNeovimUI(state, 'msg_ruler', [[[0, '42,1']]]);
    state = applyNeovimUI(state, 'msg_clear', []);
    assert.equal(state.messages.length, 0);
    assert.deepEqual(state.showmode, [[0, 'recording @a']]);
    assert.deepEqual(state.showcmd, [[0, '3d']]);
    assert.deepEqual(state.ruler, [[0, '42,1']]);
    assert.equal(state.messageVersion, 4);
    assert.deepEqual(applyNeovimUI(state, 'msg_showmode', [{}]).showmode, []);
});

test('nested command lines retain parent text, byte cursor and literal-input state', () => {
    let state = emptyNeovimUI();
    state = applyNeovimUI(state, 'cmdline_show', [[[0, 'echo ']], 5, ':', '', 0, 1, 4]);
    state = applyNeovimUI(state, 'cmdline_show', [
        [[3, '日本😀']],
        10,
        '=',
        'Expression: ',
        2,
        2,
        5
    ]);
    const messageVersion = state.messageVersion;
    state = applyNeovimUI(state, 'cmdline_pos', [3, 2]);
    state = applyNeovimUI(state, 'cmdline_special_char', ['^', true, 2]);
    assert.equal(state.commands[2].position, 3);
    assert.deepEqual(state.commands[2].special, { text: '^', shift: true });
    assert.equal(state.commands[2].highlight, 5);
    state = applyNeovimUI(state, 'cmdline_hide', [2, false]);
    assert.deepEqual(Object.keys(state.commands), ['1']);
    state = applyNeovimUI(state, 'cmdline_show', [[[0, 'echo 2']], 6, ':', '', 0, 1]);
    assert.equal(state.commands[1].special, undefined);
    assert.equal(state.messageVersion, messageVersion);
    assert.deepEqual(applyNeovimUI(state, 'cmdline_hide', [1, true]).commands, {});
});

test('command blocks, completion and history remain independent of regular messages', () => {
    let state = emptyNeovimUI();
    state = applyNeovimUI(state, 'cmdline_block_show', [[[[1, 'function Foo()']]]]);
    state = applyNeovimUI(state, 'cmdline_block_append', [[[2, '  echo "ok"']]]);
    assert.deepEqual(state.block, [[[1, 'function Foo()']], [[2, '  echo "ok"']]]);
    state = applyNeovimUI(state, 'popupmenu_show', [[['echo', '', '', '']], 0, 0, 1, -1]);
    assert.equal(state.completion?.items[0][0], 'echo');
    state = applyNeovimUI(state, 'popupmenu_select', [-1]);
    assert.equal(state.completion?.selected, -1);
    state = applyNeovimUI(state, 'popupmenu_hide', []);
    assert.equal(state.completion, null);
    assert.equal(applyNeovimUI(state, 'popupmenu_show', [[], 0, 0, 0, 1]), state);
    state = applyNeovimUI(state, 'msg_history_show', [[['echomsg', [[4, 'history']]]]]);
    state = applyNeovimUI(state, 'msg_clear', []);
    assert.deepEqual(state.history, [{ kind: 'echomsg', content: [[4, 'history']] }]);
    assert.deepEqual(applyNeovimUI(state, 'cmdline_block_hide', []).block, []);
    assert.equal(applyNeovimUI(state, 'msg_history_clear', []).history, null);
});

test('UTF-8 positions split Japanese and emoji across highlight chunks without broken characters', () => {
    assert.deepEqual(
        splitCommandContent(
            [
                [1, 'a日'],
                [2, '本😀z']
            ],
            4
        ),
        {
            before: [[1, 'a日']],
            cursor: [[2, '本']],
            after: [[2, '😀z']]
        }
    );
    assert.deepEqual(
        splitCommandContent(
            [
                [1, 'a日'],
                [2, '本😀z']
            ],
            7
        ),
        {
            before: [
                [1, 'a日'],
                [2, '本']
            ],
            cursor: [[2, '😀']],
            after: [[2, 'z']]
        }
    );
    assert.deepEqual(splitCommandContent([[1, '😀']], 4), {
        before: [[1, '😀']],
        cursor: [],
        after: []
    });
});

test('external UI is published only with complete grid frames and replayed on reattachment', () => {
    const sent: NidoEvent[] = [];
    const events = new SessionEvents('alpha', (event) => sent.push(event));
    events.receiveNotification('redraw', [['cmdline_show', [[[0, 'echo']], 4, ':', '', 0, 1]]]);
    assert.equal(sent.length, 0);
    events.receiveNotification('redraw', [['flush', []]]);
    assert.deepEqual(
        sent.map((event) => event.type),
        ['redraw', 'neovimUI']
    );
    const ui = sent[1];
    assert.equal(ui.type, 'neovimUI');
    if (ui.type === 'neovimUI') assert.equal(ui.state.commands[1].position, 4);
    events.beginScrollBatch();
    events.receiveNotification('redraw', [
        ['msg_show', ['echo', [[0, 'batched']], false]],
        ['flush', []]
    ]);
    assert.equal(sent.length, 2);
    events.endScrollBatch();
    assert.deepEqual(
        sent.slice(2).map((event) => event.type),
        ['redraw', 'neovimUI']
    );
    events.replayUI();
    assert.deepEqual(sent.at(-1), sent.at(-2));
});

test(
    'bundled Neovim externalizes command editing, completion, errors, prompts and history',
    { timeout: 20000 },
    async () => {
        let latest = emptyNeovimUI();
        const grids: string[] = [];
        const session = await Session.create(process.cwd(), (event) => {
            if (event.type === 'neovimUI') latest = event.state;
            if (event.type === 'redraw') {
                for (const [name, ...calls] of event.events)
                    if (name === 'grid_line') {
                        for (const call of calls)
                            for (const cell of call[3] as [string][]) grids.push(cell[0]);
                    }
            }
        });
        const until = async (predicate: () => boolean): Promise<void> => {
            for (let attempt = 0; attempt < 300; attempt++) {
                if (predicate()) return;
                await delay(10);
            }
            assert.fail(`External UI did not update: ${JSON.stringify(latest)}`);
        };
        try {
            assert.equal(
                await session.client.request('nvim_get_option_value', ['cmdheight', {}]),
                1
            );
            assert.equal(await session.client.request('nvim_win_get_height', [0]), 23);
            await session.input(':echo "日本😀"');
            await until(() => Boolean(latest.commands[1]));
            await until(
                () =>
                    latest.commands[1]?.content.map((chunk) => chunk[1]).join('') ===
                    'echo "日本😀"'
            );
            assert.equal(latest.commands[1].position, Buffer.byteLength('echo "日本😀"'));
            await session.input('<Left>');
            await until(() => latest.commands[1]?.position === Buffer.byteLength('echo "日本😀'));
            await session.input('<Esc>');
            await until(() => !latest.commands[1]);

            await session.input(':echo <C-r>=');
            await until(() => Boolean(latest.commands[2]));
            await session.input('1+1<CR>');
            await until(
                () =>
                    !latest.commands[2] &&
                    latest.commands[1]?.content.map((chunk) => chunk[1]).join('') === 'echo 2'
            );
            await session.input('<Esc>');
            await until(() => !latest.commands[1]);

            await session.input(':ec<Tab>');
            await until(() => Boolean(latest.completion?.items.length));
            const index = latest.completion!.items.findIndex((item) => item[0] === 'echo');
            assert.ok(index >= 0);
            await session.selectCompletion(index);
            await until(
                () => latest.commands[1]?.content.map((chunk) => chunk[1]).join('') === 'echo'
            );
            await session.input('<Esc>');
            await until(() => !latest.commands[1]);

            await session.input(':echo "external-only-notice"<CR>');
            await until(() =>
                latest.messages.some((message) =>
                    message.content.some((chunk) => chunk[1].includes('external-only-notice'))
                )
            );
            assert.equal(grids.join('').includes('external-only-notice'), false);
            await session.input(':NoSuchNidoCommand<CR>');
            await until(() => latest.messages.some((message) => message.kind === 'emsg'));
            await session.input('<Esc>');

            await session.input(':let g:nido_choice = confirm("Continue?", "&Yes\\n&No", 2)<CR>');
            await until(() => latest.messages.some((message) => message.kind === 'confirm'));
            await session.input('n');
            await until(
                () =>
                    !latest.commands[1] &&
                    !latest.messages.some((message) => message.kind === 'confirm')
            );
            assert.equal(await session.client.request('nvim_eval', ['g:nido_choice']), 2);

            await session.input(':echomsg "retained-native-history"<CR>');
            await until(() =>
                latest.messages.some((message) =>
                    message.content.some((chunk) => chunk[1].includes('retained-native-history'))
                )
            );
            await session.input(':messages<CR>');
            await until(() => latest.history !== null);
            assert.ok(
                latest.history!.some((message) =>
                    message.content.some((chunk) => chunk[1].includes('retained-native-history'))
                )
            );
            await session.input('<Esc>');
            await session.attach(80, 24);
            assert.deepEqual(latest.commands, {});
        } finally {
            await session.client.request('nvim_input', ['<Esc><C-c>']).catch(() => {});
            await session.stop();
        }
    }
);
