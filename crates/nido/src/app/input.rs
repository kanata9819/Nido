use super::*;

impl Model {
    pub(super) fn pump(&mut self) {
        self.events();
        if !self.mode_pending {
            let queued = std::mem::take(&mut self.queued_input);
            for event in queued {
                match event {
                    InputEvent::Key(key) => {
                        self.key(&key, true);
                    }
                    InputEvent::Text(text) => self.text(&text),
                }
            }
        }
        if self.settings != self.settings_before {
            if let Err(error) = settings::save(&self.data, &self.settings) {
                self.error(format!("Settings: {error}"));
            }
            for w in &self.workspaces {
                w.session.send("settings", self.settings.clone());
            }
            self.settings_before = self.settings.clone();
        }
        self.notifications
            .retain(|(_, time)| time.elapsed() < Duration::from_secs(30));
        if self.last_persist.elapsed() > Duration::from_secs(5) {
            self.persist();
        }
    }

    pub(super) fn text(&mut self, text: &str) {
        if self.mode_pending {
            self.queued_input.push(InputEvent::Text(text.into()));
        } else if let Some(p) = self.palette.as_mut() {
            p.query.push_str(text);
            self.palette_changed();
        } else if self.closing.is_none() && self.file_request.is_none() && !self.show_wsl {
            if self.explorer_focus {
                self.explorer_key(text);
            } else if [" ", "H", "L"].contains(&text)
                && self.input_index() == self.active_index()
                && self.active_index().is_some_and(|i| {
                    !self.workspaces[i].session.terminal
                        && self.workspaces[i].grid.commands.is_empty()
                })
            {
                self.mode_shortcut(text);
            } else {
                self.input(&text.replace('<', "<LT>"));
            }
        }
    }

    pub(super) fn key(&mut self, stroke: &Keystroke, editor: bool) -> bool {
        let key = stroke.key.as_str();
        let m = stroke.modifiers;
        let ctrl = m.control && !m.alt && !m.platform;
        if let Some(close) = &self.closing {
            if key == "escape" && close.stage == "prompt" {
                self.close_choice("cancel");
                return true;
            }
            return editor;
        }
        if key == "escape" {
            let modal =
                self.palette.take().is_some() | self.file_request.take().is_some() | self.show_wsl;
            self.show_wsl = false;
            if modal
                || !self.hover.is_empty()
                || !self.diagnostics.is_null()
                || !self.panel.is_empty()
                || self.explorer_focus
            {
                self.hover.clear();
                self.diagnostics = Value::Null;
                self.panel.clear();
                self.explorer_focus = false;
                self.focus_editor = true;
                return true;
            }
        }
        if self.palette.is_some() {
            let items = self.palette_items();
            if key == "down" || (ctrl && key == "j") {
                let p = self.palette.as_mut().unwrap();
                p.index = (p.index + 1).min(items.len().saturating_sub(1));
            } else if key == "up" || (ctrl && key == "k") {
                let p = self.palette.as_mut().unwrap();
                p.index = p.index.saturating_sub(1);
            } else if key == "enter" {
                if let Some(item) = items.get(self.palette.as_ref().unwrap().index) {
                    self.activate_palette(item.clone());
                }
            } else {
                return false;
            }
            return true;
        }
        if self.file_request.is_some() {
            if key == "enter" {
                self.submit_file();
                return true;
            }
            return false;
        }
        if self.show_wsl {
            return false;
        }
        if ctrl && self.preedit.is_empty() {
            let action = match (key, m.shift) {
                ("n", true) => Some("new"),
                ("p", true) => Some("commands"),
                ("f", true) => Some("search"),
                ("g", true) => Some("git"),
                ("m", true) => Some("problems"),
                ("h", true) => Some("history"),
                ("o", true) => Some("symbols"),
                ("x", true) => Some("extensions"),
                ("d", true) => Some("debug"),
                ("s", false)
                    if self.input_index() == self.active_index()
                        && self
                            .active_index()
                            .is_some_and(|i| !self.workspaces[i].session.terminal) =>
                {
                    Some("save")
                }
                ("`" | "@", _) | ("2", true) => Some("terminal"),
                ("h", false) => Some("explorer"),
                ("j", false) => Some("debug"),
                ("k", false)
                    if self.terminal_focused || self.explorer_focus || !self.panel.is_empty() =>
                {
                    Some("focusEditor")
                }
                ("l", false) => Some("focusEditor"),
                ("r", true) => Some("restartTerminal"),
                ("tab", false) => Some("nextWorkspace"),
                ("tab", true) => Some("previousWorkspace"),
                _ => None,
            };
            if let Some(action) = action {
                self.execute(action);
                return true;
            }
            if editor
                && key == "p"
                && self.input_index() == self.active_index()
                && self
                    .active_index()
                    .is_some_and(|i| !self.workspaces[i].session.terminal)
            {
                self.mode_shortcut("<C-p>");
                return true;
            }
        }
        if m.alt
            && !m.control
            && let Ok(digit @ 1..=9) = key.parse::<usize>()
        {
            if let Some(w) = self
                .workspaces
                .iter()
                .filter(|w| w.parent.is_none())
                .nth(digit - 1)
            {
                self.active = w.session.id.clone();
                self.focus_editor = true;
            }
            return true;
        }
        if !editor {
            return false;
        }
        if self.mode_pending {
            if vim_key(stroke).is_some() {
                self.queued_input.push(InputEvent::Key(stroke.clone()));
                return true;
            }
            return false;
        }
        if !self.preedit.is_empty() {
            return false;
        }
        if self.explorer_focus {
            self.explorer_key(match key {
                "down" => "j",
                "up" => "k",
                "left" => "h",
                "right" => "l",
                key => key,
            });
            return matches!(key, "down" | "up" | "left" | "right" | "enter" | "delete");
        }
        let debug = match (key, m.shift) {
            ("f5", false) => Some("start"),
            ("f5", true) => Some("stop"),
            ("f9", _) => Some("breakpoint"),
            ("f10", _) => Some("over"),
            ("f11", false) => Some("into"),
            ("f11", true) => Some("out"),
            _ => None,
        };
        if let Some(action) = debug {
            self.send("debug", json!([action, 0]));
            return true;
        }
        if let Some(key) = vim_key(stroke) {
            self.input(&key);
            return true;
        }
        false
    }
}

