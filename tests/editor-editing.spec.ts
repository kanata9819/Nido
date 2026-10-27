import { test, expect } from '@playwright/test';
import { electron } from './helpers/electron';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('basic editing shortcuts indent, comment, undo and redo without leaving insert input behind', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nido-editing-shortcuts-'));
  const profile = join(root, 'profile');
  const file = join(root, 'sample.lua');
  await mkdir(profile);
  await writeFile(file, 'local one = 1\nlocal two = 2\n');
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
  try {
    const page = await running.firstWindow();
    const input = page.getByRole('textbox', { name: 'Neovim input' });
    await expect(input).toBeFocused();
    const save = async (expected: string): Promise<void> => {
      await page.keyboard.press('Control+s');
      await expect.poll(() => readFile(file, 'utf8')).toBe(expected);
    };
    await page.keyboard.press('i');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Backspace');
    await save('  local one = 1\nlocal two = 2\n');
    await page.keyboard.press('Control+/');
    await expect(page.getByText('INSERT', { exact: true })).toBeVisible();
    await save('  -- local one = 1\nlocal two = 2\n');
    await page.keyboard.press('Control+/');
    await page.keyboard.press('Shift+Tab');
    await save('local one = 1\nlocal two = 2\n');
    await page.keyboard.press('Escape');
    await page.keyboard.type('ggVj');
    await page.keyboard.press('Tab');
    await save('  local one = 1\n  local two = 2\n');
    await page.keyboard.press('Shift+Tab');
    await save('local one = 1\nlocal two = 2\n');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+z');
    await save('  local one = 1\n  local two = 2\n');
    await page.keyboard.press('Control+Shift+z');
    await save('local one = 1\nlocal two = 2\n');
    await page.keyboard.type('ggVj');
    await page.keyboard.press('Control+/');
    await save('-- local one = 1\n-- local two = 2\n');
    const command = async (title: string): Promise<void> => {
      await page.keyboard.press('Control+Shift+p');
      await page.getByRole('textbox', { name: 'Filter items' }).fill(title);
      await page.keyboard.press('Enter');
      await expect(input).toBeFocused();
    };
    await command('Undo');
    await save('local one = 1\nlocal two = 2\n');
    await command('Redo');
    await save('-- local one = 1\n-- local two = 2\n');
    await page.keyboard.type('gg');
    await command('Toggle line comments');
    await save('local one = 1\n-- local two = 2\n');
    await page.screenshot({ path: test.info().outputPath('editing-shortcuts.png') });
  } finally {
    await running.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
