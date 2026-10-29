use super::*;

impl Nido {
    pub(in crate::app::ui) fn buffer_tabs(&self, i: usize, cx: &Context<Self>) -> AnyElement {
        let w = &self.model.workspaces[i];
        let mut tabs = div()
            .id("buffer-tabs")
            .flex()
            .h(px(if self.model.settings["compactMode"] == true {
                28.
            } else {
                35.
            }))
            .flex_shrink_0()
            .bg(rgb(0x14191d))
            .border_b_1()
            .border_color(rgb(0x282c30))
            .overflow_x_scroll();
        for b in w.buffers() {
            let id = b["id"].clone();
            let close_id = id.clone();
            let active = b["id"] == w.state["current"];
            let path = s(&b["name"]);
            let name = Path::new(path)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            tabs = tabs.child(
                div()
                    .flex()
                    .h_full()
                    .flex_shrink_0()
                    .border_r_1()
                    .border_color(rgb(0x282c30))
                    .when(active, |el| {
                        el.bg(rgb(0x191e23))
                            .border_t_2()
                            .border_color(rgb(0x99c68c))
                    })
                    .child(
                        self.button(
                            format!("buffer-{id}"),
                            "",
                            move |this, window, cx| {
                                this.model.send("selectBuffer", json!([id]));
                                this.model.focus_editor = true;
                                this.tick(window, cx);
                            },
                            cx,
                        )
                        .h_full()
                        .gap(px(10.))
                        .px_3()
                        .child(file_icon(path))
                        .child(if name.is_empty() {
                            "[No Name]".into()
                        } else {
                            name
                        })
                        .when(b["modified"] == true, |el| {
                            el.child(div().size(px(6.)).rounded_full().bg(rgb(0x99c68c)))
                        }),
                    )
                    .child(
                        self.button(
                            format!("buffer-close-{close_id}"),
                            "",
                            move |this, window, cx| {
                                this.model.send("closeBuffer", json!([close_id, false]));
                                this.tick(window, cx);
                            },
                            cx,
                        )
                        .px_1()
                        .child(icon("x", 12.)),
                    ),
            );
        }
        tabs.into_any_element()
    }

