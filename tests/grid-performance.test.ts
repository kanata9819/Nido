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
