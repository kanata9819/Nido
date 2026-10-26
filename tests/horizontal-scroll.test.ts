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
