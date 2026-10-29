use super::*;

impl Nido {
    pub(in crate::app::ui) fn prepare_grid(
        &mut self,
        id: &str,
        bounds: Bounds<Pixels>,
        window: &mut Window,
        _cx: &mut Context<Self>,
    ) {
        let Some(i) = self
            .model
            .workspaces
            .iter()
            .position(|w| w.session.id == id)
        else {
            return;
        };
        let setting = s(&self.model.settings["fontFamily"]).to_owned();
        if self.font_setting != setting {
            self.font_setting = setting.clone();
            self.font_family = setting
                .split(',')
                .next()
                .unwrap_or("Cascadia Code")
                .trim()
                .trim_matches(['\'', '"'])
                .to_owned();
            if Path::new(&setting).is_file() {
                let loaded = (|| -> anyhow::Result<String> {
                    let bytes = std::fs::read(&setting)?;
                    let mut database = fontdb::Database::new();
                    database.load_font_data(bytes.clone());
                    let family = database
                        .faces()
                        .next()
                        .and_then(|face| face.families.first())
                        .map(|(name, _)| name.clone())
                        .ok_or_else(|| anyhow::anyhow!("Invalid font file"))?;
                    window.text_system().add_fonts(vec![bytes.into()])?;
                    Ok(family)
                })();
                match loaded {
                    Ok(family) => self.font_family = family,
                    Err(error) => {
                        self.font_family = "Consolas".into();
                        self.model.error(format!("Font: {error}"));
                    }
                }
            }
        }
        let settings = &self.model.settings;
        let font_size = settings["fontSize"].as_f64().unwrap_or(14.) as f32;
        let mut font = font(self.font_family.clone());
        font.weight = FontWeight(settings["fontWeight"].as_f64().unwrap_or(350.) as f32);
        let mut fallbacks: Vec<String> = setting
            .split(',')
            .skip(1)
            .map(|name| name.trim().trim_matches(['\'', '"']).to_owned())
            .collect();
        fallbacks.extend([
            "Consolas".into(),
            "Yu Gothic UI".into(),
            "Meiryo".into(),
            "Segoe UI Emoji".into(),
            "Segoe UI Symbol".into(),
        ]);
        font.fallbacks = Some(FontFallbacks::from_fonts(fallbacks));
        let cell = Size {
            width: f32::from(
                shape("M", &font, font_size, rgb(0xffffff).into(), None, window).width,
            )
            .max(1.),
            height: (font_size * settings["lineHeight"].as_f64().unwrap_or(1.5) as f32)
                .max(font_size + 2.),
        };
        let dimensions = (
            (f32::from(bounds.size.width) / cell.width).floor().max(2.) as usize,
            (f32::from(bounds.size.height) / cell.height)
                .floor()
                .max(2.) as usize,
        );
        let w = &mut self.model.workspaces[i];
        if w.ready && dimensions != w.size {
            w.size = dimensions;
            w.session
                .send("resize", json!([dimensions.0, dimensions.1]));
        }
        w.grid.scroll_cursor = grid::screen_cursor(&w.state["scrollCursor"]);
        let key = format!("{:?}:{font_size}:{}:{}", font, cell.width, cell.height);
        if let Some(cache) = self.grids.get_mut(id)
            && cache.revision == w.grid.revision
            && cache.key == key
        {
            cache.bounds = bounds;
            return;
        }
        let mut runs = vec![];
        for (row, values) in w.grid.cells.iter().enumerate() {
            let mut col = 0;
            while col < values.len() {
                let start = col;
                let h = values[col].highlight;
                let mut text = String::new();
                if values[col].text.is_ascii() && !values[col].text.is_empty() {
                    while col < values.len()
                        && values[col].highlight == h
                        && values[col].text.is_ascii()
                        && !values[col].text.is_empty()
                    {
                        text.push_str(&values[col].text);
                        col += 1;
                    }
                } else {
                    text.push_str(&values[col].text);
                    col += 1;
                    if col < values.len() && values[col].text.is_empty() {
                        col += 1;
                    }
                }
                let (foreground, background) = w.grid.colors(h);
                runs.push(GridRun {
                    origin: point(start as f32 * cell.width, row as f32 * cell.height),
                    width: (col - start) as f32 * cell.width,
                    background,
                    text: (!text.trim().is_empty()).then(|| {
                        shape(
                            &text,
                            &font,
                            font_size,
                            foreground,
                            w.grid.highlights.get(&h),
                            window,
                        )
                    }),
                });
            }
        }
        self.grids.insert(
            id.into(),
            GridCache {
                completion: None,
                bounds,
                cell,
                cursor: Bounds::new(bounds.origin, size(px(cell.width), px(cell.height))),
                revision: w.grid.revision,
                key,
                font,
                font_size,
                runs,
            },
        );
    }
}
