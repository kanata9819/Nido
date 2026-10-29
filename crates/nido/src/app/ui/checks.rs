use super::*;

pub fn verify_gui() -> anyhow::Result<()> {
    use anyhow::ensure;
    use std::cell::{Cell, RefCell};
    let root = std::env::temp_dir().join(format!("nido-gpui-check-{}", uuid::Uuid::new_v4()));
    let project = root.join("project");
    fs::create_dir_all(&project)?;
    fs::write(project.join("hello.txt"), "Native GPUI\n")?;
    let phase = Rc::new(Cell::new(0usize));
    let progress = phase.clone();
    let failure = Rc::new(RefCell::new(None::<String>));
    let error = failure.clone();
    let open_failure = failure.clone();
    let data = root.join("data");
    Application::new()
        .with_assets(crate::assets::Assets)
        .run(move |cx| {
            text_input::init(cx);
            let options = WindowOptions {
                show: !cfg!(windows),
                focus: !cfg!(windows),
                window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                    None,
                    size(px(1200.), px(800.)),
                    cx,
                ))),
                titlebar: Some(TitlebarOptions {
                    title: Some("Nido GPUI check".into()),
                    appears_transparent: true,
                    ..Default::default()
                }),
                ..Default::default()
            };
            let opened = cx.open_window(options, move |window, cx| {
                cx.new(|cx| {
                    let mut view = Nido::new(data, window, cx);
                    view.model.add_workspace(project, false, None, None);
                    cx.spawn_in(window, async move |entity, cx| {
                        let started = Instant::now();
                        loop {
                            Timer::after(Duration::from_millis(150)).await;
                            let checked =
                                entity.update_in(cx, |this, window, cx| -> anyhow::Result<()> {
                                    ensure!(
                                        started.elapsed() < Duration::from_secs(45),
                                        "GPUI check timed out at phase {}",
                                        progress.get()
                                    );
                                    let step = progress.get();
                                    let i = this.model.active_index().unwrap();
                                    match step {
                                        0 if this.model.workspaces[i].ready => {
                                            this.model.send("open", json!(["hello.txt", 1, 1]));
                                            progress.set(1);
                                        }
                                        1 if this.model.workspaces[i]
                                            .grid
                                            .description()
                                            .contains("Native GPUI") =>
                                        {
                                            ensure!(
                                                this.painted > 0,
                                                "GPUI did not paint the editor"
                                            );
                                            this.model.text("i");
                                            progress.set(2);
                                        }
                                        2 if this.model.workspaces[i].state["mode"] == "i" => {
                                            this.replace_and_mark_text_in_range(
                                                None,
                                                "日本語",
                                                None,
                                                window,
                                                cx,
                                            );
                                            progress.set(3);
                                        }
                                        3 => {
                                            ensure!(
                                                this.model.preedit == "日本語",
                                                "Editor lost IME preedit"
                                            );
                                            ensure!(
                                                this.bounds_for_range(
                                                    0..3,
                                                    Bounds::default(),
                                                    window,
                                                    cx
                                                )
                                                .is_some(),
                                                "IME candidate position is missing"
                                            );
                                            this.replace_text_in_range(
                                                None,
                                                "GPUI日本語",
                                                window,
                                                cx,
                                            );
                                            this.key_down(
                                                &KeyDownEvent {
                                                    keystroke: Keystroke::parse("escape").unwrap(),
                                                    is_held: false,
                                                },
                                                window,
                                                cx,
                                            );
                                            progress.set(4);
                                        }
                                        4 if this.model.workspaces[i]
                                            .grid
                                            .description()
                                            .contains("GPUI日本語") =>
                                        {
                                            this.key_down(
                                                &KeyDownEvent {
                                                    keystroke: Keystroke::parse("ctrl-s").unwrap(),
                                                    is_held: false,
                                                },
                                                window,
                                                cx,
                                            );
                                            progress.set(5);
                                        }
                                        5 if this.model.workspaces[i]
                                            .buffers()
                                            .iter()
                                            .all(|b| b["modified"] == false) =>
                                        {
                                            ensure!(
                                                fs::read_to_string(
                                                    this.model.workspaces[i]
                                                        .session
                                                        .root
                                                        .join("hello.txt")
                                                )?
                                                .contains("GPUI日本語"),
                                                "GPUI input was not saved"
                                            );
                                            this.model.open_palette("files");
                                            this.sync_focus(window, cx);
                                            progress.set(6);
                                        }
                                        6 if this
                                            .model
                                            .palette
                                            .as_ref()
                                            .is_some_and(|p| !array(&p.items).is_empty()) =>
                                        {
                                            #[cfg(windows)]
                                            ensure!(this.accessibility.has_label("hello.txt "), "Palette result is missing from Windows UI Automation");
                                            let field = this.inputs.get("palette").unwrap().clone();
                                            ensure!(
                                                field.focus_handle(cx).is_focused(window),
                                                "Palette did not receive focus"
                                            );
                                            field.update(cx, |input, cx| {
                                                input.replace_and_mark_text_in_range(
                                                    None,
                                                    "日本語",
                                                    None,
                                                    window,
                                                    cx,
                                                );
                                                input.set("", cx);
                                                assert_eq!(
                                                    input.content.as_ref(),
                                                    "日本語",
                                                    "Parent repaint reset IME composition"
                                                );
                                                input.replace_text_in_range(
                                                    None, "hello", window, cx,
                                                );
                                            });
                                            progress.set(7);
                                        }
                                        7 => {
                                            ensure!(
                                                this.model
                                                    .palette
                                                    .as_ref()
                                                    .is_some_and(|p| p.query == "hello"),
                                                "Palette lost committed text"
                                            );
                                            this.key_down(
                                                &KeyDownEvent {
                                                    keystroke: Keystroke::parse("escape").unwrap(),
                                                    is_held: false,
                                                },
                                                window,
                                                cx,
                                            );
                                            progress.set(8);
                                        }
                                        8..=17 => {
                                            const PANELS: [&str; 10] = [
                                                "search",
                                                "git",
                                                "gitHistory",
                                                "history",
                                                "debug",
                                                "references",
                                                "problems",
                                                "extensions",
                                                "markdown",
                                                "settings",
                                            ];
                                            this.model.show_panel(PANELS[step - 8]);
                                            if step == 17 {
                                                this.model.settings["fontFamily"] = json!(r"C:\Windows\Fonts\consola.ttf");
                                            }
                                            progress.set(step + 1);
                                        }
                                        18 => {
                                            #[cfg(windows)]
                                            ensure!(this.font_family == "Consolas", "Font file setting did not load: {}", this.font_family);
                                            this.model.panel.clear();
                                            this.key_down(&KeyDownEvent { keystroke: Keystroke::parse("alt-f4").unwrap(), is_held: false }, window, cx);
                                            progress.set(19);
                                        }
                                        _ => {}
                                    }
                                    this.tick(window, cx);
                                    Ok(())
                                });
                            match checked {
                                Ok(Ok(())) => {}
                                Ok(Err(e)) => {
                                    *error.borrow_mut() = Some(format!("{e:#}"));
                                    let _ = cx.update(|_, cx| cx.quit());
                                    break;
                                }
                                Err(_) => break,
                            }
                        }
                    })
                    .detach();
                    view
                })
            });
            if let Err(e) = opened {
                *open_failure.borrow_mut() = Some(format!("Open GPUI check: {e:#}"));
                cx.quit();
            }
            cx.on_window_closed(|cx| {
                if cx.windows().is_empty() {
                    cx.quit();
                }
            })
            .detach();
        });
    // The normal close path removes the window only after snapshots and all sessions stop.
    ensure!(
        phase.get() == 19,
        "GPUI check ended early at phase {}; data: {}",
        phase.get(),
        root.display()
    );
    if let Some(error) = failure.borrow_mut().take() {
        anyhow::bail!("{error}; data: {}", root.display());
    }
    crate::smoke::remove_test_dir(&root)?;
    println!(
        "PASS: GPUI window, grid painting, IME preedit/commit, candidate position, save, palette focus, all panels and clean close"
    );
    Ok(())
}
