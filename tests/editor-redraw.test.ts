import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  editorGridSize,
  isAnimatableScroll,
  isHorizontalStep,
  scrollMotion,
  summarizeRedraw
} from '../src/renderer/src/editorRedraw';
import { debugActionFor, isCtrl, isCtrlShift } from '../src/renderer/src/shortcutKeys';

test('redraw summaries expose a single viewport scroll and the buffer column', () => {
  const redraw = summarizeRedraw([
    ['nido_buffer', [1, 'a.ts', 7]],
    ['nido_scroll', [1, 0, 30, 0, 80, 3, 0, 0, 12]],
    ['grid_line', [1, 0, 0, []]]
  ]);
  assert.equal(redraw.bufferChanged, true);
  assert.equal(redraw.bufferColumn, 7);
  assert.equal(redraw.lastScrollColumn, 12);
  assert.deepEqual(redraw.scroll, {
    grid: 1,
    top: 0,
    bottom: 30,
    left: 0,
    right: 80,
    rows: 3,
    columns: 0
  });
  assert.equal(redraw.cursorJumped, true);
  assert.equal(redraw.viewportMoved, true);
  assert.equal(redraw.descriptionChanged, true);
  assert.equal(redraw.layoutReset, false);
});

test('multiple viewport scrolls in one batch are not animated as one', () => {
  const redraw = summarizeRedraw([
    ['nido_scroll', [1, 0, 30, 0, 80, 1, 0], [1, 0, 30, 0, 80, 2, 0]]
  ]);
  assert.equal(redraw.viewportScrolls.length, 2);
  assert.equal(redraw.scroll, undefined);
});

test('edits alone neither move the viewport nor reset the cursor', () => {
  const redraw = summarizeRedraw([['nido_edit']]);
  assert.equal(redraw.edited, true);
  assert.equal(redraw.cursorJumped, false);
  assert.equal(redraw.viewportMoved, false);
  assert.equal(redraw.descriptionChanged, false);
});

test('scroll classification separates horizontal steps from animatable scrolls', () => {
  const base = { grid: 1, top: 0, bottom: 30, left: 0, right: 80 };
  assert.equal(isHorizontalStep({ ...base, rows: 0, columns: 4 }), true);
  assert.equal(isHorizontalStep({ ...base, rows: 0, columns: 80 }), false);
  assert.equal(isHorizontalStep({ ...base, rows: 1, columns: 4 }), false);
  assert.equal(isAnimatableScroll({ ...base, rows: 2, columns: 0 }), true);
  assert.equal(isAnimatableScroll({ ...base, rows: 0, columns: 0 }), false);
  assert.equal(isAnimatableScroll({ ...base, grid: 2, rows: 2, columns: 0 }), false);
});

test('scroll motion clamps large jumps to one viewport', () => {
  const grid = { rowTop: (row: number): number => row * 10 };
  const scroll = { grid: 1, top: 0, bottom: 30, left: 0, right: 80, rows: 100, columns: 0 };
  const motion = scrollMotion(scroll, grid, 8, { x: 0, y: 0 }, 1000, 950);
  assert.equal(motion.distance, 300);
  assert.equal(motion.duration, 50);
  assert.equal(motion.incomingRows, 0);
});

test('editor grid size keeps minimums and adds pixel-scroll overscan', () => {
  const metrics = { cellWidth: 10, cellHeight: 20 };
  assert.deepEqual(editorGridSize({ width: 100, height: 50 }, metrics, false, 0), {
    columns: 20,
    rows: 4
  });
  assert.deepEqual(editorGridSize({ width: 800, height: 410 }, metrics, true, 1), {
    columns: 80,
    rows: 21 + 1 + 2
  });
});

test('shortcut chords ignore Alt and Meta combinations', () => {
  const event = { key: 'M', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false };
  assert.equal(isCtrlShift(event, 'm'), true);
  assert.equal(isCtrlShift({ ...event, altKey: true }, 'm'), false);
  assert.equal(isCtrl({ ...event, key: '`' }, '@', '`'), true);
  assert.equal(isCtrl({ ...event, key: '`', metaKey: true }, '@', '`'), false);
});

test('debug keys map to their actions', () => {
  assert.equal(debugActionFor({ key: 'F5', shiftKey: false }), 'start');
  assert.equal(debugActionFor({ key: 'F5', shiftKey: true }), 'stop');
  assert.equal(debugActionFor({ key: 'F9', shiftKey: false }), 'breakpoint');
  assert.equal(debugActionFor({ key: 'F10', shiftKey: false }), 'over');
  assert.equal(debugActionFor({ key: 'F11', shiftKey: true }), 'out');
});
