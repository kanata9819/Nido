import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { Session } from '../src/main/session';
import type { NidoEvent } from '../src/shared/types';

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
