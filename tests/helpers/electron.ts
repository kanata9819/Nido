import { _electron, test, type ElectronApplication, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

type LaunchOptions = Parameters<typeof _electron.launch>[0];

export const electron = {
    async launch(options: LaunchOptions): Promise<ElectronApplication> {
        const packaged = process.env.NIDO_PACKAGED_EXE;
        const running = await _electron.launch(
            packaged
                ? {
                      ...options,
                      executablePath: resolve(packaged),
                      // Older development tests pass '.' as their first argument.
                      args: options?.args?.[0] === '.' ? options.args.slice(1) : options?.args
                  }
                : options
        );
        const info = test.info();
        const errors: string[] = [];
        const pages = new WeakSet<Page>();
        let stderr = '';
        running.process().stderr?.on('data', (data: Buffer) => {
            stderr = (stderr + data.toString()).slice(-50000);
        });
        const observe = (page: Page): void => {
            if (pages.has(page)) return;
            pages.add(page);
            page.on('pageerror', (error) => errors.push(error.stack || error.message));
            page.on('crash', () => errors.push('Electron renderer crashed.'));
        };
        for (const page of running.windows()) observe(page);
        running.on('window', observe);
        if (packaged && !(await running.evaluate(({ app }) => app.isPackaged))) {
            await running.close();
            throw new Error(
                'Windows baseline launched a development app instead of the packaged executable.'
            );
        }
        const close = running.close.bind(running);
        const closeWithinDeadline = async (): Promise<void> => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const timeoutError = new Error('Electron did not close within 30 seconds.');
            try {
                await Promise.race([
                    close(),
                    new Promise<never>((_resolve, reject) => {
                        timer = setTimeout(() => reject(timeoutError), 30000);
                    })
                ]);
            } catch (error) {
                if (error === timeoutError) {
                    const child = running.process();
                    // Stop only this test's app and its descendants; keep shutdown a failure.
                    if (process.platform === 'win32' && child.pid) {
                        try {
                            execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
                                stdio: 'ignore',
                                timeout: 10000
                            });
                        } catch {
                            child.kill();
                        }
                    } else {
                        child.kill('SIGKILL');
                    }
                    await info.attach('electron-shutdown-stderr', {
                        body: stderr,
                        contentType: 'text/plain'
                    });
                }
                throw error;
            } finally {
                clearTimeout(timer);
            }
        };
        let closing: Promise<void> | undefined;
        running.close = async (): Promise<void> => {
            if (closing) return closing;
            closing = (async () => {
                try {
                    if (info.status !== info.expectedStatus || errors.length) {
                        for (const [index, page] of running.windows().entries()) {
                            if (!page.isClosed()) {
                                await info.attach(`electron-window-${index}`, {
                                    body: await page.screenshot().catch(() => Buffer.alloc(0)),
                                    contentType: 'image/png'
                                });
                            }
                        }
                    }
                    // Tests may close the app in their finally block before Playwright marks a failure.
                    await info.attach('electron-stderr', {
                        body: stderr,
                        contentType: 'text/plain'
                    });
                } finally {
                    await closeWithinDeadline();
                }
                if (errors.length) {
                    await info.attach('electron-runtime-errors', {
                        body: errors.join('\n'),
                        contentType: 'text/plain'
                    });
                    throw new Error(`Unhandled Electron runtime errors:\n${errors.join('\n')}`);
                }
            })();
            return closing;
        };
        return running;
    }
};
