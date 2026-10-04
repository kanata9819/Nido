import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('Sticky Scroll pins nested headers, jumps by mouse and keyboard, and saves its settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-sticky-ui-'));
    const profile = join(root, 'profile');
    const file = join(root, 'scopes.txt');
    await mkdir(profile);
    await writeFile(
        file,
        [
            'class Panel {',
            '  render() {',
            '    if (ready) {',
            ...Array.from({ length: 40 }, (_, i) => `      item${i}();`),
            '    }',
            ...Array.from({ length: 30 }, (_, i) => `    after${i}();`),
            '  }',
            '}',
            ...Array.from({ length: 70 }, () => 'outside();')
        ].join('\n')
    );
    await writeFile(
        join(profile, 'workspaces.json'),
        JSON.stringify({
            version: 1,
            active: 0,
            workspaces: [{ root, current: file, files: [{ path: file, line: 1, column: 0 }] }],
            window: { width: 1100, height: 800, maximized: false }
        })
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const running = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], env });
    try {
        const page = await running.firstWindow();
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        const display = page.locator('canvas[aria-label="Neovim editor display"]:visible');
        await expect(display).toHaveAttribute('aria-description', /class Panel/);
        const send = async (keys: string): Promise<void> => {
            await page.evaluate(async (keys) => {
                const layout = await window.nido.restoreWorkspaces();
                await window.nido.input(layout.workspaces[0].id, keys);
            }, keys);
        };
        const sticky = page.getByRole('navigation', { name: 'Sticky Scroll' });
        await expect(sticky).toHaveCount(0);
        await display.evaluate((node) => {
            window.nido.onEvent((event) => {
                if (event.type !== 'redraw') return;
                for (const [name, ...calls] of event.events) {
                    if (name === 'nido_sticky_scroll') node.dataset.sticky = JSON.stringify(calls.at(-1));
                }
            });
        });
        await send('<Cmd>set syntax=typescript<CR><Cmd>normal! 20Gzt<CR>');
        await expect(display).toHaveAttribute('aria-description', /item16/);
        await expect.poll(() => display.getAttribute('data-sticky')).not.toBeNull();
        await expect(sticky.getByRole('button')).toHaveCount(3);
        await expect(sticky.locator('[data-source-line="1"]')).toContainText('class Panel');
        await expect(sticky.locator('[data-source-line="2"]')).toContainText('render()');
        await page.screenshot({
            path: 'C:/Users/taka9/.codex/visualizations/2026/10/04/01a10505-e4c9-7da0-8c10-398bac9823f1/sticky-scroll.png'
        });

        await page.keyboard.press('Alt+Shift+S');
        await expect(sticky.locator('[data-source-line="1"]')).toBeFocused();
        await page.keyboard.press('j');
        await expect(sticky.locator('[data-source-line="2"]')).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
        await expect(page.locator('body')).toContainText('Ln 2, Col 1');

        await send('<Cmd>normal! 20Gzt<CR>');
        const condition = sticky.locator('[data-source-line="3"]');
        await expect(condition).toBeVisible();
        await page.keyboard.down('Shift');
        await condition.hover();
        await expect(condition).toHaveAttribute('aria-label', 'Go to line 44');
        await condition.click({ modifiers: ['Shift'] });
        await page.keyboard.up('Shift');
        await expect(page.locator('body')).toContainText('Ln 44, Col 1');
        await send('<Cmd>normal! 20Gzt<CR>');
        await expect(sticky.getByRole('button')).toHaveCount(3);
        await page.reload();
        await expect(sticky.getByRole('button')).toHaveCount(3);
        await page.keyboard.type(' ,');
        await page.getByRole('spinbutton', { name: 'Sticky Scroll maximum lines' }).fill('1');
        await page.keyboard.press('Escape');
        await expect(sticky.getByRole('button')).toHaveCount(1);
        await page.keyboard.type(' ,');
        await page.getByRole('checkbox', { name: 'Sticky Scroll', exact: true }).uncheck();
        await page.keyboard.press('Escape');
        await expect(sticky).toHaveCount(0);
        await page.reload();
        await expect(display).toHaveAttribute('aria-description', /item/);
        await expect(sticky).toHaveCount(0);
        await expect
            .poll(() => page.evaluate(() => localStorage.getItem('nido.stickyScroll')))
            .toBe('false');
        await expect
            .poll(() => page.evaluate(() => localStorage.getItem('nido.stickyScrollMaxLines')))
            .toBe('1');
        expect(errors).toEqual([]);
    } finally {
        await running.close();
        await rm(root, { recursive: true, force: true });
    }
});

