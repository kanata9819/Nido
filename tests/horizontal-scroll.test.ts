import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HorizontalScroll } from '../src/renderer/src/horizontalScroll';

test('fine horizontal input requests an edge immediately and preserves fractional positions through pauses', () => {
  const scroll = new HorizontalScroll();
  assert.equal(scroll.request(0.125), 1);
  assert.equal(scroll.acknowledge(1, 1), false);
  assert.equal(scroll.offset, 0.875);
  assert.equal(scroll.request(0.125), 0);
  assert.equal(scroll.offset, 0.75);
  assert.equal(scroll.request(0.75), 0);
  assert.equal(scroll.offset, 0);
  assert.equal(scroll.request(0.125), 1);
});

test('reversing across a cell requests the other edge without losing fractional input', () => {
  const scroll = new HorizontalScroll();
  scroll.request(0.75);
  scroll.acknowledge(1, 1);
  assert.equal(scroll.request(-0.25), 0);
  assert.equal(scroll.offset, 0.5);
  assert.equal(scroll.request(0.25), 0);
  assert.equal(scroll.offset, 0.25);
  assert.equal(scroll.request(-0.75), -1);
  scroll.acknowledge(0, -1);
  assert.equal(scroll.offset, 0);
  assert.equal(scroll.request(-100), 0);
});

test('pending reversals keep a native frame ahead of the desired edge', () => {
  const scroll = new HorizontalScroll();
  assert.equal(scroll.request(2.25), 3);
  assert.equal(scroll.request(1.5), 1);
  assert.equal(scroll.request(-0.5), 0);
  scroll.acknowledge(3, 3);
  assert.equal(scroll.offset, -0.25);
  scroll.acknowledge(4, 1);
  assert.equal(scroll.offset, 0.75);
});

test('stopping preserves only an outstanding native movement before the next gesture', () => {
  const scroll = new HorizontalScroll();
  scroll.request(2.25);
  scroll.request(10);
  scroll.stop(3);
  assert.equal(scroll.active, false);
  assert.equal(scroll.offset, 0);
  assert.equal(scroll.request(-0.5), 0);
  scroll.acknowledge(3, 3);
  assert.equal(scroll.offset, 0.5);
  scroll.stop();
  assert.equal(scroll.active, false);
  assert.equal(scroll.request(0.25), 1);
});

test('an arriving frame cancels a queued reversal already covered by the two cached edges', () => {
  const scroll = new HorizontalScroll();
  assert.equal(scroll.request(2.25), 3);
  assert.equal(scroll.request(-1), -1);
  assert.equal(scroll.acknowledge(3, 3), true);
  assert.equal(scroll.offset, 1.75);
  assert.equal(scroll.request(0.25), 0);
  assert.equal(scroll.offset, 1.5);
});

test('native boundaries clamp queued movement and reopen after vertical movement or editing', () => {
  const scroll = new HorizontalScroll();
  scroll.request(50);
  assert.equal(scroll.acknowledge(12, 50), true);
  assert.equal(scroll.offset, 0);
  assert.equal(scroll.request(50), 0);
  scroll.invalidateLimit();
  assert.equal(scroll.request(0.5), 1);
  scroll.acknowledge(13, 1);
  assert.equal(scroll.offset, 0.5);
  scroll.request(50);
  scroll.acknowledge(14, 50);
  scroll.stop();
  assert.equal(scroll.request(0.5), 1);
  scroll.reset();
  assert.equal(scroll.native, 0);
  assert.equal(scroll.active, false);
});

test('native cursor movement and invalid inputs cannot leave a stale horizontal offset', () => {
  const scroll = new HorizontalScroll();
  scroll.acknowledge(20, 0);
  assert.equal(scroll.request(0.25), 1);
  assert.equal(scroll.acknowledge(5, 0), true);
  assert.equal(scroll.offset, 0);
  assert.equal(scroll.request(NaN), 0);
  assert.equal(scroll.request(Infinity), 0);
  assert.equal(scroll.acknowledge(NaN, 0), false);
  assert.equal(scroll.native, 5);
});

