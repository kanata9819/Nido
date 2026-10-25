import { test, expect, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import type {} from './renderer/harness';
import rustPack from '../resources/nido/language-packs/rust/pack.json';

declare global {
  interface Window {
    explorerMetrics: { searches: number; writes: number; bytes: number };
  }
}

let server: ViteDevServer;
let origin: string;
interface RuntimeDiagnostics {
  pageErrors: string[];
  consoleErrors: {
    text: string;
    location: { url: string; lineNumber: number; columnNumber: number };
  }[];
  requestFailures: { url: string; method: string; error?: string }[];
  httpErrors: { url: string; status: number; statusText: string }[];
}
const runtimeDiagnostics = new WeakMap<Page, RuntimeDiagnostics>();
test.beforeEach(({ page }) => {
  const diagnostics: RuntimeDiagnostics = {
    pageErrors: [],
    consoleErrors: [],
    requestFailures: [],
    httpErrors: []
  };
  runtimeDiagnostics.set(page, diagnostics);
  page.on('pageerror', (error) => diagnostics.pageErrors.push(error.stack || error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      diagnostics.consoleErrors.push({ text: message.text(), location: message.location() });
    }
  });
  page.on('requestfailed', (request) => {
    diagnostics.requestFailures.push({
      url: request.url(),
      method: request.method(),
      error: request.failure()?.errorText
    });
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      diagnostics.httpErrors.push({
        url: response.url(),
        status: response.status(),
        statusText: response.statusText()
      });
    }
  });
});
test.afterEach(async ({ page }, testInfo) => {
  const diagnostics = runtimeDiagnostics.get(page)!;
  if (testInfo.status !== testInfo.expectedStatus || diagnostics.pageErrors.length) {
    const snapshot = await page
      .evaluate(() => ({
        url: location.href,
        readyState: document.readyState,
        rootHTML: document.getElementById('root')?.innerHTML.slice(0, 20000),
        rendererTest: !!window.rendererTest,
        calls: window.rendererTest?.calls.slice(-200),
        canvasCount: document.querySelectorAll('canvas').length
      }))
      .catch((error: unknown) => ({ error: String(error) }));
    await testInfo.attach('renderer-runtime-diagnostics', {
      body: JSON.stringify({ ...diagnostics, snapshot }, null, 2),
      contentType: 'application/json'
    });
  }
  expect(diagnostics.pageErrors, 'Renderer must not report uncaught browser errors').toEqual([]);
});
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

async function open(page: Page, view: string, deferred: string): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('nido.language', 'en');
    localStorage.setItem('nido.animations', 'false');
  });
  await page.goto(`${origin}?view=${view}&defer=${deferred}`);
  await expect(page.locator('canvas').or(page.getByRole('listbox')).first()).toBeVisible({
    timeout: 15000
  });
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
}

test('Explorer navigation reuses row indices and batches state writes while flushing on close', async ({
  page
}) => {
  // Install before mounting so the initial native save timer cannot leak into the measurement.
  await page.clock.install({ time: new Date(0) });
  await page.clock.pauseAt(new Date(1000));
  await page.addInitScript(() => {
    localStorage.setItem('nido.language', 'en');
    localStorage.setItem('nido.animations', 'false');
  });
  await page.goto(`${origin}?view=app&defer=files`);
  await expect(page.getByRole('tree', { name: 'Project files' })).toBeVisible();
  await page.evaluate(() =>
    window.rendererTest.settle(
      'files',
      0,
      Array.from({ length: 10000 }, (_, i) => ({
        name: `file-${String(i).padStart(5, '0')}.txt`,
        path: `file-${String(i).padStart(5, '0')}.txt`,
        directory: false
      }))
    )
  );
  const tree = page.getByRole('tree', { name: 'Project files' });
  await expect(tree).toHaveAttribute('data-row-count', '10000');
  await tree.press('End');
  await page.clock.runFor(200);
  await page.evaluate(() => {
    window.explorerMetrics = { searches: 0, writes: 0, bytes: 0 };
    for (const method of ['find', 'findIndex'] as const) {
      const original = Array.prototype[method];
      Object.defineProperty(Array.prototype, method, {
        configurable: true,
        writable: true,
        value: function (this: { path?: string }[], ...args: unknown[]) {
          if (this.length === 10000 && this[0]?.path === 'file-00000.txt') {
            window.explorerMetrics.searches++;
          }
          return Reflect.apply(original, this, args);
        }
      });
    }
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string): void {
      if (key === 'nido.explorer./alpha') {
        window.explorerMetrics.writes++;
        window.explorerMetrics.bytes += new TextEncoder().encode(value).length;
      }
      write.call(this, key, value);
    };
  });
  for (let i = 0; i < 20; i++) await tree.press('ArrowUp');
  await expect(tree.locator('[aria-selected="true"]')).toHaveText('file-09979.txt');
  const beforeFlush = await page.evaluate(() => ({ ...window.explorerMetrics }));
  await page.clock.runFor(200);
  const afterFlush = await page.evaluate(() => ({ ...window.explorerMetrics }));
  console.log(
    JSON.stringify({
      explorerNavigation: { entries: 10000, moves: 20, beforeFlush, afterFlush }
    })
  );
  expect(beforeFlush.searches).toBe(0);
  expect(beforeFlush.writes).toBe(0);
  expect(afterFlush.writes).toBe(1);
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('nido.explorer./alpha')!).selected)
  ).toBe('file-09979.txt');
  // Stay inside the visible rows: a late native scroll event after the synthetic
  // pagehide would legitimately schedule another save on this still-open page.
  await tree.press('ArrowDown');
  await expect(tree.locator('[aria-selected="true"]')).toHaveText('file-09980.txt');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('nido.explorer./alpha')!).selected)
  ).toBe('file-09980.txt');
  expect(await page.evaluate(() => window.explorerMetrics.writes)).toBe(2);
  await page.clock.runFor(200);
  expect(await page.evaluate(() => window.explorerMetrics.writes)).toBe(2);
});

