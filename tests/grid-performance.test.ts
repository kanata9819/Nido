import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Grid } from '../src/renderer/src/grid';

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
    grid.prepareLayout(1260, 8, 28, 1);
    reads = 0;
    grid.apply([
        ...Array.from({ length: 45 }, (_, row) => ['grid_line', [1, row, 0, [['8', 0]]]]),
        ['flush']
    ]);
    grid.prepareLayout(1260, 8, 28, 1);
    assert.ok(reads <= 45 * 3, `gutter update scanned ${reads} unchanged cells`);
    assert.equal(grid.rowTop(40), 40 * 28);
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
        grid.prepareLayout(120, 8, 28, 1);
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
    grid.prepareLayout(60, 8, 20, 1);
    assert.equal(grid.scrollOffset, 30, 'preview must continue beyond the old one-row limit');
    assert.equal(grid.rowY(3), 40, 'command line stays below the code viewport');
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
    grid.prepareLayout(800, 8, 20, 1);
    assert.equal(grid.scrollOffset, 0, 'EOF must not expose empty preview rows');
    assert.equal(grid.needsLowerRows, false);
    grid.apply([['grid_resize', [1, 8, 40]], ['flush']]);
    assert.equal(grid.needsLowerRows, true, 'resize invalidates the cached boundary');
});
