import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NidoEvent } from '../src/shared/types';
import { onNidoEvent } from '../src/renderer/src/nidoEvents';

test('redraws cross the bridge once, preserve delivery order and release the last subscription', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let receive: ((event: NidoEvent) => void) | undefined;
  let subscriptions = 0;
  let releases = 0;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      nido: {
        onEvent: (callback: typeof receive) => {
          subscriptions++;
          receive = callback;
          return () => {
            releases++;
            receive = undefined;
          };
        }
      }
    }
  });
  const stops: (() => void)[] = [];
  try {
    const event: NidoEvent = { type: 'redraw', id: 'alpha', events: [['flush']] };
    const received: NidoEvent[] = [];
    const listener = (value: NidoEvent): void => {
      received.push(value);
    };
    for (let i = 0; i < 16; i++) stops.push(onNidoEvent(listener));
    assert.equal(subscriptions, 1);
    receive!(event);
    assert.equal(received.length, 16);
    assert.ok(received.every((value) => value === event));
    stops.pop()!();
    assert.equal(releases, 0);
    received.length = 0;
    receive!(event);
    assert.equal(received.length, 15);
    while (stops.length) stops.pop()!();
    assert.equal(releases, 1);
    stops.push(onNidoEvent(listener));
    assert.equal(subscriptions, 2);
  } finally {
    while (stops.length) stops.pop()!();
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('removing or adding listeners during delivery does not corrupt the current redraw', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let receive: ((event: NidoEvent) => void) | undefined;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      nido: {
        onEvent: (callback: typeof receive) => {
          receive = callback;
          return () => {};
        }
      }
    }
  });
  const stops: (() => void)[] = [];
  try {
    const calls: string[] = [];
    let added = false;
    let stopSecond = (): void => {};
    stops.push(
      onNidoEvent(() => {
        calls.push('first');
        stopSecond();
        if (!added) {
          added = true;
          stops.push(
            onNidoEvent(() => {
              calls.push('new');
            })
          );
        }
      })
    );
    stopSecond = onNidoEvent(() => {
      calls.push('second');
    });
    stops.push(stopSecond);
    const event: NidoEvent = { type: 'redraw', id: 'alpha', events: [['flush']] };
    receive!(event);
    assert.deepEqual(calls, ['first']);
    receive!(event);
    assert.deepEqual(calls, ['first', 'first', 'new']);
  } finally {
    stops.forEach((stop) => stop());
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('a failing subscriber reports its error without dropping the redraw for other subscribers', (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let receive: ((event: NidoEvent) => void) | undefined;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      nido: {
        onEvent: (callback: typeof receive) => {
          receive = callback;
          return () => {};
        }
      }
    }
  });
  const errors: (() => void)[] = [];
  t.mock.method(globalThis, 'queueMicrotask', (callback: () => void) => {
    errors.push(callback);
  });
  let delivered = false;
  const failure = new Error('subscriber failed');
  const stops = [
    onNidoEvent(() => {
      throw failure;
    }),
    onNidoEvent(() => {
      delivered = true;
    })
  ];
  try {
    receive!({ type: 'redraw', id: 'alpha', events: [['flush']] });
    assert.equal(delivered, true);
    assert.equal(errors.length, 1);
    assert.throws(errors[0], (error: unknown) => error === failure);
  } finally {
    stops.forEach((stop) => stop());
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
