import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('bracket pair guides connect scopes and track the active scope and virtual rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-bracket-guides-ui-'));
    const profile = join(root, 'profile');
    const file = join(root, 'scope.txt');
    const content = [
        'pub fn apply_csi(&mut self, csi: &CsiActions) {',
        '    match csi {',
        '        CursorPosition { row, col } => {',
        '            self.set_cursor(*row, *col);',
        '        }',
        '        EraseDisplay { mode } => {',
        '            // modeについて',
        '            // 0 : カーソルから画面末尾まで',
        '            match mode {',
        '                0 => {},',
        '                1 => {},',
        '                2 => {},',
        '                _ => {},',
        '            }',
        '        }',
        '    }',
        '}',
        '',
        ...Array.from({ length: 50 }, (_, i) => `// filler ${i}`)
    ].join('\n');
    await mkdir(profile);
    await writeFile(file, content);
    await writeFile(
        join(profile, 'workspaces.json'),
        JSON.stringify({
            version: 1,
            active: 0,
            workspaces: [{ root, current: file, files: [{ path: file, line: 8, column: 12 }] }],
            window: { width: 1100, height: 850, maximized: false }
        })
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const running = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], env });
    try {
        const page = await running.firstWindow();
        const canvas = page.locator('canvas:visible');
        await expect(canvas).toHaveAttribute('aria-description', /apply_csi/);
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await canvas.evaluate((node: HTMLCanvasElement) => {
            window.nido.onEvent((event) => {
                if (event.type !== 'redraw') return;
                for (const [name, ...calls] of event.events) {
                    if (name === 'nido_bracket_guides')
                        node.dataset.guides = JSON.stringify(calls.at(-1)![0]);
                }
            });
            const ctx = node.getContext('2d')!;
            node.dataset.indentLines = '[]';
            const originalFill = CanvasRenderingContext2D.prototype.fillRect;
            CanvasRenderingContext2D.prototype.fillRect = function (x, y, width, height) {
                if (
                    this.canvas !== node &&
                    width <= 1 &&
                    height > 10 &&
                    ['#75633f', '#476a86', '#745781', '#467568', '#805655', '#647747'].includes(
                        String(this.fillStyle)
                    )
                ) {
                    const lines = JSON.parse(node.dataset.indentLines!);
                    lines.push({ x, width });
                    node.dataset.indentLines = JSON.stringify(lines);
                }
                originalFill.call(this, x, y, width, height);
            };
            const fill = ctx.fillRect.bind(ctx);
            ctx.fillRect = (x, y, width, height) => {
                if (x === 0 && y === 0 && height > 100) node.dataset.guideLines = '[]';
                if (ctx.globalAlpha === 0.9) {
                    const lines = JSON.parse(node.dataset.guideLines || '[]');
                    lines.push({ x, y, width, height });
                    node.dataset.guideLines = JSON.stringify(lines);
                }
                fill(x, y, width, height);
            };
        });
        const send = async (keys: string): Promise<void> => {
            await page.evaluate(async (keys) => {
                const state = await window.nido.restoreWorkspaces();
                await window.nido.input(state.workspaces[0].id, keys);
            }, keys);
        };
        await send('<Cmd>set syntax=rust shiftwidth=4<CR>');
        const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        await page.setViewportSize({ ...viewport, width: viewport.width + 1 });
        await expect
            .poll(async () => JSON.parse((await canvas.getAttribute('data-guides')) || '[]').length)
            .toBe(5);
        await page.keyboard.type('8G');
        const active = async (): Promise<{ top: number; bottom: number }[]> =>
            JSON.parse((await canvas.getAttribute('data-guides')) || '[]').filter(
                (guide: { active: boolean }) => guide.active
            );
        await expect
            .poll(async () => (await active()).map(({ top, bottom }) => [top, bottom]))
            .toEqual([[5, 14]]);
        await expect
            .poll(
                async () =>
                    JSON.parse((await canvas.getAttribute('data-guide-lines')) || '[]').length
            )
            .toBe(3);
        const edges = await canvas.evaluate((node: HTMLCanvasElement) => {
            const guide = JSON.parse(node.dataset.guides!).find(
                (item: { active: boolean }) => item.active
            );
            const line = JSON.parse(node.dataset.guideLines!).find(
                (item: { width: number; height: number }) => item.height > item.width
            );
            const width = node.getContext('2d')!.measureText('M').width;
            const dpr = window.devicePixelRatio;
            return {
                aligned: JSON.parse(node.dataset.indentLines!).some(
                    (indent: { x: number; width: number }) =>
                        Math.abs(indent.x - line.x) < 0.001 &&
                        Math.abs(indent.width - line.width) < 0.001
                ),
                right: line.x + line.width,
                bracket: Math.round(guide.closing * width * dpr) / dpr
            };
        });
        expect(edges.right).toBeLessThanOrEqual(edges.bracket);
        expect(edges.aligned).toBe(true);
        await canvas.screenshot({ path: 'test-results/bracket-pair-guides.png' });
        await send(
            "<Cmd>lua vim.api.nvim_buf_set_extmark(0, vim.api.nvim_create_namespace('guide-lens-test'), 5, 0, {virt_lines={{{'Run Tests', 'NidoCodeLens'}}}, virt_lines_above=true})<CR>"
        );
        await expect
            .poll(async () => (await active()).map(({ top, bottom }) => [top, bottom]))
            .toEqual([[6, 15]]);
        await page.keyboard.type('4G');
        await expect
            .poll(async () => (await active()).map(({ top, bottom }) => [top, bottom]))
            .toEqual([[2, 4]]);
        await canvas.hover();
        await page.mouse.wheel(0, 500);
        await expect
            .poll(async () => JSON.parse((await canvas.getAttribute('data-guides')) || '[]').length)
            .toBe(0);
        expect(errors).toEqual([]);
    } finally {
        await running.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});