test('a settled or recreated frame requests fresh pixels when reversing from the native endpoint', () => {
  const scroll = new HorizontalScroll();
  scroll.acknowledge(80, 0);
  assert.equal(scroll.request(-0.25), -1);
  scroll.acknowledge(79, -1);
  scroll.request(-0.75);
  scroll.discardFrame();
  assert.equal(scroll.request(0.25), 1);
});

test('discarding nonoverlapping frames preserves movement still queued beyond the native limit', () => {
  const scroll = new HorizontalScroll();
  assert.equal(scroll.request(2500.5), 2501);
  assert.equal(scroll.acknowledge(1000, 1000), false);
  scroll.discardFrame();
  assert.equal(scroll.acknowledge(2000, 1000), false);
  scroll.discardFrame();
  assert.equal(scroll.acknowledge(2501, 501), false);
  scroll.discardFrame();
  assert.equal(scroll.request(0.25), -1);
  assert.equal(scroll.acknowledge(2500, -1), false);
  assert.equal(scroll.offset, -0.75);
});

test('native edge lookahead bounds RPCs during long fine-input bursts', () => {
  const calls = (ahead: number): number => {
    const scroll = new HorizontalScroll();
    let requests = 0;
    let desired = 0;
    for (let i = 0; i < 640; i++) {
      desired += 0.125;
      const movement = scroll.request(0.125, ahead);
      if (movement) {
        scroll.acknowledge(scroll.native + movement, movement);
        requests++;
      }
      assert.equal(scroll.native - scroll.offset, desired);
    }
    return requests;
  };
  assert.equal(calls(1), 80);
  assert.equal(calls(8), 10);
});

test('lookahead keeps cached integral endpoints and requests the opposite edge on reversal', () => {
  const scroll = new HorizontalScroll();
  assert.equal(scroll.request(0.25, 8), 8);
  scroll.acknowledge(8, 8);
  assert.equal(scroll.request(8, 8), 8);
  scroll.acknowledge(16, 8);
  assert.equal(scroll.request(-0.25, 8), 0);
  assert.equal(scroll.offset, 8);
  assert.equal(scroll.request(-0.125, 8), -16);
  scroll.acknowledge(0, -16);
  assert.equal(scroll.offset, -7.875);
  assert.equal(scroll.request(0.25, 8), 0);
  assert.equal(scroll.offset, -8.125);
});

test('lookahead reaching EOF preserves an earlier desired position and clamps later input', () => {
  const scroll = new HorizontalScroll();
  assert.equal(scroll.request(0.25, 8), 8);
  assert.equal(scroll.acknowledge(5, 8), true);
  assert.equal(scroll.offset, 4.75);
  assert.equal(scroll.request(0.25, 8), 0);
  assert.equal(scroll.offset, 4.5);
  assert.equal(scroll.request(100, 8), 0);
  assert.equal(scroll.offset, 0);
  scroll.invalidateLimit();
  assert.equal(scroll.request(0.125, 8), 8);
});

test('unexpected native movement resets lookahead rather than retaining stale cached coverage', () => {
  const scroll = new HorizontalScroll();
  scroll.acknowledge(20, 0);
  assert.equal(scroll.request(0.25, 8), 8);
  assert.equal(scroll.acknowledge(4, 8), true);
  assert.equal(scroll.offset, 0);
  assert.equal(scroll.request(0.125, 8), 8);
});

test('idle settlement preserves the desired view and does not oscillate at a fractional boundary', () => {
  for (const direction of [1, -1]) {
    const scroll = new HorizontalScroll();
    scroll.acknowledge(24, 0);
    const movement = scroll.request(direction * 0.25, 8);
    scroll.acknowledge(24 + movement, movement);
    const desired = scroll.native - scroll.offset;
    assert.equal(scroll.settle(), -movement);
    scroll.acknowledge(24, -movement);
    assert.equal(scroll.native - scroll.offset, desired);
    assert.equal(scroll.settle(), 0);
    assert.equal(scroll.request(direction * 0.125, 8), 0);
  }
});

