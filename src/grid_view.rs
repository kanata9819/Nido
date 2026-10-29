use super::*;

pub(super) struct GridCache {
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

impl Nido {
    pub(super) fn prepare_grid(
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

    pub(super) fn paint_grid(
        &mut self,
        id: &str,
        bounds: Bounds<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.painted += 1;
        let Some(i) = self
            .model
            .workspaces
            .iter()
            .position(|w| w.session.id == id)
        else {
            return;
        };
        let focused = self.focus.is_focused(window)
            && self.model.input_index() == Some(i)
            && !self.model.explorer_focus
            && self.model.palette.is_none()
            && self.model.file_request.is_none()
            && self.model.closing.is_none();
        if focused {
            window.handle_input(
                &self.focus,
                ElementInputHandler::new(bounds, cx.entity()),
                cx,
            );
        }
        let settings = &self.model.settings;
        let preedit = self.model.preedit.clone();
        let w = &mut self.model.workspaces[i];
        let grid = &mut w.grid;
        let Some(cache) = self.grids.get_mut(id) else {
            return;
        };
        let cell = cache.cell;
        let font = &cache.font;
        let fs = cache.font_size;
        cache.completion = None;
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            let mut background = grid.background;
            if settings["theme"] == "acrylic" {
                background.a = 0.86;
            }
            window.paint_quad(fill(bounds, background));
            let scale = window.scale_factor();
            let snap = |p: Point<f32>| {
                point(
                    px((p.x * scale).round() / scale),
                    px((p.y * scale).round() / scale),
                )
            };
            for run in &cache.runs {
                let p = bounds.origin
                    + snap(point(
                        run.origin.x,
                        run.origin.y - grid.pixel.y * cell.height,
                    ));
                if p.y + px(cell.height) < bounds.top() || p.y > bounds.bottom() {
                    continue;
                }
                if run.background != grid.background {
                    window.paint_quad(fill(
                        Bounds::new(p, size(px(run.width), px(cell.height))),
                        run.background,
                    ));
                }
                if let Some(line) = &run.text {
                    let _ = line.paint(p, px(cell.height), window, cx);
                }
            }
            for guide in array(&grid.guides) {
                let x = (n(&guide["column"]) as f32 + 0.15) * cell.width;
                let top = guide["top"].as_i64().unwrap_or(0) as f32;
                let bottom = guide["bottom"].as_i64().unwrap_or(0) as f32;
                let y = (top + 1. - grid.pixel.y) * cell.height;
                let height = ((bottom - top - 1.) * cell.height).max(0.);
                let mut color =
                    grid::parse_color(s(&guide["color"])).unwrap_or(rgb(0x414141).into());
                color.a = if guide["active"] == true { 0.8 } else { 0.35 };
                window.paint_quad(fill(
                    Bounds::new(
                        bounds.origin + point(px(x), px(y)),
                        size(px(1.), px(height)),
                    ),
                    color,
                ));
            }
            let cursor = grid.scroll_cursor.unwrap_or(grid.cursor);
            let hidden = cursor.0 >= grid.rows || cursor.1 >= grid.columns;
            let target = point(
                cursor.1.min(grid.columns) as f32 * cell.width,
                (cursor.0.min(grid.rows) as f32 - grid.pixel.y) * cell.height,
            );
            let now = self.started.elapsed().as_secs_f64();
            if grid
                .cursor_position
                .is_none_or(|old| (old.x - target.x).abs() + (old.y - target.y).abs() > 0.1)
            {
                grid.blink_origin = now;
            }
            let visual = if focused && settings["smoothCursor"] == true {
                let old = grid.cursor_position.unwrap_or(target);
                let next = point(
                    old.x + (target.x - old.x) * 0.65,
                    old.y + (target.y - old.y) * 0.65,
                );
                if (next.x - target.x).abs() + (next.y - target.y).abs() > 0.1 {
                    window.request_animation_frame();
                }
                next
            } else {
                target
            };
            grid.cursor_position = (!hidden).then_some(visual);
            let mode = grid.modes.get(grid.mode_index).cloned().unwrap_or_default();
            let pct = mode["cell_percentage"].as_f64().unwrap_or(20.) as f32 / 100.;
            let width = if grid
                .cells
                .get(cursor.0)
                .and_then(|r| r.get(cursor.1 + 1))
                .is_some_and(|c| c.text.is_empty())
            {
                cell.width * 2.
            } else {
                cell.width
            };
            let origin = bounds.origin + snap(visual);
            let full_cursor = Bounds::new(origin, size(px(width), px(cell.height)));
            let mut cursor_bounds = full_cursor;
            match s(&mode["cursor_shape"]) {
                "vertical" => cursor_bounds.size.width = px((cell.width * pct).max(1.)),
                "horizontal" => {
                    cursor_bounds.size.height = px((cell.height * pct).max(1.));
                    cursor_bounds.origin.y += px(cell.height) - cursor_bounds.size.height;
                }
                _ if grid.mode.starts_with("insert") => cursor_bounds.size.width = px(2.),
                _ => {}
            }
            cache.cursor = full_cursor;
            let phase = (now - grid.blink_origin - 0.7).max(0.);
            let alpha = if settings["smoothBlink"] == true {
                (0.5 + 0.5 * (phase * std::f64::consts::TAU).cos()) as f32
            } else if phase % 1. < 0.55 {
                1.
            } else {
                0.
            };
            if !hidden && !grid.busy {
                let mut color = grid.foreground;
                color.a = if focused { alpha * 0.7 } else { 0.6 };
                if focused {
                    window.paint_quad(fill(cursor_bounds, color));
                } else {
                    window.paint_quad(outline(cursor_bounds, color, BorderStyle::Solid));
                }
            }
            if settings["stickyScroll"] != false {
                let gutter = n(&grid.sticky["gutter"]);
                let left = n(&grid.sticky["leftcol"]);
                let max = settings["stickyScrollMaxLines"].as_f64().unwrap_or(5.) as usize;
                let mut sticky_rows = 0;
                for (row, scope) in array(&grid.sticky["scopes"])
                    .iter()
                    .filter(|s| s["top"].as_i64().unwrap_or(0) < 0)
                    .take(max)
                    .enumerate()
                {
                    sticky_rows += 1;
                    let origin = bounds.origin + point(px(0.), px(row as f32 * cell.height));
                    window.paint_quad(fill(
                        Bounds::new(origin, size(bounds.size.width, px(cell.height))),
                        grid.background,
                    ));
                    let line = n(&scope["line"]);
                    let anchor = n(&grid.sticky["relativeTo"]);
                    let number = if settings["relativeLineNumbers"] == true && anchor > 0 {
                        line.abs_diff(anchor)
                    } else {
                        line
                    };
                    let text = format!("{number:>width$}", width = gutter.saturating_sub(1));
                    let _ = shape(&text, font, fs, rgb(0x7d7d7d).into(), None, window).paint(
                        origin,
                        px(cell.height),
                        window,
                        cx,
                    );
                    let clip = Bounds::new(
                        origin + point(px(gutter as f32 * cell.width), px(0.)),
                        size(
                            (bounds.size.width - px(gutter as f32 * cell.width)).max(px(0.)),
                            px(cell.height),
                        ),
                    );
                    let mut col = gutter as f32 - left as f32;
                    window.with_content_mask(Some(ContentMask { bounds: clip }), |window| {
                        for chunk in array(&scope["text"]) {
                            let text = s(&chunk["text"]);
                            let color =
                                grid::parse_color(s(&chunk["color"])).unwrap_or(grid.foreground);
                            let _ = shape(text, font, fs, color, None, window).paint(
                                origin + point(px(col * cell.width), px(0.)),
                                px(cell.height),
                                window,
                                cx,
                            );
                            col += chunk["cells"]
                                .as_f64()
                                .unwrap_or(text.chars().count() as f64)
                                as f32;
                        }
                    });
                }
                if sticky_rows > 0 {
                    window.paint_quad(fill(
                        Bounds::new(
                            bounds.origin + point(px(0.), px(sticky_rows as f32 * cell.height)),
                            size(bounds.size.width, px(1.)),
                        ),
                        rgb(0x464646),
                    ));
                }
                for sep in array(&grid.sticky["separators"]) {
                    window.paint_quad(fill(
                        Bounds::new(
                            bounds.origin + point(px(0.), px(n(&sep["row"]) as f32 * cell.height)),
                            size(bounds.size.width, px(1.)),
                        ),
                        rgb(0x303030),
                    ));
                }
            }
            if focused && !preedit.is_empty() {
                let line = shape(&preedit, font, fs, rgb(0xffffff).into(), None, window);
                window.paint_quad(fill(
                    Bounds::new(
                        origin,
                        size(line.width.max(px(cell.width)), px(cell.height)),
                    ),
                    rgb(0x282f37),
                ));
                let _ = line.paint(origin, px(cell.height), window, cx);
                window.paint_quad(fill(
                    Bounds::new(
                        origin + point(px(0.), px(cell.height - 1.)),
                        size(line.width, px(1.)),
                    ),
                    rgb(0x99c68c),
                ));
            }
            if !w.ready {
                let text = if w.closed {
                    "Neovim stopped. Close and reopen this workspace."
                } else {
                    "Connecting to Neovim…"
                };
                let _ = shape(text, font, fs, grid.foreground, None, window).paint(
                    bounds.origin + point(px(16.), px(20.)),
                    px(cell.height),
                    window,
                    cx,
                );
            }
            let command = grid
                .commands
                .last_key_value()
                .map(|(_, c)| format!("{}{}{}", s(&c[2]), s(&c[3]), grid::chunks(&c[0])));
            if let Some(message) = command.as_ref().or_else(|| grid.messages.last()) {
                let p = point(
                    bounds.left() + px(8.),
                    bounds.bottom() - px(cell.height + 8.),
                );
                window.paint_quad(fill(
                    Bounds::new(p, size(bounds.size.width - px(16.), px(cell.height + 4.))),
                    rgb(0x242c35),
                ));
                let _ = shape(message, font, fs, grid.foreground, None, window).paint(
                    p + point(px(4.), px(2.)),
                    px(cell.height),
                    window,
                    cx,
                );
            }
            if grid.completion.is_object() {
                let completion = &grid.completion;
                let items = array(&completion["items"]);
                let selected = completion["selected"].as_i64().unwrap_or(-1);
                let start = (selected.max(0) as usize).saturating_sub(7);
                let count = items.len().saturating_sub(start).min(10);
                let x = (n(&completion["column"]) as f32 * cell.width)
                    .min(f32::from(bounds.size.width) - 320.)
                    .max(0.);
                let y = ((n(&completion["row"]) + 1) as f32 * cell.height)
                    .min(f32::from(bounds.size.height) - count as f32 * cell.height)
                    .max(0.);
                let origin = bounds.origin + point(px(x), px(y));
                let popup = Bounds::new(origin, size(px(320.), px(count as f32 * cell.height)));
                cache.completion = Some((popup, start, count));
                window.paint_quad(fill(popup, rgb(0x252d34)));
                for (row, item) in items.iter().enumerate().skip(start).take(10) {
                    let p = origin + point(px(0.), px((row - start) as f32 * cell.height));
                    if row as i64 == selected {
                        window.paint_quad(fill(
                            Bounds::new(p, size(px(320.), px(cell.height))),
                            rgb(0x3d5144),
                        ));
                    }
                    let label = format!("{} {}  {}", s(&item[1]), s(&item[0]), s(&item[2]));
                    window.with_content_mask(Some(ContentMask { bounds: popup }), |window| {
                        let _ = shape(&label, font, fs, grid.foreground, None, window).paint(
                            p + point(px(6.), px(0.)),
                            px(cell.height),
                            window,
                            cx,
                        );
                    });
                }
            }
        });
    }
}

