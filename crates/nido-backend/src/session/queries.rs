use super::*;

type ReplacementState = Arc<Mutex<Option<files::Replacement>>>;

pub(super) fn read_worker(
    session: &Session,
    events: Sender<Event>,
    repaint: Arc<dyn Fn() + Send + Sync>,
) -> (Sender<Action>, ReplacementState) {
    let (tx, rx) = std::sync::mpsc::channel::<Action>();
    let root = session.root.clone();
    let id = session.id.clone();
    let replacement: ReplacementState = Arc::default();
    let preview = replacement.clone();
    // File scans and Git hooks must never hold up Neovim input.
    thread::spawn(move || {
        let mut search: Option<files::Search> = None;
        while let Ok(first) = rx.recv() {
            let mut jobs = VecDeque::from([first]);
            jobs.extend(rx.try_iter());
            while let Some(action) = jobs.pop_front() {
                if ["findFiles", "search"].contains(&action.name.as_str())
                    && jobs.iter().any(|next| next.name == action.name)
                {
                    continue;
                }
                let a = &action.args;
                let text = |index: usize| a[index].as_str().unwrap_or_default();
                let result = (|| -> Result<Value> {
                    match action.name.as_str() {
                        "findFiles" => {
                            let query = text(0).to_lowercase();
                            Ok(json!(files::walk(&root, "")?.iter().filter_map(|path| {
                                let name = paths::relative(&root, path);
                                fuzzy(&name.to_lowercase(), &query).then(|| json!({"path":name,"name":path.file_name().unwrap_or_default().to_string_lossy()}))
                            }).take(500).collect::<Vec<_>>()))
                        }
                        "search" => {
                            search = None;
                            *preview.lock().unwrap() = None;
                            let result = files::search(&root, text(0), a[1].clone())?;
                            let value = json!({"matches":result.matches,"truncated":result.matches.len()>200,"token":result.token,"query":result.query,"options":result.options});
                            search = Some(result);
                            *preview.lock().unwrap() = None;
                            Ok(value)
                        }
                        "previewReplacement" => {
                            let selected: Vec<usize> = a[2]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .filter_map(|v| v.as_u64().map(|v| v as usize))
                                .collect();
                            let result = search.as_ref().context("Search again")?.preview(
                                &root,
                                text(0),
                                text(1),
                                &selected,
                            )?;
                            let value = json!({"token":result.token,"searchToken":a[0],"replacement":a[1],"files":result.files.iter().map(|(p,b,a,c)|json!({"path":p,"before":b,"after":a,"count":c})).collect::<Vec<_>>()});
                            *preview.lock().unwrap() = Some(result);
                            Ok(value)
                        }
                        "git" => git::action(&root, text(0), &a[1]),
                        _ => bail!("Unknown workspace job"),
                    }
                })();
                let _ = events.send(match result {
                    Ok(value) => Event::Result(id.clone(), action.tag, value),
                    Err(error) => Event::Error(format!("{}: {error:#}", action.name)),
                });
                repaint();
            }
        }
    });
    (tx, replacement)
}

fn fuzzy(value: &str, query: &str) -> bool {
    let mut chars = value.chars();
    query
        .chars()
        .all(|needle| chars.by_ref().any(|c| c == needle))
}
