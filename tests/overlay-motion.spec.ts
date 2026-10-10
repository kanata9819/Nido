import { test, expect, type Page, type Locator } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import type {} from './renderer/harness';
import type { NidoEvent } from '../src/shared/types';
import { applyNeovimUI, emptyNeovimUI } from '../src/shared/neovimUI';

let server: ViteDevServer;
let origin: string;
test.beforeAll(async () => {
    server = await createServer({
        configFile: false,
        root: resolve('tests/renderer'),
        plugins: [react()],
        server: { host: '127.0.0.1', port: 0, fs: { allow: [process.cwd()] } }
    });
    await server.listen();
    origin = server.resolvedUrls!.local[0];
});
test.afterAll(async () => server?.close());

async function openApp(page: Page, animations = true, reducedMotion = false): Promise<void> {
    await page.addInitScript((enabled) => {
        localStorage.setItem('nido.language', 'en');
        localStorage.setItem('nido.animations', String(enabled));
    }, animations);
    await page.emulateMedia({ reducedMotion: reducedMotion ? 'reduce' : 'no-preference' });
    await page.goto(`${origin}?view=app`);
    await expect(page.getByRole('textbox', { name: 'Neovim input', exact: true })).toBeFocused();
    await page.clock.install({ time: new Date(0) });
    await page.clock.pauseAt(new Date(1000));
    await page.evaluate(() => {
        // Pause actual CSS transitions on their first frame, independent of CI wall time.
        document.addEventListener('transitionrun', (event) => {
            const element = event.target as HTMLElement;
            if (event.propertyName !== 'opacity' || !element.hasAttribute('data-overlay-motion')) {
                return;
            }
            element.dataset.testOpacityRuns = String(
                Number(element.dataset.testOpacityRuns || 0) + 1
            );
            for (const animation of element.getAnimations()) {
                animation.pause();
            }
        });
    });
}

async function emit(page: Page, event: NidoEvent): Promise<void> {
    await page.evaluate((event) => window.rendererTest.emit(event), event);
}

async function expectOpening(card: Locator): Promise<void> {
    await expect(card).toHaveAttribute('data-overlay-phase', 'open');
    await expect(card).toHaveAttribute('data-test-opacity-runs', /[1-9]/);
    expect(
        await card.evaluate((node) =>
            node
                .getAnimations()
                .some(
                    (animation) =>
                        Number(animation.effect?.getTiming().duration) > 0 &&
                        animation.playState === 'paused'
                )
        )
    ).toBe(true);
    await card.evaluate((node) => node.getAnimations().forEach((animation) => animation.finish()));
}

async function expectClosing(page: Page, card: Locator): Promise<void> {
    await expect(card).toHaveAttribute('data-overlay-phase', 'closing');
    await expect(card).toHaveAttribute('inert', '');
    await expect(card).toHaveAttribute('aria-hidden', 'true');
    await expect(card).toHaveCSS('pointer-events', 'none');
    await expect
        .poll(async () => Number(await card.getAttribute('data-test-opacity-runs')))
        .toBeGreaterThanOrEqual(2);
    expect(
        await card.evaluate((node) =>
            node
                .getAnimations()
                .some(
                    (animation) =>
                        animation.playState === 'paused' &&
                        (animation.effect as KeyframeEffect).getKeyframes().at(-1)?.opacity === '0'
                )
        )
    ).toBe(true);
    await page.clock.runFor(160);
    await expect(card).toHaveCount(0);
}

function command(text = '日本語', firstCharacter = '/'): NidoEvent {
    return {
        type: 'neovimUI',
        id: 'alpha',
        state: applyNeovimUI(emptyNeovimUI(), 'cmdline_show', [
            [[0, text]],
            Buffer.byteLength(text),
            firstCharacter,
            '',
            0,
            1
        ])
    };
}

test('search fades in and out without moving the IME anchor or delaying editor input', async ({
    page
}) => {
    await openApp(page);
    await emit(page, command());
    const card = page.locator('[data-neovim-ui][role="dialog"]');
    const input = page.getByRole('textbox', { name: 'Neovim input', exact: true });
    await expectOpening(card);
    await expect(input).toBeFocused();
    const alignment = await input.evaluate((node) => {
        const caret = document.querySelector('[data-neovim-caret]')!.getBoundingClientRect();
        const input = node.getBoundingClientRect();
        return Math.max(Math.abs(caret.x - input.x), Math.abs(caret.y - input.y));
    });
    expect(alignment).toBeLessThan(1);
    const starts = await card.getAttribute('data-test-opacity-runs');
    await emit(page, command('日本語の続き'));
    await expect(card).toContainText('日本語の続き');
    expect(await card.getAttribute('data-test-opacity-runs')).toBe(starts);
    await emit(page, { type: 'neovimUI', id: 'alpha', state: emptyNeovimUI() });
    await expect(card).toHaveAttribute('data-overlay-phase', 'closing');
    await expect(card).toContainText('日本語の続き');
    await expect(input).not.toHaveAttribute('data-nvim-command-active');
    await expect(input).toBeFocused();
    // Logical closure returns input immediately, even though the fading card still exists.
    await input.press('x');
    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    window.rendererTest.calls.filter((call) => call.method === 'input').at(-1)?.args
            )
        )
        .toEqual(['alpha', 'x']);
    await expectClosing(page, card);
});