test('Extensions bounds slow status polling, pauses while hidden and recovers from errors', async ({
  page
}) => {
  await open(page, 'app', 'languagePacks');
  await page.keyboard.press('Control+Shift+x');
  await page.clock.runFor(1);
  await expect
    .poll(() =>
      page.evaluate(
        () => window.rendererTest.pending.filter(({ method }) => method === 'languagePacks').length
      )
    )
    .toBe(1);
  await page.clock.runFor(10000);
  const pending = await page.evaluate(
    () => window.rendererTest.pending.filter(({ method }) => method === 'languagePacks').length
  );
  console.log(JSON.stringify({ extensionStatus: { elapsedMs: 10000, pending } }));
  expect(pending).toBe(1);
  const snapshot = {
    packs: [{ ...rustPack, bundled: true, enabled: true, status: 'running' }],
    errors: []
  };
  await page.evaluate((value) => window.rendererTest.settle('languagePacks', 0, value), snapshot);
  await expect(page.locator('[data-pack="rust"] [data-status]')).toHaveAttribute(
    'data-status',
    'running'
  );
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(10000);
  expect(
    await page.evaluate(
      () => window.rendererTest.pending.filter(({ method }) => method === 'languagePacks').length
    )
  ).toBe(0);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => window.rendererTest.pending.filter(({ method }) => method === 'languagePacks').length
      )
    )
    .toBe(1);
  await page.evaluate(() =>
    window.rendererTest.settle('languagePacks', 0, 'temporary status error', true)
  );
  await expect(page.getByRole('alert')).toContainText('temporary status error');
  await page.clock.runFor(2000);
  await page.evaluate((value) => window.rendererTest.settle('languagePacks', 0, value), snapshot);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('Extensions ignores status read before a toggle and stops refreshing after close', async ({
  page
}) => {
  await open(page, 'app', 'languagePacks,setLanguagePackEnabled');
  await page.keyboard.press('Control+Shift+x');
  await page.clock.runFor(1);
  const enabled = {
    packs: [{ ...rustPack, bundled: true, enabled: true, status: 'running' }],
    errors: []
  };
  await page.evaluate((value) => window.rendererTest.settle('languagePacks', 0, value), enabled);
  const checkbox = page.getByRole('checkbox', { name: 'Enable Rust', exact: true });
  await expect(checkbox).toBeChecked();
  await page.clock.runFor(2000);
  await checkbox.uncheck();
  await expect(checkbox).toBeDisabled();
  await page.evaluate((value) => window.rendererTest.settle('languagePacks', 0, value), enabled);
  await expect(checkbox).not.toBeChecked();
  await page.keyboard.press('Escape');
  const requests = await page.evaluate(
    () => window.rendererTest.calls.filter(({ method }) => method === 'languagePacks').length
  );
  await page.evaluate(() => window.rendererTest.settle('setLanguagePackEnabled', 0, undefined));
  await page.clock.runFor(6000);
  expect(
    await page.evaluate(
      () => window.rendererTest.calls.filter(({ method }) => method === 'languagePacks').length
    )
  ).toBe(requests);
});

test('Explorer waits for restored folders before restoring scroll and skips deleted folders', async ({
  page
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'nido.explorer./alpha',
      JSON.stringify({
        version: 1,
        expanded: ['src', 'removed'],
        selected: 'src',
        scrollTop: 780
      })
    );
  });
  await open(page, 'app', 'files');
  const tree = page.getByRole('tree', { name: 'Project files' });
  await expect(tree).toHaveAttribute('aria-busy', 'true');
  await expect
    .poll(() =>
      page.evaluate(
        () => window.rendererTest.pending.filter(({ method }) => method === 'files').length
      )
    )
    .toBe(3);
  await page.evaluate(() => {
    window.rendererTest.settle('files', 0, [
      { name: 'src', path: 'src', directory: true },
      ...Array.from({ length: 100 }, (_, i) => ({
        name: `file-${i}.txt`,
        path: `file-${i}.txt`,
        directory: false
      }))
    ]);
  });
  await expect(tree).toHaveAttribute('aria-busy', 'true');
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('nido.explorer./alpha')!).scrollTop)
  ).toBe(780);
  await page.evaluate(() => {
    window.rendererTest.settle('files', 0, [
      { name: 'nested.txt', path: 'src/nested.txt', directory: false }
    ]);
    window.rendererTest.settle('files', 0, 'ENOENT: removed folder', true);
  });
  await expect(tree).toHaveAttribute('aria-busy', 'false');
  await expect(tree).toHaveAttribute('data-row-count', '102');
  await expect(tree.locator('[aria-selected="true"]')).toHaveText('src');
  await expect.poll(() => tree.evaluate((node) => node.scrollTop)).toBe(780);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.clock.runFor(200);
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('nido.explorer./alpha')!).scrollTop)
  ).toBe(780);
});

for (const saved of [
  '{',
  JSON.stringify({
    version: 1,
    expanded: ['../outside', '/absolute', 'C:\\outside', 42],
    selected: {},
    scrollTop: -30
  })
]) {
  test(`Explorer ignores invalid saved state: ${saved}`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('nido.explorer./alpha', value), saved);
    await open(page, 'app', 'files');
    expect(
      await page.evaluate(() =>
        window.rendererTest.pending
          .filter(({ method }) => method === 'files')
          .map(({ args }) => args[1])
      )
    ).toEqual(['']);
    await page.evaluate(() =>
      window.rendererTest.settle('files', 0, [{ name: 'src', path: 'src', directory: true }])
    );
    const tree = page.getByRole('tree', { name: 'Project files' });
    await expect(tree).toHaveAttribute('aria-busy', 'false');
    await expect(tree.getByRole('treeitem', { name: 'src', exact: true })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    await expect(tree.locator('[aria-selected="true"]')).toHaveCount(0);
    expect(await tree.evaluate((node) => node.scrollTop)).toBe(0);
  });
}

