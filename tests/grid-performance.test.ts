import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Grid } from '../src/renderer/src/grid';

test('pixel-scrolled code uses the full viewport and keeps bottom clicks in document rows', () => {
  for (const height of [72, 77, 77.6, 90]) {
    const grid = new Grid();
    grid.pixelScrollEnabled = true;
    grid.apply([['grid_resize', [1, 20, Math.ceil(height / 18) + 2]], ['flush']]);
    for (const fraction of [0, 0.25, 0.9]) {
      grid.scrollFraction = fraction;
      grid.prepareLayout(height, 8, 18);
      assert.equal(grid.contentHeight, height);
      assert.equal(grid.rowY(grid.rows - 1), height, 'external command row is offscreen');
      assert.equal(grid.rowAt(height - 0.01), Math.floor((height - 0.01) / 18 + fraction));
      assert.equal(grid.rowAt(height), -1);
    }
  }
});

test('compact CodeLens rows retain a full row of bottom scroll overscan', () => {
  const grid = new Grid();
  grid.pixelScrollEnabled = true;
  grid.apply([
    ['grid_resize', [1, 20, 12]],
    ['hl_attr_define', [1, {}, {}, [{ hi_name: 'NidoCodeLens' }]]],
    ['grid_line', [1, 3, 0, [['Run', 1]]]],
    ['flush']
  ]);
  grid.prepareLayout(200, 8, 20);
  assert.equal(grid.extraRows, 1);
  grid.apply([['grid_resize', [1, 20, 12 + grid.extraRows]], ['flush']]);
  grid.scrollFraction = 0.9;
  grid.prepareLayout(200, 8, 20);
  assert.ok(grid.rowAt(199.99) >= 0, 'bottom pixels remain clickable while scrolling');
  assert.ok(grid.rowTop(grid.rows - 1) - grid.scrollOffset >= 200);
});

test('editor text snapshots read only changed rows during repeated typing', (context) => {
  const grid = new Grid();
  grid.apply([
    ['grid_resize', [1, 160, 45]],
    ...Array.from({ length: 45 }, (_, row) => ['grid_line', [1, row, 0, [['x', 0, 160]]]]),
    ['flush']
  ]);
  const snapshot = (): string =>
    'description' in grid
      ? (grid.description as string)
      : grid.cells.map((row) => row.map((cell) => cell.text).join('')).join('\n');
  snapshot();
  let reads = 0;
  for (const row of grid.cells) {
    for (const cell of row) {
      const text = cell.text;
      Object.defineProperty(cell, 'text', {
        get: () => {
          reads++;
          return text;
        }
      });
    }
  }
  for (let i = 0; i < 20; i++) {
    grid.apply([['grid_line', [1, 17, 10, [[String(i % 10), 0]]]], ['flush']]);
    const lines = snapshot().split('\n');
    assert.equal(lines.length, 45);
    assert.equal(lines[17], 'x'.repeat(10) + String(i % 10) + 'x'.repeat(149));
  }
  context.diagnostic(JSON.stringify({ snapshotCellReads: reads, edits: 20 }));
  if (!process.env.NIDO_PERFORMANCE_BASELINE) {
    assert.ok(reads <= 20 * 165, `typing read ${reads} cells for 20 edited rows`);
  }
});

test('text snapshots preserve Unicode, highlight changes, cached scrolling, partial scrolling and resize', () => {
  const grid = new Grid();
  const snapshot = (): string =>
    'description' in grid
      ? (grid.description as string)
      : grid.cells.map((row) => row.map((cell) => cell.text).join('')).join('\n');
  const check = (): void => {
    assert.equal(
      snapshot(),
      grid.cells.map((row) => row.map((cell) => cell.text).join('')).join('\n')
    );
  };
  grid.apply([
    ['grid_resize', [1, 8, 4]],
    ['grid_line', [1, 0, 0, [['日', 0], [''], ['e\u0301'], ['🙂'], [''], [' ', 0, 3]]]],
    ['grid_line', [1, 1, 0, [['B', 0, 8]]], [1, 2, 0, [['C', 0, 8]]]],
    ['flush']
  ]);
  assert.equal(snapshot().split('\n')[0], '日e\u0301🙂   ');
  for (const events of [
    [['grid_line', [1, 0, 0, [['日', 2]]]]],
    [
      ['nido_scroll', [1, 0, 3, 0, 8, 1, 0]],
      ['grid_scroll', [1, 0, 3, 0, 8, 1, 0]]
    ],
    [['grid_line', [1, 2, 0, [['D', 0, 8]]]]],
    [
      ['nido_scroll', [1, 0, 3, 0, 8, -1, 0]],
      ['grid_scroll', [1, 0, 3, 0, 8, -1, 0]],
      ['grid_line', [1, 0, 0, [['日', 2], [''], ['e\u0301'], ['🙂'], [''], [' ', 0, 3]]]]
    ],
    [['grid_scroll', [1, 0, 3, 2, 6, 0, 1]]],
    [['grid_line', [1, 0, 3, [['Z', 0]]]]],
    [['grid_resize', [1, 10, 5]]],
    [['grid_clear', [1]]]
  ]) {
    grid.apply([...events, ['flush']]);
    check();
  }
});

