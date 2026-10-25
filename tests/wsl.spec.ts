import { expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { electron } from './helpers/electron';
import { wslArguments } from '../src/main/wsl';
import { parseWslPath, wslHostPath } from '../src/shared/wsl';

test('connect to WSL from the picker, edit with the keyboard and restore after restart', async () => {
  const distro = process.env.NIDO_TEST_WSL_DISTRO;
  test.skip(!distro, 'Set NIDO_TEST_WSL_DISTRO to test a real WSL distribution.');
  test.setTimeout(120000);
  const exec = promisify(execFile);
  const { stdout } = await exec(
    'wsl.exe',
    wslArguments(distro!, '~', ['mktemp', '-d', '/tmp/nido-wsl-ui-test-XXXXXXXX']),
    { windowsHide: true }
  );
  const fixture = stdout.trim();
  expect(fixture).toMatch(/^\/tmp\/nido-wsl-ui-test-[A-Za-z0-9]+$/);
  const linuxRoot = `${fixture}/日本語 Project`;
  const root = wslHostPath(distro!, linuxRoot);
  const profile = await mkdtemp(join(tmpdir(), 'nido-wsl-ui-profile-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const options = { args: ['.', `--user-data-dir=${profile}`], env };
  let running: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await mkdir(root);
    await writeFile(join(root, 'notes.txt'), 'Hello from Linux\n');
    running = await electron.launch(options);
    let page = await running.firstWindow();
    await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
    await page.getByRole('button', { name: 'Open a local or WSL workspace' }).click();
    const connection = page.getByRole('combobox', { name: 'Connection', exact: true });
    await expect(connection.locator('option', { hasText: `WSL: ${distro}` })).toHaveCount(1);
    await connection.selectOption(distro!);
    const address = page.getByRole('textbox', { name: 'Folder path' });
    await expect(address).toHaveValue(/^\//);
    await address.fill(linuxRoot);
    await address.press('Enter');
    await expect(page.getByRole('listbox', { name: 'Folders' })).toHaveAttribute(
      'aria-busy',
      'false'
    );
    await page.keyboard.press('Control+Enter');
    await expect(
      page.getByRole('tab', { name: 'Workspace 日本語 Project', exact: true })
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open a local or WSL workspace' })).toHaveText(
      `WSL: ${distro}`
    );
    await page.keyboard.press('Control+p');
    await page.getByRole('textbox', { name: 'Filter items' }).fill('notes.txt');
    await expect(page.getByRole('button', { name: /notes.txt/ })).toBeVisible();
    await page.keyboard.press('Enter');
    const input = page.getByRole('textbox', { name: 'Neovim input', exact: true });
    await expect(input).toBeFocused();
    await expect(page.locator('canvas:visible')).toHaveAttribute(
      'aria-description',
      /Hello from Linux/
    );
    await page.keyboard.type('ggIWSL edit: ');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+s');
    await expect
      .poll(() => readFile(join(root, 'notes.txt'), 'utf8'))
      .toBe('WSL edit: Hello from Linux\n');
    await page
      .getByRole('button', { name: 'Favorite workspace 日本語 Project', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Favorite workspace 日本語 Project', exact: true })
    ).toHaveAttribute('aria-pressed', 'true');
    await page.screenshot({ path: 'test-results/nido-wsl-editing.png' });
    await running.close();
    running = await electron.launch(options);
    page = await running.firstWindow();
    await expect(
      page.getByRole('tab', { name: 'Workspace 日本語 Project', exact: true })
    ).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('canvas:visible')).toHaveAttribute(
      'aria-description',
      /WSL edit: Hello from Linux/
    );
    await expect(page.getByRole('button', { name: 'Open a local or WSL workspace' })).toHaveText(
      `WSL: ${distro}`
    );
    const restored = await page.evaluate(() => window.nido.restoreWorkspaces());
    expect(parseWslPath(restored.workspaces[0].root)?.path).toBe(linuxRoot);
    expect(restored.errors).toEqual([]);
  } finally {
    await running?.close();
    expect(parseWslPath(wslHostPath(distro!, fixture))!.path).toMatch(
      /^\/tmp\/nido-wsl-ui-test-[A-Za-z0-9]+$/
    );
    await rm(wslHostPath(distro!, fixture), {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100
    });
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
