use super::*;

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
}
