use eframe::egui::{self, Align2, Color32, FontId, Pos2, Rect, Stroke, Vec2};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};

#[derive(Clone, Default, Debug)]
pub struct Cell {
    pub text: String,
    pub highlight: u64,
}
#[derive(Clone, Default)]
pub struct Highlight {
    pub foreground: Option<Color32>,
    pub background: Option<Color32>,
    pub special: Option<Color32>,
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
    pub foreground: Color32,
    pub background: Color32,
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
    pub pixel: Vec2,
    pending: Vec<(String, Value)>,
    pub scroll_cursor: Option<(usize, usize)>,
    pub frame: u64,
    pub cursor_position: Option<Pos2>,
    pub blink_origin: f64,
}
impl Default for Grid {
    fn default() -> Self {
        Self {
            columns: 0,
            rows: 0,
            cells: vec![],
            cursor: (0, 0),
            foreground: Color32::from_rgb(214, 220, 226),
            background: Color32::from_rgb(25, 30, 35),
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
            pixel: Vec2::ZERO,
            pending: vec![],
            scroll_cursor: None,
            frame: 0,
            cursor_position: None,
            blink_origin: 0.0,
        }
    }
}
pub fn color(value: &Value) -> Option<Color32> {
    value
        .as_i64()
        .filter(|n| *n >= 0)
        .map(|n| Color32::from_rgb((n >> 16) as u8, (n >> 8) as u8, n as u8))
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
                self.pixel = Vec2::ZERO;
                self.cursor_position = None;
            }
            _ => {}
        }
    }
    fn apply(&mut self, name: &str, a: &Value) {
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
    pub fn colors(&self, id: u64) -> (Color32, Color32) {
        let attrs = self.highlights.get(&id);
        let fg = attrs.and_then(|a| a.foreground).unwrap_or(self.foreground);
        let bg = attrs.and_then(|a| a.background).unwrap_or(self.background);
        if attrs.is_some_and(|a| a.reverse) {
            (bg, fg)
        } else {
            (fg, bg)
        }
    }
    pub fn metrics(ui: &egui::Ui, size: f32, line_height: f32) -> Vec2 {
        let font = FontId::monospace(size);
        let width = ui
            .painter()
            .layout_no_wrap("M".into(), font, Color32::WHITE)
            .size()
            .x;
        Vec2::new(width.max(1.0), (size * line_height).max(size + 2.0))
    }
    pub fn paint(
        &mut self,
        ui: &egui::Ui,
        rect: Rect,
        cell: Vec2,
        focused: bool,
        settings: &Value,
        acrylic: bool,
    ) -> Rect {
        let painter = ui.painter().with_clip_rect(rect);
        let size = settings["fontSize"].as_f64().unwrap_or(14.0) as f32;
        let font = FontId::monospace(size);
        painter.rect_filled(
            rect,
            0.0,
            if acrylic {
                Color32::from_rgba_unmultiplied(
                    self.background.r(),
                    self.background.g(),
                    self.background.b(),
                    220,
                )
            } else {
                self.background
            },
        );
        let snap = |v: f32| {
            let d = ui.ctx().pixels_per_point();
            (v * d).round() / d
        };
        for (row, values) in self.cells.iter().enumerate() {
            let y = snap(rect.top() + row as f32 * cell.y - self.pixel.y * cell.y);
            if y + cell.y < rect.top() || y > rect.bottom() {
                continue;
            }
            for (col, value) in values.iter().enumerate() {
                let x = snap(rect.left() + col as f32 * cell.x);
                let (fg, bg) = self.colors(value.highlight);
                let width = if values.get(col + 1).is_some_and(|c| c.text.is_empty()) {
                    cell.x * 2.0
                } else {
                    cell.x
                };
                let bounds = Rect::from_min_size(Pos2::new(x, y), Vec2::new(width, cell.y));
                if bg != self.background {
                    painter.rect_filled(bounds, 0.0, bg);
                }
                if value.text.is_empty() || value.text == " " {
                    continue;
                }
                let hl = self.highlights.get(&value.highlight);
                let mut text_font = font.clone();
                if let Some(hl) = hl
                    && (hl.bold || hl.italic)
                {
                    text_font.family = egui::FontFamily::Name(
                        match (hl.bold, hl.italic) {
                            (true, true) => "editor-bold-italic",
                            (true, false) => "editor-bold",
                            _ => "editor-italic",
                        }
                        .into(),
                    );
                }
                let galley = painter.layout_no_wrap(value.text.clone(), text_font, fg);
                let pos = Pos2::new(x, y + (cell.y - galley.size().y) * 0.5);
                painter.galley(pos, galley.clone(), fg);
                if let Some(hl) = self.highlights.get(&value.highlight) {
                    if hl.underline || hl.undercurl {
                        painter.line_segment(
                            [
                                Pos2::new(x, y + cell.y - 2.0),
                                Pos2::new(x + width, y + cell.y - 2.0),
                            ],
                            Stroke::new(1.0, hl.special.unwrap_or(fg)),
                        );
                    }
                    if hl.strike {
                        painter.line_segment(
                            [bounds.left_center(), bounds.right_center()],
                            Stroke::new(1.0, fg),
                        );
                    }
                }
            }
        }
        for guide in array(&self.guides) {
            let col = n(&guide["column"]);
            let x = snap(rect.left() + (col as f32 + 0.15) * cell.x);
            let top = guide["top"].as_i64().unwrap_or(0) as f32;
            let bottom = guide["bottom"].as_i64().unwrap_or(0) as f32;
            let y = rect.top() + (top + 1.0 - self.pixel.y) * cell.y;
            let end = rect.top() + (bottom - self.pixel.y) * cell.y;
            let color = parse_color(s(&guide["color"])).unwrap_or(Color32::from_gray(65));
            painter.line_segment(
                [Pos2::new(x, y), Pos2::new(x, end)],
                Stroke::new(
                    1.0,
                    color.gamma_multiply(if guide["active"] == true { 0.8 } else { 0.35 }),
                ),
            );
        }
        let cursor = self.scroll_cursor.unwrap_or(self.cursor);
        let hidden = cursor.0 >= self.rows || cursor.1 >= self.columns;
        let cursor = (cursor.0.min(self.rows), cursor.1.min(self.columns));
        let pos = Pos2::new(
            snap(rect.left() + cursor.1 as f32 * cell.x),
            snap(rect.top() + cursor.0 as f32 * cell.y - self.pixel.y * cell.y),
        );
        let now = ui.input(|i| i.time);
        if self
            .cursor_position
            .is_none_or(|old| old.distance(pos) > 0.1)
        {
            self.blink_origin = now;
        }
        let visual = if settings["smoothCursor"] == true && focused {
            let old = self.cursor_position.unwrap_or(pos);
            let next = old.lerp(pos, 1.0 - (-ui.input(|i| i.stable_dt) * 30.0).exp());
            if next.distance(pos) > 0.1 {
                ui.ctx().request_repaint();
            }
            next
        } else {
            pos
        };
        self.cursor_position = if hidden { None } else { Some(visual) };
        let mode = self.modes.get(self.mode_index).cloned().unwrap_or_default();
        let shape = s(&mode["cursor_shape"]);
        let pct = mode["cell_percentage"].as_f64().unwrap_or(20.0) as f32 / 100.0;
        let width = if self
            .cells
            .get(cursor.0)
            .and_then(|r| r.get(cursor.1 + 1))
            .is_some_and(|c| c.text.is_empty())
        {
            cell.x * 2.0
        } else {
            cell.x
        };
        let mut bounds = Rect::from_min_size(visual, Vec2::new(width, cell.y));
        if shape == "vertical" || self.mode.starts_with("insert") {
            bounds.max.x = bounds.min.x + (cell.x * pct).max(1.0);
        } else if shape == "horizontal" {
            bounds.min.y = bounds.max.y - (cell.y * pct).max(1.0);
        }
        let phase = (now - self.blink_origin - 0.7).max(0.0);
        let on = phase % 1.0 < 0.55;
        let alpha = if settings["smoothBlink"] == true {
            (0.5 + 0.5 * (phase * std::f64::consts::TAU).cos()) as f32
        } else {
            if on { 1.0 } else { 0.0 }
        };
        if focused && !self.busy && !hidden {
            painter.rect_filled(bounds, 0.0, self.foreground.gamma_multiply(alpha * 0.7));
        } else if !self.busy {
            painter.rect_stroke(
                bounds,
                0.0,
                Stroke::new(1.0, self.foreground),
                egui::StrokeKind::Inside,
            );
        }
        if focused {
            ui.ctx()
                .request_repaint_after(std::time::Duration::from_millis(
                    if settings["smoothBlink"] == true {
                        32
                    } else {
                        200
                    },
                ));
        }
        if settings["stickyScroll"] != false {
            self.paint_sticky(ui, rect, cell, size, settings);
        }
        bounds
    }
    fn paint_sticky(&self, ui: &egui::Ui, rect: Rect, cell: Vec2, size: f32, settings: &Value) {
        let painter = ui.painter().with_clip_rect(rect);
        let max = settings["stickyScrollMaxLines"].as_f64().unwrap_or(5.0) as usize;
        let mut row = 0;
        let gutter = n(&self.sticky["gutter"]);
        let left = n(&self.sticky["leftcol"]);
        for scope in array(&self.sticky["scopes"])
            .iter()
            .filter(|s| s["top"].as_i64().unwrap_or(0) < 0)
            .take(max)
        {
            let bounds = Rect::from_min_size(
                rect.min + Vec2::new(0.0, row as f32 * cell.y),
                Vec2::new(rect.width(), cell.y),
            );
            painter.rect_filled(bounds, 0.0, self.background);
            let line = n(&scope["line"]);
            let anchor = n(&self.sticky["relativeTo"]);
            let number = if settings["relativeLineNumbers"] == true && anchor > 0 {
                line.abs_diff(anchor)
            } else {
                line
            };
            painter.text(
                bounds.min,
                Align2::LEFT_TOP,
                format!("{number:>width$}", width = gutter.saturating_sub(1)),
                FontId::monospace(size),
                Color32::from_gray(125),
            );
            let mut column = gutter as f32 - left as f32;
            for chunk in array(&scope["text"]) {
                let text = s(&chunk["text"]);
                let color = parse_color(s(&chunk["color"])).unwrap_or(self.foreground);
                let x = rect.left() + column * cell.x;
                painter
                    .with_clip_rect(Rect::from_min_max(
                        Pos2::new(rect.left() + gutter as f32 * cell.x, bounds.top()),
                        bounds.max,
                    ))
                    .text(
                        Pos2::new(x, bounds.top()),
                        Align2::LEFT_TOP,
                        text,
                        FontId::monospace(size),
                        color,
                    );
                column += chunk["cells"]
                    .as_f64()
                    .unwrap_or(text.chars().count() as f64) as f32;
            }
            row += 1;
        }
        if row > 0 {
            let y = rect.top() + row as f32 * cell.y;
            painter.line_segment(
                [Pos2::new(rect.left(), y), Pos2::new(rect.right(), y)],
                Stroke::new(1.0, Color32::from_gray(70)),
            );
        }
        for sep in array(&self.sticky["separators"]) {
            let y = rect.top() + n(&sep["row"]) as f32 * cell.y;
            painter.line_segment(
                [Pos2::new(rect.left(), y), Pos2::new(rect.right(), y)],
                Stroke::new(1.0, Color32::from_gray(48)),
            );
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
pub fn parse_color(value: &str) -> Option<Color32> {
    let n = u32::from_str_radix(value.strip_prefix('#')?, 16).ok()?;
    Some(Color32::from_rgb((n >> 16) as u8, (n >> 8) as u8, n as u8))
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
        g.notify(
            "redraw",
            &json!([["grid_scroll", [1, 0, 2, 0, 4, -1, 0]], ["flush", []]]),
        );
        assert_eq!(g.cells[1][0].text, "日");
        assert_eq!(g.cells[0][0].text, " ");
        g.notify(
            "nido:pixel_scroll",
            &json!([0.5, true, {"row":-1,"column":-1}]),
        );
        assert_eq!(g.scroll_cursor, Some((usize::MAX, usize::MAX)));
    }
}
