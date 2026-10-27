import { test, expect } from '@playwright/test';
import { electron } from './helpers/electron';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('completion stays opaque and mounted during typing and Backspace with a slow server', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nido-completion-continuity-'));
  const profile = join(root, 'profile');
  const file = join(root, 'sample.txt');
  await mkdir(profile);
  await writeFile(file, '');
  await writeFile(
    join(profile, 'workspaces.json'),
    JSON.stringify({
      version: 1,
      active: 0,
      workspaces: [{ root, current: file, files: [{ path: file, line: 1, column: 0 }] }]
    })
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const running = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], env });
  await running.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false });
  });
  try {
    const page = await running.firstWindow();
    const input = page.getByRole('textbox', { name: 'Neovim input' });
    await expect(input).toBeFocused();
    await page.evaluate(() => localStorage.setItem('nido.animations', 'true'));
    await page.reload();
    await expect(input).toBeFocused();
    const state = await page.evaluate(() => window.nido.restoreWorkspaces());
    const id = state.workspaces[0].id;
    await page.evaluate(
      ({ id, file }) => window.nido.input(id, `<Cmd>lua dofile([[${file}]])<CR>`),
      {
        id,
        file: resolve('tests/fixtures/completion-server.lua').replaceAll('\\', '/')
      }
    );
    await page.evaluate(() => {
      const latency = new Promise<number>((resolve) => {
        let started = 0;
        const onKey = (event: KeyboardEvent): void => {
          if (event.key === '.') started = performance.now();
        };
        document.addEventListener('keydown', onKey);
        const observer = new MutationObserver(() => {
          if (!started || !document.querySelector('[aria-label="Code completion"]')) return;
          observer.disconnect();
          document.removeEventListener('keydown', onKey);
          resolve(performance.now() - started);
        });
        observer.observe(document.body, { childList: true, subtree: true });
      });
      Object.assign(window, { triggerCompletionLatency: latency });
    });
    await page.keyboard.type('i.');
    const menu = page.getByRole('listbox', { name: 'Code completion' });
    await expect(menu).toHaveAttribute('aria-busy', 'false');
    const triggerMs = await page.evaluate(
      () =>
        (window as unknown as { triggerCompletionLatency: Promise<number> })
          .triggerCompletionLatency
    );
    console.log(`Trigger-character completion: ${triggerMs.toFixed(1)} ms`);
    await input.press('Escape');
    await expect(page.locator('[aria-label="Code completion"]')).toHaveCount(0);
    await page.evaluate(({ id }) => window.nido.input(id, '0D'), { id });
    await page.evaluate(() => {
      type Probe = {
        frames: number;
        remounts: number;
        closing: number;
        minOpacity: number;
        latencies: number[];
        started: number;
      };
      const probe: Probe = {
        frames: 0,
        remounts: 0,
        closing: 0,
        minOpacity: 1,
        latencies: [],
        started: 0
      };
      Object.assign(window, { completionProbe: probe });
      document.addEventListener('keydown', (event) => {
        if (event.key === 'p') probe.started = performance.now();
      });
      let previous: Element | null = null;
      const sample = (): void => {
        const list = document.querySelector('[aria-label="Code completion"]');
        if (list) {
          if (previous && list !== previous) probe.remounts++;
          previous = list;
          if (probe.started) {
            probe.latencies.push(performance.now() - probe.started);
            probe.started = 0;
          }
          const card = list.parentElement!;
          probe.frames++;
          if (card.dataset.overlayPhase !== 'open' || card.inert) probe.closing++;
          probe.minOpacity = Math.min(
            probe.minOpacity,
            Number(getComputedStyle(card).opacity),
            ...Array.from(list.querySelectorAll('[role="option"]'), (row) =>
              Number(getComputedStyle(row).opacity)
            )
          );
        } else if (previous) probe.closing++;
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.keyboard.type('ip');
    await expect(menu).toHaveAttribute('aria-busy', 'false');
    await page.evaluate(
      ({ id }) => window.nido.input(id, '<Cmd>lua vim.g.nido_completion_test_delay=90<CR>'),
      { id }
    );
    for (const key of ['r', 'i', 'n', 't', 'l', 'Backspace']) {
      await input.press(key);
      await expect(menu).toHaveAttribute('aria-busy', 'true');
      await expect(menu).toHaveAttribute('aria-busy', 'false');
    }
    const probe = await page.evaluate(
      () =>
        (
          window as unknown as {
            completionProbe: {
              frames: number;
              remounts: number;
              closing: number;
              minOpacity: number;
              latencies: number[];
            };
          }
        ).completionProbe
    );
    const output = test.info().outputPath('completion-continuity.json');
    await writeFile(output, JSON.stringify(probe, null, 2));
    await test
      .info()
      .attach('completion-continuity', { path: output, contentType: 'application/json' });
    expect(probe.frames).toBeGreaterThan(5);
    expect(probe.remounts).toBe(0);
    expect(probe.closing).toBe(0);
    expect(probe.minOpacity).toBe(1);
    await input.press('Tab');
    await expect(menu).toHaveCount(0);
    await expect(page.locator('canvas:visible')).toHaveAttribute(
      'aria-description',
      /printLine|println/
    );
    // Let the deliberately slow server reply; accepting must not reopen completion.
    await page.waitForTimeout(200);
    await expect(menu).toHaveCount(0);
  } finally {
    await running.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