test('reopening during the fade cancels removal and shows the new search', async ({ page }) => {
    await openApp(page);
    const card = page.locator('[data-neovim-ui][role="dialog"]');
    await emit(page, command('first'));
    await expectOpening(card);
    await emit(page, { type: 'neovimUI', id: 'alpha', state: emptyNeovimUI() });
    await expect(card).toHaveAttribute('data-overlay-phase', 'closing');
    await page.clock.runFor(50);
    await emit(page, command('second', '?'));
    await expect(card).toHaveAttribute('data-overlay-phase', 'open');
    await expect(card).not.toHaveAttribute('inert');
    await page.clock.runFor(200);
    await expect(card).toContainText('?second');
});

for (const disabledBy of ['setting', 'system'] as const) {
    test(`search opens and closes immediately when motion is disabled by ${disabledBy}`, async ({
        page
    }) => {
        await openApp(page, disabledBy !== 'setting', disabledBy === 'system');
        await emit(page, command());
        const card = page.locator('[data-neovim-ui][role="dialog"]');
        await expect(card).toHaveAttribute('data-overlay-motion', 'false');
        expect(await card.evaluate((node) => node.getAnimations().length)).toBe(0);
        await emit(page, { type: 'neovimUI', id: 'alpha', state: emptyNeovimUI() });
        await expect(card).toHaveCount(0);
    });
}

test('changing reduced motion during a fade removes the closing card immediately', async ({
    page
}) => {
    await openApp(page);
    const card = page.locator('[data-neovim-ui][role="dialog"]');
    await emit(page, command());
    await expectOpening(card);
    await emit(page, { type: 'neovimUI', id: 'alpha', state: emptyNeovimUI() });
    await expect(card).toHaveAttribute('data-overlay-phase', 'closing');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(card).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.clock.runFor(200);
    await expect(card).toHaveCount(0);
});

test('file palettes and the keyboard guide fade away while restoring editor focus', async ({
    page
}) => {
    await openApp(page);
    const input = page.getByRole('textbox', { name: 'Neovim input', exact: true });
    await page.keyboard.press('Control+p');
    const scrim = page.locator('[data-overlay-motion]:has(> [data-panel="files"])');
    await expectOpening(scrim);
    await page.keyboard.press('Escape');
    await expect(input).toBeFocused();
    await expectClosing(page, scrim);
    await page.keyboard.press('Space');
    const guide = page.locator('[role="dialog"][aria-label="Keyboard commands"]');
    await expectOpening(guide);
    await page.keyboard.press('Escape');
    await expect(input).toBeFocused();
    await expectClosing(page, guide);
});

test('completion, hover, diagnostics, messages and manually dismissed notifications share open and close motion', async ({
    page
}) => {
    await openApp(page);
    const scenarios: { open: NidoEvent; close: NidoEvent; selector: string }[] = [
        {
            open: {
                type: 'redraw',
                id: 'alpha',
                events: [['popupmenu_show', [[['value', 'Variable', '', '']], 0, 0, 0, 1]]]
            },
            close: { type: 'redraw', id: 'alpha', events: [['popupmenu_hide', []]] },
            selector: '[data-overlay-motion]:has(> [role="listbox"][aria-label="Code completion"])'
        },
        {
            open: { type: 'hover', id: 'alpha', markdown: 'A helpful type', codeBlocks: [] },
            close: { type: 'hover', id: 'alpha', markdown: '', codeBlocks: [] },
            selector: '[data-type-information]'
        },
        {
            open: {
                type: 'diagnostics',
                id: 'alpha',
                focus: true,
                items: [
                    {
                        path: '/alpha/a.ts',
                        line: 1,
                        column: 1,
                        severity: 1,
                        message: 'A diagnostic'
                    }
                ]
            },
            close: { type: 'diagnostics', id: 'alpha', focus: false, items: [] },
            selector: '[data-diagnostic-information]'
        },
        {
            open: {
                type: 'neovimUI',
                id: 'alpha',
                state: applyNeovimUI(emptyNeovimUI(), 'msg_show', [
                    'echo',
                    [[0, 'A message']],
                    false
                ])
            },
            close: { type: 'neovimUI', id: 'alpha', state: emptyNeovimUI() },
            selector: '[data-neovim-ui][aria-label="Neovim messages"]'
        }
    ];
    for (const scenario of scenarios) {
        await emit(page, scenario.open);
        const card = page.locator(scenario.selector);
        await expectOpening(card);
        await emit(page, scenario.close);
        await expectClosing(page, card);
    }
    await emit(page, {
        type: 'notification',
        id: 'alpha',
        severity: 'info',
        title: 'Saved',
        message: 'Ready'
    });
    const notice = page.locator('aside[aria-label="Saved"]');
    await expectOpening(notice);
    await notice.getByRole('button', { name: 'Dismiss notification' }).click();
    await expectClosing(page, notice);
});

