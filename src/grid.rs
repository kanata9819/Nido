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
    pub fn notify(&mut self, method: &str, args: &Value) {
        match method {
            "redraw" => {
                for event in array(args) {
                    let name = s(&event[0]);
                    for args in array(event).iter().skip(1) {
                        if name == "flush" {
                            let pending = std::mem::take(&mut self.pending);
                            for (name, args) in pending {
                                self.apply(&name, &args);
                            }
                            self.frame += 1;
                        } else {
                            self.pending.push((name.into(), args.clone()));
                        }
                    }
                }
            }
            "nido:sticky_scroll" => self.pending.push(("sticky".into(), args[0].clone())),
            "nido:bracket_guides" => {
                if args[1] == true {
                    self.guides = args[0].clone()
                } else {
                    self.pending.push(("guides".into(), args[0].clone()));
                }
            }
            "nido:pixel_scroll" => {
                self.pixel.y = args[0].as_f64().unwrap_or(0.0) as f32;
                self.scroll_cursor = screen_cursor(&args[2]);
            }
            "nido:buffer" | "nido:edit" => {
                self.pixel = point(0.0, 0.0);
                self.cursor_position = None;
            }
            _ => {}
        }
    }
    fn apply(&mut self, name: &str, a: &Value) {
        if matches!(
            name,
            "grid_resize"
                | "grid_clear"
                | "grid_line"
                | "grid_scroll"
                | "hl_attr_define"
                | "default_colors_set"
        ) {
            self.revision += 1;
        }
        match name {
            "grid_resize" if a[0] == 1 => {
                let (cols, rows) = (n(&a[1]).min(2000), n(&a[2]).min(1000));
                self.columns = cols;
                self.rows = rows;
                self.cells.resize_with(rows, Vec::new);
                for row in &mut self.cells {
                    row.resize(
                        cols,
                        Cell {
                            text: " ".into(),
                            highlight: 0,
                        },
                    );
                }
            }
            "grid_clear" if a[0] == 1 => {
                for row in &mut self.cells {
                    row.fill(Cell {
                        text: " ".into(),
                        highlight: 0,
                    });
                }
            }
            "grid_line" if a[0] == 1 => {
                if let Some(row) = self.cells.get_mut(n(&a[1])) {
                    let mut column = n(&a[2]);
                    let mut highlight = 0;
                    for item in array(&a[3]) {
                        if let Some(id) = item[1].as_u64() {
                            highlight = id;
                        }
                        let repeat = item[2].as_u64().unwrap_or(1).min(2000);
                        for _ in 0..repeat {
                            if let Some(cell) = row.get_mut(column) {
                                *cell = Cell {
                                    text: s(&item[0]).into(),
                                    highlight,
                                };
                            }
                            column += 1;
                        }
                    }
                }
            }
            "grid_cursor_goto" if a[0] == 1 => {
                self.cursor = (n(&a[1]), n(&a[2]));
            }
            "grid_scroll" if a[0] == 1 => {
                let (top, bottom, left, right) = (
                    n(&a[1]).min(self.rows),
                    n(&a[2]).min(self.rows),
                    n(&a[3]).min(self.columns),
                    n(&a[4]).min(self.columns),
                );
                let (dy, dx) = (a[5].as_i64().unwrap_or(0), a[6].as_i64().unwrap_or(0));
                let old = self.cells.clone();
                for (row, row_cells) in self.cells.iter_mut().enumerate().take(bottom).skip(top) {
                    for (col, cell) in row_cells.iter_mut().enumerate().take(right).skip(left) {
                        let (sr, sc) = (row as i64 + dy, col as i64 + dx);
                        *cell = if sr >= top as i64
                            && sr < bottom as i64
                            && sc >= left as i64
                            && sc < right as i64
                        {
                            old[sr as usize][sc as usize].clone()
                        } else {
                            Cell {
                                text: " ".into(),
                                highlight: 0,
                            }
                        };
                    }
                }
            }
            "hl_attr_define" => {
                let attrs = &a[1];
                self.highlights.insert(
                    a[0].as_u64().unwrap_or(0),
                    Highlight {
                        foreground: color(&attrs["foreground"]),
                        background: color(&attrs["background"]),
                        special: color(&attrs["special"]),
                        reverse: attrs["reverse"] == true,
                        bold: attrs["bold"] == true,
                        italic: attrs["italic"] == true,
                        underline: attrs["underline"] == true,
                        undercurl: attrs["undercurl"] == true,
                        strike: attrs["strikethrough"] == true,
                    },
                );
            }
            "default_colors_set" => {
                if let Some(c) = color(&a[0]) {
                    self.foreground = c;
                }
                if let Some(c) = color(&a[1]) {
                    self.background = c;
                }
            }
            "mode_info_set" => self.modes = array(&a[1]).to_vec(),
            "mode_change" => {
                self.mode = s(&a[0]).into();
                self.mode_index = n(&a[1]);
            }
            "busy_start" => self.busy = true,
            "busy_stop" => self.busy = false,
            "popupmenu_show" => {
                self.completion = json!({"items":a[0],"selected":a[1],"row":a[2],"column":a[3]})
            }
            "popupmenu_select" => {
                if self.completion.is_object() {
                    self.completion["selected"] = a[0].clone();
                }
            }
            "popupmenu_hide" => self.completion = Value::Null,
            "cmdline_show" => {
                self.commands.insert(a[5].as_u64().unwrap_or(0), a.clone());
            }
            "cmdline_hide" => {
                self.commands.remove(&a[0].as_u64().unwrap_or(0));
            }
            "cmdline_pos" => {
                if let Some(command) = self.commands.get_mut(&a[1].as_u64().unwrap_or(0)) {
                    command[1] = a[0].clone();
                }
            }
            "msg_show" => {
                if a[2] == true {
                    self.messages.pop();
                }
                self.messages.push(chunks(&a[1]));
                if self.messages.len() > 100 {
                    self.messages.remove(0);
                }
            }
            "msg_clear" => self.messages.clear(),
            "cmdline_block_show" => {
                self.messages = array(&a[0]).iter().map(chunks).collect();
            }
            "cmdline_block_append" => self.messages.push(chunks(&a[0])),
            "cmdline_block_hide" => self.messages.clear(),
            "sticky" => self.sticky = a.clone(),
            "guides" => self.guides = a.clone(),
            _ => {}
        }
    }
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
