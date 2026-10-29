// GPUI 0.2.2 has no accessibility tree; retain Windows UI Automation through AccessKit.
use accesskit::{
    ActionHandler, ActionRequest, ActivationHandler, Node, NodeId, Role, Tree, TreeId, TreeUpdate,
};
use accesskit_windows::SubclassingAdapter;
use gpui::{Bounds, Pixels, Window};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    hash::{Hash, Hasher},
    sync::{Arc, Mutex},
};
use windows::Win32::{
    Foundation::HWND,
    UI::WindowsAndMessaging::{SW_SHOW, ShowWindow},
};

pub fn id(name: &str) -> NodeId {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    name.hash(&mut hash);
    NodeId(hash.finish().max(2))
}

struct Snapshot(Arc<Mutex<TreeUpdate>>);
impl ActivationHandler for Snapshot {
    fn request_initial_tree(&mut self) -> Option<TreeUpdate> {
        Some(self.0.lock().unwrap().clone())
    }
}
struct Actions {
    pending: Arc<Mutex<Vec<ActionRequest>>>,
    wake: Arc<dyn Fn() + Send + Sync>,
}
impl ActionHandler for Actions {
    fn do_action(&mut self, request: ActionRequest) {
        self.pending.lock().unwrap().push(request);
        (self.wake)();
    }
}

pub struct Accessibility {
    adapter: SubclassingAdapter,
    snapshot: Arc<Mutex<TreeUpdate>>,
    pending: Arc<Mutex<Vec<ActionRequest>>>,
    nodes: RefCell<BTreeMap<NodeId, Node>>,
    hwnd: HWND,
}
impl Accessibility {
    pub fn new(window: &Window, wake: Arc<dyn Fn() + Send + Sync>) -> Self {
        let RawWindowHandle::Win32(handle) =
            HasWindowHandle::window_handle(window).unwrap().as_raw()
        else {
            unreachable!("Windows application requires a Win32 window")
        };
        let hwnd = HWND(handle.hwnd.get() as *mut _);
        let mut root = Node::new(Role::Window);
        root.set_label("Nido");
        let snapshot = Arc::new(Mutex::new(TreeUpdate {
            nodes: vec![(NodeId(1), root)],
            tree: Some(Tree::new(NodeId(1))),
            tree_id: TreeId::ROOT,
            focus: NodeId(1),
        }));
        let pending = Arc::new(Mutex::new(vec![]));
        let adapter = SubclassingAdapter::new(
            hwnd,
            Snapshot(snapshot.clone()),
            Actions {
                pending: pending.clone(),
                wake,
            },
        );
        Self {
            adapter,
            snapshot,
            pending,
            nodes: RefCell::new(BTreeMap::new()),
            hwnd,
        }
    }
    pub fn show(&self) {
        // The adapter must be installed before the first ShowWindow/SetFocus.
        unsafe {
            let _ = ShowWindow(self.hwnd, SW_SHOW);
        }
    }
    pub fn clear(&self) {
        self.nodes.borrow_mut().clear();
    }
    pub fn insert(&self, key: &str, node: Node) {
        self.nodes.borrow_mut().insert(id(key), node);
    }
    pub fn label(&self, key: &str, label: &str) {
        if let Some(node) = self.nodes.borrow_mut().get_mut(&id(key)) {
            node.set_label(label);
        }
    }
    pub fn bounds(&self, key: &str, bounds: Bounds<Pixels>, scale: f32) {
        if let Some(node) = self.nodes.borrow_mut().get_mut(&id(key)) {
            node.set_bounds(accesskit::Rect::new(
                f64::from(f32::from(bounds.left()) * scale),
                f64::from(f32::from(bounds.top()) * scale),
                f64::from(f32::from(bounds.right()) * scale),
                f64::from(f32::from(bounds.bottom()) * scale),
            ));
        }
    }
    pub fn take_actions(&self) -> Vec<ActionRequest> {
        std::mem::take(&mut *self.pending.lock().unwrap())
    }
    pub fn has_label(&self, label: &str) -> bool {
        self.snapshot
            .lock()
            .unwrap()
            .nodes
            .iter()
            .any(|(_, node)| node.label() == Some(label))
    }
    pub fn publish(&mut self, focus: Option<NodeId>) {
        let nodes = self.nodes.borrow();
        let mut root = Node::new(Role::Window);
        root.set_label("Nido");
        let mut children = nodes.keys().copied().collect::<Vec<_>>();
        children.sort_by(|a, b| {
            let a = nodes[a].bounds().unwrap_or_default();
            let b = nodes[b].bounds().unwrap_or_default();
            a.y0.total_cmp(&b.y0).then(a.x0.total_cmp(&b.x0))
        });
        root.set_children(children);
        let update = TreeUpdate {
            nodes: std::iter::once((NodeId(1), root))
                .chain(nodes.iter().map(|(id, node)| (*id, node.clone())))
                .collect(),
            tree: Some(Tree::new(NodeId(1))),
            tree_id: TreeId::ROOT,
            focus: focus
                .filter(|id| nodes.contains_key(id))
                .unwrap_or(NodeId(1)),
        };
        let mut snapshot = self.snapshot.lock().unwrap();
        if *snapshot == update {
            return;
        }
        *snapshot = update.clone();
        drop(snapshot);
        if let Some(events) = self.adapter.update_if_active(|| update) {
            events.raise();
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn stable_ids_do_not_reuse_the_root() {
        assert_eq!(super::id("search"), super::id("search"));
        assert_ne!(super::id("search"), super::id("editor"));
        assert!(super::id("search").0 > 1);
    }
}
