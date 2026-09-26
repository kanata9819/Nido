import type { Redraw } from '../../shared/types'

export interface Cell {
    text: string
    highlight: number
}
interface Highlight {
    foreground?: number
    background?: number
    special?: number
    bold?: boolean
    italic?: boolean
    underline?: boolean
    undercurl?: boolean
    reverse?: boolean
    strikethrough?: boolean
}
export class Grid {
    cells: Cell[][] = []
    highlights = new Map<number, Highlight>()
    columns = 0
    rows = 0
    cursor = { row: 0, column: 0 }
    foreground = '#d6dce2'
    background = '#191e23'
    mode = 'normal'
    busy = false
    apply(events: Redraw): boolean {
        let flush = false
        for (const [name, ...calls] of events) {
            if (name === 'flush') flush = true
            if (name === 'busy_start') this.busy = true
            if (name === 'busy_stop') this.busy = false
            for (const args of calls) {
                if (name === 'grid_resize' && args[0] === 1) {
                    this.columns = Number(args[1])
                    this.rows = Number(args[2])
                    this.cells = Array.from({ length: this.rows }, (_, row) =>
                        Array.from(
                            { length: this.columns },
                            (_, col) => this.cells[row]?.[col] || { text: ' ', highlight: 0 }
                        )
                    )
                } else if (name === 'grid_clear' && args[0] === 1) {
                    this.cells = Array.from({ length: this.rows }, () =>
                        Array.from({ length: this.columns }, () => ({ text: ' ', highlight: 0 }))
                    )
                } else if (name === 'grid_line' && args[0] === 1) {
                    const row = this.cells[Number(args[1])]
                    let column = Number(args[2]),
                        highlight = 0
                    for (const cell of args[3] as [string, number?, number?][]) {
                        if (cell[1] !== undefined) highlight = cell[1]
                        for (let i = 0; i < (cell[2] ?? 1); i++) {
                            if (row && column < this.columns) row[column] = { text: cell[0], highlight }
                            column++
                        }
                    }
                } else if (name === 'grid_scroll' && args[0] === 1) {
                    const [, top, bottom, left, right, rows, columns] = args as number[]
                    const old = this.cells.map((row) => row.slice())
                    for (let row = top; row < bottom; row++)
                        for (let col = left; col < right; col++) {
                            const sourceRow = row + rows,
                                sourceCol = col + columns
                            this.cells[row][col] =
                                sourceRow >= top && sourceRow < bottom && sourceCol >= left && sourceCol < right
                                    ? old[sourceRow][sourceCol]
                                    : { text: ' ', highlight: 0 }
                        }
                } else if (name === 'hl_attr_define') this.highlights.set(Number(args[0]), args[1] as Highlight)
                else if (name === 'default_colors_set') {
                    if (Number(args[0]) >= 0) this.foreground = color(Number(args[0]))
                    if (Number(args[1]) >= 0) this.background = color(Number(args[1]))
                } else if (name === 'grid_cursor_goto' && args[0] === 1)
                    this.cursor = { row: Number(args[1]), column: Number(args[2]) }
                else if (name === 'mode_change') this.mode = String(args[0])
                else if (name === 'busy_start') this.busy = true
                else if (name === 'busy_stop') this.busy = false
                else if (name === 'flush') flush = true
            }
        }
        return flush
    }

