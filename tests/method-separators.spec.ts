import {
  test,
  expect,
  _electron as electron,
  type Page,
  type ElectronApplication
} from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('method separators toggle by keyboard, repaint existing lines and survive an app restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nido-method-separators-'));
  const profile = join(root, 'profile');
  const file = join(root, 'main.rs');
  await mkdir(profile);
  await writeFile(
    join(root, 'Cargo.toml'),
    '[package]\nname="separator_probe"\nversion="0.1.0"\nedition="2021"\n[[bin]]\nname="separator_probe"\npath="main.rs"\n'
  );
  await writeFile(
    file,
    [
      'struct Screen;',
      'impl Screen {',
      '    fn first(&self) {',
      '        if true { println!("first"); }',
      '    }',
      '',
      '    fn second(&self) {}',
      '}',
      '',
      'fn main() { Screen.first(); Screen.second(); }'
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
  const launch = (): Promise<ElectronApplication> =>
    electron.launch({ args: ['.', `--user-data-dir=${profile}`], env });
  let running = await launch();
  const errors: string[] = [];
  const probe = async (page: Page): Promise<void> => {
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.locator('canvas:visible')).toHaveAttribute(
      'aria-description',
      /struct Screen/
    );
    await page.evaluate(() => {
      const node = document.querySelector('canvas')!;
      const context = node.getContext('2d')!;
      const fill = context.fillRect.bind(context);
      context.fillRect = (x, y, width, height) => {
        if (x === 0 && y === 0 && height > 100) node.dataset.separatorLines = '[]';
        if (Math.abs(context.globalAlpha - 0.22) < 0.001 && width > 100 && height <= 1) {
          const lines = JSON.parse(node.dataset.separatorLines || '[]');
          lines.push({ x, y, width, height });
          node.dataset.separatorLines = JSON.stringify(lines);
        }
        fill(x, y, width, height);
      };
    });
  };
  const count = (page: Page): Promise<number> =>
    page
      .locator('canvas:visible')
      .evaluate(
        (node) => JSON.parse((node as HTMLCanvasElement).dataset.separatorLines || '[]').length
      );
  try {
    const page = await running.firstWindow();
    await probe(page);
    await page.keyboard.type(' ,');
    const toggle = page.getByRole('checkbox', { name: 'Method separators', exact: true });
    await expect(toggle).not.toBeChecked();
    await page.getByRole('checkbox', { name: 'Word wrap', exact: true }).focus();
    await page.keyboard.press('j');
    await expect(toggle).toBeFocused();
    await page.keyboard.press('Space');
    await expect(toggle).toBeChecked();
    await page.keyboard.press('Escape');
    await expect.poll(() => count(page)).toBe(3);
    await page
      .locator('canvas:visible')
      .screenshot({ path: test.info().outputPath('method-separators-on.png') });
    await page.keyboard.type(' ,');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).not.toBeChecked();
    await page.keyboard.press('Escape');
    await expect.poll(() => count(page)).toBe(0);
    await page.keyboard.type(' ,');
    await toggle.check();
    await page.keyboard.press('Escape');
    await expect.poll(() => count(page)).toBe(3);
    await running.close();
    running = await launch();
    const restored = await running.firstWindow();
    await probe(restored);
    await restored.keyboard.type(' ,');
    await expect(
      restored.getByRole('checkbox', { name: 'Method separators', exact: true })
    ).toBeChecked();
    await restored.getByRole('combobox', { name: 'Language', exact: true }).selectOption('ja');
    await expect(
      restored.getByRole('checkbox', { name: 'メソッドセパレータ', exact: true })
    ).toBeChecked();
    await restored.keyboard.press('Escape');
    await restored.keyboard.type('j');
    await expect.poll(() => count(restored)).toBe(3);
    expect(errors).toEqual([]);
  } finally {
    await running.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