test('Explorer refresh bounds directory requests and stops obsolete queued work', async ({
  page
}) => {
  await open(page, 'app', 'files');
  const directories = Array.from({ length: 12 }, (_, i) => ({
    name: `dir-${i}`,
    path: `dir-${i}`,
    directory: true
  }));
  await page.evaluate((value) => window.rendererTest.settle('files', 0, value), directories);
  const tree = page.getByRole('tree', { name: 'Project files' });
  for (const directory of directories) {
    await tree.getByRole('treeitem', { name: directory.name, exact: true }).click();
    await page.evaluate(() => window.rendererTest.settle('files', 0, []));
  }
  await page.evaluate(() => {
    window.rendererTest.calls.length = 0;
    window.rendererTest.emit({ type: 'filesChanged', id: 'alpha' });
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => window.rendererTest.pending.filter(({ method }) => method === 'files').length
      )
    )
    .toBe(4);
  await page.evaluate((value) => {
    // Supersede a refresh before any of its queued directories can start.
    window.rendererTest.emit({ type: 'filesChanged', id: 'alpha' });
    for (let i = 0; i < 4; i++) window.rendererTest.settle('files', 0, value);
  }, []);
  await expect
    .poll(() =>
      page.evaluate(
        () => window.rendererTest.pending.filter(({ method }) => method === 'files').length
      )
    )
    .toBe(4);
  let completed = 0;
  while (completed < directories.length + 1) {
    const count = await page.evaluate((value) => {
      const batch = window.rendererTest.pending.filter(({ method }) => method === 'files');
      if (batch.length > 4) throw new Error(`Unbounded refresh: ${batch.length}`);
      for (const request of batch) {
        const path = String(request.args[1]);
        window.rendererTest.settle(
          'files',
          0,
          path ? [{ name: 'fresh.txt', path: `${path}/fresh.txt`, directory: false }] : value
        );
      }
      return batch.length;
    }, directories);
    completed += count;
    if (completed < directories.length + 1) {
      await expect
        .poll(() =>
          page.evaluate(
            () => window.rendererTest.pending.filter(({ method }) => method === 'files').length
          )
        )
        .toBeGreaterThan(0);
    }
  }
  await expect(tree).toHaveAttribute('data-row-count', '24');
  expect(
    await page.evaluate(
      () => window.rendererTest.calls.filter(({ method }) => method === 'files').length
    )
  ).toBe(17);
  // Closing the workspace cancels queued directories even before React removes its UI.
  await page.evaluate(() => window.rendererTest.emit({ type: 'filesChanged', id: 'alpha' }));
  await expect
    .poll(() =>
      page.evaluate(
        () => window.rendererTest.pending.filter(({ method }) => method === 'files').length
      )
    )
    .toBe(4);
  await page.getByRole('button', { name: 'Close workspace Alpha', exact: true }).click();
  await page.evaluate((value) => {
    window.rendererTest.emit({ type: 'exit', id: 'alpha' });
    for (let i = 0; i < 4; i++) window.rendererTest.settle('files', 0, value);
  }, directories);
  await expect(tree).toHaveCount(0);
  expect(
    await page.evaluate(
      () => window.rendererTest.pending.filter(({ method }) => method === 'files').length
    )
  ).toBe(0);
  expect(
    await page.evaluate(
      () => window.rendererTest.calls.filter(({ method }) => method === 'files').length
    )
  ).toBe(21);
});

test('expanding a folder during refresh reuses the other directory reads', async ({ page }) => {
  await open(page, 'app', 'files');
  const directories = ['first', 'second', 'third'].map((path) => ({
    name: path,
    path,
    directory: true
  }));
  await page.evaluate((value) => window.rendererTest.settle('files', 0, value), directories);
  const tree = page.getByRole('tree', { name: 'Project files' });
  await tree.getByRole('treeitem', { name: 'first', exact: true }).click();
  await page.evaluate(() => window.rendererTest.settle('files', 0, []));
  await page.evaluate(() => {
    window.rendererTest.calls.length = 0;
    window.rendererTest.emit({ type: 'filesChanged', id: 'alpha' });
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => window.rendererTest.pending.filter(({ method }) => method === 'files').length
      )
    )
    .toBe(2);
  await tree.getByRole('treeitem', { name: 'second', exact: true }).click();
  expect(
    await page.evaluate(() =>
      window.rendererTest.calls
        .filter(({ method }) => method === 'files')
        .map(({ args }) => args[1])
    )
  ).toEqual(['', 'first', 'second']);
  await page.evaluate((value) => {
    window.rendererTest.settle('files', 0, value);
    window.rendererTest.settle('files', 0, [
      { name: 'one.txt', path: 'first/one.txt', directory: false }
    ]);
    window.rendererTest.settle('files', 0, [
      { name: 'two.txt', path: 'second/two.txt', directory: false }
    ]);
  }, directories);
  await expect(tree).toHaveAttribute('data-row-count', '5');
  await expect(tree).toContainText('one.txt');
  await expect(tree).toContainText('two.txt');
});

test('Explorer removes missing directories and retries failed reads without reusing their errors', async ({
  page
}) => {
  await open(page, 'app', 'files');
  const directories = [{ name: 'src', path: 'src', directory: true }];
  await page.evaluate((value) => window.rendererTest.settle('files', 0, value), directories);
  const tree = page.getByRole('tree', { name: 'Project files' });
  await tree.getByRole('treeitem', { name: 'src', exact: true }).click();
  await page.evaluate(() =>
    window.rendererTest.settle('files', 0, [
      { name: 'old.txt', path: 'src/old.txt', directory: false }
    ])
  );
  await expect(tree).toHaveAttribute('data-row-count', '2');
  await page.evaluate(() => window.rendererTest.emit({ type: 'filesChanged', id: 'alpha' }));
  await expect
    .poll(() =>
      page.evaluate(
        () => window.rendererTest.pending.filter(({ method }) => method === 'files').length
      )
    )
    .toBe(2);
  await page.evaluate((value) => {
    window.rendererTest.settle('files', 0, value);
    window.rendererTest.settle('files', 0, 'ENOENT: missing directory', true);
  }, directories);
  await expect(tree).toHaveAttribute('data-row-count', '1');
  const folder = tree.getByRole('treeitem', { name: 'src', exact: true });
  await folder.click();
  await folder.click();
  await page.evaluate(() =>
    window.rendererTest.settle('files', 0, 'EACCES: denied directory', true)
  );
  await expect(page.getByRole('alert')).toContainText('EACCES');
  await folder.click();
  await folder.click();
  await page.evaluate(() =>
    window.rendererTest.settle('files', 0, [
      { name: 'fresh.txt', path: 'src/fresh.txt', directory: false }
    ])
  );
  await expect(tree).toHaveAttribute('data-row-count', '2');
  await expect(tree).toContainText('fresh.txt');
  await expect(tree).not.toContainText('old.txt');
});

