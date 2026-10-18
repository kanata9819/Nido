import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ScrollQueue } from '../src/renderer/src/scroll';
import { EditorScroll } from '../src/renderer/src/editorScroll';
import { Grid } from '../src/renderer/src/grid';

test('cold gestures send movement first and refill the final direction after reversing', async () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const calls: (string | boolean | undefined)[][] = [];
    const completions: Promise<void>[] = [];
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
            nido: {
                scroll: async (): Promise<void> => {
                    calls.push(['scroll']);
                },
                prefetchScroll: async (_id: string, down?: boolean): Promise<void> => {
                    calls.push(['prefetch', down]);
                }
            }
        }
    });
    try {
        for (const [first, second] of [
            [-7, -7],
            [7, 7],
            [-7, 7],
            [-0.25, -0.25],
            [0.25, 0.25],
            [-0.25, 0.25]
        ]) {
            calls.length = 0;
            completions.length = 0;
            const grid = new Grid();
            // A sub-line gesture can exhaust the preview at a fractional boundary too.
            if (Math.abs(first) < 1 && first > 0) grid.scrollFraction = 0.99;
            const scrolling = new EditorScroll({
                id: 'alpha',
                grid,
                enabled: () => true,
                schedule: () => {},
                onError: (error) => {
                    throw error;
                },
                onCompletion: (promise) => {
                    completions.push(promise);
                }
            });
            try {
                scrolling.request(first, true);
                scrolling.request(second, true);
                assert.deepEqual(calls, [['scroll'], ['prefetch', first > 0]]);
                await Promise.all(completions);
                assert.deepEqual(
                    calls,
                    first === second
                        ? [['scroll'], ['prefetch', first > 0]]
                        : [['scroll'], ['prefetch', first > 0], ['prefetch', second > 0]]
                );
                await Promise.all(completions);
            } finally {
                scrolling.dispose();
            }
        }
    } finally {
        if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
        else Reflect.deleteProperty(globalThis, 'window');
    }
});

test('late replies from a previous buffer cannot complete a new scroll or refill', async () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const replies: (() => void)[] = [];
    const completions: Promise<void>[] = [];
    const deferred = (): Promise<void> => new Promise((resolve) => replies.push(resolve));
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { nido: { scroll: deferred, prefetchScroll: deferred } }
    });
    const grid = new Grid();
    const scrolling = new EditorScroll({
        id: 'alpha',
        grid,
        enabled: () => true,
        schedule: () => {},
        onError: (error) => {
            throw error;
        },
        onCompletion: (promise) => completions.push(promise)
    });
    try {
        scrolling.request(-7, true);
        assert.equal(replies.length, 2);
        scrolling.reset();
        scrolling.request(7, true);
        assert.equal(replies.length, 4);
        replies[0]();
        replies[1]();
        await Promise.all(completions.slice(0, 2));
        assert.equal(scrolling.pending, true);
        assert.equal(scrolling.prefetchPending, true);
        assert.equal(grid.scrollPreview, 7);
        scrolling.acknowledge(true);
        replies[2]();
        replies[3]();
        await Promise.all(completions);
        assert.equal(scrolling.pending, false);
        assert.equal(scrolling.prefetchPending, false);
    } finally {
        replies.forEach((reply) => reply());
        scrolling.dispose();
        if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
        else Reflect.deleteProperty(globalThis, 'window');
    }
});

for (const first of ['reply', 'redraw'] as const) {
    test(`wheel input waits for both reply and redraw when ${first} arrives first`, () => {
        const queue = new ScrollQueue();
        queue.enqueue(0.25, true);
        assert.deepEqual(queue.start(), { lines: 0.25, follow: true });
        queue.enqueue(0.5, false);

        if (first === 'reply') queue.complete();
        else queue.acknowledge();
        assert.equal(queue.finish(), false);
        assert.equal(queue.start(), undefined);
        assert.equal(queue.preview, first === 'reply' ? 0.75 : 0.5);

        if (first === 'reply') queue.acknowledge();
        else queue.complete();
        assert.equal(queue.finish(), true);
        assert.equal(queue.preview, 0.5);
        assert.deepEqual(queue.start(), { lines: 0.5, follow: false });
    });
}

test('large wheel bursts preserve distance across bounded commands in both directions', () => {
    for (const distance of [2500.25, -2500.25]) {
        const queue = new ScrollQueue();
        queue.enqueue(distance, false);
        let total = 0;
        let commands = 0;
        while (queue.hasQueued) {
            const command = queue.start()!;
            assert.ok(Math.abs(command.lines) <= 1000);
            assert.equal(command.follow, false);
            total += command.lines;
            commands++;
            queue.acknowledge();
            queue.complete();
            assert.equal(queue.finish(), true);
        }
        assert.equal(total, distance);
        assert.equal(commands, 3);
        assert.equal(queue.preview, 0);
        assert.equal(queue.pending, false);
    }
});

test('reversing direction while a command is pending previews each movement once', () => {
    const queue = new ScrollQueue();
    queue.enqueue(1.5, true);
    queue.start();
    queue.enqueue(-2, true);
    queue.enqueue(0.25, false);
    assert.equal(queue.preview, -0.25);
    queue.acknowledge();
    assert.equal(queue.preview, -1.75);
    queue.complete();
    queue.finish();
    assert.deepEqual(queue.start(), { lines: -1.75, follow: false });
});

test('canceling queued input retains the outstanding command until its redraw arrives', () => {
    const queue = new ScrollQueue();
    queue.enqueue(0.5, true);
    queue.start();
    queue.enqueue(3, true);
    queue.cancelQueued();
    assert.equal(queue.preview, 0.5);
    assert.equal(queue.hasQueued, false);
    queue.complete();
    assert.equal(queue.finish(), false);
    queue.acknowledge();
    assert.equal(queue.preview, 0);
    assert.equal(queue.finish(), true);
    assert.equal(queue.start(), undefined);
});

test('a failed command clears its preview and allows the next gesture without a redraw', () => {
    const queue = new ScrollQueue();
    queue.enqueue(2, true);
    queue.start();
    queue.enqueue(3, true);
    queue.fail();
    assert.equal(queue.preview, 0);
    queue.complete();
    assert.equal(queue.finish(), true);
    queue.enqueue(-0.5, false);
    assert.deepEqual(queue.start(), { lines: -0.5, follow: false });
});
