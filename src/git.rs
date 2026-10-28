use crate::{
    rpc::command,
    wsl::{Remote, output},
};
use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::path::{Component, Path, PathBuf};

pub fn run(root: &Path, args: &[&str]) -> Result<String> {
    let mut c = if let Some(remote) = Remote::parse(root) {
        remote.command("git", &[])
    } else {
        let mut c = command("git");
        c.current_dir(root);
        c
    };
    c.args([
        "--no-optional-locks",
        "-c",
        "core.quotepath=false",
        "-c",
        "color.ui=false",
    ])
    .args(args);
    output(c)
}
fn hash(value: &str) -> Result<()> {
    if ![40, 64].contains(&value.len()) || !value.bytes().all(|c| c.is_ascii_hexdigit()) {
        bail!("Invalid commit hash")
    }
    Ok(())
}
fn path(value: &str) -> Result<()> {
    if value.is_empty()
        || Path::new(value)
            .components()
            .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
        || value
            .split(['/', '\\'])
            .any(|p| p == ".." || p.eq_ignore_ascii_case(".git"))
    {
        bail!("Invalid Git path")
    }
    Ok(())
}
pub fn repository(root: &Path) -> Result<PathBuf> {
    let name = run(root, &["rev-parse", "--show-toplevel"])?;
    Ok(Remote::parse(root)
        .map(|r| r.host(&name))
        .unwrap_or_else(|| PathBuf::from(name)))
}

pub fn action(root: &Path, action: &str, args: &Value) -> Result<Value> {
    let repository = repository(root)?;
    let root = &repository;
    let string = |index: usize| args[index].as_str().unwrap_or_default();
    match action {
        "status" => {
            let actual = run(root, &["rev-parse", "--show-toplevel"])?;
            let branch = run(root, &["branch", "--show-current"])?;
            let output = run(
                root,
                &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            )?;
            Ok(json!({"root": actual, "branch": branch, "changes": parse_status(&output)}))
        }
        "diff" => {
            path(string(0))?;
            let staged = args[1].as_bool().unwrap_or(false);
            let mut argv = vec!["diff", "--no-ext-diff", "--no-textconv"];
            if staged {
                argv.push("--cached");
            }
            argv.extend(["--", string(0)]);
            let mut diff = run(root, &argv)?;
            if diff.is_empty()
                && !staged
                && run(root, &["ls-files", "--error-unmatch", "--", string(0)]).is_err()
            {
                let file = crate::files::inside(root, string(0), false)?;
                diff = match crate::files::text(&file) {
                    Ok(text) => similar::TextDiff::from_lines("", &text)
                        .unified_diff()
                        .header("/dev/null", &format!("b/{}", string(0)))
                        .to_string(),
                    Err(_) => "Binary file or text file over 1 MB".into(),
                };
            }
            Ok(json!(diff))
        }
        "stage" => {
            path(string(0))?;
            if args[1].as_bool().unwrap_or(false) {
                run(root, &["add", "--", string(0)])?;
            } else if run(root, &["rev-parse", "--verify", "HEAD"]).is_ok() {
                run(root, &["restore", "--staged", "--", string(0)])?;
            } else {
                run(root, &["rm", "--cached", "--", string(0)])?;
            }
            Ok(Value::Null)
        }
        "stageAll" => Ok(json!(run(root, &["add", "--all", "--", "."])?)),
        "commit" => {
            let message = string(0);
            if message.trim().is_empty() || message.len() > 10000 {
                bail!("Enter a commit message")
            }
            Ok(json!(run(root, &["commit", "-m", message])?))
        }
        "branches" => {
            let text = run(
                root,
                &[
                    "for-each-ref",
                    "--format=%(refname:short)%00%(HEAD)%00%(objectname)%00%(upstream:short)",
                    "refs/heads",
                    "refs/remotes",
                ],
            )?;
            Ok(json!(text.lines().filter_map(|line| { let fields:Vec<_> = line.split('\0').collect(); if fields.len()<4 { return None } Some(json!({"name":fields[0], "current":fields[1]=="*", "hash":fields[2], "upstream":fields[3]})) }).collect::<Vec<_>>()))
        }
        "switch" => {
            let name = string(0);
            if name.is_empty() || name.starts_with('-') || name.len() > 1000 {
                bail!("Invalid branch name")
            }
            run(root, &["check-ref-format", "--branch", name])?;
            let remote = run(
                root,
                &[
                    "show-ref",
                    "--verify",
                    "--quiet",
                    &format!("refs/remotes/{name}"),
                ],
            )
            .is_ok();
            let argv = if args[1].as_bool().unwrap_or(false) {
                vec!["switch", "-c", name]
            } else if remote {
                vec!["switch", "--track", name]
            } else {
                vec!["switch", name]
            };
            Ok(json!(run(root, &argv)?))
        }
        "history" => {
            let skip = args[0].as_u64().unwrap_or(0).min(1_000_000).to_string();
            if run(root, &["rev-parse", "--verify", "HEAD"]).is_err() {
                return Ok(json!({"commits":[],"total":0,"skip":0}));
            }
            let text = run(
                root,
                &[
                    "log",
                    "-50",
                    "--skip",
                    &skip,
                    "--format=%H%x00%s%x00%an%x00%aI%x00",
                ],
            )?;
            let fields: Vec<_> = text.split('\0').collect();
            let commits: Vec<_> = fields
                .chunks(4)
                .filter(|c| c.len() == 4)
                .map(|f| json!({"hash":f[0].trim(),"message":f[1],"author":f[2],"date":f[3]}))
                .collect();
            Ok(
                json!({"commits":commits, "skip":skip.parse::<usize>().unwrap_or(0), "total":run(root,&["rev-list","--count","HEAD"])?.parse::<usize>().unwrap_or(0)}),
            )
        }
        "commitFiles" => {
            hash(string(0))?;
            Ok(json!(
                run(
                    root,
                    &[
                        "diff-tree",
                        "--root",
                        "--no-commit-id",
                        "--name-only",
                        "-r",
                        "-z",
                        string(0)
                    ]
                )?
                .split('\0')
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
            ))
        }
        "commitDiff" => {
            hash(string(0))?;
            path(string(1))?;
            Ok(json!(run(
                root,
                &[
                    "show",
                    "--format=fuller",
                    "--no-ext-diff",
                    "--no-textconv",
                    string(0),
                    "--",
                    string(1)
                ]
            )?))
        }
        _ => bail!("Unknown Git command"),
    }
}

fn parse_status(output: &str) -> Vec<Value> {
    let mut parts = output.split('\0');
    let mut changes = vec![];
    while let Some(item) = parts.next() {
        if item.len() < 4 {
            continue;
        }
        let bytes = item.as_bytes();
        let name = &item[3..];
        let original = if bytes[..2].iter().any(|b| *b == b'R' || *b == b'C') {
            parts.next()
        } else {
            None
        };
        if bytes[0] == b'?' {
            changes.push(json!({"path":name,"status":"?","staged":false}));
            continue;
        }
        for (code, staged) in [(bytes[0], true), (bytes[1], false)] {
            if code != b' ' {
                changes.push(json!({"path":name,"original":original,"status":(code as char).to_string(),"staged":staged}));
            }
        }
    }
    changes
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_rename_and_dual_status_without_losing_paths() {
        let result = parse_status("R  新.txt\0old.txt\0MM both.txt\0?? new.txt\0");
        assert_eq!(result.len(), 4);
        assert_eq!(result[0]["original"], "old.txt");
        assert_eq!(result[2]["staged"], false);
        assert!(hash("--help").is_err());
        assert!(path("../private").is_err());
    }
}
