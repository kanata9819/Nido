import { test, expect, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import type { DocumentSymbolList } from '../src/shared/types';
import type {} from './renderer/harness';

let server: ViteDevServer;
let origin: string;
const errors = new WeakMap<Page, string[]>();
const symbols = [
  { name: 'Widget', kind: 'Class', container: '', line: 1, column: 1 },
  { name: 'run', kind: 'Method', container: 'Widget', line: 3, column: 5 },
  { name: 'render', kind: 'Method', container: 'Widget', line: 7, column: 5 },
  { name: 'helper', kind: 'Function', container: '', line: 15, column: 1 }
];

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
test.beforeEach(({ page }) => {
  const messages: string[] = [];
  errors.set(page, messages);
  page.on('pageerror', (error) => messages.push(error.message));
});
test.afterEach(({ page }) => {
  expect(errors.get(page), 'Symbol navigation must not cause renderer errors').toEqual([]);
});

async function open(page: Page, language = 'en', deferSymbols = false): Promise<void> {
  await page.addInitScript((language) => {
    localStorage.setItem('nido.language', language);
    localStorage.setItem('nido.animations', 'false');
  }, language);
  await page.goto(
    `${origin}?view=app&defer=restoreWorkspaces,openSymbol${deferSymbols ? ',findSymbols' : ''}`
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.rendererTest.pending.some((call) => call.method === 'restoreWorkspaces')
      )
    )
    .toBe(true);
  await page.evaluate(() => {
    window.rendererTest.settle('restoreWorkspaces', 0, {
      workspaces: [
        { id: 'alpha', root: '/alpha', name: 'Alpha' },
        { id: 'beta', root: '/beta', name: 'Beta' },
        { id: 'shell', root: '/shell', name: 'Shell', kind: 'terminal' }
      ],
      active: 'alpha',
      errors: []
    });
    for (const id of ['alpha', 'beta']) {
      window.rendererTest.emit({
        type: 'statePatch',
        id,
        state: {
          current: 1,
          buffers: [{ id: 1, name: `/${id}/main.ts`, modified: false }],
          filetype: 'typescript',
          lsp: 'typescript'
        }
      });
    }
  });
  await expect(
    page.getByRole('textbox', {
      name: language === 'ja' ? 'Neovim入力' : 'Neovim input',
      exact: true
    })
  ).toBeFocused();
}

async function publish(
  page: Page,
  version: number,
  overrides: Partial<DocumentSymbolList> = {},
  id = 'alpha'
): Promise<void> {
  await page.evaluate(
    ({ version, overrides, id, symbols }) => {
      window.rendererTest.emit({
        type: 'statePatch',
        id,
        state: {
          symbols: {
            version,
            buffer: 1,
            loading: false,
            error: '',
            items: symbols,
            ...overrides
          }
        }
      });
    },
    { version, overrides, id, symbols }
  );
}

async function calls(page: Page, method: string): Promise<unknown[][]> {
  return page.evaluate(
    (method) =>
      window.rendererTest.calls.filter((call) => call.method === method).map((call) => call.args),
    method
  );
}

test('file symbols filter names and containers and keyboard selection opens the original symbol index', async ({
  page
}) => {
  await open(page);
  await page.keyboard.press('Control+Shift+o');
  const palette = page.getByRole('dialog', { name: 'symbols palette' });
  const filter = palette.getByRole('combobox', { name: 'Filter items' });
  const results = palette.getByRole('listbox', { name: 'File symbols' });
  await expect(filter).toBeFocused();
  await expect(filter).toHaveAttribute('placeholder', 'Type a symbol name…');
  await expect(filter).toHaveAttribute('aria-expanded', 'true');
  await expect(filter).toHaveAttribute('aria-controls', 'symbol-results');
  await expect(results).toHaveAttribute('aria-busy', 'true');
  await expect.poll(() => calls(page, 'findSymbols')).toEqual([['alpha']]);
  await publish(page, 1);
  await expect(palette.getByText('helper', { exact: true })).toBeVisible();
  await expect(results).toHaveAttribute('aria-busy', 'false');
  await expect(results.getByRole('option')).toHaveCount(4);
  await expect(results.getByRole('option', { selected: true })).toHaveAccessibleName(/^Widget\b/);
  await page.screenshot({ path: 'test-results/document-symbols.png' });
  await filter.fill('render');
  await expect(palette.getByText('render', { exact: true })).toBeVisible();
  await expect(palette.getByText('helper', { exact: true })).toHaveCount(0);
  await filter.fill('widget');
  await expect(palette.getByText('run', { exact: true })).toBeVisible();
  await expect(palette.getByText('render', { exact: true })).toBeVisible();
  await expect(palette.getByText('helper', { exact: true })).toHaveCount(0);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Control+j');
  await page.keyboard.press('Control+k');
  await expect(filter).toHaveAttribute('aria-activedescendant', 'symbol-1');
  await expect(results.getByRole('option', { selected: true })).toHaveAccessibleName(/^run\b/);
  await page.keyboard.press('Enter');
  await expect.poll(() => calls(page, 'openSymbol')).toEqual([['alpha', 2, 1]]);
  await expect(palette).toBeVisible();
  await page.evaluate(() => window.rendererTest.settle('openSymbol', 0, undefined));
  await expect(palette).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Neovim input', exact: true })).toBeFocused();
});

