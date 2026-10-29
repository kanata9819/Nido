use super::*;

impl Nido {
    pub(in crate::app::ui) fn new(
        data: PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let (wake, wake_rx) = async_channel::bounded(1);
        let repaint: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            let _ = wake.try_send(());
        });
        let model = Model::load(data, repaint.clone());
        #[cfg(windows)]
        let accessibility = crate::accessibility::Accessibility::new(window, repaint);
        let focus = cx.focus_handle();
        #[cfg(windows)]
        accessibility.show();
        window.activate_window();
        window.focus(&focus);
        let entity = cx.weak_entity();
        window.on_window_should_close(cx, move |_, cx| {
            entity
                .update(cx, |this, cx| {
                    this.model.request_close(true);
                    cx.notify();
                    this.model.exit_allowed
                })
                .unwrap_or(true)
        });
        cx.observe_window_bounds(window, |this, window, _| {
            let bounds = window.window_bounds().get_bounds();
            this.model.window = json!({"width":f32::from(bounds.size.width),"height":f32::from(bounds.size.height),"maximized":window.is_maximized()});
        }).detach();
        cx.observe_window_activation(window, |this, window, cx| {
            if !window.is_window_active() {
                this.model.preedit.clear();
            }
            cx.notify();
        })
        .detach();
        cx.spawn_in(window, async move |entity, cx| {
            while wake_rx.recv().await.is_ok() {
                if entity
                    .update_in(cx, |this, window, cx| this.tick(window, cx))
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        cx.spawn_in(window, async move |entity, cx| {
            loop {
                let delay = entity
                    .read_with(cx, |this, _| {
                        if this.model.settings["smoothBlink"] == true
                            || this.model.settings["smoothCursor"] == true
                        {
                            32
                        } else {
                            200
                        }
                    })
                    .unwrap_or(200);
                Timer::after(Duration::from_millis(delay)).await;
                if entity
                    .update_in(cx, |this, window, cx| {
                        this.model.pump();
                        if this.focus.is_focused(window) && window.is_window_active()
                            || this.model.exit_allowed
                        {
                            this.tick(window, cx);
                        }
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        Self {
            model,
            focus,
            inputs: HashMap::new(),
            grids: HashMap::new(),
            tree_scroll: UniformListScrollHandle::new(),
            palette_scroll: UniformListScrollHandle::new(),
            palette_position: None,
            context_entry: None,
            control_focus: RefCell::new(HashMap::new()),
            #[cfg(windows)]
            accessibility,
            #[cfg(windows)]
            accessible_actions: RefCell::new(HashMap::new()),
            #[cfg(windows)]
            accessible_fields: RefCell::new(HashSet::new()),
            resize_sidebar: false,
            resize_terminal: false,
            terminal_height: 260.,
            started: Instant::now(),
            painted: 0,
            acrylic: None,
            font_setting: String::new(),
            font_family: "Cascadia Code".into(),
        }
    }

    pub(in crate::app::ui) fn tick(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        #[cfg(windows)]
        for request in self.accessibility.take_actions() {
            let action = self
                .accessible_actions
                .borrow()
                .get(&request.target_node)
                .cloned();
            if let Some(action) = action {
                action(self, &request, window, cx);
            }
        }
        self.model.pump();
        if self.model.exit_allowed {
            window.remove_window();
            return;
        }
        if let Some(command) = self.model.window_command.take() {
            match command.as_str() {
                "minimize" => window.minimize_window(),
                "maximize" => window.zoom_window(),
                _ => {}
            }
        }
        self.sync_focus(window, cx);
        cx.notify();
    }

    pub(in crate::app::ui) fn act(
        &mut self,
        action: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.model.execute(action);
        self.tick(window, cx);
    }
}

pub fn run() -> anyhow::Result<()> {
    let data = persistence::data_dir();
    let saved = persistence::read_layout(&data.join("workspaces.json")).unwrap_or_default();
    let startup_error = Rc::new(RefCell::new(None));
    let open_error = startup_error.clone();
    Application::new()
        .with_assets(crate::assets::Assets)
        .run(move |cx| {
            text_input::init(cx);
            let width = saved.window["width"].as_f64().unwrap_or(1440.0) as f32;
            let height = saved.window["height"].as_f64().unwrap_or(940.0) as f32;
            let bounds = Bounds::centered(
                None,
                size(px(width.clamp(850., 3840.)), px(height.clamp(560., 2160.))),
                cx,
            );
            let options = WindowOptions {
                show: !cfg!(windows),
                focus: !cfg!(windows),
                window_bounds: Some(if saved.window["maximized"] == true {
                    WindowBounds::Maximized(bounds)
                } else {
                    WindowBounds::Windowed(bounds)
                }),
                titlebar: Some(TitlebarOptions {
                    title: Some("Nido".into()),
                    appears_transparent: true,
                    ..Default::default()
                }),
                app_id: Some("com.kanata9819.nido".into()),
                window_min_size: Some(size(px(700.), px(420.))),
                ..Default::default()
            };
            if let Err(error) = cx.open_window(options, |window, cx| {
                cx.new(|cx| Nido::new(data, window, cx))
            }) {
                *open_error.borrow_mut() = Some(format!("Open Nido: {error:#}"));
                cx.quit();
            }
            cx.on_window_closed(|cx| {
                if cx.windows().is_empty() {
                    cx.quit();
                }
            })
            .detach();
            cx.activate(true);
        });
    if let Some(error) = startup_error.borrow_mut().take() {
        anyhow::bail!(error);
    }
    Ok(())
}
