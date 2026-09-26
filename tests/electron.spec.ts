import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('keyboard-only workspace switching, editing, saving and dirty-close guard', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nido-e2e-'))
  await mkdir(join(root, 'Nido'))
  await mkdir(join(root, 'Portfolio'))
  await writeFile(
    join(root, 'Nido', 'WorkspaceTabs.tsx'),
    `import { useState } from 'react'\n\ninterface Workspace {\n  id: string\n  name: string\n}\n\nexport function WorkspaceTabs() {\n  const [active, setActive] = useState('nido')\n  const workspaces: Workspace[] = [\n    { id: 'nido', name: 'Nido' },\n    { id: 'portfolio', name: 'Portfolio' }\n  ]\n\n  return (\n    <nav aria-label="Workspaces">\n      {workspaces.map((workspace) => (\n        <button\n          key={workspace.id}\n          onClick={() => setActive(workspace.id)}\n          aria-selected={active === workspace.id}\n        >\n          {workspace.name}\n        </button>\n      ))}\n    </nav>\n  )\n}\n`
  )
  await writeFile(join(root, 'Nido', 'App.tsx'), 'export default function App() { return null }\n')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${join(root, 'profile')}`],
    env
  })
  try {
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible()
    await app.evaluate(
      ({ dialog }, paths) => {
        let index = 0
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths[index++]] })
        dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
      },
      [join(root, 'Nido'), join(root, 'Portfolio')]
    )
    await page.keyboard.press('Control+Shift+n')
    await expect(page.getByRole('tab', { name: 'Workspace Nido', exact: true })).toBeVisible()
    await page.keyboard.press('Control+p')
    await page.getByRole('textbox', { name: 'Filter items' }).fill('WorkspaceTabs')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('tab', { name: 'WorkspaceTabs.tsx' })).toBeVisible()
    await page.keyboard.type('gg0i// smoke test')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+s')
    await expect
      .poll(() => readFile(join(root, 'Nido', 'WorkspaceTabs.tsx'), 'utf8'))
      .toContain('// smoke test')
    await expect(page.locator('canvas:visible')).toHaveAttribute('aria-description', /smoke test/)
    await page.keyboard.press('Control+v')
    await expect(page.getByText('VISUAL', { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.keyboard.type('Go')
    await page.locator('textarea:visible').evaluate((element) => {
      const input = element as HTMLTextAreaElement
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      input.value = '日本語入力'
      input.dispatchEvent(
        new InputEvent('input', { bubbles: true, data: '日本語入力', isComposing: true })
      )
      input.dispatchEvent(
        new CompositionEvent('compositionend', { bubbles: true, data: '日本語入力' })
      )
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '日本語入力' }))
    })
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+s')
    await expect
      .poll(
        async () =>
          (await readFile(join(root, 'Nido', 'WorkspaceTabs.tsx'), 'utf8')).match(/日本語入力/g)
            ?.length
      )
      .toBe(1)
    await expect(page.locator('canvas:visible')).toHaveAttribute('aria-description', /日本語入力/)
    await page.keyboard.type('gg')
    await page.keyboard.press('Control+Shift+n')
    await expect(page.getByRole('tab', { name: 'Workspace Portfolio', exact: true })).toBeVisible()
    await page.keyboard.type('iindependent buffer')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+Tab')
    await expect(page.getByRole('tab', { name: 'Workspace Nido', exact: true })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await page.keyboard.press('Space')
    await expect(page.getByRole('dialog', { name: 'Keyboard commands' })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Space')
    await page.keyboard.press('e')
    await expect(page.getByRole('tree', { name: 'Project files' })).toBeFocused()
    await page.keyboard.press('Home')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('tab', { name: 'App.tsx', exact: true })).toBeVisible()
    await page.keyboard.press('Space')
    await page.keyboard.press('b')
    await page.getByRole('textbox', { name: 'Filter items' }).fill('WorkspaceTabs')
    await page.keyboard.press('Enter')
    await expect(page.locator('canvas:visible')).toHaveAttribute('aria-description', /smoke test/)
    await page.keyboard.press('Space')
    await page.screenshot({ path: 'test-results/nido-editor.png' })
    await page.keyboard.press('Escape')
    await page.keyboard.press('Alt+2')
    await page.keyboard.press('Space')
    await page.keyboard.press('x')
    await expect(page.getByRole('tab', { name: 'Workspace Portfolio', exact: true })).toBeVisible()
    await expect(
      page.getByRole('tab', { name: 'Workspace Portfolio', exact: true })
    ).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('canvas:visible')).toHaveAttribute(
      'aria-description',
      /independent buffer/
    )
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false })
    })
    await page.keyboard.press('Space')
    await page.keyboard.press('x')
    await expect(page.getByRole('tab', { name: 'Workspace Portfolio', exact: true })).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    await app.evaluate(({ app }) => app.exit(0))
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})
