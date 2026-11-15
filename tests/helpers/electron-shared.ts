// Helpers shared by the electron test files.
import { expect, type Page } from '@playwright/test';
import { realpath } from 'node:fs/promises';

export async function chooseWorkspace(page: Page, path: string, navigate = false): Promise<void> {
	const canonicalPath = await realpath(path);
	const folders = page.getByRole('listbox', { name: 'Folders' });
	await expect(folders).toHaveAttribute('aria-busy', 'false');
	const address = page.getByRole('textbox', { name: 'Folder path' });
	await address.fill(path);
	await address.press('Enter');
	await expect(page.getByRole('listbox', { name: 'Folders' })).toHaveAttribute(
		'aria-busy',
		'false'
	);
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
		await expect(page.getByRole('listbox', { name: 'Folders' })).toHaveAttribute(
			'aria-busy',
			'false'
		);
		await page.keyboard.press('h');
		await expect(page.getByRole('textbox', { name: 'Folder path' })).toHaveValue(canonicalPath);
		await expect(page.getByRole('listbox', { name: 'Folders' })).toHaveAttribute(
			'aria-busy',
			'false'
		);
		await page.screenshot({ path: 'test-results/nido-folder-picker.png' });
	}
	await page.keyboard.press('Control+Enter');
}