    draw(
        canvas: HTMLCanvasElement,
        width: number,
        height: number,
        fontSize: number,
        focused: boolean
    ): { cellWidth: number; cellHeight: number } {
        const ctx = canvas.getContext('2d')!
        const dpr = window.devicePixelRatio || 1
        if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
            canvas.width = Math.round(width * dpr)
            canvas.height = Math.round(height * dpr)
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        const family = '"Cascadia Code", "Consolas", "Yu Gothic UI", monospace'
        ctx.font = `${fontSize}px ${family}`
        const cellWidth = ctx.measureText('M').width,
            cellHeight = Math.ceil(fontSize * 1.65)
        ctx.fillStyle = this.background
        ctx.fillRect(0, 0, width, height)
        ctx.textBaseline = 'alphabetic'
        for (let row = 0; row < this.rows; row++) {
            // Paint all cell backgrounds first so a wide glyph is not erased by its continuation cell.
            for (let col = 0; col < this.columns; col++) {
                const h = this.highlights.get(this.cells[row]?.[col]?.highlight || 0) || {}
                ctx.fillStyle = h.reverse
                    ? h.foreground === undefined
                        ? this.foreground
                        : color(h.foreground)
                    : h.background === undefined
                      ? this.background
                      : color(h.background)
                ctx.fillRect(col * cellWidth, row * cellHeight, cellWidth + 0.5, cellHeight)
            }
            for (let col = 0; col < this.columns; col++) {
                const cell = this.cells[row]?.[col]
                if (!cell?.text || cell.text === ' ') continue
                const h = this.highlights.get(cell.highlight) || {}
                ctx.font = `${h.italic ? 'italic ' : ''}${h.bold ? 'bold ' : ''}${fontSize}px ${family}`
                ctx.fillStyle = h.reverse
                    ? h.background === undefined
                        ? this.background
                        : color(h.background)
                    : h.foreground === undefined
                      ? this.foreground
                      : color(h.foreground)
                const x = col * cellWidth,
                    y = row * cellHeight
                ctx.fillText(cell.text, x, y + (cellHeight + fontSize) / 2 - 3)
                if (h.underline || h.undercurl || h.strikethrough) {
                    if (h.special !== undefined) ctx.fillStyle = color(h.special)
                    ctx.fillRect(x, y + (h.strikethrough ? cellHeight / 2 : cellHeight - 3), cellWidth, 1)
                }
            }
        }
        if (!this.busy && this.cursor.row < this.rows) {
            const x = this.cursor.column * cellWidth,
                y = this.cursor.row * cellHeight
            ctx.fillStyle = '#aad39f'
            ctx.strokeStyle = '#aad39f'
            if (!focused) ctx.strokeRect(x + 0.5, y + 1, cellWidth - 1, cellHeight - 2)
            else if (this.mode.startsWith('insert')) ctx.fillRect(x, y + 2, 2, cellHeight - 4)
            else {
                ctx.globalAlpha = 0.48
                ctx.fillRect(x, y + 1, cellWidth, cellHeight - 2)
                ctx.globalAlpha = 1
            }
        }
        return { cellWidth, cellHeight }
    }
}

function color(value: number): string {
    return `#${value.toString(16).padStart(6, '0')}`
}

export function vimKey(
    event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'isComposing'>
): string | null {
    if (
        event.isComposing ||
        ['Shift', 'Control', 'Alt', 'Meta', 'Dead', 'Process', 'Unidentified'].includes(event.key)
    ) {
        return null
    }

    const special: Record<string, string> = {
        Escape: 'Esc',
        Enter: 'CR',
        Backspace: 'BS',
        Delete: 'Del',
        Tab: 'Tab',
        ArrowUp: 'Up',
        ArrowDown: 'Down',
        ArrowLeft: 'Left',
        ArrowRight: 'Right',
        Home: 'Home',
        End: 'End',
        PageUp: 'PageUp',
        PageDown: 'PageDown',
        Insert: 'Insert'
    }
    let key = special[event.key] || event.key
    if (/^F\d+$/.test(key) || special[event.key] || event.ctrlKey || event.altKey || event.metaKey) {
        if (key === ' ') key = 'Space'
        return `<${event.ctrlKey ? 'C-' : ''}${event.altKey ? 'M-' : ''}${event.metaKey ? 'D-' : ''}${event.shiftKey && (special[event.key] || event.ctrlKey || event.altKey) ? 'S-' : ''}${key}>`
    }
    return key === '<' ? '<LT>' : key
}
