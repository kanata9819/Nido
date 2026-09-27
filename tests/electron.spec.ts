import { test, expect, _electron as electron, type Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('Git changes can be reviewed, staged and committed with the keyboard', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nido-git-ui-'));
  const repository = join(root, 'repo');
  await mkdir(repository);
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repository, encoding: 'utf8', windowsHide: true });
  git('init');
  git('config', 'user.name', 'Nido Test');
  git('config', 'user.email', 'nido-test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  await writeFile(join(repository, 'main.rs'), 'fn main() {}\n');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let running: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const executablePath = process.env.NIDO_PACKAGED_EXE;
    running = await electron.launch({
      executablePath,
      args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`],
      env
    });
    const page = await running.firstWindow();
    await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
    await page.keyboard.press('Control+Shift+n');
    await chooseWorkspace(page, repository);
    await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
    await page.keyboard.press('Control+Shift+g');
    const panel = page.getByRole('region', { name: 'Git changes' });
    await expect(panel).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByRole('listbox', { name: 'Changed files' })).toBeFocused();
    await expect(page.getByLabel('Git diff')).toContainText('+fn main() {}');
    await page.keyboard.press('s');
    await expect(page.getByRole('heading', { name: 'Staged changes' })).toBeVisible();
    await expect(panel).toHaveAttribute('aria-busy', 'false');
    await page.keyboard.press('u');
    await expect(page.getByRole('heading', { name: 'Staged changes' })).toHaveCount(0);
    await expect(panel).toHaveAttribute('aria-busy', 'false');
    await page.keyboard.press('s');
    await expect(panel.getByRole('heading', { name: 'Staged changes' })).toBeVisible();
    await expect(panel).toHaveAttribute('aria-busy', 'false');
    await page.screenshot({ path: 'test-results/nido-git.png' });
    await page.keyboard.press('c');
    await expect(page.getByRole('textbox', { name: 'Commit message' })).toBeFocused();
    await page.keyboard.type('First commit');
    await page.keyboard.press('Control+Enter');
    await expect(panel.getByText('Working tree clean.')).toBeVisible();
    expect(git('log', '-1', '--format=%s').trim()).toBe('First commit');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
    await page.keyboard.press('Space');
    await page.keyboard.press('g');
    await expect(panel).toBeVisible();
  } finally {
    await running?.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function chooseWorkspace(page: Page, path: string, navigate = false): Promise<void> {
  await expect(page.getByRole('listbox', { name: 'Folders' })).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('textbox', { name: 'Folder path' }).fill(path);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox', { name: 'Folders' })).toHaveAttribute('aria-busy', 'false');
  if (navigate) {
    await expect(page.getByRole('listbox', { name: 'Folders' })).toBeFocused();
    await page.keyboard.press('j');
    await expect(page.getByRole('listbox', { name: 'Folders' })).toHaveAttribute(
      'aria-activedescendant',
      'folder-choice-1'
    );
    await page.keyboard.press('k');
    await page.keyboard.press('l');
    await expect(page.getByRole('textbox', { name: 'Folder path' })).not.toHaveValue(path);
    await expect(page.getByRole('listbox', { name: 'Folders' })).toHaveAttribute('aria-busy', 'false');
    await page.keyboard.press('h');
    await expect(page.getByRole('textbox', { name: 'Folder path' })).toHaveValue(path);
    await expect(page.getByRole('listbox', { name: 'Folders' })).toHaveAttribute('aria-busy', 'false');
    await page.screenshot({ path: 'test-results/nido-folder-picker.png' });
  }
  await page.keyboard.press('Control+Enter');
}

test('terminal toggle, focus, background execution and standalone terminal sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nido-terminal-ui-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let running: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const executablePath = process.env.NIDO_PACKAGED_EXE;
    running = await electron.launch({
      executablePath,
      args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`],
      env
    });
    const page = await running.firstWindow();
    await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
    await page.keyboard.press('Control+Shift+n');
    await chooseWorkspace(page, root);
    await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
    await page.keyboard.press('Control+@');
    const terminal = page.getByRole('region', { name: 'Terminal', exact: true });
    await expect(terminal).toBeVisible();
    const explorerBounds = await page.getByRole('complementary', { name: 'File explorer' }).boundingBox();
    const terminalBounds = await terminal.boundingBox();
    assert.ok(explorerBounds && terminalBounds);
    assert.ok(terminalBounds.x >= explorerBounds.x + explorerBounds.width);
    assert.ok(explorerBounds.y + explorerBounds.height >= terminalBounds.y + terminalBounds.height - 1);
    await expect(page.getByRole('contentinfo').locator(':scope > :first-child')).toHaveText('NORMAL');
    await expect(terminal.getByRole('textbox', { name: 'Terminal input' })).toBeFocused();
    await page.keyboard.type(
      "$nidoValue = 'alive'; Start-Sleep -Milliseconds 500; Set-Content background.txt $nidoValue"
    );
    await page.keyboard.press('Enter');
    await page.keyboard.press('Control+@');
    await expect(terminal).toBeHidden();
    await expect.poll(async () => readFile(join(root, 'background.txt'), 'utf8').catch(() => '')).toContain('alive');
    await page.keyboard.press('Control+j');
    await expect(terminal.getByRole('textbox', { name: 'Terminal input' })).toBeFocused();
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
    await page.keyboard.press('Control+j');
    await expect(terminal.getByRole('textbox', { name: 'Terminal input' })).toBeFocused();
    await page.keyboard.type('Set-Content preserved.txt $nidoValue');
    await page.keyboard.press('Enter');
    await expect.poll(async () => readFile(join(root, 'preserved.txt'), 'utf8').catch(() => '')).toContain('alive');
    await expect(terminal.getByRole('button', { name: /Restart shell/ })).toHaveCSS('font-size', '12px');
    await page.keyboard.press('Control+Shift+r');
    await page.keyboard.type('Set-Content restarted.txt ([string]::IsNullOrEmpty($nidoValue))');
    await page.keyboard.press('Enter');
    await expect
      .poll(async () => readFile(join(root, 'restarted.txt'), 'utf8').catch(() => ''))
      .toContain('True')
      .catch(async (error) => {
        await page.screenshot({ path: 'test-results/restart-failure.png' });
        throw error;
      });
    await page.screenshot({ path: 'test-results/nido-terminal.png' });
    await page.keyboard.press('Control+Shift+n');
    await expect(page.getByRole('combobox', { name: 'Session type' })).toBeVisible();
    await page.getByRole('combobox', { name: 'Session type' }).focus();
    await page.keyboard.press('End');
    await chooseWorkspace(page, root);
    const input = page.getByRole('textbox', { name: 'Terminal input' });
    await expect(input).toHaveCount(1);
    await expect(input).toBeFocused();
    await page.keyboard.type("Set-Content standalone.txt 'separate'");
    await page.keyboard.press('Enter');
    await expect.poll(async () => readFile(join(root, 'standalone.txt'), 'utf8').catch(() => '')).toContain('separate');
    await page.keyboard.press('Control+Tab');
    await page.keyboard.press('Control+j');
    await expect(terminal.getByRole('textbox', { name: 'Terminal input' })).toBeFocused();
    const closed = running.waitForEvent('close');
    await page.evaluate(() => {
      void window.nido.windowAction('close');
    });
    await closed;
    running = await electron.launch({
      executablePath,
      args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`],
      env
    });
    const restored = await running.firstWindow();
    await expect(restored.getByRole('tab', { name: /^Workspace / })).toHaveCount(2, { timeout: 15000 });
    await restored.keyboard.press('Alt+2');
    await expect(restored.getByRole('textbox', { name: 'Terminal input' })).toBeFocused();
    await restored.keyboard.type("Set-Content restored.txt 'restored'");
    await restored.keyboard.press('Enter');
    await expect.poll(async () => readFile(join(root, 'restored.txt'), 'utf8').catch(() => '')).toContain('restored');
  } finally {
    await running?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('viewport movement animates with keyboard and wheel and respects settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nido-motion-'));
  const content = Array.from({ length: 200 }, (_, index) => `line ${index + 1} ${'text '.repeat(60)}`).join('\n');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let running: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await writeFile(join(root, 'scroll.txt'), content);
    const executablePath = process.env.NIDO_PACKAGED_EXE;
    running = await electron.launch({
      executablePath,
      args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`],
      env
    });
    const page = await running.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
    await page.keyboard.press('Control+Shift+n');
    await chooseWorkspace(page, root);
    await expect(page.getByRole('treeitem', { name: 'scroll.txt', exact: true })).toBeVisible();
    await page.keyboard.press('Control+p');
    await page.getByRole('textbox', { name: 'Filter items' }).fill('scroll.txt');
    await expect(page.getByRole('button', { name: /scroll.txt/ })).toBeVisible();
    await page.keyboard.press('Enter');
    const canvas = page.locator('canvas:visible');
    await expect(canvas).toHaveAttribute('aria-description', /line 1 /);
    await page.keyboard.type(':set nowrap');
    await page.keyboard.press('Enter');
    await expect(canvas).toHaveAttribute('aria-description', /line 20/);
    await canvas.evaluate((surface) => {
      const context = (surface as HTMLCanvasElement).getContext('2d')!;
      const draw = context.drawImage.bind(context);
      context.drawImage = ((...args: Parameters<typeof draw>) => {
        surface.setAttribute(
          'data-animation-frames',
          String(Number(surface.getAttribute('data-animation-frames') || 0) + 1)
        );
        draw(...args);
      }) as typeof draw;
    });
    await canvas.hover();
    await page.mouse.wheel(0, 100);
    await expect.poll(async () => Number(await canvas.getAttribute('data-animation-frames'))).toBeGreaterThan(2);
    await page.waitForTimeout(250);
    let frames = await canvas.getAttribute('data-animation-frames');
    await page.waitForTimeout(150);
    expect(await canvas.getAttribute('data-animation-frames')).toBe(frames);
    for (const key of ['Control+d', 'Control+u', 'Control+e', 'Control+y', 'Control+f', 'Control+b']) {
      await page.keyboard.press(key);
      await expect
        .poll(async () => Number(await canvas.getAttribute('data-animation-frames')), { message: key })
        .toBeGreaterThan(Number(frames));
      await page.waitForTimeout(150);
      frames = await canvas.getAttribute('data-animation-frames');
    }
    for (const command of ['G', 'gg', '100G', 'zt', 'zb', 'zz', '/line 150\n', 'zL', 'zH']) {
      await page.keyboard.type(command);
      await expect
        .poll(async () => Number(await canvas.getAttribute('data-animation-frames')), { message: command })
        .toBeGreaterThan(Number(frames));
      await page.waitForTimeout(150);
      frames = await canvas.getAttribute('data-animation-frames');
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const before = await canvas.getAttribute('aria-description');
    await page.mouse.wheel(0, 100);
    await expect(canvas).not.toHaveAttribute('aria-description', before!);
    expect(await canvas.getAttribute('data-animation-frames')).toBe(frames);
    expect(await readFile(join(root, 'scroll.txt'), 'utf8')).toBe(content);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const toggle = page.getByRole('checkbox', { name: 'UI animations' });
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCSS('animation-name', 'none');
    await page.keyboard.press('Escape');
    const beforeDisabledScroll = await canvas.getAttribute('aria-description');
    await canvas.hover();
    await page.mouse.wheel(0, 100);
    await expect(canvas).not.toHaveAttribute('aria-description', beforeDisabledScroll!);
    expect(await canvas.getAttribute('data-animation-frames')).toBe(frames);
    for (const key of ['Control+d', 'Control+u', 'Control+f', 'Control+b']) {
      const beforeKey = await canvas.getAttribute('aria-description');
      await page.keyboard.press(key);
      await expect(canvas).not.toHaveAttribute('aria-description', beforeKey!);
      expect(await canvas.getAttribute('data-animation-frames')).toBe(frames);
    }
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await toggle.check();
    await page.keyboard.press('Escape');
    await canvas.hover();
    await page.mouse.wheel(0, 100);
    await expect
      .poll(async () => Number(await canvas.getAttribute('data-animation-frames')))
      .toBeGreaterThan(Number(frames));
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await toggle.uncheck();
    await running.close();
    running = await electron.launch({
      executablePath,
      args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`],
      env
    });
    const restoredPage = await running.firstWindow();
    await restoredPage.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(restoredPage.getByRole('checkbox', { name: 'UI animations' })).not.toBeChecked();
    expect(errors).toEqual([]);
  } finally {
    await running?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('references stay accessible after jumping and can be closed with the keyboard', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nido-references-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let running: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'Cargo.toml'), '[package]\nname="nido_references"\nversion="0.1.0"\nedition="2021"\n');
    await writeFile(
      join(root, 'src/main.rs'),
      'fn greet() -> u32 { 42 }\nfn main() {\n    let answer = greet();\n    println!("{answer}");\n}\n'
    );
    const executablePath = process.env.NIDO_PACKAGED_EXE;
    running = await electron.launch({
      executablePath,
      args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`],
      env
    });
    const page = await running.firstWindow();
    await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
    await page.keyboard.press('Control+Shift+n');
    await chooseWorkspace(page, root);
    await expect(page.getByRole('treeitem', { name: 'src', exact: true })).toBeVisible();
    await page.keyboard.press('Control+p');
    await page.getByRole('textbox', { name: 'Filter items' }).fill('main.rs');
    await expect(page.getByRole('button', { name: /main.rs/ })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(async () => {
      await page.keyboard.press('Control+k');
      await page.keyboard.type('gg0wgr');
      await expect(page.getByRole('listbox', { name: 'Reference results' }).getByRole('option')).toHaveCount(2, {
        timeout: 1000
      });
    }).toPass({ timeout: 30000 });
    const list = page.getByRole('listbox', { name: 'Reference results' });
    await expect(list).toBeFocused();
    const preview = page.getByRole('region', { name: 'Reference preview', exact: true });
    await expect(preview).toContainText('fn main()');
    await expect(preview.locator('[data-current="true"]')).toContainText('fn greet()');
    await page.keyboard.press('j');
    await expect(preview.locator('[data-current="true"]')).toContainText('let answer');
    await expect(
      page.getByRole('listbox', { name: 'Reference results' }).getByRole('option', { selected: true })
    ).toContainText('let answer');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
    await expect(preview).toBeHidden();
    await expect(page.getByRole('region', { name: 'References' })).toBeVisible();
    await page.keyboard.press('Control+j');
    await expect(list).toBeFocused();
    await expect(preview).toContainText('println!');
    await expect(
      page.getByRole('listbox', { name: 'Reference results' }).getByRole('option', { selected: true })
    ).toContainText('let answer');
    await page.screenshot({ path: 'test-results/nido-references.png' });
    await page.keyboard.press('k');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
    await page.keyboard.press('Control+j');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('region', { name: 'References' })).toBeHidden();
    await page.keyboard.press('Control+j');
    await expect(list).toBeFocused();
    await page.keyboard.press('Space');
    await page.keyboard.press('d');
    await expect(page.getByRole('region', { name: 'References' })).toBeHidden();
    await expect(page.getByRole('tab', { name: 'main.rs', exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: '[Untitled]', exact: true })).toHaveCount(0);
    await page.keyboard.press('Shift+F12');
    await expect(page.getByRole('region', { name: 'References' })).toBeVisible();
  } finally {
    await running?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Rust debugger keyboard controls stop, inspect and step in the packaged app', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nido-debug-ui-'));
  let running: Awaited<ReturnType<typeof electron.launch>> | undefined;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    await mkdir(join(root, 'src'));
    await mkdir(join(root, 'src/bin'));
    await writeFile(join(root, 'src/bin/other.rs'), 'fn main() {}');
    await writeFile(join(root, 'Cargo.toml'), '[package]\nname="nido_debug_ui"\nversion="0.1.0"\nedition="2021"\n');
    await writeFile(
      join(root, 'src/main.rs'),
      'fn main() {\n    let number = 21;\n    let answer = number * 2;\n    println!("answer={answer}");\n}\n'
    );
    const executablePath = process.env.NIDO_PACKAGED_EXE;
    running = await electron.launch({
      executablePath,
      args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`],
      env
    });
    await running.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => {
        throw new Error('Native folder picker must not be used');
      };
    });
    const page = await running.firstWindow();
    await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
    await page.keyboard.press('Control+Shift+n');
    await expect(page.getByRole('listbox', { name: 'Folders' })).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByRole('listbox', { name: 'Folders' })).toBeFocused();
    await page.keyboard.press('Control+l');
    await expect(page.getByRole('textbox', { name: 'Folder path' })).toBeFocused();
    await page.keyboard.type('relative-path');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('alert')).toContainText('absolute folder path');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.keyboard.press('Control+Shift+n');
    await chooseWorkspace(page, root, true);
    await expect(page.getByRole('treeitem', { name: 'src', exact: true })).toBeVisible();
    await page.keyboard.press('Control+p');
    await page.getByRole('textbox', { name: 'Filter items' }).fill('main.rs');
    await expect(page.getByRole('button', { name: /main.rs.*src/ })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('tab', { name: 'main.rs', exact: true })).toBeVisible();
    await page.keyboard.type('3G');
    await page.keyboard.press('F9');
    await expect(page.getByRole('region', { name: 'Debugger' })).toBeVisible();
    await page.keyboard.press('F5');
    await expect(page.getByRole('region', { name: 'Debugger' })).toContainText('Choose a binary:', { timeout: 30000 });
    await page.keyboard.press('Control+j');
    await expect(page.locator('[data-debug-target]:focus')).toHaveCount(1);
    for (
      let i = 0;
      i < 10 &&
      !(await page
        .getByRole('button', { name: 'nido_debug_ui', exact: true })
        .evaluate((element) => element === document.activeElement));
      i++
    )
      await page.keyboard.press('l');
    await expect(page.getByRole('button', { name: 'nido_debug_ui', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('region', { name: 'Debugger' })).toContainText('Debug · paused', { timeout: 30000 });
    await expect(page.getByLabel('Debug variables')).toContainText('number = 21');
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
    await page.keyboard.press('Control+h');
    await expect(page.getByRole('tree', { name: 'Project files' })).toBeFocused();
    await page.keyboard.press('Control+l');
    await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
    await page.keyboard.press('Control+j');
    await expect(page.getByRole('button', { name: /Continue/ })).toBeFocused();
    await page.keyboard.press('Space');
    await page.keyboard.press('d');
    await expect(page.getByRole('region', { name: 'Debugger' })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
    await expect(page.getByRole('tab', { name: 'main.rs', exact: true })).toBeVisible();
    await page.keyboard.press('F10');
    await expect(page.getByRole('region', { name: 'Debugger' })).toHaveCount(0);
    await page.keyboard.press('Control+j');
    await expect(page.getByLabel('Debug variables')).toContainText('answer = 42');
    await page.screenshot({ path: 'test-results/nido-debugger.png' });
    await page.keyboard.press('Shift+F5');
    await expect(page.getByRole('region', { name: 'Debugger' })).toContainText('Debug · finished');
  } finally {
    await running?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('normal shutdown restores workspace order, active file and cursors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nido-restart-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.NIDO_PACKAGED_EXE;
  if (executablePath) {
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') env[key] = '';
    env.VIMINIT = 'lua error("Personal configuration must not run")';
  }
  const args = [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`];
  let running: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await mkdir(join(root, 'One'));
    await mkdir(join(root, 'Two'));
    await writeFile(join(root, 'One', 'a.txt'), 'first line\nsecond line\nthird line\n');
    await writeFile(join(root, 'One', 'b.txt'), 'another line\n');
    await writeFile(join(root, 'One', 'mixed.txt'), 'first\r\nsecond\n');
    await writeFile(join(root, 'One', 'highlight.rs'), 'fn main() { let greeting = "hello"; }\n');
    await writeFile(
      join(root, 'One', 'Cargo.toml'),
      '[package]\nname = "nido_highlight_fixture"\nversion = "0.1.0"\nedition = "2021"\n[lib]\npath = "highlight.rs"\n'
    );
    running = await electron.launch({ executablePath, args, env });
    let page = await running.firstWindow();
    await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
    await page.keyboard.press('Control+Shift+n');
    await chooseWorkspace(page, join(root, 'One'));
    await expect(page.getByRole('tab', { name: 'Workspace One', exact: true })).toBeVisible();
    await expect(page.getByRole('treeitem', { name: 'a.txt', exact: true })).toBeVisible();
    await page.keyboard.press('Control+p');
    await page.getByRole('textbox', { name: 'Filter items' }).fill('mixed.txt');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('combobox', { name: 'Line endings' })).toHaveValue('Mixed');
    await expect(page.getByRole('alert')).toContainText('Mixed line endings detected');
    await page.getByRole('button', { name: 'Dismiss error' }).click();
    await page.getByRole('combobox', { name: 'Line endings' }).selectOption('LF');
    await expect(page.getByRole('combobox', { name: 'Line endings' })).toHaveValue('LF');
    assert.equal(await readFile(join(root, 'One', 'mixed.txt'), 'utf8'), 'first\r\nsecond\n');
    await page.keyboard.press('Control+s');
    await expect.poll(() => readFile(join(root, 'One', 'mixed.txt'), 'utf8')).toBe('first\nsecond\n');
    await page.keyboard.press('Control+Shift+p');
    await page.getByRole('textbox', { name: 'Filter items' }).fill('Convert line endings to CRLF');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('combobox', { name: 'Line endings' })).toHaveValue('CRLF');
    await page.keyboard.press('Control+s');
    await expect.poll(() => readFile(join(root, 'One', 'mixed.txt'), 'utf8')).toBe('first\r\nsecond\r\n');
    await page.keyboard.press('Space');
    await page.keyboard.press('d');
    await expect(page.getByRole('tab', { name: 'mixed.txt', exact: true })).toHaveCount(0);
    await page.keyboard.press('Control+p');
    await page.getByRole('textbox', { name: 'Filter items' }).fill('highlight.rs');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('tab', { name: 'highlight.rs', exact: true })).toBeVisible();
    await expect
      .poll(() =>
        page.locator('canvas:visible').evaluate((element) => {
          const canvas = element as HTMLCanvasElement;
          const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
          let keyword = false,
            string = false;
          for (let i = 0; i < pixels.length; i += 4) {
            if (pixels[i] === 86 && pixels[i + 1] === 156 && pixels[i + 2] === 214) keyword = true;
            if (pixels[i] === 206 && pixels[i + 1] === 145 && pixels[i + 2] === 120) string = true;
          }
          return keyword && string;
        })
      )
      .toBe(true);
    await page.screenshot({ path: 'test-results/nido-rust-highlights.png' });
    const cursorIsVisible = (): Promise<boolean> =>
      page.locator('canvas:visible').evaluate((element) => {
        const canvas = element as HTMLCanvasElement;
        const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Neovim input"]')!;
        const scale = window.devicePixelRatio || 1;
        const pixel = canvas
          .getContext('2d')!
          .getImageData(
            Math.floor((parseFloat(input.style.left) + 1) * scale),
            Math.floor((parseFloat(input.style.top) + 3) * scale),
            1,
            1
          ).data;
        return pixel[0] > 80;
      });
    await expect.poll(cursorIsVisible, { intervals: [50] }).toBe(true);
    await expect.poll(cursorIsVisible, { intervals: [50] }).toBe(false);
    await expect.poll(cursorIsVisible, { intervals: [50] }).toBe(true);
    await expect.poll(cursorIsVisible, { intervals: [50] }).toBe(false);
    await page.keyboard.press('ArrowLeft');
    await expect.poll(cursorIsVisible, { intervals: [20], timeout: 400 }).toBe(true);
    await expect
      .poll(() =>
        page.locator('canvas:visible').evaluate((element) => {
          const canvas = element as HTMLCanvasElement;
          const scale = window.devicePixelRatio || 1;
          const ctx = canvas.getContext('2d')!;
          const sample = (y: number): string =>
            Array.from(ctx.getImageData(canvas.width - 2, Math.floor((y + 0.5) * scale), 1, 1).data)
              .slice(0, 3)
              .join(',');
          return [sample(0), sample(24), sample(12)];
        })
      )
      .toEqual(['70,81,92', '70,81,92', '20,20,20']);
    await expect(page.getByTitle('Rust language server connection')).toHaveText('rust_analyzer');
    await page.keyboard.type(
      ":lua vim.lsp.handlers['$/progress'](nil, {token='nido-ui-test',value={kind='begin',title='Indexing',message='example_crate',percentage=42}}, {client_id=vim.lsp.get_clients({name='rust_analyzer'})[1].id})"
    );
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status')).toContainText('Indexing — example_crate (42%)');
    await page.screenshot({ path: 'test-results/nido-lsp-progress.png' });
    await page.keyboard.type(
      ":lua vim.lsp.handlers['$/progress'](nil, {token='nido-ui-test',value={kind='end'}}, {client_id=vim.lsp.get_clients({name='rust_analyzer'})[1].id})"
    );
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: 'example_crate' })).toHaveCount(0);
    await page.keyboard.type(
      ":lua vim.lsp.handlers['window/showMessage'](nil, {type=2,message='Failed to run build scripts of some packages.'}, {client_id=vim.lsp.get_clients({name='rust_analyzer'})[1].id})"
    );
    await page.keyboard.press('Enter');
    await expect(page.getByRole('alert')).toContainText('LSP[rust_analyzer][Warning] Failed to run build scripts');
    await expect(page.locator('canvas:visible')).not.toHaveAttribute('aria-description', /Press ENTER/);
    await page.screenshot({ path: 'test-results/nido-lsp-warning.png' });
    await page.getByRole('button', { name: 'Dismiss error' }).click();
    await page.locator('textarea:visible').focus();
    await page.keyboard.type(
      ":lua vim.lsp.util.open_floating_preview({'# Nido documentation', '', '**Markdown preview**'}, 'markdown', {})"
    );
    await page.keyboard.press('Enter');
    await expect(page.locator('canvas:visible')).toHaveAttribute('aria-description', /Markdown preview/);
    await expect(page.locator('canvas:visible')).not.toHaveAttribute(
      'aria-description',
      /Parser could not be created|Error executing/
    );
    await page.screenshot({ path: 'test-results/nido-documentation.png' });
    await page.keyboard.press('j');
    await page.keyboard.type('gg0w');
    await expect(async () => {
      await page.keyboard.press('K');
      await expect(page.locator('canvas:visible')).toHaveAttribute('aria-description', /Type information/, {
        timeout: 1000
      });
    }).toPass({ timeout: 20000 });
    await page.screenshot({ path: 'test-results/nido-hover.png' });
    for (const [file, keys] of [
      ['a.txt', '3G4l'],
      ['b.txt', 'gg6l']
    ]) {
      await page.keyboard.press('Control+p');
      await page.getByRole('textbox', { name: 'Filter items' }).fill(file);
      await expect(page.getByRole('button', { name: `${file} ${file}`, exact: true })).toBeVisible();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('tab', { name: file, exact: true })).toBeVisible();
      await page.keyboard.type(keys);
    }
    await expect(page.getByText('Ln 1, Col 7', { exact: true })).toBeVisible();
    await page.keyboard.press('Shift+H');
    await expect(page.getByRole('tab', { name: 'a.txt', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('Ln 3, Col 5', { exact: true })).toBeVisible();
    await page.keyboard.press('Shift+L');
    await expect(page.getByRole('tab', { name: 'b.txt', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Shift+L');
    await expect(page.getByRole('tab', { name: 'highlight.rs', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Shift+H');
    await expect(page.getByRole('tab', { name: 'b.txt', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Control+h');
    await expect(page.getByRole('tree', { name: 'Project files' })).toBeFocused();
    const explorer = page.getByRole('complementary', { name: 'File explorer' });
    await page.keyboard.press('Shift+L');
    await expect(explorer).toHaveCSS('width', '263px');
    await page.keyboard.press('Shift+H');
    await expect(explorer).toHaveCSS('width', '243px');
    const edge = await page.getByRole('separator', { name: 'Explorer width' }).boundingBox();
    assert.ok(edge);
    await page.mouse.move(edge.x + edge.width / 2, edge.y + 100);
    await page.mouse.down();
    await page.mouse.move(edge.x + edge.width / 2 + 40, edge.y + 100);
    await page.mouse.up();
    await expect(explorer).toHaveCSS('width', '283px');
    await page.keyboard.press('Control+l');
    await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
    await page.keyboard.press('i');
    await expect(page.getByText('INSERT', { exact: true })).toBeVisible();
    await expect(page.getByText('INSERT', { exact: true })).toHaveCSS('background-color', 'rgb(134, 189, 221)');
    await page.keyboard.press('Shift+H');
    await page.keyboard.press('Shift+L');
    await expect(page.locator('canvas:visible')).toHaveAttribute('aria-description', /HL/);
    await expect(page.getByRole('tab', { name: 'b.txt Unsaved', exact: true })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await page.keyboard.press('Escape');
    await page.keyboard.press('u');
    await expect(page.getByText('Ln 1, Col 7', { exact: true })).toBeVisible();
    await page.keyboard.press('Control+Shift+n');
    await chooseWorkspace(page, join(root, 'Two'));
    await expect(page.getByRole('tab', { name: 'Workspace Two', exact: true })).toBeVisible();
    await page.keyboard.press('Space');
    await page.keyboard.press('h');
    const closed = running.waitForEvent('close');
    await page.evaluate(() => {
      void window.nido.windowAction('close');
    });
    await closed;
    running = await electron.launch({ executablePath, args, env });
    page = await running.firstWindow();
    await expect(page.getByRole('complementary', { name: 'File explorer' })).toHaveCSS('width', '283px');
    await expect(page.getByRole('tab', { name: 'Workspace Two', exact: true })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await page.keyboard.press('Alt+2');
    await expect(page.getByRole('tab', { name: 'Workspace One', exact: true })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await expect(page.getByText('Ln 1, Col 7', { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'a.txt', exact: true }).click();
    await expect(page.getByText('Ln 3, Col 5', { exact: true })).toBeVisible();
  } finally {
    if (running) {
      await running.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await running.close();
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('keyboard-only workspace switching, editing, saving and dirty-close guard', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nido-e2e-'));
  await mkdir(join(root, 'Nido'));
  await mkdir(join(root, 'Portfolio'));
  await writeFile(
    join(root, 'Nido', 'WorkspaceTabs.tsx'),
    `import { useState } from 'react'\n\ninterface Workspace {\n  id: string\n  name: string\n}\n\nexport function WorkspaceTabs() {\n  const [active, setActive] = useState('nido')\n  const workspaces: Workspace[] = [\n    { id: 'nido', name: 'Nido' },\n    { id: 'portfolio', name: 'Portfolio' }\n  ]\n\n  return (\n    <nav aria-label="Workspaces">\n      {workspaces.map((workspace) => (\n        <button\n          key={workspace.id}\n          onClick={() => setActive(workspace.id)}\n          aria-selected={active === workspace.id}\n        >\n          {workspace.name}\n        </button>\n      ))}\n    </nav>\n  )\n}\n`
  );
  await writeFile(join(root, 'Nido', 'App.tsx'), 'export default function App() { return null }\n');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.NIDO_PACKAGED_EXE;
  if (executablePath) {
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') env[key] = '';
    env.VIMINIT = 'lua error("Personal configuration must not run")';
  }
  const app = await electron.launch({
    executablePath,
    args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`],
    env
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    await page.keyboard.press('Control+Shift+n');
    await chooseWorkspace(page, join(root, 'Nido'));
    await expect(page.getByRole('tab', { name: 'Workspace Nido', exact: true })).toBeVisible();
    const welcome = page.getByRole('region', { name: 'Workspace welcome' });
    await expect(welcome).toBeVisible();
    await expect(page.locator('canvas:visible')).not.toHaveAttribute('aria-description', /NVIM v/);
    await page.screenshot({ path: 'test-results/nido-workspace-welcome.png' });
    await page.keyboard.press('i');
    await expect(welcome).toBeHidden();
    await page.keyboard.type('draft');
    await page.keyboard.press('Escape');
    await expect(welcome).toBeHidden();
    await page.keyboard.press('u');
    await expect(welcome).toBeVisible();
    await page.keyboard.type(':');
    await expect(welcome).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(welcome).toBeVisible();
    await page.getByRole('button', { name: 'Open a file' }).click();
    await page.getByRole('textbox', { name: 'Filter items' }).fill('WorkspaceTabs');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('tab', { name: 'WorkspaceTabs.tsx' })).toBeVisible();
    await expect(welcome).toBeHidden();
    await page.keyboard.type('gg0i// smoke test');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+s');
    await expect.poll(() => readFile(join(root, 'Nido', 'WorkspaceTabs.tsx'), 'utf8')).toContain('// smoke test');
    await expect(page.locator('canvas:visible')).toHaveAttribute('aria-description', /smoke test/);
    await page.keyboard.press('Control+v');
    await expect(page.getByText('VISUAL', { exact: true })).toBeVisible();
    await expect(page.getByText('VISUAL', { exact: true })).toHaveCSS('background-color', 'rgb(201, 166, 230)');
    await page.keyboard.press('Escape');
    await page.keyboard.type('Go');
    await page.locator('textarea:visible').evaluate((element) => {
      const input = element as HTMLTextAreaElement;
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      input.value = '日本語入力';
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '日本語入力', isComposing: true }));
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '日本語入力' }));
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '日本語入力' }));
    });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+s');
    await expect
      .poll(async () => (await readFile(join(root, 'Nido', 'WorkspaceTabs.tsx'), 'utf8')).match(/日本語入力/g)?.length)
      .toBe(1);
    await expect(page.locator('canvas:visible')).toHaveAttribute('aria-description', /日本語入力/);
    await page.keyboard.type('gg');
    await page.keyboard.press('Control+Shift+n');
    await chooseWorkspace(page, join(root, 'Portfolio'));
    await expect(page.getByRole('tab', { name: 'Workspace Portfolio', exact: true })).toBeVisible();
    await page.keyboard.type('iindependent buffer');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Tab');
    await expect(page.getByRole('tab', { name: 'Workspace Nido', exact: true })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await page.keyboard.press('Space');
    await expect(page.getByRole('dialog', { name: 'Keyboard commands' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Space');
    await page.keyboard.press('e');
    await expect(page.getByRole('tree', { name: 'Project files' })).toBeFocused();
    await page.keyboard.press('Home');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('tab', { name: 'App.tsx', exact: true })).toBeVisible();
    await page.keyboard.press('Space');
    await page.keyboard.press('b');
    await page.getByRole('textbox', { name: 'Filter items' }).fill('WorkspaceTabs');
    await page.keyboard.press('Enter');
    await expect(page.locator('canvas:visible')).toHaveAttribute('aria-description', /smoke test/);
    await page.keyboard.press('Space');
    await page.screenshot({ path: 'test-results/nido-editor.png' });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Alt+2');
    await page.keyboard.press('Space');
    await page.keyboard.press('x');
    await expect(page.getByRole('tab', { name: 'Workspace Portfolio', exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Workspace Portfolio', exact: true })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await expect(page.locator('canvas:visible')).toHaveAttribute('aria-description', /independent buffer/);
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false });
    });
    await page.keyboard.press('Space');
    await page.keyboard.press('x');
    await expect(page.getByRole('tab', { name: 'Workspace Portfolio', exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await app.evaluate(({ app }) => app.exit(0));
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
