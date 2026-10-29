use super::*;
use crate::text_input::{self, Changed, TextInput};
use gpui::{prelude::*, *};
#[cfg(windows)]
use std::collections::HashSet;
use std::{cell::RefCell, ops::Range, path::Path, rc::Rc};

#[cfg(windows)]
type AccessibleAction =
    Rc<dyn Fn(&mut Nido, &accesskit::ActionRequest, &mut Window, &mut Context<Nido>)>;
type UiAction = Rc<dyn Fn(&mut Nido, &mut Window, &mut Context<Nido>)>;

mod grid_view;
use grid_view::GridCache;

pub(super) struct Nido {
    model: Model,
    focus: FocusHandle,
    inputs: HashMap<&'static str, Entity<TextInput>>,
    grids: HashMap<String, GridCache>,
    tree_scroll: UniformListScrollHandle,
    palette_scroll: UniformListScrollHandle,
    palette_position: Option<(u64, usize)>,
    context_entry: Option<(String, Value)>,
    control_focus: RefCell<HashMap<SharedString, FocusHandle>>,
    #[cfg(windows)]
    accessibility: crate::accessibility::Accessibility,
    #[cfg(windows)]
    accessible_actions: RefCell<HashMap<accesskit::NodeId, AccessibleAction>>,
    #[cfg(windows)]
    accessible_fields: RefCell<HashSet<&'static str>>,
    resize_sidebar: bool,
    resize_terminal: bool,
    terminal_height: f32,
    started: Instant,
    painted: u64,
    acrylic: Option<bool>,
    font_setting: String,
    font_family: String,
}

mod accessibility;
mod checks;
mod chrome;
mod controls;
mod documents;
mod editor;
mod explorer;
mod fields;
mod input;
mod layout;
mod overlays;
mod panels;
mod window;
pub use checks::verify_gui;
use controls::{column, file_icon, icon, kbd, row};
use documents::{diff, markdown};
pub use window::run;
