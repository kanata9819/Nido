import { test, expect } from '@playwright/test';
import { electron } from './helpers/electron';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installRowImageProbe } from './helpers/row-image-probe';

test('fast gestures reach both file edges without a slow final approach', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nido-fast-scroll-boundary-'));
  const profile = join(root, 'profile');
  const file = join(root, 'rows.txt');
  await mkdir(profile);
  await writeFile(file, Array.from({ length: 1000 }, (_, i) => `ROW_${i + 1}`).join('\n'));
  await writeFile(
    join(profile, 'workspaces.json'),
    JSON.stringify({
      version: 1,
      active: 0,
      window: { width: 1100, height: 850, maximized: false },
      workspaces: [{ root, current: file, files: [{ path: file, line: 1, column: 0 }] }]
    })
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const running = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], env });
  try {
    const page = await running.firstWindow();
    await page.addInitScript(installRowImageProbe);
    await page.reload();
    const canvas = page.locator('canvas:visible');
    await expect(canvas).toHaveAttribute('aria-description', /ROW_1/);
    await canvas.evaluate((node: HTMLCanvasElement) => {
      const context = node.getContext('2d')!;
      const draw = context.drawImage.bind(context);
      context.drawImage = ((...args: Parameters<typeof draw>) => {
        if (args.length === 5 && Number(args[2]) + Number(args[4]) > 0) {
          const source = args[0] as HTMLCanvasElement;
          const row = source.dataset.rowText?.match(/ROW_(\d+)/);
          if (row) {
            const height = Number(localStorage.getItem('nido.lineHeight'));
            const baseline = Number(source.dataset.rowBaseline);
            const phase = (baseline - Math.floor(baseline)) / devicePixelRatio;
            node.dataset.documentTop = String(
              (Number(row[1]) - 1) * height - Number(args[2]) - phase
            );
          }
        }
        draw(...args);
      }) as typeof draw;
    });
    const restored = await page.evaluate(() => window.nido.restoreWorkspaces());
    const id = restored.workspaces[0].id;
    const top = async (): Promise<number> => Number(await canvas.getAttribute('data-document-top'));
    const reports: object[] = [];
    for (const direction of [-1, 1]) {
      await page.evaluate(
        async ({ id, direction }) => {
          await window.nido.input(id, direction < 0 ? 'gg' : 'Gzt');
          await window.nido.scroll(id, direction * 1000, true, true);
          await window.nido.prefetchScroll(id, direction > 0);
        },
        { id, direction }
      );
      await expect(canvas).toHaveAttribute(
        'aria-description',
        direction < 0 ? /ROW_1\s/ : /ROW_1000\s/
      );
      // Warm the exact edge, then move eight rows away without changing the buffer.
      await canvas.evaluate(async () => {
        for (let i = 0; i < 2; i++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      });
      const edge = await top();
      const height = await page.evaluate(() => Number(localStorage.getItem('nido.lineHeight')));
      await page.evaluate(
        async ({ id, direction }) => {
          await window.nido.scroll(id, -direction * 8, true, true);
          await window.nido.prefetchScroll(id, direction > 0);
        },
        { id, direction }
      );
      await expect
        .poll(async () => Math.abs((await top()) - edge + direction * 8 * height))
        .toBeLessThan(1);
      const approached = await canvas.evaluate(async (node, direction) => {
        node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: direction * 2160 }));
        node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: direction * 2160 }));
        for (let i = 0; i < 4; i++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
        return Number((node as HTMLCanvasElement).dataset.documentTop);
      }, direction);
      reports.push({ direction, edge, approached });
      expect(Math.abs(approached - edge), JSON.stringify(reports)).toBeLessThanOrEqual(1);
    }
    await writeFile('test-results/fast-scroll-boundary.json', JSON.stringify(reports, null, 2));
  } finally {
    await running.evaluate(({ app }) => app.exit(0));
    await running.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('upward touchpad gestures stop at the first row while replies are delayed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nido-scroll-boundary-'));
  const profile = join(root, 'profile');
  const file = join(root, 'ReferencesPanel.tsx');
  const source = await readFile('src/renderer/src/components/ReferencesPanel.tsx', 'utf8');
  const startLine = source.split('\n').findIndex((line) => line.includes('referencesToolbar')) + 1;
  expect(startLine).toBeGreaterThan(100);
  await mkdir(profile);
  await writeFile(file, source);
  await writeFile(
    join(profile, 'workspaces.json'),
    JSON.stringify({
      version: 1,
      active: 0,
      window: { width: 960, height: 900, maximized: false },
      workspaces: [{ root, current: file, files: [{ path: file, line: startLine, column: 0 }] }]
    })
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.NIDO_PACKAGED_EXE;
  const running = await electron.launch({
    executablePath,
    args: [...(executablePath ? [] : ['.']), `--user-data-dir=${profile}`],
    env
  });
  try {
    const page = await running.firstWindow();
    const canvas = page.locator('canvas:visible');
    await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    if (process.env.NIDO_TEST_THEME === 'acrylic') {
      await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption('acrylic');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'acrylic');
    }
    await page.getByRole('checkbox', { name: 'Cursor follows scrolling' }).uncheck();
    await page.getByRole('checkbox', { name: 'Relative line numbers' }).check();
    await page.keyboard.press('Escape');
    await canvas.evaluate(installRowImageProbe);
    await canvas.evaluate((node: HTMLCanvasElement) => {
      const measurement = {
        samples: [] as { text: string; y: number; at: number }[],
        events: [] as unknown[]
      };
      Object.assign(window, { boundaryMeasurement: measurement });
      const context = node.getContext('2d')!;
      const fill = context.fillRect.bind(context);
      const draw = context.drawImage.bind(context);
      let first = true;
      context.fillRect = (x, y, width, height) => {
        if (x === 0 && y === 0 && height > 100) first = true;
        fill(x, y, width, height);
      };
      context.drawImage = ((...args: Parameters<typeof draw>) => {
        if (first && args.length === 5 && Number(args[2]) + Number(args[4]) > 0) {
          first = false;
          const source = args[0] as HTMLCanvasElement;
          const baseline = Number(source.dataset.rowBaseline);
          const phase = (baseline - Math.floor(baseline)) / devicePixelRatio;
          const sample = {
            text: source.dataset.rowText ?? '',
            y: Number(args[2]) + phase,
            at: performance.now()
          };
          measurement.samples.push(sample);
          node.dataset.boundaryTop = String(sample.y);
        }
        draw(...args);
      }) as typeof draw;
      window.nido.onEvent((event) => {
        if (event.type === 'redraw')
          measurement.events.push(event.events.filter(([name]) => name.startsWith('nido_')));
      });
    });
    await page.keyboard.type(`${startLine}Gzt`);
    await expect(canvas).toHaveAttribute('aria-description', /referencesToolbar/);
    await running.evaluate(({ ipcMain }) => {
      const handlers = (
        ipcMain as unknown as {
          _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
        }
      )._invokeHandlers;
      for (const [name, delay] of [
        ['nido:scroll', 80],
        ['nido:prefetchScroll', 60]
      ] as const) {
        const original = handlers.get(name)!;
        handlers.set(name, async (...args) => {
          await new Promise((resolve) => setTimeout(resolve, delay));
          return original(...args);
        });
      }
    });
    // Wrapped rows and wheel sensitivity change the distance to the first line.
    // Keep exercising the wheel path until it reaches the boundary under test.
    await expect
      .poll(
        async () => {
          await canvas.evaluate(async (node) => {
            for (let index = 0; index < 30; index++) {
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
              node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -60 }));
            }
          });
          return canvas.getAttribute('aria-description');
        },
        { timeout: 15000, intervals: [0] }
      )
      .toMatch(/import.*useLayoutEffect/);
    await page.waitForTimeout(400);
    // A language-server decoration can scroll the grid without moving the viewport.
    const restored = await page.evaluate(() => window.nido.restoreWorkspaces());
    await page.evaluate(async (id) => {
      await window.nido.input(id, 'gg');
      await window.nido.input(
        id,
        ":lua local ns=vim.api.nvim_create_namespace('boundary-test'); vim.api.nvim_buf_set_extmark(0,ns,0,0,{virt_lines={{{'VIRTUAL_GHOST','Normal'}}},virt_lines_above=true}); vim.fn.winrestview({topline=1,topfill=1}); vim.cmd.redraw()<CR>"
      );
      await window.nido.input(
        id,
        ":lua vim.api.nvim_buf_clear_namespace(0,vim.api.nvim_create_namespace('boundary-test'),0,-1); vim.cmd.redraw()<CR>"
      );
      await window.nido.inputMode(id);
    }, restored.active);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                boundaryMeasurement: { samples: { text: string }[] };
              }
            ).boundaryMeasurement.samples.at(-1)?.text
        )
      )
      .toMatch(/import.*useLayoutEffect/);
    await canvas.evaluate(async (node) => {
      (
        window as unknown as {
          boundaryMeasurement: { samples: unknown[]; events: unknown[] };
        }
      ).boundaryMeasurement.samples = [];
      for (let index = 0; index < 60; index++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        node.dispatchEvent(
          new WheelEvent('wheel', { bubbles: true, deltaY: index % 2 ? -2 : -20 })
        );
      }
    });
    await page.waitForTimeout(300);
    const measured = await page.evaluate(
      () =>
        (
          window as unknown as {
            boundaryMeasurement: {
              samples: { text: string; y: number; at: number }[];
              events: unknown[];
            };
          }
        ).boundaryMeasurement
    );
    await writeFile('test-results/scroll-boundary.json', JSON.stringify(measured, null, 2));
    expect(measured.samples.length).toBeGreaterThan(10);
    expect(
      measured.samples.every(
        (sample) => sample.y === 0 && /import.*useLayoutEffect/.test(sample.text)
      ),
      JSON.stringify(
        measured.samples.filter(
          (sample) => sample.y !== 0 || !/import.*useLayoutEffect/.test(sample.text)
        )
      )
    ).toBe(true);
    await canvas.screenshot({ path: 'test-results/scroll-boundary.png' });
  } finally {
    await running.evaluate(({ app }) => app.exit(0));
    await running.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