test('explorer closing releases the native modal immediately and keeps its fading position', async ({
    page
}) => {
    await openApp(page);
    const trigger = page.getByRole('button', { name: 'Explorer commands', exact: true });
    await trigger.click();
    const dialog = page.locator('dialog[data-explorer-commands]');
    await expectOpening(dialog);
    const before = await dialog.boundingBox();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveAttribute('data-overlay-phase', 'closing');
    expect(await dialog.evaluate((node) => node.matches(':modal'))).toBe(false);
    expect(await dialog.boundingBox()).toEqual(before);
    await page.clock.runFor(20);
    await expect(page.getByRole('tree', { name: 'Project files' })).toBeFocused();
    await expectClosing(page, dialog);
    // Reopening mounts a functioning native dialog again.
    await trigger.click();
    await expect(dialog).toHaveAttribute('open', '');
    expect(await dialog.evaluate((node) => node.matches(':modal'))).toBe(true);
});

test('changing the animation setting takes effect for palettes and subsequent searches', async ({
    page
}) => {
    await openApp(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const scrim = page.locator('[data-overlay-motion]:has(> [data-panel="settings"])');
    await expectOpening(scrim);
    await page.getByRole('checkbox', { name: 'UI animations', exact: true }).uncheck();
    await expect(scrim).toHaveAttribute('data-overlay-motion', 'false');
    await page.keyboard.press('Escape');
    await expect(scrim).toHaveCount(0);
    const card = page.locator('[data-neovim-ui][role="dialog"]');
    await emit(page, command());
    await expect(card).toHaveAttribute('data-overlay-motion', 'false');
    expect(await card.evaluate((node) => node.getAnimations().length)).toBe(0);
    await emit(page, { type: 'neovimUI', id: 'alpha', state: emptyNeovimUI() });
    await expect(card).toHaveCount(0);
});

test('command completion fades independently without moving or closing the command card', async ({
    page
}) => {
    await openApp(page);
    let state = applyNeovimUI(emptyNeovimUI(), 'cmdline_show', [[[0, 'echo']], 4, ':', '', 0, 1]);
    await emit(page, { type: 'neovimUI', id: 'alpha', state });
    const card = page.locator('[data-neovim-ui][role="dialog"]');
    await expectOpening(card);
    state = applyNeovimUI(state, 'popupmenu_show', [[['echo', '', '', '']], 0, 0, 0, -1]);
    await emit(page, { type: 'neovimUI', id: 'alpha', state });
    const completion = page.locator('[role="listbox"][aria-label="Command completion"]');
    await expectOpening(completion);
    state = applyNeovimUI(state, 'popupmenu_hide', []);
    await emit(page, { type: 'neovimUI', id: 'alpha', state });
    await expectClosing(page, completion);
    await expect(card).toHaveAttribute('data-overlay-phase', 'open');
    await expect(card).toContainText(':echo');
    await expect(
        page.getByRole('textbox', { name: 'Neovim input', exact: true })
    ).not.toHaveAttribute('aria-controls');
});

test('reference preview fades on focus changes and retains the selected source while closing', async ({
    page
}) => {
    await openApp(page);
    await emit(page, {
        type: 'statePatch',
        id: 'alpha',
        state: {
            references: {
                version: 1,
                loading: false,
                error: '',
                items: [{ path: '/alpha/first.ts', line: 1, column: 1, text: 'A reference' }]
            }
        }
    });
    await page.clock.runFor(20);
    const preview = page.locator('[aria-label="Reference preview"]');
    await expectOpening(preview);
    await expect(preview).toContainText('/alpha/first.ts');
    await page.getByRole('textbox', { name: 'Neovim input', exact: true }).focus();
    await expect(preview).toHaveAttribute('data-overlay-phase', 'closing');
    await expect(preview).toContainText('/alpha/first.ts');
    await expectClosing(page, preview);
});
