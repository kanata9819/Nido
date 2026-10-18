import { Grid } from '../../src/renderer/src/grid';
import type { Cell } from '../../src/renderer/src/gridTypes';
import type { Redraw } from '../../src/shared/types';

const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
const dom = document.querySelector<HTMLDivElement>('#dom')!;
const family = document.querySelector<HTMLSelectElement>('#family')!;
const size = document.querySelector<HTMLSelectElement>('#size')!;
const weight = document.querySelector<HTMLSelectElement>('#weight')!;
const motion = document.querySelector<HTMLSelectElement>('#motion')!;
const offset = document.querySelector<HTMLInputElement>('#offset')!;
const animate = document.querySelector<HTMLButtonElement>('#animate')!;
const status = document.querySelector<HTMLElement>('#status')!;
const families: Record<string, string> = {
    cascadia: '"Cascadia Code", "Consolas", "Yu Gothic UI", monospace',
    consolas: '"Consolas", "Yu Gothic UI", monospace',
    meiryo: '"Cascadia Code", "Consolas", "Meiryo", monospace'
};
const colors = ['#cccccc', '#569cd6', '#4ec9b0', '#dcdcaa', '#ffb300', '#6a9955', '#ce9178'];
const source = [
    'use crate::gpu::Gpu;',
    'use crate::{',
    '    action::{applier, types::Action},',
    '    screen::Screen,',
    '};',
    '',
    'pub struct Renderer {',
    '    screen: Screen,',
    '    gpu: Option<Gpu>,',
    '}',
    '',
    'impl Renderer {',
    '    pub fn new(window: Arc<Window>, terminal_rows: u16) -> Self {',
    '        Self {',
    '            gpu: Some(pollster::block_on(Gpu::new(window.clone()))),',
    '            screen: Screen::new(terminal_rows, 80),',
    '        }',
    '    }',
    '',
    '    /// 構築されたCell(apply_text)から、描画処理に渡す文字列を取得する',
    '    pub fn get_text(&mut self) -> &str {',
    '        let cells = self.cells.get_cells().iter().enumerate();',
    '        // 日本語の確認：漢字・ひらがな・カタカナ・é・😀',
    '        let name = "Nido";',
    '        return cells;',
    '    }',
    '}'
];

function cellsFor(text: string): Cell[] {
    const comment = text.indexOf('//');
    const cells: Cell[] = [];
    const pattern =
        /\/\/.*|"[^"]*"|\b(?:pub|fn|use|impl|struct|let|mut|return|self)\b|\b[A-Z]\w*\b|\b\w+(?=\()|\bterminal_rows\b|./gu;
    for (const match of text.matchAll(pattern)) {
        const token = match[0];
        const highlight =
            comment >= 0 && match.index >= comment
                ? 5
                : token.startsWith('"')
                  ? 6
                  : /^(pub|fn|use|impl|struct|let|mut|return|self)$/.test(token)
                    ? 1
                    : /^[A-Z]/.test(token)
                      ? 2
                      : text[match.index + token.length] === '('
                        ? 3
                        : token === 'terminal_rows'
                          ? 4
                          : 0;
        for (const character of token) {
            if (/\p{Mark}/u.test(character) && cells.length) {
                cells[cells.length - 1].text += character;
            } else {
                cells.push({ text: character, highlight });
                if (
                    /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\uff01-\uff60]|\p{Extended_Pictographic}/u.test(
                        character
                    )
                ) {
                    cells.push({ text: '', highlight });
                }
            }
        }
    }
    return cells;
}

const grid = new Grid();
grid.busy = true;
grid.pixelScrollEnabled = true;
grid.apply([
    ['grid_resize', [1, 130, 33]],
    ['default_colors_set', [0xcccccc, 0x121212]],
    [
        'hl_attr_define',
        ...colors.map((color, index) => [
            index,
            { foreground: parseInt(color.slice(1), 16) },
            {},
            []
        ])
    ],
    ...Array.from({ length: 32 }, (_, row): Redraw[number] => [
        'grid_line',
        [
            1,
            row,
            0,
            cellsFor(source[row % source.length]).map(({ text, highlight }) => [text, highlight])
        ]
    ]),
    ['flush']
]);

let lineHeight = 18;
let width = 0;
let height = 0;
let scroll = 0;
let playing = false;
let direction = 1;
let lastTime = 0;
let animationFrame = 0;
let rowElements: { node: HTMLDivElement; top: number }[] = [];
let generation = 0;
const lines = document.createElement('div');
lines.id = 'lines';
dom.append(lines);
const snap = (value: number): number => Math.round(value * devicePixelRatio) / devicePixelRatio;

function paint(): void {
    grid.scrolling = playing || scroll !== 0;
    grid.scrollFraction = scroll / lineHeight;
    grid.draw(
        canvas,
        width,
        height,
        Number(size.value),
        families[family.value],
        false,
        undefined,
        lineHeight,
        Number(weight.value)
    );
    const layered = motion.value === 'layer';
    lines.style.willChange = layered ? 'transform' : 'auto';
    lines.style.transform = layered ? `translate3d(0, ${-grid.scrollOffset}px, 0)` : '';
    for (const { node, top } of rowElements) {
        node.style.top = `${top - (layered ? 0 : grid.scrollOffset)}px`;
    }
    offset.value = String(scroll);
    status.textContent = `${size.value}px · 太さ ${weight.value} · 行高 ${lineHeight}px · 倍率 ${Math.round(devicePixelRatio * 100)}% · 移動 ${scroll.toFixed(2)}px`;
}

