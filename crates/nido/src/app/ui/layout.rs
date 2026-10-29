use super::*;

impl Render for Nido {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.grids
            .retain(|id, _| self.model.workspaces.iter().any(|w| w.session.id == *id));
        #[cfg(windows)]
        {
            self.accessibility.clear();
            self.accessible_actions.borrow_mut().clear();
            self.accessible_fields.borrow_mut().clear();
        }
        self.sync_focus(window, cx);
        let acrylic = self.model.settings["theme"] == "acrylic";
        if self.acrylic != Some(acrylic) {
            window.set_background_appearance(if acrylic {
                WindowBackgroundAppearance::Blurred
            } else {
                WindowBackgroundAppearance::Opaque
            });
            self.acrylic = Some(acrylic);
        }
        let top_rail = self.model.settings["activityBarPosition"] == "top";
        let mut center = div().flex().flex_col().flex_1().min_w_0().min_h_0();
        if let Some(i) = self.model.active_index() {
            center = center
                .child(self.buffer_tabs(i, cx))
                .child(self.editor(i, false, cx));
        } else {
            center = center.child(self.welcome(cx));
        }
        if self.model.terminal_visible
            && let Some(index) = self
                .model
                .workspaces
                .iter()
                .position(|w| w.parent.as_deref() == Some(&self.model.active))
        {
            center = center
                .child(
                    div()
                        .id("terminal-divider")
                        .h(px(4.))
                        .flex_shrink_0()
                        .cursor(CursorStyle::ResizeUpDown)
                        .bg(rgb(0x282c30))
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|this, _, _, _| this.resize_terminal = true),
                        ),
                )
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .h(px(self.terminal_height))
                        .min_h(px(100.))
                        .flex_shrink_0()
                        .child(
                            div()
                                .flex()
                                .h(px(30.))
                                .items_center()
                                .px_2()
                                .gap_2()
                                .bg(rgb(0x151b20))
                                .child(div().flex_1().child(self.model.tr("Terminal")))
                                .child(self.button(
                                    "restart-paired",
                                    "Restart shell",
                                    move |this, _, _| {
                                        this.model.workspaces[index]
                                            .session
                                            .send("restartTerminal", json!([]))
                                    },
                                    cx,
                                ))
                                .child(
                                    self.button(
                                        "hide-terminal",
                                        "",
                                        |this, window, cx| {
                                            this.model.terminal_visible = false;
                                            this.model.focus_editor = true;
                                            this.tick(window, cx);
                                        },
                                        cx,
                                    )
                                    .child(icon("x", 14.)),
                                ),
                        )
                        .child(self.editor(index, true, cx)),
                );
        }
        let mut body = div().flex().flex_1().min_h_0().overflow_hidden();
        if !top_rail {
            body = body.child(self.navigation(false, cx));
        }
        if self.model.settings["sidebar"] != false && self.model.active_index().is_some() {
            body = body
                .child(
                    div()
                        .w(px(
                            self.model.settings["sidebarWidth"].as_f64().unwrap_or(243.) as f32,
                        ))
                        .flex_shrink_0()
                        .h_full()
                        .child(self.explorer(cx)),
                )
                .child(
                    div()
                        .id("sidebar-divider")
                        .w(px(3.))
                        .h_full()
                        .flex_shrink_0()
                        .cursor(CursorStyle::ResizeLeftRight)
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|this, _, _, _| this.resize_sidebar = true),
                        ),
                );
        }
        body = body.child(center);
        if !self.model.panel.is_empty() {
            body = body.child(self.side_panel(cx));
        }
        div()
            .id("nido")
            .track_focus(&self.focus)
            .relative()
            .flex()
            .flex_col()
            .size_full()
            .overflow_hidden()
            .font_family("Segoe UI Variable")
            .text_size(px(13.))
            .text_color(rgb(0xd6dce2))
            .bg(if acrylic {
                rgba(0x191e23dc)
            } else {
                rgba(0x191e23ff)
            })
            .capture_key_down(cx.listener(Self::key_down))
            .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, window, cx| {
                if this.resize_sidebar {
                    this.model.settings["sidebarWidth"] =
                        json!((f32::from(event.position.x) - 47.).clamp(160., 480.));
                    cx.notify();
                }
                if this.resize_terminal {
                    this.terminal_height =
                        (f32::from(window.viewport_size().height - event.position.y) - 25.)
                            .clamp(100., 700.);
                    cx.notify();
                }
            }))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, _, _, _| {
                    this.resize_sidebar = false;
                    this.resize_terminal = false;
                }),
            )
            .child(self.titlebar(cx))
            .when(top_rail, |el| el.child(self.navigation(true, cx)))
            .child(body)
            .child(self.status(cx))
            .children(self.overlay(cx))
            .children(self.notifications(cx))
            .child({
                let entity = cx.entity();
                canvas(
                    |_, _, _| {},
                    move |_, _, window, cx| {
                        #[cfg(windows)]
                        entity.update(cx, |this, cx| this.publish_accessibility(window, cx));
                        #[cfg(not(windows))]
                        let _ = (&entity, window, cx);
                    },
                )
                .absolute()
                .size_full()
            })
    }
}
