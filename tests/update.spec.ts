import { test, expect, _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { Transform } from 'node:stream';

test('the update button sits directly left of minimize and is disabled in development', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-update-button-'));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const running = await electron.launch({ args: ['.', `--user-data-dir=${root}`], env });
    try {
        const page = await running.firstWindow();
        const button = page.getByRole('button', { name: 'Check for updates', exact: true });
        await expect(button).toBeDisabled();
        await expect(button).toHaveAttribute('title', 'Install Nido to enable updates.');
        const update = (await button.boundingBox())!;
        const minimize = (await page.getByRole('button', { name: 'Minimize' }).boundingBox())!;
        expect(Math.abs(update.x + update.width - minimize.x)).toBeLessThan(1);
        expect(update.y).toBe(minimize.y);
        await expect(
            page.evaluate(() => window.nido.updateAction('invalid' as 'check'))
        ).rejects.toThrow('Unknown update action');
        expect((await page.evaluate(() => window.nido.updateAction('install'))).status).toBe(
            'disabled'
        );
    } finally {
        await running.evaluate(({ app }) => app.exit(0));
        await running.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test('a packaged update downloads and verifies an installer, permits cancellation, and saves before restart', async () => {
    test.skip(
        process.env.NIDO_UPDATER_FIXTURE !== '1',
        'Requires the dedicated dist/auto-update build.'
    );
    test.setTimeout(120000);
    const executable = resolve(process.env.NIDO_PACKAGED_EXE!);
    // Never create or remove an uninstaller marker in a user's installed application.
    assert.equal(
        executable.toLowerCase(),
        resolve('dist/auto-update/win-unpacked/nido.exe').toLowerCase()
    );
    const marker = join(dirname(executable), 'Uninstall nido.exe');
    const root = await mkdtemp(join(tmpdir(), 'nido-update-transfer-'));
    const profile = join(root, 'profile');
    const file = join(root, 'notes.txt');
    const version = JSON.parse(await readFile('package.json', 'utf8')).version as string;
    const [major, minor, patch] = version.split('.').map(Number);
    const nextVersion = `${major}.${minor}.${patch + 1}`;
    const installer = resolve(`dist/auto-update/nido-${version}-setup.exe`);
    const metadata = (await readFile('dist/auto-update/latest.yml', 'utf8')).replace(
        /^version: .*$/m,
        `version: ${nextVersion}`
    );
    const installerSize = (await stat(installer)).size;
    const server = createServer((request, response) => {
        if (request.url?.split('?')[0] === '/latest.yml') {
            response.writeHead(200, { 'Content-Type': 'text/yaml' });
            response.end(metadata);
        } else if (request.url?.split('?')[0] === '/' + basename(installer)) {
            response.writeHead(200, { 'Content-Length': installerSize });
            const slow = new Transform({
                transform(chunk, _encoding, callback) {
                    setTimeout(() => callback(null, chunk), 2);
                }
            });
            createReadStream(installer).pipe(slow).pipe(response);
        } else {
            response.writeHead(404);
            response.end();
        }
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const port = (server.address() as { port: number }).port;
    await mkdir(profile);
    await writeFile(file, 'Original text\n');
    await writeFile(
        join(profile, 'workspaces.json'),
        JSON.stringify({
            version: 1,
            active: 0,
            window: { width: 1200, height: 900, maximized: false },
            workspaces: [{ root, current: file, files: [{ path: file, line: 1, column: 0 }] }]
        })
    );
    await writeFile(marker, 'Nido updater test fixture only', { flag: 'wx' });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const running = await electron.launch({
        executablePath: executable,
        args: [`--user-data-dir=${profile}`],
        env
    });
    try {
        await running.evaluate(({ app, dialog }, url) => {
            const requireFromApp = process
                .getBuiltinModule('module')
                .createRequire(app.getAppPath() + '/package.json');
            const updater = requireFromApp('electron-updater').autoUpdater;
            Object.defineProperty(updater.app, 'baseCachePath', {
                value: app.getPath('userData') + '/cache'
            });
            updater.disableDifferentialDownload = true;
            updater.setFeedURL({ provider: 'generic', url });
            const recorded = { installs: 0, prompts: 0, response: 1, saved: '' };
            Object.assign(globalThis, { recordedUpdate: recorded });
            dialog.showMessageBox = async () => {
                recorded.prompts++;
                return { response: recorded.response, checkboxChecked: false };
            };
            // Exercise the real updater transport; stop at the OS installation boundary.
            updater.quitAndInstall = (silent: boolean, restart: boolean): void => {
                if (!silent || !restart) throw new Error('Silent install must restart Nido.');
                const fs = requireFromApp('node:fs');
                recorded.saved = fs.readFileSync(
                    app.getPath('userData') + '/workspaces.json',
                    'utf8'
                );
                recorded.installs++;
            };
        }, `http://127.0.0.1:${port}`);
        const page = await running.firstWindow();
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        const input = page.getByRole('textbox', { name: 'Neovim input' });
        await expect(input).toBeFocused();
        await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
        const download = page.getByRole('button', { name: 'Download update', exact: true });
        await expect(download).toHaveAttribute('title', `Download update · ${nextVersion}`);
        await download.click();
        await expect(
            page.getByRole('button', { name: /^Downloading update \d+%$/ })
        ).toBeDisabled();
        const restart = page.getByRole('button', { name: 'Restart to update', exact: true });
        await expect(restart).toBeVisible({ timeout: 90000 });
        await page.screenshot({
            path: process.env.NIDO_UPDATE_SCREENSHOT ?? 'test-results/update-ready.png'
        });
        await page.evaluate(() => localStorage.setItem('nido.animations', 'false'));
        await page.reload();
        await expect(restart).toBeVisible();
        await input.focus();
        await page.keyboard.type('iUnsaved ');
        await page.keyboard.press('Escape');
        await restart.click();
        await expect(restart).toBeVisible();
        expect(await readFile(file, 'utf8')).toBe('Original text\n');
        expect(
            await running.evaluate(
                () =>
                    (globalThis as unknown as { recordedUpdate: { installs: number } })
                        .recordedUpdate.installs
            )
        ).toBe(0);
        await running.evaluate(() => {
            (
                globalThis as unknown as { recordedUpdate: { response: number } }
            ).recordedUpdate.response = 0;
        });
        await restart.click();
        await expect
            .poll(() =>
                running.evaluate(
                    () =>
                        (globalThis as unknown as { recordedUpdate: { installs: number } })
                            .recordedUpdate.installs
                )
            )
            .toBe(1);
        expect(await readFile(file, 'utf8')).toBe('Unsaved Original text\n');
        const recorded = await running.evaluate(
            () =>
                (globalThis as unknown as { recordedUpdate: { prompts: number; saved: string } })
                    .recordedUpdate
        );
        expect(recorded.prompts).toBe(2);
        expect(JSON.parse(recorded.saved).workspaces[0].current).toBe(file);
        expect(errors).toEqual([]);
    } finally {
        await running.evaluate(({ app }) => app.exit(0));
        await running.close();
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
        await rm(marker, { force: true });
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});
