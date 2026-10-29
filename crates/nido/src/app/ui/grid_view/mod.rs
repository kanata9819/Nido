use super::*;

pub(in crate::app::ui) struct GridCache {
    pub bounds: Bounds<Pixels>,
    pub cell: Size<f32>,
    pub cursor: Bounds<Pixels>,
    pub completion: Option<(Bounds<Pixels>, usize, usize)>,
    revision: u64,
    key: String,
    font: Font,
    font_size: f32,
    runs: Vec<GridRun>,
}
struct GridRun {
    origin: Point<f32>,
    width: f32,
    background: Hsla,
    text: Option<ShapedLine>,
}

fn shape(
    text: &str,
    font: &Font,
    font_size: f32,
    color: Hsla,
    highlight: Option<&grid::Highlight>,
    window: &Window,
) -> ShapedLine {
    let mut font = font.clone();
    if let Some(h) = highlight {
        if h.bold {
            font = font.bold();
        }
        if h.italic {
            font = font.italic();
        }
    }
    let text: SharedString = text.replace(['\n', '\r', '\0'], " ").into();
    let run = TextRun {
        len: text.len(),
        font,
        color,
        background_color: None,
        underline: highlight
            .filter(|h| h.underline || h.undercurl)
            .map(|h| UnderlineStyle {
                color: h.special,
                thickness: px(1.),
                wavy: h.undercurl,
            }),
        strikethrough: highlight.filter(|h| h.strike).map(|_| StrikethroughStyle {
            color: Some(color),
            thickness: px(1.),
        }),
    };
    window
        .text_system()
        .shape_line(text, px(font_size), &[run], None)
}

mod ime;
mod layout;
mod paint;
