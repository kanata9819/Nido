import type { Page, TestInfo } from '@playwright/test';
import type { NidoEvent, SessionState } from '../../src/shared/types';

interface EditorDiagnostics {
    id?: string;
    state?: SessionState;
    events: unknown[];
    keys: unknown[];
    focus: unknown[];
}

type DiagnosticWindow = Window & { editorDiagnostics?: EditorDiagnostics };

export async function recordEditorDiagnostics(page: Page): Promise<void> {
    await page.evaluate(() => {
        const diagnostics: EditorDiagnostics = { events: [], keys: [], focus: [] };
        (window as DiagnosticWindow).editorDiagnostics = diagnostics;
        const focused = (): string => {
            const element = document.activeElement;
            return `${element?.tagName} ${element?.getAttribute('aria-label') || ''}`;
        };
        window.nido.onEvent((event: NidoEvent) => {
            if (event.type === 'state') {
                diagnostics.id = event.id;
                diagnostics.state = event.state;
            } else if (event.type !== 'redraw') {
                diagnostics.events.push(event);
                diagnostics.events = diagnostics.events.slice(-20);
            }
        });
        document.addEventListener(
            'keydown',
            (event) => {
                diagnostics.keys.push({
                    key: event.key,
                    ctrl: event.ctrlKey,
                    shift: event.shiftKey,
                    alt: event.altKey,
                    focus: focused()
                });
                diagnostics.keys = diagnostics.keys.slice(-50);
            },
            true
        );
        document.addEventListener('focusin', () => {
            diagnostics.focus.push(focused());
            diagnostics.focus = diagnostics.focus.slice(-20);
        });
    });
}

export async function attachEditorDiagnostics(page: Page, testInfo: TestInfo): Promise<void> {
    // Capture before the test closes Electron, which otherwise leaves an empty error context.
    await Promise.allSettled([
        (async () => {
            const snapshot = await page.evaluate(async () => {
                const diagnostics = (window as DiagnosticWindow).editorDiagnostics;
                const mode = diagnostics?.id
                    ? await Promise.race([
                          window.nido.inputMode(diagnostics.id).catch(String),
                          new Promise<string>((resolve) =>
                              setTimeout(() => resolve('Mode request did not finish.'), 2000)
                          )
                      ])
                    : undefined;
                return { ...diagnostics, mode, body: document.body.innerText };
            });
            await testInfo.attach('editor-state', {
                body: JSON.stringify(snapshot, null, 2),
                contentType: 'application/json'
            });
        })(),
        (async () => {
            await testInfo.attach('editor-before-cleanup', {
                body: await page.screenshot(),
                contentType: 'image/png'
            });
        })()
    ]);
}
