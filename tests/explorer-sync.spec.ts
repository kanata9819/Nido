import { test, expect } from '@playwright/test';
import { mkdir, mkdtemp, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { electron } from './helpers/electron';

interface ExplorerSyncProbe {
  paths: string[];
  subscriptions: string[][];
  pending: number;
  maxPending: number;
}

test('Explorer synchronizes external file changes without losing expansion, selection or viewport', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nido-explorer-sync-'));
  const project = join(root, 'Project');
  const nested = join('src', 'nested');
  await mkdir(join(project, nested), { recursive: true });
  await mkdir(join(project, 'closed'));
  await writeFile(join(project, nested, 'old.txt'), 'old');
  await Promise.all(
    Array.from({ length: 70 }, (_, index) =>
      writeFile(join(project, `file-${String(index).padStart(2, '0')}.txt`), 'sample')
    )
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const running = await electron.launch({
    args: ['.', `--user-data-dir=${join(root, 'profile')}`],
    env
  });
  try {
    const page = await running.firstWindow();
    await page.setViewportSize({ width: 1100, height: 720 });
    await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
    await running.evaluate(({ ipcMain }) => {
      const handlers = (
        ipcMain as unknown as {
          _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
        }
      )._invokeHandlers;
      const files = handlers.get('nido:files')!;
      const watch = handlers.get('nido:watchDirectories')!;
      const probe: ExplorerSyncProbe = {
        paths: [],
        subscriptions: [],
        pending: 0,
        maxPending: 0
      };
      Object.assign(globalThis, { explorerSyncProbe: probe });
      handlers.set('nido:files', async (...args) => {
        probe.paths.push(String(args[2]));
        probe.pending++;
        probe.maxPending = Math.max(probe.maxPending, probe.pending);
        try {
          return await files(...args);
        } finally {
          probe.pending--;
        }
      });
      handlers.set('nido:watchDirectories', async (...args) => {
        probe.subscriptions.push(args[2] as string[]);
        return watch(...args);
      });
    });
    const probe = (): Promise<ExplorerSyncProbe> =>
      running.evaluate(
        () => (globalThis as unknown as { explorerSyncProbe: ExplorerSyncProbe }).explorerSyncProbe
      );
    const clearReads = (): Promise<void> =>
      running.evaluate(() => {
        (
          globalThis as unknown as { explorerSyncProbe: ExplorerSyncProbe }
        ).explorerSyncProbe.paths.length = 0;
      });
    await page.keyboard.press('Control+Shift+n');
    const address = page.getByRole('textbox', { name: 'Folder path' });
    const folders = page.getByRole('listbox', { name: 'Folders' });
    // Initial browsing writes the home path into the input; finish it before fill().
    await expect(folders).toHaveAttribute('aria-busy', 'false');
    await address.fill(project);
    await expect(address).toHaveValue(project);
    await address.press('Enter');
    await expect(folders).toHaveAttribute('aria-busy', 'false');
    await expect(address).toHaveValue(await realpath(project));
    await expect(folders).toBeFocused();
    await page.keyboard.press('Control+Enter');
    let tree = page.getByRole('tree', { name: 'Project files' });
    await expect(tree).toHaveAttribute('aria-busy', 'false');
    await tree.getByRole('treeitem', { name: 'src', exact: true }).click();
    await tree.getByRole('treeitem', { name: 'nested', exact: true }).click();
    await expect(tree.getByRole('treeitem', { name: 'old.txt', exact: true })).toBeVisible();
    await expect
      .poll(async () => (await probe()).subscriptions.at(-1))
      .toEqual(['', 'src', nested]);
    // Let initial watcher reconciliation finish before counting external changes.
    await page.waitForTimeout(600);
    await expect.poll(async () => (await probe()).pending).toBe(0);
    await running.evaluate(() => {
      (
        globalThis as unknown as { explorerSyncProbe: ExplorerSyncProbe }
      ).explorerSyncProbe.maxPending = 0;
    });
    const selection = await tree.getAttribute('aria-activedescendant');
    const rows = Number(await tree.getAttribute('data-row-count'));
    await tree.evaluate((node) => {
      node.scrollTop = 520;
    });
    await expect.poll(() => tree.evaluate((node) => node.scrollTop)).toBe(520);
    await expect(tree.getByRole('treeitem', { name: 'file-24.txt', exact: true })).toBeVisible();
    await clearReads();
    await Promise.all([
      unlink(join(project, 'file-24.txt')),
      rename(join(project, 'file-25.txt'), join(project, 'renamed-25.txt')),
      writeFile(join(project, 'file-24-added.txt'), 'external creation'),
      unlink(join(project, nested, 'old.txt')),
      writeFile(join(project, nested, 'new.txt'), 'external creation')
    ]);
    await expect(
      tree.getByRole('treeitem', { name: 'file-24-added.txt', exact: true })
    ).toBeVisible();
    await expect(tree.getByRole('treeitem', { name: 'file-24.txt', exact: true })).toHaveCount(0);
    await expect(tree.getByRole('treeitem', { name: 'file-25.txt', exact: true })).toHaveCount(0);
    await expect(tree).toHaveAttribute('aria-activedescendant', selection!);
    await expect(tree.locator('[aria-selected="true"]')).toHaveText('nested');
    expect(await tree.evaluate((node) => node.scrollTop)).toBe(520);
    await expect(tree).toHaveAttribute('data-row-count', String(rows));
    expect((await probe()).paths.every((path) => path === '' || path === nested)).toBe(true);
    await page.screenshot({ path: 'test-results/explorer-external-changes.png' });
    await page.waitForTimeout(400);
    await clearReads();
    await writeFile(join(project, 'closed', 'generated.txt'), 'closed folder');
    await page.waitForTimeout(600);
    expect((await probe()).paths).toEqual([]);
    const generated = Array.from({ length: 1000 }, (_, index) =>
      join(project, `generated-${index}.txt`)
    );
    await Promise.all(generated.map((file) => writeFile(file, 'generated')));
    await expect(tree).toHaveAttribute('data-row-count', String(rows + generated.length));
    await page.waitForTimeout(400);
    const creationReads = (await probe()).paths.length;
    await clearReads();
    const started = Date.now();
    await Promise.all(generated.map((file) => unlink(file)));
    await expect(tree).toHaveAttribute('data-row-count', String(rows));
    await page.waitForTimeout(400);
    const deletionMs = Date.now() - started;
    const afterDeletion = await probe();
    expect(afterDeletion.paths.every((path) => path === '')).toBe(true);
    expect(afterDeletion.paths.length).toBeLessThanOrEqual(Math.ceil(deletionMs / 250) + 2);
    await page.waitForTimeout(700);
    const idleReads = (await probe()).paths.length - afterDeletion.paths.length;
    expect(idleReads).toBe(0);
    expect(await tree.evaluate((node) => node.scrollTop)).toBe(520);
    // Watching expanded descendants must not prevent a Windows parent-folder rename.
    await rename(join(project, 'src'), join(project, 'lib'));
    await expect(tree.getByRole('treeitem', { name: 'src', exact: true })).toHaveCount(0);
    await tree.evaluate((node) => {
      node.scrollTop = 0;
    });
    await tree.getByRole('treeitem', { name: 'lib', exact: true }).click();
    await tree.getByRole('treeitem', { name: 'nested', exact: true }).click();
    await expect(tree.getByRole('treeitem', { name: 'new.txt', exact: true })).toBeVisible();
    await expect(tree.getByRole('treeitem', { name: 'old.txt', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Show file explorer', exact: true }).uncheck();
    await expect.poll(async () => (await probe()).subscriptions.at(-1)).toEqual([]);
    await page.keyboard.press('Escape');
    await writeFile(join(project, 'external-while-hidden.txt'), 'hidden');
    await page.getByRole('button', { name: 'Explorer', exact: true }).click();
    tree = page.getByRole('tree', { name: 'Project files' });
    await expect(
      tree.getByRole('treeitem', { name: 'external-while-hidden.txt', exact: true })
    ).toBeVisible();
    await expect(tree.getByRole('treeitem', { name: 'new.txt', exact: true })).toBeVisible();
    await expect(tree.locator('[aria-selected="true"]')).toHaveText('nested');
    const metrics = {
      files: generated.length,
      creationReads,
      deletionReads: afterDeletion.paths.length,
      deletionMs,
      idleReads,
      maxConcurrentReads: afterDeletion.maxPending
    };
    expect(metrics.maxConcurrentReads).toBeLessThanOrEqual(4);
    console.log(JSON.stringify({ explorerSync: metrics }));
    await test.info().attach('explorer-sync-performance', {
      body: JSON.stringify(metrics, null, 2),
      contentType: 'application/json'
    });
  } finally {
    await running.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