test('gutter updates reuse row geometry without scanning unchanged cells', () => {
  const grid = new Grid();
  grid.apply([
    ['grid_resize', [1, 160, 45]],
    ...Array.from({ length: 45 }, (_, row) => [
      'grid_line',
      [
        1,
        row,
        0,
        [
          ['7', 0],
          ['content', 0, 159]
        ]
      ]
    ]),
    ['flush']
  ]);
  let reads = 0;
  for (const row of grid.cells) {
    for (const cell of row) {
      const text = cell.text;
      Object.defineProperty(cell, 'text', {
        get: () => {
          reads++;
          return text;
        }
      });
    }
  }
  grid.prepareLayout(1260, 8, 28);
  reads = 0;
  grid.apply([
    ...Array.from({ length: 45 }, (_, row) => ['grid_line', [1, row, 0, [['8', 0]]]]),
    ['flush']
  ]);
  grid.prepareLayout(1260, 8, 28);
  assert.ok(reads <= 45 * 3, `gutter update scanned ${reads} unchanged cells`);
  assert.equal(grid.rowTop(40), 40 * 28);
});

test('scrolling with relative numbers preserves cached rows without searching the full cache for each gutter', (context) => {
  for (const direction of [-1, 1]) {
    const grid = new Grid();
    grid.apply([
      ['grid_resize', [1, 160, 50]],
      ...Array.from({ length: 49 }, (_, row) => [
        'grid_line',
        [
          1,
          row,
          0,
          [
            ['9', 0, 4],
            ['body', 0, 156]
          ]
        ]
      ]),
      ['flush']
    ]);
    const cached = (): Grid['cells'] =>
      Array.from({ length: 256 }, () =>
        Array.from({ length: 160 }, () => ({ text: 'cached', highlight: 0 }))
      );
    Reflect.set(grid, 'upperRows', cached());
    Reflect.set(grid, 'lowerRows', cached());
    const before = grid.cells.slice();
    const upper = grid.historyRows.slice();
    const lower = grid.futureRows.slice();
    const includes = Array.prototype.includes;
    let searchedRows = 0;
    Array.prototype.includes = function (value, ...rest) {
      if (Array.isArray(value)) searchedRows += this.length;
      return Reflect.apply(includes, this, [value, ...rest]);
    };
    try {
      grid.apply([
        ['nido_scroll', [1, 0, 49, 0, 160, direction * 4, 0]],
        ['grid_scroll', [1, 0, 49, 0, 160, direction * 4, 0]],
        ...Array.from({ length: 4 }, (_, row) => [
          'grid_line',
          [
            1,
            direction > 0 ? 45 + row : row,
            0,
            [
              ['9', 0, 4],
              ['new', 0, 156]
            ]
          ]
        ]),
        ...Array.from({ length: 49 }, (_, row) => [
          'grid_line',
          [1, row, 0, Array.from(String(row).padStart(4, '0'), (text) => [text, 0])]
        ]),
        ['flush']
      ]);
    } finally {
      Array.prototype.includes = includes;
    }
    assert.ok(
      searchedRows <= 4 * 2 * 512,
      `cache lookup work must scale with incoming rows, not every gutter: ${searchedRows}`
    );
    context.diagnostic(JSON.stringify({ direction, searchedRows }));
    for (const rows of [upper, lower]) {
      for (const row of rows) assert.equal(row[0].text, 'cached');
    }
    for (const row of before.slice(0, 49)) assert.equal(row[0].text, '9');
    for (let row = 0; row < 49; row++) {
      assert.equal(
        grid.cells[row]
          .slice(0, 4)
          .map((cell) => cell.text)
          .join(''),
        String(row).padStart(4, '0')
      );
    }
  }
});