test('large symbol palettes reuse prepared items while selecting and filtering', async ({
  page
}) => {
  await open(page);
  await page.keyboard.press('Control+Shift+o');
  const palette = page.getByRole('dialog', { name: 'symbols palette' });
  const filter = palette.getByRole('combobox', { name: 'Filter items' });
  await expect(filter).toBeFocused();
  await expect.poll(() => calls(page, 'findSymbols')).toEqual([['alpha']]);
  await page.evaluate(() => {
    const metrics = { names: 0 };
    Object.assign(window, { symbolMetrics: metrics });
    window.rendererTest.emit({
      type: 'statePatch',
      id: 'alpha',
      state: {
        symbols: {
          version: 1,
          buffer: 1,
          loading: false,
          error: '',
          items: Array.from({ length: 10000 }, (_, index) => ({
            get name() {
              metrics.names++;
              return `function_${index}`;
            },
            kind: 'Function',
            container: 'Module',
            line: index + 1,
            column: 1
          }))
        }
      }
    });
  });
  await expect(palette.getByRole('option')).toHaveCount(100);
  await page.evaluate(() => {
    (window as unknown as { symbolMetrics: { names: number } }).symbolMetrics.names = 0;
  });
  for (let index = 0; index < 20; index++) await filter.press('ArrowDown');
  await expect(filter).toHaveAttribute('aria-activedescendant', 'symbol-20');
  await filter.fill('function_9999');
  await expect(palette.getByRole('option')).toHaveCount(1);
  const names = await page.evaluate(
    () => (window as unknown as { symbolMetrics: { names: number } }).symbolMetrics.names
  );
  console.log(JSON.stringify({ symbols: 10000, selectionMoves: 20, preparedNameReads: names }));
  expect(names, 'Selection and query changes must reuse the prepared symbol items').toBe(0);
  await filter.press('Enter');
  await expect.poll(() => calls(page, 'openSymbol')).toEqual([['alpha', 10000, 1]]);
});

test('a partial symbol response keeps valid results selectable beside its warning', async ({
  page
}) => {
  await open(page);
  await page.keyboard.press('Control+Shift+o');
  const palette = page.getByRole('dialog', { name: 'symbols palette' });
  await publish(page, 1, { error: 'One language server did not respond.' });
  await expect(
    palette.getByText('One language server did not respond.', { exact: true })
  ).toBeVisible();
  await expect(palette.getByRole('option')).toHaveCount(4);
  await palette.getByRole('combobox', { name: 'Filter items' }).fill('render');
  await expect(palette.getByRole('option')).toHaveCount(1);
  await expect(palette.getByRole('option', { selected: true })).toHaveAccessibleName(/^render\b/);
  await page.keyboard.press('Enter');
  await expect.poll(() => calls(page, 'openSymbol')).toEqual([['alpha', 3, 1]]);
  await page.evaluate(() => window.rendererTest.settle('openSymbol', 0, undefined));
  await expect(palette).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Neovim input', exact: true })).toBeFocused();
});

test('reopening waits for its request version before queued Enter can use a delayed old result', async ({
  page
}) => {
  await open(page, 'en', true);
  await page.keyboard.press('Control+Shift+o');
  const palette = page.getByRole('dialog', { name: 'symbols palette' });
  const results = palette.getByRole('listbox', { name: 'File symbols' });
  await expect.poll(() => calls(page, 'findSymbols')).toEqual([['alpha']]);
  await publish(page, 1, { loading: true, items: [] });
  await page.evaluate(() => window.rendererTest.settle('findSymbols', 0, 1));
  await publish(page, 2);
  await expect(palette.getByRole('option')).toHaveCount(4);
  await page.keyboard.press('Escape');

  await page.keyboard.press('Control+Shift+o');
  await expect.poll(() => calls(page, 'findSymbols')).toEqual([['alpha'], ['alpha']]);
  await page.keyboard.press('Enter');
  await publish(page, 3, {
    items: [{ name: 'staleRequest', kind: 'Function', container: '', line: 1, column: 1 }]
  });
  await expect(results).toHaveAttribute('aria-busy', 'true');
  await expect(palette.getByRole('option')).toHaveCount(0);
  expect(await calls(page, 'openSymbol')).toEqual([]);

  await page.evaluate(() => window.rendererTest.settle('findSymbols', 0, 4));
  await expect(results).toHaveAttribute('aria-busy', 'true');
  await expect(palette.getByRole('option')).toHaveCount(0);
  await publish(page, 5, {
    items: [{ name: 'currentRequest', kind: 'Function', container: '', line: 8, column: 1 }]
  });
  await expect.poll(() => calls(page, 'openSymbol')).toEqual([['alpha', 1, 5]]);
  await page.evaluate(() => window.rendererTest.settle('openSymbol', 0, undefined));
  await expect(palette).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Neovim input', exact: true })).toBeFocused();
});