    pub(in crate::app::ui) fn editor(
        &self,
        index: usize,
        terminal: bool,
        cx: &Context<Self>,
    ) -> AnyElement {
        let id = self.model.workspaces[index].session.id.clone();
        let prepaint = cx.entity();
        let paint = prepaint.clone();
        let grid_id = id.clone();
        let paint_id = id.clone();
        div()
            .id(SharedString::from(format!("editor-{id}")))
            .relative()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .overflow_hidden()
            .cursor_text()
            .child(
                canvas(
                    move |bounds, window, cx| {
                        prepaint.update(cx, |this, cx| {
                            this.prepare_grid(&grid_id, bounds, window, cx)
                        })
                    },
                    move |bounds, _, window, cx| {
                        paint.update(cx, |this, cx| {
                            this.paint_grid(&paint_id, bounds, window, cx)
                        })
                    },
                )
                .size_full(),
            )
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |this, event: &MouseDownEvent, window, cx| {
                    this.model.explorer_focus = false;
                    this.model.terminal_focused = terminal;
                    window.focus(&this.focus);
                    this.grid_mouse(index, "press", event.position, event.modifiers, window, cx);
                }),
            )
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(move |this, event: &MouseUpEvent, window, cx| {
                    this.grid_mouse(
                        index,
                        "release",
                        event.position,
                        event.modifiers,
                        window,
                        cx,
                    );
                }),
            )
            .on_mouse_move(
                cx.listener(move |this, event: &MouseMoveEvent, window, cx| {
                    if event.pressed_button == Some(MouseButton::Left) {
                        this.grid_mouse(index, "drag", event.position, event.modifiers, window, cx);
                    }
                }),
            )
            .on_scroll_wheel(cx.listener(move |this, event: &ScrollWheelEvent, _, _| {
                let w = &this.model.workspaces[index];
                if let Some(cache) = this.grids.get(&w.session.id) {
                    let delta = event.delta.pixel_delta(px(cache.cell.height));
                    w.session.send(
                        "scroll",
                        json!([
                            -f32::from(delta.y) / cache.cell.height,
                            -f32::from(delta.x) / cache.cell.width
                        ]),
                    );
                }
            }))
            .into_any_element()
    }

    pub(in crate::app::ui) fn grid_mouse(
        &mut self,
        index: usize,
        action: &str,
        position: Point<Pixels>,
        modifiers: Modifiers,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(w) = self.model.workspaces.get(index) else {
            return;
        };
        let Some(cache) = self.grids.get(&w.session.id) else {
            return;
        };
        if w.grid.completion.is_object()
            && let Some((bounds, start, count)) = cache.completion
            && bounds.contains(&position)
        {
            if action == "press" {
                let item =
                    (f32::from(position.y - bounds.top()) / cache.cell.height).floor() as usize;
                if item < count {
                    w.session.send(
                        "rpc",
                        json!(["nvim_select_popupmenu_item", [start + item, true, true, {}]]),
                    );
                }
            }
            cx.stop_propagation();
            return;
        }
        let row = (f32::from(position.y - cache.bounds.top()) / cache.cell.height)
            .floor()
            .max(0.) as usize;
        let col = (f32::from(position.x - cache.bounds.left()) / cache.cell.width)
            .floor()
            .max(0.) as usize;
        if action == "press" && self.model.settings["stickyScroll"] != false {
            let max = self.model.settings["stickyScrollMaxLines"]
                .as_u64()
                .unwrap_or(5) as usize;
            if let Some(scope) = array(&w.grid.sticky["scopes"])
                .iter()
                .filter(|s| s["top"].as_i64().unwrap_or(0) < 0)
                .take(max)
                .nth(row)
            {
                w.session.send(
                    "lua",
                    json!([
                        "return require('nido_sticky').jump(...)",
                        [
                            w.grid.sticky["window"],
                            w.grid.sticky["buffer"],
                            scope["line"]
                        ]
                    ]),
                );
                self.tick(window, cx);
                return;
            }
        }
        let mut m = String::new();
        if modifiers.shift {
            m.push('S');
        }
        if modifiers.control {
            m.push('C');
        }
        if modifiers.alt {
            m.push('A');
        }
        w.session
            .send("mouse", json!(["left", action, m, 1, row, col]));
        cx.notify();
    }

    pub(in crate::app::ui) fn welcome(&self, cx: &Context<Self>) -> AnyElement {
        let mut content = div()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap_3()
            .size_full()
            .text_color(rgb(0x929eaa))
            .child(icon("leaf", 52.).text_color(rgb(0x99c68c)))
            .child(
                div()
                    .text_size(px(38.))
                    .text_color(rgb(0xd6dce2))
                    .child("Nido"),
            )
            .child(self.model.tr("Open a local or WSL workspace"))
            .child(self.command("welcome-new", "New workspace", "new", cx))
            .child(self.command(
                "welcome-terminal",
                "New terminal workspace",
                "newTerminal",
                cx,
            ))
            .child(self.command("welcome-wsl", "Connect to WSL", "wsl", cx));
        for (i, favorite) in array(&self.model.favorites).iter().enumerate() {
            let f = favorite.clone();
            content = content.child(self.button(
                format!("favorite-{i}"),
                s(&f["name"]).to_owned(),
                move |this, window, cx| {
                    this.model.add_workspace(
                        PathBuf::from(s(&f["root"])),
                        f["kind"] == "terminal",
                        None,
                        None,
                    );
                    this.tick(window, cx);
                },
                cx,
            ));
        }
        content
            .child(
                div()
                    .mt_4()
                    .text_size(px(12.))
                    .child("Ctrl+Shift+N   Open workspace       Space   Commands"),
            )
            .into_any_element()
    }
}
