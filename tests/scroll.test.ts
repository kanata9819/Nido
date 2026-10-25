import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ScrollQueue } from '../src/renderer/src/scroll';
import { EditorScroll } from '../src/renderer/src/editorScroll';
import { Grid } from '../src/renderer/src/grid';

test('fast gestures keep their speed until the actual file boundary in both directions', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const sent: number[] = [];
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
  try {
    for (const direction of [-1, 1]) {
      sent.length = 0;
      const grid = new Grid();
      grid.apply([
        ['grid_resize', [1, 20, 12]],
        ['nido_scroll_cache', [direction < 0, false, direction > 0, true]],
        ['flush']
      ]);
      grid.apply([
        ['nido_scroll', [1, 0, 11, 0, 20, -direction * 8, 0, false]],
        ['grid_scroll', [1, 0, 11, 0, 20, -direction * 8, 0]],
        ['flush']
      ]);
      assert.equal(grid.limitScroll(direction * 60), direction * 8);
      const scrolling = new EditorScroll({
        id: 'alpha',
        grid,
        enabled: () => true,
        schedule: () => {},
        onError: (error) => {
          throw error;
        },
        onCompletion: () => {}
      });
      try {
        scrolling.request(direction * 60, true, 120, 0);
        scrolling.request(direction * 60, true, 120, 8);
        scrolling.advance(24, true);
        scrolling.flush();
        assert.equal(
          sent.reduce((total, lines) => total + lines, 0),
          direction * 8,
          'A fast gesture must reach the edge without easing over the shorter distance'
        );
        assert.equal(scrolling.animating, false, 'Motion stops as soon as it hits the edge');
      } finally {
        scrolling.dispose();
      }
    }
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

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
    scrolling.request(1, true, 120, 0);
    assert.equal(sent.length, 0, 'A wheel detent must not jump a whole line during input');
    await step(16);
    assert.ok(distance() > 0 && distance() < 1, 'The first paint advances a fraction of a line');
    const first = distance();
    await step(32);
    assert.ok(distance() > first && distance() < 1);
    await step(120);
    assert.equal(distance(), 1, 'Easing preserves the exact wheel distance');
    assert.equal(scrolling.animating, false);

    scrolling.request(3, true, 120, 200);
    await step(224);
    const beforeReversal = distance();
    scrolling.request(-3, true, 120, 224);
    await step(240);
    assert.ok(distance() < beforeReversal, 'An opposite detent reverses the remaining motion');
    await step(344);
    assert.ok(Math.abs(distance() - 1) < 1e-10, 'Retargeting never loses queued distance');

    scrolling.request(2, false, 120, 400);
    await step(416);
    await step(432, false);
    assert.ok(
      Math.abs(distance() - 3) < 1e-10,
      'Disabling animation commits the remaining distance'
    );
    assert.equal(scrolling.animating, false);

    scrolling.request(2, true, 120, 500);
    await step(516);
    scrolling.stop();
    const stopped = distance();
    await step(700);
    assert.equal(distance(), stopped, 'Editing or clicking cancels unpainted wheel movement');

    grid.apply([['nido_pixel_scroll', [0, true, undefined, true]], ['flush']]);
    scrolling.request(-20, true, 120, 800);
    scrolling.request(1, true, 120, 801);
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
    scrolling.request(20, true, 120, 1000);
    scrolling.request(-1, true, 120, 1001);
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

test('touchpad interpolation fills input gaps and stays responsive while native replies are delayed', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  try {
    for (const direction of [-1, 1]) {
      let applied = 0;
      const pending: { lines: number; resolve: () => void }[] = [];
      const completions: Promise<void>[] = [];
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
          nido: {
            scroll: (_id: string, lines: number): Promise<void> =>
              new Promise((resolve) => pending.push({ lines, resolve })),
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
      const frames: number[] = [];
      const inputs = [0, 24, 56, 80, 120, 152, 176];
      const position = (): number => applied + grid.scrollPreview;
      try {
        for (let now = 0; now <= 216; now += 8) {
          if (inputs.includes(now)) scrolling.request(direction * 0.3, true, 40, now);
          scrolling.advance(now, true);
          scrolling.flush();
          const before = position();
          if (now && now % 64 === 0 && pending.length) {
            const reply = pending.shift()!;
            applied += reply.lines;
            grid.scrollFraction = applied;
            scrolling.acknowledge(true);
            reply.resolve();
            await Promise.all(completions.slice());
            assert.ok(
              Math.abs(position() - before) < 1e-10,
              'a delayed acknowledgement must not jump'
            );
          }
          frames.push(direction * position());
        }
        assert.ok(frames[1] > 0 && frames[1] < 0.3, 'the first frame must respond without jumping');
        assert.ok(frames[2] > frames[1], 'paint frames between touchpad inputs must keep moving');
        for (let index = 1; index < frames.length; index++) {
          assert.ok(
            frames[index] >= frames[index - 1] - 1e-10,
            'delayed replies must not reverse motion'
          );
          assert.ok(
            frames[index] - frames[index - 1] < 0.25,
            'input bursts must not become whole steps'
          );
        }
        assert.ok(
          Math.abs(frames.at(-1)! - inputs.length * 0.3) < 1e-10,
          'touchpad motion settles within 40ms of the last input'
        );
        assert.equal(scrolling.animating, false);
      } finally {
        scrolling.dispose();
        while (pending.length) {
          pending.shift()!.resolve();
          await Promise.all(completions.slice());
        }
      }
    }
  } finally {
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

test('horizontal gestures defer vertical prefetch until vertical input needs it', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const calls: unknown[][] = [];
  const completions: Promise<void>[] = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      nido: {
        scroll: async (
          _id: string,
          lines: number,
          _follow: boolean,
          _pixel: boolean,
          columns?: number
        ): Promise<void> => {
          calls.push(['scroll', lines, columns]);
        },
        prefetchScroll: async (_id: string, down?: boolean): Promise<void> => {
          calls.push(['prefetch', down]);
        }
      }
    }
  });
  const grid = new Grid();
  grid.apply([['grid_resize', [1, 20, 12]], ['flush']]);
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
    for (const columns of [2, 2, -4]) {
      scrolling.requestHorizontal(columns, false);
      scrolling.acknowledge(true);
      await Promise.all(completions.splice(0));
    }
    assert.deepEqual(calls, [
      ['scroll', 0, 2],
      ['scroll', 0, 2],
      ['scroll', 0, -4]
    ]);
    scrolling.request(2, false);
    scrolling.acknowledge(true);
    await Promise.all(completions.splice(0));
    assert.deepEqual(calls.slice(3), [
      ['scroll', 2, undefined],
      ['prefetch', true]
    ]);
  } finally {
    scrolling.dispose();
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

test('horizontal wheel bursts coalesce with vertical movement without adding vertical preview', () => {
  const queue = new ScrollQueue();
  queue.enqueue(0, false, 2);
  assert.deepEqual(queue.start(), { lines: 0, follow: false, columns: 2 });
  assert.equal(queue.preview, 0);
  queue.enqueue(1.5, false, 2500);
  queue.enqueue(0.5, false, -3);
  assert.equal(queue.start(), undefined);
  queue.acknowledge();
  queue.complete();
  assert.equal(queue.finish(), true);
  let columns = 0;
  let lines = 0;
  while (queue.hasQueued) {
    const command = queue.start()!;
    assert.ok(Math.abs(command.columns ?? 0) <= 1000);
    columns += command.columns ?? 0;
    lines += command.lines;
    queue.acknowledge();
    queue.complete();
    queue.finish();
  }
  assert.equal(columns, 2497);
  assert.equal(lines, 2);
  queue.enqueue(0, false, 5);
  queue.cancelQueued();
  assert.equal(queue.hasQueued, false);
  assert.equal(queue.preview, 0);
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