test('relative number redraws reuse cache membership and preserve shared scroll rows', (context) => {
  const grid = new Grid();
  grid.apply([
    ['grid_resize', [1, 20, 40]],
    ...Array.from({ length: 40 }, (_, row) => ['grid_line', [1, row, 0, [['0', 0, 20]]]]),
    ['flush']
  ]);
  let examined = 0;
  const cached = (): Grid['cells'] => {
    const rows = Array.from({ length: 256 }, () =>
      Array.from({ length: 20 }, () => ({ text: 'cached', highlight: 0 }))
    );
    const includes = rows.includes;
    rows.includes = function (...args) {
      examined += this.length;
      return includes.apply(this, args);
    };
    const iterator = rows[Symbol.iterator];
    rows[Symbol.iterator] = function* () {
      for (const row of iterator.call(this)) {
        examined++;
        yield row;
      }
    };
    return rows;
  };
  const upper = cached();
  const lower = cached();
  Reflect.set(grid, 'upperRows', upper);
  Reflect.set(grid, 'lowerRows', lower);
  grid.cells[0] = upper[0];
  for (let move = 0; move < 20; move++) {
    grid.apply([
      ...Array.from({ length: 39 }, (_, row) => [
        'grid_line',
        [1, row, 0, [[String((move + 1) % 10), 0]]]
      ]),
      ['flush']
    ]);
    assert.equal(grid.cells[0][0].text, String((move + 1) % 10));
  }
  assert.equal(upper[0][0].text, 'cached');
  assert.equal(lower[0][0].text, 'cached');
  context.diagnostic(
    JSON.stringify({ cursorMoves: 20, updatedRows: 39, examinedCacheRows: examined })
  );
  assert.ok(examined <= 512, `cursor redraws repeatedly searched ${examined} cached rows`);
  // A replacement cache needs a fresh lookup, even without a viewport scroll event.
  const replacement = cached();
  Reflect.set(grid, 'upperRows', replacement);
  grid.cells[0] = replacement[0];
  grid.apply([['grid_line', [1, 0, 0, [['new', 0]]]], ['flush']]);
  assert.equal(grid.cells[0][0].text, 'new');
  assert.equal(replacement[0][0].text, 'cached');
});

test('native scrolling reuses unchanged row identities without rereading their body cells', () => {
  for (const direction of [-1, 1]) {
    const grid = new Grid();
    grid.apply([
      ['grid_resize', [1, 160, 50]],
      ...Array.from({ length: 49 }, (_, row) => ['grid_line', [1, row, 0, [['body', 0, 160]]]]),
      ['flush']
    ]);
    grid.prepareLayout(1000, 8, 20);
    const before = grid.cells.slice();
    let reads = 0;
    for (const row of before) {
      for (const cell of row) {
        const text = cell.text;
        Object.defineProperty(cell, 'text', {
          get: () => {
            reads++;
            return text;
          }
        });
      }
    }
    grid.apply([
      ['nido_scroll', [1, 0, 49, 0, 160, direction * 4, 0]],
      ['grid_scroll', [1, 0, 49, 0, 160, direction * 4, 0]],
      ...Array.from({ length: 4 }, (_, row) => [
        'grid_line',
        [1, direction > 0 ? 45 + row : row, 0, [['new', 0, 160]]]
      ]),
      ['flush']
    ]);
    assert.equal(reads, 0, 'unchanged native rows already have authoritative identities');
    for (let row = direction > 0 ? 0 : 4; row < (direction > 0 ? 45 : 49); row++) {
      assert.equal(grid.cells[row], before[row + direction * 4]);
    }
    assert.equal(grid.cells[49], before[49], 'the command row stays fixed');
  }
});

test('compact row counts follow edits, highlight changes and rectangular scrolling', () => {
  const grid = new Grid();
  grid.apply([
    ['grid_resize', [1, 8, 4]],
    ['hl_attr_define', [1, {}, {}, [{ hi_name: 'NidoCodeLens' }]]],
    ['grid_line', [1, 0, 0, [['Run', 1]]], [1, 1, 0, [['code', 0]]]],
    ['flush']
  ]);
  const height = (): number => {
    grid.prepareLayout(120, 8, 28);
    return grid.rowTop(1);
  };
  assert.equal(height(), 20);
  grid.apply([['grid_line', [1, 0, 1, [['x', 0]]]], ['flush']]);
  assert.equal(height(), 28);
  grid.apply([['grid_line', [1, 0, 1, [[' ', 0]]]], ['flush']]);
  assert.equal(height(), 20);
  grid.apply([['grid_scroll', [1, 0, 2, 0, 4, 1, 0]], ['flush']]);
  assert.equal(height(), 28);
  assert.equal(grid.cells[0][0].text, 'code');
  grid.apply([['grid_line', [1, 0, 0, [['Run', 1]]]], ['flush']]);
  assert.equal(height(), 20);
  grid.apply([['hl_attr_define', [1, {}, {}, []]], ['flush']]);
  assert.equal(height(), 28);
});

