import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ScrollQueue } from '../src/renderer/src/scroll';
import { EditorScroll } from '../src/renderer/src/editorScroll';
import { Grid } from '../src/renderer/src/grid';

test('animated wheel steps interpolate distance, coalesce reversals and finish immediately when disabled', async () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const sent: number[] = [];
    const completions: Promise<void>[] = [];
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
            nido: {
                scroll: async (_id: string, lines: number): Promise<void> => {
                    sent.push(lines);
                },
                prefetchScroll: async (): Promise<void> => {}
            }
        }
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
        onCompletion: (promise) => {
            completions.push(promise);
        }
    });
    const step = async (now: number, animate = true): Promise<void> => {
        scrolling.advance(now, animate);
        scrolling.flush();
        scrolling.acknowledge(true);
        await Promise.all(completions);
    };
    const distance = (): number => sent.reduce((sum, lines) => sum + lines, 0);
    try {
        scrolling.request(1, true, true, 0);
        assert.equal(sent.length, 0, 'A wheel detent must not jump a whole line during input');
        await step(16);
        assert.ok(
            distance() > 0 && distance() < 1,
            'The first paint advances a fraction of a line'
        );
        const first = distance();
        await step(32);
        assert.ok(distance() > first && distance() < 1);
        await step(120);
        assert.equal(distance(), 1, 'Easing preserves the exact wheel distance');
        assert.equal(scrolling.animating, false);

        scrolling.request(3, true, true, 200);
        await step(224);
        const beforeReversal = distance();
        scrolling.request(-3, true, true, 224);
        await step(240);
        assert.ok(distance() < beforeReversal, 'An opposite detent reverses the remaining motion');
        await step(344);
        assert.ok(Math.abs(distance() - 1) < 1e-10, 'Retargeting never loses queued distance');

        scrolling.request(2, false, true, 400);
        await step(416);
        await step(432, false);
        assert.ok(
            Math.abs(distance() - 3) < 1e-10,
            'Disabling animation commits the remaining distance'
        );
        assert.equal(scrolling.animating, false);

        scrolling.request(2, true, true, 500);
        await step(516);
        scrolling.stop();
        const stopped = distance();
        await step(700);
        assert.equal(distance(), stopped, 'Editing or clicking cancels unpainted wheel movement');

        grid.apply([['nido_pixel_scroll', [0, true, undefined, true]], ['flush']]);
        scrolling.request(-20, true, true, 800);
        scrolling.request(1, true, true, 801);
        await step(817);
        assert.ok(
            distance() > stopped,
            'At BOF, an outward detent must not swallow the reverse gesture'
        );
        await step(921);
        assert.ok(Math.abs(distance() - stopped - 1) < 1e-10);

        scrolling.stop();
        grid.apply([
            ['grid_resize', [1, 20, 4]],
            ['nido_scroll_cache', [undefined, false, true, true]],
            ['flush']
        ]);
        const atEnd = distance();
        scrolling.request(20, true, true, 1000);
        scrolling.request(-1, true, true, 1001);
        await step(1017);
        assert.ok(distance() < atEnd, 'At EOF, reverse input also responds immediately');
        await step(1121);
        assert.ok(Math.abs(distance() - atEnd + 1) < 1e-10);
    } finally {
        scrolling.dispose();
        if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
        else Reflect.deleteProperty(globalThis, 'window');
    }
});

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
