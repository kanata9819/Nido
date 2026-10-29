// Adapted from gpui 0.2.2 examples/input.rs (Zed Industries, Apache-2.0).
use std::ops::Range;

use gpui::*;
use unicode_segmentation::*;

actions!(
    text_input,
    [
        Backspace,
        Delete,
        Left,
        Right,
        SelectLeft,
        SelectRight,
        SelectAll,
        Home,
        End,
        ShowCharacterPalette,
        Paste,
        Cut,
        Copy,
        Quit,
    ]
);

pub struct TextInput {
    focus_handle: FocusHandle,
    pub content: SharedString,
    placeholder: SharedString,
    selected_range: Range<usize>,
    selection_reversed: bool,
    marked_range: Option<Range<usize>>,
    last_layout: Option<ShapedLine>,
    last_bounds: Option<Bounds<Pixels>>,
    is_selecting: bool,
    scroll_x: Pixels,
    pub tab_stop: bool,
}

mod element;
mod ime;
mod selection;

impl TextInput {
    #[cfg(windows)]
    pub fn accessibility(&self) -> (String, String, Option<Bounds<Pixels>>) {
        (
            self.placeholder.to_string(),
            self.content.to_string(),
            self.last_bounds,
        )
    }
    pub fn new(content: String, placeholder: String, cx: &mut Context<Self>) -> Self {
        let end = content.len();
        Self {
            focus_handle: cx.focus_handle(),
            content: content.into(),
            placeholder: placeholder.into(),
            selected_range: end..end,
            selection_reversed: false,
            marked_range: None,
            last_layout: None,
            last_bounds: None,
            is_selecting: false,
            scroll_x: px(0.),
            tab_stop: true,
        }
    }
    pub fn set(&mut self, text: &str, cx: &mut Context<Self>) {
        // A parent repaint must not reset an in-progress IME composition.
        if self.marked_range.is_none() && self.content != text {
            self.content = text.to_owned().into();
            let end = self.content.len();
            self.selected_range = end..end;
            self.marked_range = None;
            cx.notify();
        }
    }
}

impl Focusable for TextInput {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

pub struct Changed(pub String);
impl EventEmitter<Changed> for TextInput {}

pub fn init(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("backspace", Backspace, Some("TextInput")),
        KeyBinding::new("delete", Delete, Some("TextInput")),
        KeyBinding::new("left", Left, Some("TextInput")),
        KeyBinding::new("right", Right, Some("TextInput")),
        KeyBinding::new("shift-left", SelectLeft, Some("TextInput")),
        KeyBinding::new("shift-right", SelectRight, Some("TextInput")),
        KeyBinding::new("ctrl-a", SelectAll, Some("TextInput")),
        KeyBinding::new("ctrl-v", Paste, Some("TextInput")),
        KeyBinding::new("ctrl-c", Copy, Some("TextInput")),
        KeyBinding::new("ctrl-x", Cut, Some("TextInput")),
        KeyBinding::new("home", Home, Some("TextInput")),
        KeyBinding::new("end", End, Some("TextInput")),
    ]);
}