test('Explorer external changes reload only the affected folder and preserve selection and viewport', async ({
  page
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      'nido.explorer./alpha',
      JSON.stringify({
        version: 1,
        expanded: ['src', 'other'],
        selected: 'src',
        scrollTop: 520
      })
    )
  );
  await open(page, 'app', 'files');
  await page.evaluate(() => {
    const root = [
      { name: 'src', path: 'src', directory: true },
      { name: 'other', path: 'other', directory: true },
      ...Array.from({ length: 90 }, (_, index) => ({
        name: `${index}.txt`,
        path: `${index}.txt`,
        directory: false
      }))
    ];
    const src = Array.from({ length: 60 }, (_, index) => ({
      name: `file-${index}.txt`,
      path: `src/file-${index}.txt`,
      directory: false
    }));
    for (const request of window.rendererTest.pending.filter(({ method }) => method === 'files')) {
      window.rendererTest.settle(
        'files',
        0,
        request.args[1] === '' ? root : request.args[1] === 'src' ? src : []
      );
    }
  });
  const tree = page.getByRole('tree', { name: 'Project files' });
  await expect(tree).toHaveAttribute('aria-busy', 'false');
  await expect(tree).toHaveAttribute('data-row-count', '152');
  await expect.poll(() => tree.evaluate((node) => node.scrollTop)).toBe(520);
  await page.evaluate(() => {
    window.rendererTest.calls.length = 0;
    window.rendererTest.emit({ type: 'directoryChanged', id: 'alpha', paths: ['src'] });
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.rendererTest.pending
          .filter(({ method }) => method === 'files')
          .map(({ args }) => args[1])
      )
    )
    .toEqual(['src']);
  await page.evaluate(() => window.rendererTest.settle('files', 0, []));
  await expect(tree).toHaveAttribute('data-row-count', '92');
  await expect(tree.locator('[aria-selected="true"]')).toHaveText('src');
  expect(await tree.evaluate((node) => node.scrollTop)).toBe(520);
  expect(
    await page.evaluate(() =>
      window.rendererTest.calls
        .filter(({ method }) => method === 'files')
        .map(({ args }) => args[1])
    )
  ).toEqual(['src']);
});

test('Explorer rejects a stale external directory read while reusing unaffected in-flight reads', async ({
  page
}) => {
  await open(page, 'app', 'files');
  const directories = ['src', 'other'].map((path) => ({ name: path, path, directory: true }));
  await page.evaluate((value) => window.rendererTest.settle('files', 0, value), directories);
  const tree = page.getByRole('tree', { name: 'Project files' });
  for (const name of ['src', 'other']) {
    await tree.getByRole('treeitem', { name, exact: true }).click();
    await page.evaluate(() => window.rendererTest.settle('files', 0, []));
  }
  await page.evaluate(() => {
    window.rendererTest.calls.length = 0;
    window.rendererTest.emit({ type: 'filesChanged', id: 'alpha' });
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => window.rendererTest.pending.filter(({ method }) => method === 'files').length
      )
    )
    .toBe(3);
  await page.evaluate(() => {
    for (let index = 0; index < 1000; index++) {
      window.rendererTest.emit({ type: 'directoryChanged', id: 'alpha', paths: ['src'] });
    }
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => window.rendererTest.pending.filter(({ method }) => method === 'files').length
      )
    )
    .toBe(3);
  await page.evaluate((value) => {
    window.rendererTest.settle('files', 0, value);
    window.rendererTest.settle('files', 0, [
      { name: 'stale.txt', path: 'src/stale.txt', directory: false }
    ]);
    window.rendererTest.settle('files', 0, [
      { name: 'unaffected.txt', path: 'other/unaffected.txt', directory: false }
    ]);
  }, directories);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.rendererTest.pending
          .filter(({ method }) => method === 'files')
          .map(({ args }) => args[1])
      )
    )
    .toEqual(['src']);
  await expect(tree).not.toContainText('stale.txt');
  await page.evaluate(() => {
    window.rendererTest.settle('files', 0, [
      { name: 'fresh.txt', path: 'src/fresh.txt', directory: false }
    ]);
  });
  await expect(tree).toContainText('fresh.txt');
  await expect(tree).toContainText('unaffected.txt');
  await expect(tree).not.toContainText('stale.txt');
  expect(
    await page.evaluate(() =>
      window.rendererTest.calls
        .filter(({ method }) => method === 'files')
        .map(({ args }) => args[1])
    )
  ).toEqual(['', 'src', 'other', 'src']);
});

test('Explorer unsubscribes collapsed and hidden folders and reconciles visibility and focus returns', async ({
  page
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      'nido.explorer./alpha',
      JSON.stringify({
        version: 1,
        expanded: ['src', 'src/nested'],
        selected: 'src',
        scrollTop: 0
      })
    )
  );
  await open(page, 'app', 'files');
  await page.evaluate(() => {
    window.rendererTest.settle('files', 0, [{ name: 'src', path: 'src', directory: true }]);
    window.rendererTest.settle('files', 0, [
      { name: 'nested', path: 'src/nested', directory: true }
    ]);
    window.rendererTest.settle('files', 0, []);
  });
  const subscriptions = (): Promise<unknown> =>
    page.evaluate(
      () =>
        window.rendererTest.calls.filter(({ method }) => method === 'watchDirectories').at(-1)
          ?.args[1]
    );
  await expect.poll(subscriptions).toEqual(['', 'src', 'src/nested']);
  const tree = page.getByRole('tree', { name: 'Project files' });
  await tree.getByRole('treeitem', { name: 'src', exact: true }).click();
  await expect.poll(subscriptions).toEqual(['']);
  await page.evaluate(() => {
    window.rendererTest.calls.length = 0;
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(subscriptions).toEqual([]);
  await page.evaluate(() =>
    window.rendererTest.emit({ type: 'directoryChanged', id: 'alpha', paths: [''] })
  );
  expect(
    await page.evaluate(
      () => window.rendererTest.pending.filter(({ method }) => method === 'files').length
    )
  ).toBe(0);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(subscriptions).toEqual(['']);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.rendererTest.pending
          .filter(({ method }) => method === 'files')
          .map(({ args }) => args[1])
      )
    )
    .toEqual(['']);
  await page.evaluate(() =>
    window.rendererTest.settle('files', 0, [
      { name: 'external.txt', path: 'external.txt', directory: false }
    ])
  );
  await expect(tree.getByRole('treeitem', { name: 'external.txt', exact: true })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.rendererTest.pending
          .filter(({ method }) => method === 'files')
          .map(({ args }) => args[1])
      )
    )
    .toEqual(['']);
  await page.evaluate(() => window.rendererTest.settle('files', 0, []));
  await expect(tree.getByRole('treeitem')).toHaveCount(0);
});