test('discarding recreated lookahead frames requests fresh pixels for the next fractional input', () => {
  const scroll = new HorizontalScroll();
  assert.equal(scroll.request(0.25, 8), 8);
  scroll.acknowledge(8, 8);
  assert.equal(scroll.settle(), -8);
  scroll.acknowledge(0, -8);
  scroll.discardFrame();
  assert.equal(scroll.request(0.125, 8), 8);
  scroll.acknowledge(8, 8);
  assert.equal(scroll.offset, 7.625);
});

async function withEditorScroll(
  run: (harness: {
    scroll: import('../src/renderer/src/editorScroll').EditorScroll;
    grid: import('../src/renderer/src/grid').Grid;
    calls: { lines: number; columns: number; follow: boolean; resolve: () => void }[];
    completions: Promise<void>[];
  }) => Promise<void>,
  enabled = (): boolean => true
): Promise<void> {
  const { EditorScroll } = await import('../src/renderer/src/editorScroll');
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const calls: { lines: number; columns: number; follow: boolean; resolve: () => void }[] = [];
  const completions: Promise<void>[] = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      nido: {
        scroll: (_id: string, lines: number, follow: boolean, _direct: boolean, columns: number) =>
          new Promise<void>((resolve) => calls.push({ lines, columns, follow, resolve })),
        prefetchScroll: async () => {}
      }
    }
  });
  const grid = {
    scrollPreview: 0,
    scrolling: false,
    columns: 80,
    horizontalGutter: 6
  } as import('../src/renderer/src/grid').Grid;
  const scroll = new EditorScroll({
    id: 'editor',
    grid,
    enabled,
    schedule: () => {},
    onError: (error) => assert.fail(String(error)),
    onCompletion: (promise) => completions.push(promise)
  });
  try {
    await run({ scroll, grid, calls, completions });
  } finally {
    scroll.dispose();
    for (const call of calls) call.resolve();
    await Promise.all(completions);
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

test('axis changes wait for lookahead acknowledgement and completion before realigning the native view', async () => {
  for (const acknowledgeFirst of [true, false]) {
    await withEditorScroll(async ({ scroll, calls, completions }) => {
      assert.equal(scroll.alignHorizontal(), false);
      scroll.requestHorizontal(0.5, false);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].columns, 8);
      assert.equal(scroll.alignHorizontal(), true);
      assert.equal(calls.length, 1);

      if (acknowledgeFirst) scroll.acknowledge(true, 8);
      else {
        calls[0].resolve();
        await completions[0];
      }
      assert.equal(scroll.alignHorizontal(), true);
      assert.equal(calls.length, 1);

      if (acknowledgeFirst) {
        calls[0].resolve();
        await completions[0];
      } else {
        scroll.acknowledge(true, 8);
        scroll.finish();
      }
      assert.equal(scroll.alignHorizontal(), true);
      assert.equal(calls.length, 2);
      assert.equal(calls[1].columns, -8);
      assert.equal(calls[1].follow, false);
      assert.equal(scroll.alignHorizontal(), true);
      assert.equal(calls.length, 2);
      scroll.acknowledge(true, 0);
      calls[1].resolve();
      await completions[1];
      assert.equal(scroll.horizontalColumn - scroll.horizontalOffset, 0.5);
      assert.equal(scroll.alignHorizontal(), false);
      assert.equal(calls.length, 2);
    });
  }
});

test('cursor-following horizontal scrolling keeps one-column native requests ready for editing', async () => {
  await withEditorScroll(async ({ scroll, calls, completions }) => {
    scroll.requestHorizontal(0.5, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].columns, 1);
    assert.equal(calls[0].follow, true);
    assert.equal(scroll.alignHorizontal(), false);
    scroll.acknowledge(true, 1);
    calls[0].resolve();
    await completions[0];
    assert.equal(scroll.alignHorizontal(), false);
    assert.equal(calls.length, 1);
  });
});

