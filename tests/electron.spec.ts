import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('normal shutdown restores workspace order, active file and cursors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nido-restart-'))
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const executablePath = process.env.NIDO_PACKAGED_EXE
  if (executablePath) {
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') env[key] = ''
    env.VIMINIT = 'lua error("Personal configuration must not run")'
  }
  const args = [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`]
  let running: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    await mkdir(join(root, 'One'))
    await mkdir(join(root, 'Two'))
    await writeFile(join(root, 'One', 'a.txt'), 'first line\nsecond line\nthird line\n')
    await writeFile(join(root, 'One', 'b.txt'), 'another line\n')
    await writeFile(join(root, 'One', 'highlight.rs'), 'fn main() { let greeting = "hello"; }\n')
    await writeFile(
      join(root, 'One', 'Cargo.toml'),
      '[package]\nname = "nido_highlight_fixture"\nversion = "0.1.0"\nedition = "2021"\n[lib]\npath = "highlight.rs"\n'
    )
    running = await electron.launch({ executablePath, args, env })
    let page = await running.firstWindow()
    await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible()
    await running.evaluate(
      ({ dialog }, paths) => {
        let i = 0
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths[i++]] })
      },
      [join(root, 'One'), join(root, 'Two')]
    )
    await page.keyboard.press('Control+Shift+n')
    await expect(page.getByRole('tab', { name: 'Workspace One', exact: true })).toBeVisible()
    await page.keyboard.press('Control+p')
    await page.getByRole('textbox', { name: 'Filter items' }).fill('highlight.rs')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('tab', { name: 'highlight.rs', exact: true })).toBeVisible()
    await expect
      .poll(() =>
        page.locator('canvas:visible').evaluate((element) => {
          const canvas = element as HTMLCanvasElement
          const pixels = canvas
            .getContext('2d')!
            .getImageData(0, 0, canvas.width, canvas.height).data
          let keyword = false,
            string = false
          for (let i = 0; i < pixels.length; i += 4) {
            if (pixels[i] === 86 && pixels[i + 1] === 156 && pixels[i + 2] === 214) keyword = true
            if (pixels[i] === 206 && pixels[i + 1] === 145 && pixels[i + 2] === 120) string = true
          }
          return keyword && string
        })
      )
      .toBe(true)
    await page.screenshot({ path: 'test-results/nido-rust-highlights.png' })
    for (const [file, keys] of [
      ['a.txt', '3G4l'],
      ['b.txt', 'gg6l']
    ]) {
      await page.keyboard.press('Control+p')
      await page.getByRole('textbox', { name: 'Filter items' }).fill(file)
      await expect(page.getByRole('button', { name: `${file} ${file}`, exact: true })).toBeVisible()
      await page.keyboard.press('Enter')
      await expect(page.getByRole('tab', { name: file, exact: true })).toBeVisible()
      await page.keyboard.type(keys)
    }
    await expect(page.getByText('Ln 1, Col 7', { exact: true })).toBeVisible()
    await page.keyboard.press('Control+Shift+n')
    await expect(page.getByRole('tab', { name: 'Workspace Two', exact: true })).toBeVisible()
    await page.keyboard.press('Space')
    await page.keyboard.press('h')
    const closed = running.waitForEvent('close')
    await page.evaluate(() => {
      void window.nido.windowAction('close')
    })
    await closed
    running = await electron.launch({ executablePath, args, env })
    page = await running.firstWindow()
    await expect(page.getByRole('tab', { name: 'Workspace Two', exact: true })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await page.keyboard.press('Alt+2')
    await expect(page.getByRole('tab', { name: 'Workspace One', exact: true })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await expect(page.getByText('Ln 1, Col 7', { exact: true })).toBeVisible()
    await page.getByRole('tab', { name: 'a.txt', exact: true }).click()
    await expect(page.getByText('Ln 3, Col 5', { exact: true })).toBeVisible()
  } finally {
    if (running) {
      await running.evaluate(({ app }) => app.exit(0)).catch(() => {})
      await running.close()
    }
    await rm(root, { recursive: true, force: true })
  }
})

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
  const executablePath = process.env.NIDO_PACKAGED_EXE
  if (executablePath) {
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') env[key] = ''
    env.VIMINIT = 'lua error("Personal configuration must not run")'
  }
  const app = await electron.launch({
    executablePath,
    args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`],
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
    const welcome = page.getByRole('region', { name: 'Workspace welcome' })
    await expect(welcome).toBeVisible()
    await expect(page.locator('canvas:visible')).not.toHaveAttribute('aria-description', /NVIM v/)
    await page.screenshot({ path: 'test-results/nido-workspace-welcome.png' })
    await page.keyboard.press('i')
    await expect(welcome).toBeHidden()
    await page.keyboard.type('draft')
    await page.keyboard.press('Escape')
    await expect(welcome).toBeHidden()
    await page.keyboard.press('u')
    await expect(welcome).toBeVisible()
    await page.keyboard.type(':')
    await expect(welcome).toBeHidden()
    await page.keyboard.press('Escape')
    await expect(welcome).toBeVisible()
    await page.getByRole('button', { name: 'Open a file' }).click()
    await page.getByRole('textbox', { name: 'Filter items' }).fill('WorkspaceTabs')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('tab', { name: 'WorkspaceTabs.tsx' })).toBeVisible()
    await expect(welcome).toBeHidden()
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
