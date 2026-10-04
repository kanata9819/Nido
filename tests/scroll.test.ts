import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ScrollQueue } from '../src/renderer/src/scroll';

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