test('ten thousand references keep bounded DOM and keyboard jumps, and rapid selection requests only the final preview', async ({
  page
}) => {
  await open(page, 'app', 'previewReference');
  await page.evaluate(() =>
    window.rendererTest.emit({
      type: 'statePatch',
      id: 'alpha',
      state: {
        references: {
          version: 10,
          loading: true,
          error: '',
          items: Array.from({ length: 10000 }, (_, i) => ({
            path: `/alpha/file-${i}.ts`,
            line: i + 1,
            column: 1,
            text: `reference ${i}`
          }))
        }
      }
    })
  );
  await page.clock.runFor(50);
  const list = page.getByRole('listbox', { name: 'Reference results' });
  await expect(list).toBeFocused();
  expect(await list.getByRole('option').count()).toBeLessThan(40);
  await page.clock.runFor(100);
  await page.evaluate(() => {
    window.rendererTest.calls.length = 0;
  });
  await list.press('End');
  await expect(list).toHaveAttribute('aria-activedescendant', 'reference-9999');
  await expect(list.locator('#reference-9999')).toBeVisible();
  await expect(list.locator('#reference-9999')).toHaveAttribute('aria-setsize', '10000');
  expect(await list.getByRole('option').count()).toBeLessThan(40);
  await list.press('Enter');
  expect(
    await page.evaluate(
      () => window.rendererTest.calls.find((call) => call.method === 'openReference')?.args
    )
  ).toEqual(['alpha', 10000, 10]);
  await list.focus();
  await list.press('Home');
  for (let i = 0; i < 20; i++) {
    await list.press('ArrowDown');
    await page.clock.runFor(20);
  }
  await page.clock.runFor(100);
  expect(
    await page.evaluate(() =>
      window.rendererTest.calls
        .filter((call) => call.method === 'previewReference')
        .map((call) => call.args)
    )
  ).toEqual([['alpha', 21, 10]]);
  await page.evaluate(() =>
    window.rendererTest.settle('previewReference', 1, {
      first: 21,
      line: 21,
      lines: [[{ text: 'FINAL_PREVIEW', color: '#fff' }]]
    })
  );
  await expect(page.getByRole('region', { name: 'Reference preview' })).toContainText(
    'FINAL_PREVIEW'
  );
  await page.evaluate(() =>
    window.rendererTest.settle('previewReference', 0, {
      first: 1,
      line: 1,
      lines: [[{ text: 'STALE_PREVIEW', color: '#fff' }]]
    })
  );
  await expect(page.getByText('STALE_PREVIEW')).toHaveCount(0);
});

test('file search sends the query, cancels closing searches and ignores old results', async ({
  page
}) => {
  await open(page, 'app', 'findFiles');
  await page.keyboard.press('Control+p');
  await page.clock.runFor(100);
  const filter = page.getByRole('textbox', { name: 'Filter items' });
  await filter.fill('needle');
  await page.clock.runFor(100);
  expect(
    await page.evaluate(() =>
      window.rendererTest.calls
        .filter((call) => call.method === 'findFiles')
        .map((call) => call.args)
    )
  ).toEqual([
    ['alpha', ''],
    ['alpha', 'needle']
  ]);
  await page.evaluate(() =>
    window.rendererTest.settle('findFiles', 1, [
      { name: 'needle.ts', path: 'deep/needle.ts', directory: false }
    ])
  );
  await expect(page.getByRole('button', { name: /needle.ts/ })).toBeVisible();
  await page.evaluate(() =>
    window.rendererTest.settle('findFiles', 0, [
      { name: 'needle-old.ts', path: 'needle-old.ts', directory: false }
    ])
  );
  await expect(page.getByRole('button', { name: /needle-old.ts/ })).toHaveCount(0);
  const cancelled = await page.evaluate(
    () => window.rendererTest.calls.filter((call) => call.method === 'cancelFindFiles').length
  );
  await page.keyboard.press('Escape');
  await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
  expect(
    await page.evaluate(
      () => window.rendererTest.calls.filter((call) => call.method === 'cancelFindFiles').length
    )
  ).toBe(cancelled + 1);
});

