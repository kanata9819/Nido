import { test, expect, type Page } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { electron } from './helpers/electron';

async function openWorkspace(page: Page, path: string): Promise<void> {
    await page.keyboard.press('Control+Shift+n');
    const address = page.getByRole('textbox', { name: 'Folder path' });
    await address.fill(path);
    await address.press('Enter');
    await expect(page.getByRole('listbox', { name: 'Folders' })).toHaveAttribute(
        'aria-busy',
        'false'
    );
    await page.keyboard.press('Control+Enter');
    await expect(page.getByRole('tree', { name: 'Project files' })).toHaveAttribute(
        'aria-busy',
        'false'
    );
}

test('Explorer restores each project expansion, selection and viewport after hiding and a normal restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-explorer-state-'));
    const project = join(root, 'Project');
    const other = join(root, 'Other');
    await mkdir(join(project, 'crate', 'chibi', 'src'), { recursive: true });
    await mkdir(join(other, 'crate'), { recursive: true });
    await Promise.all(
        Array.from({ length: 80 }, (_, index) =>
            writeFile(join(project, `file-${String(index).padStart(2, '0')}.txt`), 'sample\n')
        )
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const options = { args: ['.', `--user-data-dir=${join(root, 'profile')}`], env };
    let running: Awaited<ReturnType<typeof electron.launch>> | undefined;
    try {
        running = await electron.launch(options);
        let page = await running.firstWindow();
        await page.setViewportSize({ width: 1000, height: 650 });
        await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
        await openWorkspace(page, project);
        let tree = page.getByRole('tree', { name: 'Project files' });
        await tree.getByRole('treeitem', { name: 'crate', exact: true }).click();
        await tree.getByRole('treeitem', { name: 'chibi', exact: true }).click();
        await expect(tree.getByRole('treeitem', { name: 'src', exact: true })).toBeVisible();
        const originalSelection = await tree.getAttribute('aria-activedescendant');
        // Keep the selected folder above the viewport to catch accidental selection auto-scroll.
        await tree.evaluate((node) => {
            node.scrollTop = 780;
        });
        await expect.poll(() => tree.evaluate((node) => node.scrollTop)).toBe(780);
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.getByRole('checkbox', { name: 'Show file explorer', exact: true }).uncheck();
        await expect(tree).toHaveCount(0);
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'Explorer', exact: true }).click();
        tree = page.getByRole('tree', { name: 'Project files' });
        await expect(tree).toHaveAttribute('aria-busy', 'false');
        await expect(tree.locator('[aria-selected="true"]')).toHaveText('chibi');
        await expect.poll(() => tree.evaluate((node) => node.scrollTop)).toBe(780);
        await openWorkspace(page, other);
        tree = page.getByRole('tree', { name: 'Project files' });
        await expect(tree.getByRole('treeitem', { name: 'crate', exact: true })).toHaveAttribute(
            'aria-expanded',
            'false'
        );
        await expect(tree.locator('[aria-selected="true"]')).toHaveCount(0);
        await page.getByRole('tab', { name: 'Workspace Project', exact: true }).click();
        await expect.poll(() => tree.evaluate((node) => node.scrollTop)).toBe(780);
        await running.close();
        running = await electron.launch(options);
        page = await running.firstWindow();
        await page.setViewportSize({ width: 1000, height: 650 });
        await expect(
            page.getByRole('tab', { name: 'Workspace Project', exact: true })
        ).toHaveAttribute('aria-selected', 'true');
        tree = page.getByRole('tree', { name: 'Project files' });
        await expect(tree).toHaveAttribute('aria-busy', 'false');
        await expect(tree.locator('[aria-selected="true"]')).toHaveText('chibi');
        expect(await tree.getAttribute('aria-activedescendant')).not.toBe(originalSelection);
        await expect.poll(() => tree.evaluate((node) => node.scrollTop)).toBe(780);
        await page.screenshot({ path: 'test-results/explorer-restored.png' });
        await tree.focus();
        await page.keyboard.press('ArrowDown');
        await expect(tree.locator('[aria-selected="true"]')).toHaveText('src');
        await expect.poll(() => tree.evaluate((node) => node.scrollTop)).toBeLessThan(780);
        await expect(tree.getByRole('treeitem', { name: 'crate', exact: true })).toHaveAttribute(
            'aria-expanded',
            'true'
        );
        await expect(tree.getByRole('treeitem', { name: 'chibi', exact: true })).toHaveAttribute(
            'aria-expanded',
            'true'
        );
        await expect(tree.getByRole('treeitem', { name: 'src', exact: true })).toHaveAttribute(
            'aria-expanded',
            'false'
        );
        await page.getByRole('tab', { name: 'Workspace Other', exact: true }).click();
        await expect(tree).toHaveAttribute('aria-busy', 'false');
        await expect(tree.getByRole('treeitem', { name: 'crate', exact: true })).toHaveAttribute(
            'aria-expanded',
            'false'
        );
        await expect(tree.locator('[aria-selected="true"]')).toHaveCount(0);
        await expect.poll(() => tree.evaluate((node) => node.scrollTop)).toBe(0);
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.getByRole('checkbox', { name: 'Show file explorer', exact: true }).uncheck();
        await running.close();
        running = await electron.launch(options);
        page = await running.firstWindow();
        await expect(page.getByRole('tab', { name: 'Workspace Other', exact: true })).toBeVisible();
        await expect(page.getByRole('tree', { name: 'Project files' })).toHaveCount(0);
        await page.getByRole('button', { name: 'Explorer', exact: true }).click();
        await expect(page.getByRole('tree', { name: 'Project files' })).toHaveAttribute(
            'aria-busy',
            'false'
        );
    } finally {
        await running?.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});