test('fast horizontal input scales lookahead while narrow viewports retain overlapping edges', async () => {
  for (const [columns, gutter, delta, expected] of [
    [80, 6, 7.25, 29],
    [80, 6, 10, 32],
    [20, 6, 1.25, 6],
    [8, 7, 0.5, 1]
  ]) {
    await withEditorScroll(async ({ scroll, grid, calls, completions }) => {
      grid.columns = columns;
      grid.horizontalGutter = gutter;
      scroll.requestHorizontal(delta, false);
      assert.equal(calls[0].columns, expected);
      scroll.acknowledge(true, expected);
      calls[0].resolve();
      await completions[0];
      assert.equal(scroll.horizontalColumn - scroll.horizontalOffset, delta);
      scroll.requestHorizontal(-0.25, false);
      assert.equal(calls.length, 1);
      assert.equal(scroll.horizontalColumn - scroll.horizontalOffset, delta - 0.25);
    });
  }
});

test('cached horizontal input postpones idle settlement until the continuous gesture stops', async (t) => {
  await withEditorScroll(async ({ scroll, calls, completions }) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    scroll.requestHorizontal(0.125, false);
    scroll.acknowledge(true, 8);
    calls[0].resolve();
    await completions[0];

    for (let i = 0; i < 4; i++) {
      t.mock.timers.tick(80);
      scroll.requestHorizontal(0.125, false);
      assert.equal(calls.length, 1);
    }
    t.mock.timers.tick(159);
    assert.equal(calls.length, 1);
    t.mock.timers.tick(1);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].columns, -8);
    scroll.acknowledge(true, 0);
    calls[1].resolve();
    await completions[1];
    assert.equal(scroll.horizontalColumn - scroll.horizontalOffset, 0.625);
  });
});

test('pausing preserves the visible horizontal position and resynchronizes canceled settlement', () => {
  const scroll = new HorizontalScroll();
  assert.equal(scroll.request(0.5, 8), 8);
  scroll.acknowledge(8, 8);
  scroll.stop(0, true);
  assert.equal(scroll.active, true);
  assert.equal(scroll.native, 8);
  assert.equal(scroll.native - scroll.offset, 0.5);
  assert.equal(scroll.settle(), -8);
  scroll.stop(0, true);
  assert.equal(scroll.settle(), -8);
  scroll.stop();
  assert.equal(scroll.active, false);
  assert.equal(scroll.offset, 0);
});

test('blur and modal dismissal settle preserved lookahead after input becomes idle', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const blocked of [false, true]) {
    let enabled = true;
    await withEditorScroll(
      async ({ scroll, calls, completions }) => {
        scroll.requestHorizontal(0.5, false);
        scroll.acknowledge(true, 8);
        calls[0].resolve();
        await completions[0];
        scroll.stop(true);
        if (blocked) {
          enabled = false;
          scroll.pauseIfDisabled();
          t.mock.timers.tick(200);
          assert.equal(calls.length, 1);
          enabled = true;
          scroll.pauseIfDisabled();
        }
        t.mock.timers.tick(159);
        assert.equal(calls.length, 1);
        t.mock.timers.tick(1);
        assert.equal(calls[1].columns, -8);
        scroll.acknowledge(true, 0);
        calls[1].resolve();
        await completions.at(-1);
        assert.equal(scroll.horizontalColumn - scroll.horizontalOffset, 0.5);
      },
      () => enabled
    );
  }
});

test('horizontal input awaiting a vertical redraw uses a one-column native edge', async () => {
  for (const reverse of [false, true]) {
    await withEditorScroll(async ({ scroll, calls, completions }) => {
      scroll.request(1, false);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].lines, 1);
      if (reverse) scroll.request(-1, false);
      scroll.requestHorizontal(0.5, false);
      assert.equal(calls.length, 1);
      scroll.acknowledge(true, 0);
      calls[0].resolve();
      await completions[0];
      assert.equal(calls.length, 2);
      assert.equal(calls[1].columns, 1);
      assert.equal(calls[1].lines, reverse ? -1 : 0);
      scroll.acknowledge(true, 1);
      calls[1].resolve();
      await completions.at(-1);
    });
  }
});
