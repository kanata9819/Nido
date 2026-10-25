import { test, expect } from '@playwright/test';
import { electron } from './helpers/electron';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const standalone of [false, true]) {
  test(`${standalone ? 'standalone' : 'panel'} terminal closes on shell exit and returns focus to the editor`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-terminal-exit-ui-'));
    const profile = join(root, 'profile');
    const file = join(root, 'notes.txt');
    await mkdir(profile);
    await writeFile(file, Array.from({ length: 500 }, (_, i) => `ROW_${i + 1}`).join('\n'));
    await writeFile(
      join(profile, 'workspaces.json'),
      JSON.stringify({
        version: 1,
        active: standalone ? 1 : 0,
        workspaces: [
          { root, current: file, files: [{ path: file, line: 1, column: 0 }] },
          ...(standalone ? [{ root, kind: 'terminal', current: '', files: [] }] : [])
        ]
      })
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const running = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], env });
    try {
      const page = await running.firstWindow();
      if (!standalone) {
        await expect(
          page.getByRole('textbox', { name: 'Neovim input', exact: true })
        ).toBeFocused();
        await page.keyboard.press('Control+@');
      }
      const terminalInput = page.getByRole('textbox', {
        name: 'Terminal input',
        exact: true
      });
      const terminalCanvas = page.locator('canvas[aria-label="Terminal display"]:visible');
      await expect(terminalInput).toBeFocused();
      await expect(terminalCanvas).toHaveAttribute('aria-description', /PS .*?>/, {
        timeout: 15000
      });
      await page.keyboard.type('exit');
      await page.keyboard.press('Enter');
      await expect(page.locator('canvas[aria-label="Terminal display"]')).toHaveCount(0);
      const editor = page.getByRole('textbox', { name: 'Neovim input', exact: true });
      await expect(editor).toBeFocused();
      await expect(page.getByRole('tab', { name: /^Workspace / })).toHaveCount(1);
      const restored = await page.evaluate(() => window.nido.restoreWorkspaces());
      expect(restored.workspaces[0].terminalId).toBeUndefined();

      await page.keyboard.press('Control+@');
      await expect(terminalInput).toBeFocused();
      await expect(terminalCanvas).toHaveAttribute('aria-description', /PS .*?>/, {
        timeout: 15000
      });
      await page.getByRole('button', { name: /Restart shell/ }).click();
      await expect(terminalInput).toBeFocused();
      await page.keyboard.type('exit 7');
      await page.keyboard.press('Enter');
      await expect(page.locator('canvas[aria-label="Terminal display"]')).toHaveCount(0);
      await expect(editor).toBeFocused();
      await expect(page.getByRole('alert')).toHaveCount(0);

      // A normal 120 px wheel step now travels 60 px, even after reopening terminals.
      const canvas = page.locator('canvas[aria-label="Neovim editor display"]:visible');
      await canvas.hover();
      await page.mouse.wheel(0, 120);
      await expect(canvas).toHaveAttribute('aria-description', /^[^\n]*\bROW_4\b/);
      await page.mouse.wheel(0, -120);
      await expect(canvas).toHaveAttribute('aria-description', /^[^\n]*\bROW_1\b/);
      await page.screenshot({
        path: `test-results/terminal-exit-${standalone ? 'standalone' : 'panel'}.png`
      });

      // An exiting shell must not steal focus from another panel.
      await page.keyboard.press('Control+@');
      await expect(terminalInput).toBeFocused();
      await page.keyboard.type('Start-Sleep -Milliseconds 1500; exit');
      await page.keyboard.press('Enter');
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
      await expect(settings).toBeVisible();
      await expect(page.locator('canvas[aria-label="Terminal display"]')).toHaveCount(0);
      await expect(settings).toBeVisible();
    } finally {
      await running.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}