test('native pixel scrolling preserves raster origins through compact rows and cache refills', () => {
  const grid = new Grid();
  grid.apply([
    ['grid_resize', [1, 8, 5]],
    ['hl_attr_define', [1, {}, {}, [{ hi_name: 'NidoCodeLens' }]]],
    ['grid_line', [1, 0, 0, [['Run', 1]]], [1, 1, 0, [['A', 0]]]],
    ['flush']
  ]);
  grid.prepareLayout(100, 8, 20);
  grid.apply([
    ['nido_scroll', [1, 0, 4, 0, 8, 1, 0]],
    ['grid_scroll', [1, 0, 4, 0, 8, 1, 0]],
    ['nido_pixel_scroll', [0.1, true]],
    ['flush']
  ]);
  assert.equal(grid.scrollOrigin, 14, 'outgoing CodeLens height contributes to the origin');
  grid.apply([
    ['nido_scroll', [1, 0, 4, 0, 8, 1, 0], [1, 0, 4, 0, 8, -1, 0]],
    ['nido_scroll_cache', [false, false, false]],
    ['flush']
  ]);
  assert.equal(grid.scrollOrigin, 14, 'hidden cache traversal does not move the origin');
  grid.apply([
    ['nido_scroll', [1, 0, 4, 0, 8, -1, 0]],
    ['grid_scroll', [1, 0, 4, 0, 8, -1, 0]],
    ['grid_line', [1, 0, 0, [['Run', 1]]]],
    ['nido_pixel_scroll', [0.9, true]],
    ['flush']
  ]);
  assert.equal(grid.scrollOrigin, 0, 'incoming CodeLens restores the same origin');
});

test('downward preview uses cached lower rows and leaves the command line fixed', () => {
  const grid = new Grid();
  grid.pixelScrollEnabled = true;
  grid.apply([
    ['grid_resize', [1, 8, 4]],
    ['hl_attr_define', [1, {}, {}, [{ hi_name: 'NidoCodeLens' }]]],
    ['grid_line', [1, 0, 0, [['A', 0]]], [1, 1, 0, [['B', 0]]], [1, 2, 0, [['Run', 1]]]],
    ['flush']
  ]);
  const future = grid.cells[2];
  grid.apply([
    ['nido_scroll', [1, 0, 3, 0, 8, -1, 0]],
    ['grid_scroll', [1, 0, 3, 0, 8, -1, 0]],
    ['grid_line', [1, 0, 0, [['Z', 0]]]],
    ['flush']
  ]);
  assert.equal(grid.futureRows[0], future);
  grid.scrollFraction = 0.8;
  grid.scrollPreview = 0.7;
  grid.prepareLayout(60, 8, 20);
  assert.equal(grid.scrollOffset, 30, 'preview must continue beyond the old one-row limit');
  assert.equal(grid.rowY(3), 60, 'command line stays below the code viewport');
  assert.equal(grid.rowTop(4) - grid.rowTop(3), 14, 'future CodeLens rows stay compact');
  assert.ok(Number.isFinite(grid.rowTop(100.5)));

  grid.apply([
    ['nido_scroll', [1, 0, 3, 0, 8, 1, 0]],
    ['grid_scroll', [1, 0, 3, 0, 8, 1, 0]],
    ['grid_line', [1, 2, 0, [['Run', 1]]]],
    ['flush']
  ]);
  assert.equal(grid.cells[2], future, 'native movement reuses the cached row image');
  assert.equal(grid.futureRows.length, 0);
});

test('lower preview cache is bounded, cleared on edits and stops at EOF', () => {
  const grid = new Grid();
  grid.pixelScrollEnabled = true;
  grid.apply([['grid_resize', [1, 8, 40]], ['flush']]);
  for (let i = 0; i < 10; i++) {
    grid.apply([
      ['nido_scroll', [1, 0, 39, 0, 8, -30, 0]],
      ['grid_scroll', [1, 0, 39, 0, 8, -30, 0]],
      ['flush']
    ]);
  }
  assert.equal(grid.futureRows.length, 256);
  grid.apply([['nido_edit', []], ['flush']]);
  assert.equal(grid.futureRows.length, 0);
  grid.scrollPreview = 1.5;
  grid.apply([['nido_scroll_cache', [false, false, true]], ['flush']]);
  grid.prepareLayout(800, 8, 20);
  assert.equal(grid.scrollOffset, 0, 'EOF must not expose empty preview rows');
  assert.equal(grid.needsLowerRows, false);
  grid.apply([['grid_resize', [1, 8, 40]], ['flush']]);
  assert.equal(grid.needsLowerRows, true, 'resize invalidates the cached boundary');
});