#[derive(Clone)]
pub(super) enum InputEvent {
    Key(Keystroke),
    Text(String),
}

fn vim_key(stroke: &Keystroke) -> Option<String> {
    let m = stroke.modifiers;
    if m.control && m.alt {
        return None;
    }
    let special = match stroke.key.as_str() {
        "escape" => Some("Esc"),
        "enter" => Some("CR"),
        "backspace" => Some("BS"),
        "tab" => Some("Tab"),
        "delete" => Some("Del"),
        "insert" => Some("Insert"),
        "up" => Some("Up"),
        "down" => Some("Down"),
        "left" => Some("Left"),
        "right" => Some("Right"),
        "home" => Some("Home"),
        "end" => Some("End"),
        "pageup" => Some("PageUp"),
        "pagedown" => Some("PageDown"),
        "space" if m.control => Some("Space"),
        k if k.starts_with('f') && k[1..].parse::<u8>().is_ok_and(|n| (1..=24).contains(&n)) => {
            Some(k)
        }
        _ => None,
    };
    if special.is_none() && !m.control && !m.alt && !m.platform {
        return None;
    }
    let name = special.unwrap_or(&stroke.key);
    let mut prefix = String::new();
    if m.control {
        prefix.push_str("C-");
    }
    if m.alt {
        prefix.push_str("A-");
    }
    if m.platform {
        prefix.push_str("D-");
    }
    if m.shift {
        prefix.push_str("S-");
    }
    Some(format!("<{prefix}{name}>"))
}

#[cfg(test)]
mod input_tests {
    use super::*;
    #[test]
    fn altgr_is_text_and_vim_control_keys_stay_control_keys() {
        assert_eq!(
            vim_key(&Keystroke::parse("ctrl-v").unwrap()).as_deref(),
            Some("<C-v>")
        );
        assert_eq!(vim_key(&Keystroke::parse("ctrl-alt-q").unwrap()), None);
        assert_eq!(
            vim_key(&Keystroke::parse("shift-enter").unwrap()).as_deref(),
            Some("<S-CR>")
        );
        assert_eq!(vim_key(&Keystroke::parse("a").unwrap()), None);
    }
}