test('workspace grep keeps its result list while navigating and receives fresh results for a new query', async ({
  page
}) => {
  await open(page, 'app', 'searchText');
  await page.keyboard.press('Control+Shift+f');
  const query = page.getByRole('textbox', { name: 'Search in files', exact: true });
  await query.fill('needle');
  await page.clock.runFor(100);
  await page.evaluate(() => {
    const matches = Array.from({ length: 200 }, (_, index) => ({
      path: `file-${index}.txt`,
      line: index + 1,
      column: 11,
      text: `日本語 needle ${index}`
    }));
    const map = matches.map;
    Object.assign(window, { searchMaps: 0 });
    matches.map = function (...args: Parameters<typeof map>) {
      (window as unknown as { searchMaps: number }).searchMaps++;
      return map.apply(this, args);
    } as typeof map;
    window.rendererTest.settle('searchText', 0, { matches, truncated: false });
  });
  const search = page.getByRole('dialog', { name: 'search palette', exact: true });
  await expect(search.getByRole('status')).toHaveText('200 matching lines');
  await page.evaluate(() => {
    (window as unknown as { searchMaps: number }).searchMaps = 0;
  });
  for (let index = 0; index < 20; index++) await query.press('ArrowDown');
  await expect(search.getByRole('option', { name: /file-20.txt:21:11/ })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  const maps = await page.evaluate(() => (window as unknown as { searchMaps: number }).searchMaps);
  console.log(`200 grep results, 20 selection changes: ${maps} result list maps`);
  expect(maps).toBe(0);
  await query.fill('fresh');
  await page.clock.runFor(100);
  await page.evaluate(() =>
    window.rendererTest.settle('searchText', 0, {
      matches: [{ path: 'fresh.txt', line: 7, column: 3, text: 'fresh' }],
      truncated: false
    })
  );
  await expect(search.getByRole('status')).toHaveText('1 matching lines');
  await query.press('Enter');
  expect(
    await page.evaluate(() =>
      window.rendererTest.calls
        .filter((call) => call.method === 'openFile')
        .map((call) => call.args)
    )
  ).toEqual([['alpha', 'fresh.txt', 7, 3]]);
  await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
});

test('partial references never steal editor focus or reopen a closed panel; a new search opens it', async ({
  page
}) => {
  await open(page, 'app', '');
  const update = async (search: number, version: number, loading: boolean): Promise<void> => {
    await page.evaluate(
      ({ search, version, loading }) =>
        window.rendererTest.emit({
          type: 'statePatch',
          id: 'alpha',
          state: {
            references: {
              search,
              version,
              loading,
              error: '',
              items: [{ path: '/alpha/main.ts', line: 1, column: 1, text: 'reference' }]
            }
          }
        }),
      { search, version, loading }
    );
    await page.clock.runFor(50);
  };
  await update(1, 1, true);
  const panel = page.getByRole('region', { name: 'References', exact: true });
  await expect(panel).toBeVisible();
  const editor = page.getByRole('textbox', { name: 'Neovim input' });
  await editor.focus();
  await update(1, 2, true);
  await expect(editor).toBeFocused();
  await page.getByRole('button', { name: 'Hide references' }).click();
  await update(1, 3, false);
  await expect(panel).toBeHidden();
  await expect(editor).toBeFocused();
  await update(2, 4, true);
  await expect(panel).toBeVisible();
  await expect(page.getByRole('listbox', { name: 'Reference results' })).toBeFocused();
});

test('Enter during file search opens the arriving result, while closing cancels the pending choice', async ({
  page
}) => {
  await open(page, 'app', 'findFiles');
  await page.keyboard.press('Control+p');
  const filter = page.getByRole('textbox', { name: 'Filter items' });
  await filter.fill('quick');
  await filter.press('Enter');
  await page.clock.runFor(100);
  await page.evaluate(() =>
    window.rendererTest.settle('findFiles', 0, [
      { name: 'quick.ts', path: 'quick.ts', directory: false }
    ])
  );
  await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
  expect(
    await page.evaluate(() =>
      window.rendererTest.calls
        .filter((call) => call.method === 'openFile')
        .map((call) => call.args)
    )
  ).toEqual([['alpha', 'quick.ts']]);
  await page.keyboard.press('Control+p');
  await filter.fill('cancel');
  await filter.press('Enter');
  await page.clock.runFor(100);
  await filter.press('Escape');
  await page.evaluate(() =>
    window.rendererTest.settle('findFiles', 0, [
      { name: 'cancel.ts', path: 'cancel.ts', directory: false }
    ])
  );
  await page.clock.runFor(100);
  expect(
    await page.evaluate(
      () => window.rendererTest.calls.filter((call) => call.method === 'openFile').length
    )
  ).toBe(1);
});

test('Problems selection renders only the previous and next rows', async ({ page }) => {
  await page.goto(`${origin}?view=palette`);
  await page.evaluate(() => {
    Object.assign(window, { paletteSeverityReads: 0 });
    window.rendererTest.render({
      paletteItems: Array.from({ length: 10000 }, (_, index) => ({
        key: 'Error',
        title: `Diagnostic ${index}`,
        detail: `/alpha/file-${index}.rs:1:1`,
        get severity() {
          Reflect.set(
            window,
            'paletteSeverityReads',
            Reflect.get(window, 'paletteSeverityReads') + 1
          );
          return 1;
        },
        run: () => {}
      }))
    });
  });
  const results = page.getByRole('listbox', { name: 'Problems', exact: true });
  await expect(results.getByRole('option')).toHaveCount(10000);
  expect(await page.evaluate(() => Reflect.get(window, 'paletteSeverityReads'))).toBe(20000);
  await page.evaluate(() => Reflect.set(window, 'paletteSeverityReads', 0));
  const started = performance.now();
  for (let index = 0; index < 20; index++) {
    await page.keyboard.press('j');
    await expect(results).toHaveAttribute('aria-activedescendant', `problem-${index + 1}`);
  }
  const severityReads = await page.evaluate(() => Reflect.get(window, 'paletteSeverityReads'));
  console.log('problem-row-render-work', {
    rows: 10000,
    selections: 20,
    severityReads,
    elapsedMs: Math.round(performance.now() - started)
  });
  expect(severityReads).toBe(80);
});

test('Problems selection reuses sorting and filtering while preserving all multiline results', async ({
  page
}) => {
  test.setTimeout(60000);
  await open(page, 'app', 'openProblem');
  await page.evaluate(() =>
    window.rendererTest.emit({
      type: 'statePatch',
      id: 'alpha',
      state: {
        diagnosticsVersion: 7,
        problems: Array.from({ length: 10000 }, (_, index) => ({
          path: `/alpha/file-${String(index).padStart(5, '0')}.rs`,
          line: index + 1,
          column: 1,
          severity: 1,
          message: `Diagnostic ${String(index).padStart(5, '0')}${index % 250 === 0 ? '\nA second diagnostic line' : ''}`,
          source: 'rustc'
        }))
      }
    })
  );
  await page.clock.runFor(32);
  await page.keyboard.press('Control+Shift+m');
  const results = page.getByRole('listbox', { name: 'Problems', exact: true });
  const rows = results.getByRole('option');
  await expect(rows).toHaveCount(10000);
  const wrap = await rows.first().evaluate((node) => ({
    height: node.getBoundingClientRect().height,
    whiteSpace: getComputedStyle(node.querySelector('strong')!).whiteSpace
  }));
  expect(wrap.whiteSpace).toBe('pre-wrap');
  expect(wrap.height).toBeGreaterThan(
    await rows.nth(1).evaluate((node) => node.getBoundingClientRect().height)
  );
  await page.evaluate(() => {
    const originalCompare = String.prototype.localeCompare;
    const originalLower = String.prototype.toLowerCase;
    Object.assign(window, { problemWork: { comparisons: 0, filters: 0 } });
    String.prototype.localeCompare = function (...args) {
      if (String(this).startsWith('/alpha/file-')) Reflect.get(window, 'problemWork').comparisons++;
      return Reflect.apply(originalCompare, this, args);
    };
    String.prototype.toLowerCase = function () {
      if (String(this).startsWith('Diagnostic ')) Reflect.get(window, 'problemWork').filters++;
      return originalLower.call(this);
    };
  });
  await expect(results).toBeFocused();
  for (let index = 0; index < 20; index++) await page.keyboard.press('j');
  await page.evaluate(() =>
    window.rendererTest.emit({
      type: 'statePatch',
      id: 'alpha',
      state: { line: 123, column: 45 }
    })
  );
  await page.clock.runFor(32);
  const work = await page.evaluate(() => Reflect.get(window, 'problemWork'));
  console.log('problem-selection-work', { rows: 10000, selections: 20, ...work });
  expect(work).toEqual({ comparisons: 0, filters: 0 });
  await page.keyboard.press('End');
  await expect(results).toHaveAttribute('aria-activedescendant', 'problem-9999');
  await expect(rows.last()).toHaveAttribute('aria-selected', 'true');
  expect(await results.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await page.setViewportSize({ width: 900, height: 650 });
  await page.clock.runFor(32);
  const visibleSelection = (): Promise<boolean> =>
    results.evaluate((node) => {
      const selected = node.querySelector('[aria-selected="true"]')!.getBoundingClientRect();
      const bounds = node.getBoundingClientRect();
      return selected.top >= bounds.top && selected.bottom <= bounds.bottom;
    });
  await expect.poll(visibleSelection).toBe(true);
  await page.keyboard.press('Home');
  await expect(rows.first()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('/');
  await page.getByRole('textbox', { name: 'Filter items' }).fill('Diagnostic 05000');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('A second diagnostic line');
  await expect.poll(visibleSelection).toBe(true);
  await page.keyboard.press('Enter');
  await expect
    .poll(() =>
      page.evaluate(
        () => window.rendererTest.calls.filter((call) => call.method === 'openProblem').at(-1)?.args
      )
    )
    .toEqual(['alpha', 5001, 7]);
});

test('Problems refresh data, versions, workspace targets and translated labels', async ({
  page
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('nido.language', 'en');
    localStorage.setItem('nido.animations', 'false');
  });
  await page.goto(`${origin}?view=app&defer=restoreWorkspaces,openProblem`);
  await page.evaluate(() =>
    window.rendererTest.settle('restoreWorkspaces', 0, {
      workspaces: [
        { id: 'alpha', name: 'Alpha', root: '/alpha' },
        { id: 'beta', name: 'Beta', root: '/beta' }
      ],
      active: 'alpha',
      errors: []
    })
  );
  await expect(
    page.getByRole('textbox', { name: 'Neovim input', exact: true }).first()
  ).toBeFocused();
  await page.evaluate(() =>
    window.rendererTest.emit({
      type: 'statePatch',
      id: 'alpha',
      state: {
        diagnosticsVersion: 1,
        problems: [
          {
            path: '/alpha/z.rs',
            line: 1,
            column: 1,
            severity: 2,
            message: 'Warning item'
          },
          { path: '/alpha/a.rs', line: 2, column: 1, severity: 1, message: 'Error item' }
        ]
      }
    })
  );
  await page.keyboard.press('Control+Shift+m');
  let results = page.getByRole('listbox', { name: 'Problems', exact: true });
  await expect(results.getByRole('option').first()).toContainText('Error item');
  await expect(results.getByRole('option').last()).toContainText('Warning item');
  await page.evaluate(() =>
    window.rendererTest.emit({
      type: 'statePatch',
      id: 'alpha',
      state: { diagnosticsVersion: 2 }
    })
  );
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
  await results.press('Enter');
  await expect
    .poll(() =>
      page.evaluate(
        () => window.rendererTest.calls.filter((call) => call.method === 'openProblem').at(-1)?.args
      )
    )
    .toEqual(['alpha', 2, 2]);
  await page.evaluate(() => window.rendererTest.settle('openProblem', 0, undefined));
  await expect(results).toHaveCount(0);
  await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('ja');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Shift+m');
  results = page.getByRole('listbox', { name: '問題', exact: true });
  await expect(results.getByRole('option').first()).toContainText('エラー');
  await page.evaluate(() =>
    window.rendererTest.emit({
      type: 'statePatch',
      id: 'alpha',
      state: {
        diagnosticsVersion: 3,
        problems: [{ path: '/alpha/new.rs', line: 3, column: 2, severity: 1, message: 'New data' }]
      }
    })
  );
  await expect(results.getByRole('option')).toHaveCount(1);
  await expect(results.getByRole('option')).toContainText('New data');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Alt+2');
  await page.evaluate(() =>
    window.rendererTest.emit({
      type: 'statePatch',
      id: 'beta',
      state: {
        diagnosticsVersion: 9,
        problems: [
          {
            path: '/beta/current.rs',
            line: 4,
            column: 3,
            severity: 1,
            message: 'Beta data'
          }
        ]
      }
    })
  );
  await page.keyboard.press('Control+Shift+m');
  results = page.getByRole('listbox', { name: '問題', exact: true });
  await expect(results.getByRole('option')).toContainText('Beta data');
  await results.press('Enter');
  await expect
    .poll(() =>
      page.evaluate(
        () => window.rendererTest.calls.filter((call) => call.method === 'openProblem').at(-1)?.args
      )
    )
    .toEqual(['beta', 1, 9]);
});

test('Markdown bounds slow refreshes, pauses hidden work and resumes only the latest snapshot', async ({
  page
}) => {
  await open(page, 'app', 'markdownPreview');
  await page.evaluate(() =>
    window.rendererTest.emit({
      type: 'statePatch',
      id: 'alpha',
      state: { filetype: 'markdown', current: 1 }
    })
  );
  await page.clock.runFor(50);
  await page.keyboard.press('Control+Shift+v');
  const content = page.getByLabel('Markdown preview content', { exact: true });
  await expect(content).toBeVisible();
  const pending = (): Promise<number> =>
    page.evaluate(
      () => window.rendererTest.pending.filter((call) => call.method === 'markdownPreview').length
    );
  const calls = (): Promise<unknown[]> =>
    page.evaluate(() =>
      window.rendererTest.calls
        .filter((call) => call.method === 'markdownPreview')
        .map((call) => call.args)
    );
  for (let edit = 0; edit < 10; edit++) {
    await page.evaluate(() =>
      window.rendererTest.emit({ type: 'redraw', id: 'alpha', events: [['nido_edit']] })
    );
    await page.clock.runFor(200);
  }
  expect(await pending()).toBe(1);
  await page.evaluate(() =>
    window.rendererTest.settle('markdownPreview', 0, {
      token: '1:stale',
      path: '/alpha/notes.md',
      text: '# Stale'
    })
  );
  await expect.poll(pending).toBe(1);
  expect(await calls()).toHaveLength(2);
  await expect(content.getByRole('heading', { name: 'Stale' })).toHaveCount(0);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  for (let edit = 0; edit < 5; edit++) {
    await page.evaluate(() =>
      window.rendererTest.emit({ type: 'redraw', id: 'alpha', events: [['nido_edit']] })
    );
    await page.clock.runFor(200);
  }
  await page.evaluate(() =>
    window.rendererTest.settle('markdownPreview', 0, {
      token: '1:hidden',
      path: '/alpha/notes.md',
      text: '# Hidden stale'
    })
  );
  await page.clock.runFor(500);
  expect(await pending()).toBe(0);
  expect(await calls()).toHaveLength(2);
  await expect(content.getByRole('heading')).toHaveCount(0);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(pending).toBe(1);
  await page.evaluate(() =>
    window.rendererTest.settle('markdownPreview', 0, {
      token: '1:latest',
      path: '/alpha/notes.md',
      text: '# Latest'
    })
  );
  await expect(content.getByRole('heading', { name: 'Latest' })).toBeVisible();
  await page.evaluate(() =>
    window.rendererTest.emit({ type: 'redraw', id: 'alpha', events: [['nido_edit']] })
  );
  await page.clock.runFor(149);
  expect(await calls()).toHaveLength(3);
  await page.clock.runFor(1);
  await expect.poll(pending).toBe(1);
  expect((await calls()).at(-1)).toEqual(['alpha', '1:latest']);
  await content.press('Escape');
  await expect(content).toHaveCount(0);
  await page.evaluate(() =>
    window.rendererTest.settle('markdownPreview', 0, {
      token: '1:closed',
      path: '/alpha/notes.md',
      text: '# Closed'
    })
  );
  await page.clock.runFor(500);
  expect(await calls()).toHaveLength(4);
  await expect(page.getByRole('heading', { name: 'Closed' })).toHaveCount(0);
});

test('Markdown rejects old-workspace reads and retries a later edit after failure', async ({
  page
}) => {
  await page.goto(`${origin}?view=markdown&defer=markdownPreview`);
  const content = page.getByLabel('Markdown preview content', { exact: true });
  await expect(content).toBeVisible();
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.evaluate(() => window.rendererTest.render({ workspaceId: 'beta' }));
  await expect
    .poll(() =>
      page.evaluate(
        () => window.rendererTest.pending.filter((call) => call.method === 'markdownPreview').length
      )
    )
    .toBe(2);
  await page.evaluate(() =>
    window.rendererTest.settle('markdownPreview', 0, {
      token: 'old:1',
      path: '/alpha/old.md',
      text: '# Old workspace'
    })
  );
  await expect(content.getByRole('heading')).toHaveCount(0);
  await page.evaluate(() => window.rendererTest.settle('markdownPreview', 0, 'read failed', true));
  await expect(content.getByRole('alert')).toContainText('read failed');
  await page.evaluate(() =>
    window.rendererTest.emit({ type: 'redraw', id: 'beta', events: [['nido_edit']] })
  );
  await page.clock.runFor(150);
  await page.evaluate(() =>
    window.rendererTest.settle('markdownPreview', 0, {
      token: '2:1',
      path: '/beta/new.md',
      text: '# New workspace'
    })
  );
  await expect(content.getByRole('heading', { name: 'New workspace' })).toBeVisible();
  await expect(content.getByRole('alert')).toHaveCount(0);
});

test('Markdown stays beside the editable canvas, coalesces edits, preserves scroll and stops on close or file switch', async ({
  page
}) => {
  await open(page, 'app', 'markdownPreview');
  await page.evaluate(() =>
    window.rendererTest.emit({
      type: 'statePatch',
      id: 'alpha',
      state: { filetype: 'markdown', current: 1 }
    })
  );
  await page.clock.runFor(50);
  await page.keyboard.press('Control+Shift+v');
  const pane = page.getByRole('region', { name: 'Markdown preview', exact: true });
  const content = page.getByLabel('Markdown preview content', { exact: true });
  await expect(pane).toBeVisible();
  await page.evaluate(() =>
    window.rendererTest.settle('markdownPreview', 0, {
      token: '1:1',
      path: '/alpha/notes.md',
      text: '# First\n\n' + 'Paragraph\n\n'.repeat(100)
    })
  );
  await expect(content.getByRole('heading', { name: 'First' })).toBeVisible();
  await expect(content).toBeFocused();
  await expect(page.locator('canvas:visible')).toBeVisible();
  await content.press('Control+d');
  const scroll = await content.evaluate((node) => node.scrollTop);
  expect(scroll).toBeGreaterThan(0);
  await content.press('Control+j');
  await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
  await page.evaluate(() => {
    for (let i = 0; i < 20; i++)
      window.rendererTest.emit({ type: 'redraw', id: 'alpha', events: [['nido_edit']] });
  });
  await page.clock.runFor(200);
  expect(
    await page.evaluate(() =>
      window.rendererTest.calls
        .filter((call) => call.method === 'markdownPreview')
        .map((call) => call.args)
    )
  ).toEqual([
    ['alpha', ''],
    ['alpha', '1:1']
  ]);
  await page.evaluate(() =>
    window.rendererTest.settle('markdownPreview', 0, {
      token: '1:2',
      path: '/alpha/notes.md',
      text: '# Live\n\n' + 'Paragraph\n\n'.repeat(100)
    })
  );
  await expect(content.getByRole('heading', { name: 'Live' })).toHaveCount(1);
  expect(await content.evaluate((node) => node.scrollTop)).toBe(scroll);
  await page.evaluate(() =>
    window.rendererTest.emit({ type: 'redraw', id: 'alpha', events: [['nido_edit']] })
  );
  await page.clock.runFor(200);
  await page.evaluate(() =>
    window.rendererTest.settle('markdownPreview', 0, { token: '1:2', path: '/alpha/notes.md' })
  );
  await expect(content.getByRole('heading', { name: 'Live' })).toHaveCount(1);
  await content.focus();
  await content.press('Escape');
  await expect(pane).toBeHidden();
  const count = await page.evaluate(
    () => window.rendererTest.calls.filter((call) => call.method === 'markdownPreview').length
  );
  await page.evaluate(() =>
    window.rendererTest.emit({ type: 'redraw', id: 'alpha', events: [['nido_edit']] })
  );
  await page.clock.runFor(200);
  expect(
    await page.evaluate(
      () => window.rendererTest.calls.filter((call) => call.method === 'markdownPreview').length
    )
  ).toBe(count);
  await page.keyboard.press('Control+Shift+v');
  await expect(pane).toBeVisible();
  await page.evaluate(() =>
    window.rendererTest.emit({
      type: 'statePatch',
      id: 'alpha',
      state: { filetype: 'typescript', current: 2 }
    })
  );
  await page.clock.runFor(200);
  await expect(pane).toBeHidden();
  await page.evaluate(() =>
    window.rendererTest.settle('markdownPreview', 0, {
      token: '1:3',
      path: '/alpha/notes.md',
      text: '# Stale'
    })
  );
  await expect(page.getByRole('heading', { name: 'Stale' })).toHaveCount(0);
});

test('rapid Time Machine selection starts only the final preview and keeps restore disabled while waiting', async ({
  page
}) => {
  await open(page, 'history', 'history,historyPreview');
  await page.evaluate(() =>
    window.rendererTest.settle('history', 0, {
      path: '/alpha/notes.txt',
      versions: Array.from({ length: 30 }, (_, i) => ({
        id: String(i),
        timestamp: i + 1,
        kind: 'draft',
        bytes: 1,
        lines: 1
      }))
    })
  );
  const list = page.getByRole('listbox', { name: 'Edit history' });
  for (let i = 0; i < 20; i++) {
    await list.press('ArrowDown');
    await page.clock.runFor(20);
  }
  await expect(page.getByRole('button', { name: /Restore to editor/ })).toBeDisabled();
  await page.clock.runFor(100);
  expect(
    await page.evaluate(() =>
      window.rendererTest.calls
        .filter((call) => call.method === 'historyPreview')
        .map((call) => call.args)
    )
  ).toEqual([['alpha', '/alpha/notes.txt', '21']]);
});