test('loading Enter waits for symbols while Escape, blur and reopening cannot select stale results', async ({
  page
}) => {
  await open(page);
  const palette = page.getByRole('dialog', { name: 'symbols palette' });
  await page.keyboard.press('Control+Shift+o');
  await publish(page, 1, { loading: true, items: [] });
  await page.keyboard.press('Enter');
  expect(await calls(page, 'openSymbol')).toEqual([]);
  await publish(page, 1);
  await expect.poll(() => calls(page, 'openSymbol')).toEqual([['alpha', 1, 1]]);
  await page.evaluate(() => window.rendererTest.settle('openSymbol', 0, undefined));
  await expect(palette).toHaveCount(0);

  await page.keyboard.press('Control+Shift+o');
  await expect(palette.getByText('Widget', { exact: true })).toHaveCount(0);
  await publish(page, 2, { loading: true, items: [] });
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await publish(page, 2);
  await expect(palette).toHaveCount(0);
  expect((await calls(page, 'openSymbol')).length).toBe(1);

  await page.keyboard.press('Control+Shift+o');
  await publish(page, 3, { loading: true, items: [] });
  await page.keyboard.press('Enter');
  await palette.getByRole('button', { name: 'Close palette' }).focus();
  await publish(page, 3);
  await expect(palette.getByText('Widget', { exact: true })).toBeVisible();
  expect((await calls(page, 'openSymbol')).length).toBe(1);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('textbox', { name: 'Neovim input', exact: true })).toBeFocused();
});

test('file and workspace changes discard old symbol lists without reopening the palette', async ({
  page
}) => {
  await open(page);
  await page.keyboard.press('Control+Shift+o');
  const palette = page.getByRole('dialog', { name: 'symbols palette' });
  await publish(page, 1);
  await expect(palette.getByText('Widget', { exact: true })).toBeVisible();
  await page.evaluate(() =>
    window.rendererTest.emit({ type: 'statePatch', id: 'alpha', state: { current: 2 } })
  );
  await expect(palette.getByText('Widget', { exact: true })).toHaveCount(0);
  await publish(page, 2);
  await expect(palette.getByText('Widget', { exact: true })).toHaveCount(0);
  await publish(page, 3, {
    buffer: 2,
    items: [{ name: 'newFile', kind: 'Function', container: '', line: 4, column: 1 }]
  });
  await expect(palette.getByText('newFile', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Alt+2');
  await page.keyboard.press('Control+Shift+o');
  await expect(palette).toBeVisible();
  await publish(page, 4, { buffer: 2 });
  await expect(palette.getByText('Widget', { exact: true })).toHaveCount(0);
  await publish(
    page,
    1,
    { items: [{ name: 'betaFunction', kind: 'Function', container: '', line: 1, column: 1 }] },
    'beta'
  );
  await expect(palette.getByText('betaFunction', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await publish(page, 2, {}, 'beta');
  await expect(palette).toHaveCount(0);
  expect(await calls(page, 'openSymbol')).toEqual([]);
});

test('symbols are reachable from commands and the leader and stay unavailable in terminal sessions', async ({
  page
}) => {
  await open(page);
  await page.keyboard.press('Control+Shift+p');
  await page.getByRole('textbox', { name: 'Filter items' }).fill('Go to symbol in file');
  await page.keyboard.press('Enter');
  const palette = page.getByRole('dialog', { name: 'symbols palette' });
  await expect(palette).toBeVisible();
  await expect.poll(() => calls(page, 'findSymbols')).toEqual([['alpha']]);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Space');
  await page.keyboard.press('o');
  await expect(palette).toBeVisible();
  await expect.poll(() => calls(page, 'findSymbols')).toEqual([['alpha'], ['alpha']]);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Alt+3');
  await expect(page.getByRole('tab', { name: 'Workspace Shell', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await page.keyboard.press('Control+Shift+o');
  await expect(palette).toHaveCount(0);
  expect((await calls(page, 'findSymbols')).length).toBe(2);
  await page.keyboard.press('Control+Shift+p');
  await page.getByRole('textbox', { name: 'Filter items' }).fill('Go to symbol in file');
  await expect(page.getByRole('button', { name: /Go to symbol in file/ })).toHaveCount(0);
});

test('Japanese symbol search explains empty and unsupported files without opening a selection', async ({
  page
}) => {
  await open(page, 'ja');
  await page.keyboard.press('Control+Shift+o');
  const filter = page.getByPlaceholder('シンボル名を入力…');
  await expect(filter).toBeFocused();
  await expect(page.getByText('ファイル内のシンボル', { exact: true })).toBeVisible();
  await publish(page, 1, { items: [] });
  await expect(
    page.getByText('このファイルにシンボルはありません。', { exact: true })
  ).toBeVisible();
  await page.keyboard.press('Enter');
  expect(await calls(page, 'openSymbol')).toEqual([]);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Shift+o');
  await publish(page, 2, {
    items: [],
    error: 'No language server supports symbols for this file.'
  });
  await expect(
    page.getByText('このファイルのシンボル検索に対応する言語サーバーがありません。', {
      exact: true
    })
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('textbox', { name: 'Neovim入力', exact: true })).toBeFocused();
});
