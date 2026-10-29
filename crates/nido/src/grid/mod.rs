mod redraw;

use gpui::{Hsla, Point, point, rgb};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};

#[derive(Clone, Default, Debug)]
pub struct Cell {
    pub text: String,
    pub highlight: u64,
}
#[derive(Clone, Default)]
pub struct Highlight {
    pub foreground: Option<Hsla>,
    pub background: Option<Hsla>,
    pub special: Option<Hsla>,
    pub reverse: bool,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub undercurl: bool,
    pub strike: bool,
}
pub struct Grid {
    pub columns: usize,
    pub rows: usize,
    pub cells: Vec<Vec<Cell>>,
    pub cursor: (usize, usize),
    pub foreground: Hsla,
    pub background: Hsla,
    pub highlights: HashMap<u64, Highlight>,
    pub mode: String,
    pub modes: Vec<Value>,
    pub mode_index: usize,
    pub busy: bool,
    pub commands: BTreeMap<u64, Value>,
    pub messages: Vec<String>,
    pub completion: Value,
    pub sticky: Value,
    pub guides: Value,
    pub pixel: Point<f32>,
    pending: Vec<(String, Value)>,
    pub scroll_cursor: Option<(usize, usize)>,
    pub frame: u64,
    pub revision: u64,
    pub cursor_position: Option<Point<f32>>,
    pub blink_origin: f64,
}
impl Default for Grid {
    fn default() -> Self {
        Self {
            columns: 0,
            rows: 0,
            cells: vec![],
            cursor: (0, 0),
            foreground: rgb(0xd6dce2).into(),
            background: rgb(0x191e23).into(),
            highlights: HashMap::new(),
            mode: "normal".into(),
            modes: vec![],
            mode_index: 0,
            busy: false,
            commands: BTreeMap::new(),
            messages: vec![],
            completion: Value::Null,
            sticky: Value::Null,
            guides: Value::Null,
            pixel: point(0.0, 0.0),
            pending: vec![],
            scroll_cursor: None,
            frame: 0,
            revision: 0,
            cursor_position: None,
            blink_origin: 0.0,
        }
    }
}
pub fn color(value: &Value) -> Option<Hsla> {
    value
        .as_i64()
        .filter(|n| *n >= 0)
        .map(|n| rgb(n as u32 & 0xffffff).into())
}
pub fn n(value: &Value) -> usize {
    value.as_u64().unwrap_or(0) as usize
}
pub fn s(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}
pub fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}
pub fn chunks(value: &Value) -> String {
    array(value).iter().map(|p| s(&p[1])).collect::<String>()
}

impl Grid {
    pub fn colors(&self, id: u64) -> (Hsla, Hsla) {
        let attrs = self.highlights.get(&id);
        let fg = attrs.and_then(|a| a.foreground).unwrap_or(self.foreground);
        let bg = attrs.and_then(|a| a.background).unwrap_or(self.background);
        if attrs.is_some_and(|a| a.reverse) {
            (bg, fg)
        } else {
            (fg, bg)
        }
    }
    pub fn description(&self) -> String {
        self.cells
            .iter()
            .map(|r| {
                r.iter()
                    .map(|c| c.text.as_str())
                    .collect::<String>()
                    .trim_end()
                    .to_owned()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}
pub fn parse_color(value: &str) -> Option<Hsla> {
    let n = u32::from_str_radix(value.strip_prefix('#')?, 16).ok()?;
    Some(rgb(n & 0xffffff).into())
}

pub fn screen_cursor(value: &Value) -> Option<(usize, usize)> {
    value.as_object().map(|p| {
        (
            p["row"].as_u64().map(|v| v as usize).unwrap_or(usize::MAX),
            p["column"]
                .as_u64()
                .map(|v| v as usize)
                .unwrap_or(usize::MAX),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn applies_only_complete_frames_and_preserves_wide_cells() {
        let mut g = Grid::default();
        g.notify(
            "redraw",
            &json!([
                ["grid_resize", [1, 4, 2]],
                ["grid_line", [1, 0, 0, [["日", 2], [""], ["a", 3, 2]]]]
            ]),
        );
        assert_eq!(g.rows, 0);
        g.notify("redraw", &json!([["flush", []]]));
        assert_eq!(g.cells[0][1].text, "");
        assert_eq!(g.cells[0][3].highlight, 3);
        let content_revision = g.revision;
        g.notify(
            "redraw",
            &json!([["grid_cursor_goto", [1, 0, 2]], ["flush", []]]),
        );
        assert_eq!(
            g.revision, content_revision,
            "Cursor-only updates must reuse shaped text"
        );
        g.notify(
            "redraw",
            &json!([["grid_scroll", [1, 0, 2, 0, 4, -1, 0]], ["flush", []]]),
        );
        assert_eq!(g.cells[1][0].text, "日");
        assert!(
            g.revision > content_revision,
            "Scroll must invalidate shaped text"
        );
        assert_eq!(g.cells[0][0].text, " ");
        g.notify(
            "nido:pixel_scroll",
            &json!([0.5, true, {"row":-1,"column":-1}]),
        );
        assert_eq!(g.scroll_cursor, Some((usize::MAX, usize::MAX)));
    }
}