async function rebuild(): Promise<void> {
    const current = ++generation;
    playing = false;
    cancelAnimationFrame(animationFrame);
    animate.setAttribute('aria-pressed', 'false');
    const fontSize = Number(size.value);
    lineHeight = Math.max(18, fontSize + 5);
    const fontFamily = families[family.value];
    await Promise.all([
        document.fonts.load(`${weight.value} ${fontSize}px ${fontFamily}`, 'M'),
        document.fonts.load(`${weight.value} ${fontSize}px ${fontFamily}`, '漢字')
    ]);
    if (current !== generation) return;
    height = snap(32 * lineHeight);
    const viewports = [...document.querySelectorAll<HTMLElement>('.viewport')];
    width =
        Math.floor(Math.min(...viewports.map((node) => node.clientWidth)) * devicePixelRatio) /
        devicePixelRatio;
    for (const [index, surface] of [canvas, dom].entries()) {
        const viewport = viewports[index];
        viewport.style.height = `${height}px`;
        const rect = viewport.getBoundingClientRect();
        surface.style.left = `${Math.ceil(rect.left * devicePixelRatio) / devicePixelRatio - rect.left}px`;
        surface.style.top = `${Math.ceil(rect.top * devicePixelRatio) / devicePixelRatio - rect.top}px`;
        surface.style.width = `${width}px`;
        surface.style.height = `${height}px`;
    }
    paint();
    dom.style.height = `${grid.contentHeight}px`;
    dom.style.font = `${weight.value} ${fontSize}px / ${lineHeight}px ${fontFamily}`;
    lines.style.height = `${height}px`;
    lines.replaceChildren();
    rowElements = grid.cells
        .slice(0, -1)
        .map((cells, index) => {
            const node = document.createElement('div');
            node.className = 'row';
            node.style.top = '0px';
            let column = 0;
            let end = cells.length;
            while (end && cells[end - 1].text === ' ') end--;
            for (const cell of cells.slice(0, end)) {
                if (cell.text === '') {
                    column++;
                    continue;
                }
                const span = document.createElement('span');
                const count = cells[column + 1]?.text === '' ? 2 : 1;
                span.className = 'cell';
                span.textContent = cell.text;
                span.style.color = colors[cell.highlight];
                span.style.width = `${snap((column + count) * grid.cellWidth) - snap(column * grid.cellWidth)}px`;
                node.append(span);
                column++;
            }
            const marker = document.createElement('i');
            marker.className = 'baseline';
            node.append(marker);
            lines.append(node);
            return { node, marker, index };
        })
        .map(({ node, marker, index }) => {
            // Match the production Canvas alphabetic baseline, including CJK fallback metrics.
            const baseline = marker.getBoundingClientRect().top - node.getBoundingClientRect().top;
            marker.remove();
            return {
                node,
                top: snap(index * lineHeight) + snap((lineHeight + fontSize) / 2 - 3) - baseline
            };
        });
    scroll = Math.min(scroll, lineHeight - 2);
    offset.max = String(lineHeight - 2);
    paint();
    document.body.dataset.ready = 'true';
}

function setOffset(value: number): void {
    scroll = Math.max(0, Math.min(lineHeight - 2, value));
    paint();
}
offset.addEventListener('input', () => setOffset(Number(offset.value)));
motion.addEventListener('change', paint);
document.querySelector('#reset')!.addEventListener('click', () => {
    playing = false;
    cancelAnimationFrame(animationFrame);
    animate.setAttribute('aria-pressed', 'false');
    setOffset(0);
});
for (const select of [family, size, weight])
    select.addEventListener('change', () => void rebuild());
for (const viewport of document.querySelectorAll<HTMLElement>('.viewport')) {
    viewport.addEventListener(
        'wheel',
        (event: WheelEvent) => {
            event.preventDefault();
            setOffset(
                scroll +
                    event.deltaY *
                        (event.deltaMode === 1 ? lineHeight : event.deltaMode === 2 ? height : 1)
            );
        },
        { passive: false }
    );
}
animate.addEventListener('click', () => {
    playing = !playing;
    lastTime = 0;
    animate.setAttribute('aria-pressed', String(playing));
    if (playing) animationFrame = requestAnimationFrame(tick);
    else cancelAnimationFrame(animationFrame);
});
function tick(time: number): void {
    if (!playing) return;
    if (playing && lastTime) {
        const next = scroll + direction * Math.min(50, time - lastTime) * 0.002;
        if (next < 0 || next > lineHeight - 2) direction *= -1;
        setOffset(next);
    }
    lastTime = time;
    animationFrame = requestAnimationFrame(tick);
}
const observer = new ResizeObserver(() => void rebuild());
observer.observe(document.querySelector('.panes')!);
// Exposed only in this isolated prototype so measurements use exactly the displayed samples.
Object.assign(window, { textComparison: { setOffset, rebuild, grid } });
void rebuild();
