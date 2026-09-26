import { useEffect, useRef, type ReactNode } from 'react'
import { Grid, vimKey } from './grid'
import styles from './assets/Nido.module.css'

interface Props {
    children?: ReactNode
    id: string
    active: boolean
    fontSize: number
    blocked: boolean
    focusTick: number
    onError: (message: string) => void
}
export default function Editor({
    children,
    id,
    active,
    fontSize,
    blocked,
    focusTick,
    onError
}: Props): React.JSX.Element {
    const host = useRef<HTMLDivElement>(null),
        canvas = useRef<HTMLCanvasElement>(null),
        input = useRef<HTMLTextAreaElement>(null)
    const grid = useRef(new Grid()),
        composing = useRef(false),
        attached = useRef(false)
    const paint = useRef<() => void>(() => {})
    const error = useRef(onError)
    useEffect(() => {
        error.current = onError
    }, [onError])

    useEffect(() => {
        const element = host.current!,
            surface = canvas.current!
        let frame = 0,
            disposed = false,
            lastColumns = 0,
            lastRows = 0
        const render = (): void => {
            if (disposed || !element.clientWidth || !element.clientHeight) return
            const metrics = grid.current.draw(
                surface,
                element.clientWidth,
                element.clientHeight,
                fontSize,
                document.activeElement === input.current
            )
            surface.setAttribute(
                'aria-description',
                grid.current.cells.map((row) => row.map((cell) => cell.text).join('')).join('\n')
            )
            if (input.current) {
                input.current.style.left = `${grid.current.cursor.column * metrics.cellWidth}px`
                input.current.style.top = `${grid.current.cursor.row * metrics.cellHeight}px`
            }
            const columns = Math.max(20, Math.floor(element.clientWidth / metrics.cellWidth))
            const rows = Math.max(4, Math.floor(element.clientHeight / metrics.cellHeight))
            if (!attached.current) {
                attached.current = true
                lastColumns = columns
                lastRows = rows
                void window.nido.attach(id, columns, rows).catch((e) => error.current(String(e)))
            } else if (columns !== lastColumns || rows !== lastRows) {
                lastColumns = columns
                lastRows = rows
                void window.nido.resize(id, columns, rows).catch((e) => error.current(String(e)))
            }
        }
        const schedule = (): void => {
            cancelAnimationFrame(frame)
            frame = requestAnimationFrame(render)
        }
        paint.current = schedule
        const unsubscribe = window.nido.onEvent((event) => {
            if (event.type === 'redraw' && event.id === id && grid.current.apply(event.events)) schedule()
        })
        const observer = new ResizeObserver(schedule)
        observer.observe(element)
        schedule()
        return () => {
            disposed = true
            observer.disconnect()
            unsubscribe()
            cancelAnimationFrame(frame)
        }
    }, [id, fontSize])

    useEffect(() => {
        if (active && !blocked) {
            input.current?.focus()
            paint.current()
        }
    }, [active, blocked, focusTick])
    const send = (promise: Promise<unknown>): void => {
        void promise.catch((e) => error.current(String(e)))
    }
    return (
        <div
            ref={host}
            className={styles.editor}
            hidden={!active}
            onClick={() => input.current?.focus()}
            onWheel={(event) => {
                if (!blocked) send(window.nido.input(id, event.deltaY > 0 ? '<C-E><C-E><C-E>' : '<C-Y><C-Y><C-Y>'))
            }}
        >
            <canvas ref={canvas} className={styles.canvas} aria-label="Neovim editor display" />
            {children}
            <textarea
                ref={input}
                className={styles.editorInput}
                aria-label="Neovim input"
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
                onFocus={() => paint.current()}
                onBlur={() => paint.current()}
                onCompositionStart={() => {
                    composing.current = true
                }}
                onCompositionEnd={(event) => {
                    composing.current = false
                    if (event.data) send(window.nido.input(id, event.data.replaceAll('<', '<LT>')))
                    event.currentTarget.value = ''
                }}
                onInput={(event) => {
                    if (composing.current || (event.nativeEvent as InputEvent).isComposing) return
                    const value = event.currentTarget.value
                    if (value) send(window.nido.input(id, value.replaceAll('<', '<LT>')))
                    event.currentTarget.value = ''
                }}
                onPaste={(event) => {
                    event.preventDefault()
                    send(window.nido.paste(id, event.clipboardData.getData('text/plain')))
                }}
                onKeyDown={(event) => {
                    if (blocked || composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return
                    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'v') {
                        event.preventDefault()
                        send(window.nido.pasteClipboard(id))
                        return
                    }
                    const key = vimKey(event.nativeEvent)
                    if (key) {
                        event.preventDefault()
                        send(window.nido.input(id, key))
                    }
                }}
            />
        </div>
    )
}