impl EntityInputHandler for Nido {
    fn text_for_range(
        &mut self,
        range: Range<usize>,
        actual: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let text = self.model.preedit.encode_utf16().collect::<Vec<_>>();
        let end = range.end.min(text.len());
        let range = range.start.min(end)..end;
        *actual = Some(range.clone());
        Some(String::from_utf16_lossy(&text[range]))
    }
    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        let end = self.model.preedit.encode_utf16().count();
        Some(UTF16Selection {
            range: end..end,
            reversed: false,
        })
    }
    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        (!self.model.preedit.is_empty()).then(|| 0..self.model.preedit.encode_utf16().count())
    }
    fn unmark_text(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        self.model.preedit.clear();
        cx.notify();
    }
    fn replace_text_in_range(
        &mut self,
        _: Option<Range<usize>>,
        text: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.model.preedit.clear();
        self.model.text(text);
        self.tick(window, cx);
    }
    fn replace_and_mark_text_in_range(
        &mut self,
        _: Option<Range<usize>>,
        text: &str,
        _: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.model.preedit = text.into();
        cx.notify();
    }
    fn bounds_for_range(
        &mut self,
        _: Range<usize>,
        _: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let i = self.model.input_index()?;
        self.grids
            .get(&self.model.workspaces[i].session.id)
            .map(|c| c.cursor)
    }
    fn character_index_for_point(
        &mut self,
        _: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        Some(0)
    }
}
