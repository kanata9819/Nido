use super::*;

pub(super) fn check(project: &Path) -> Result<()> {
    nido_backend::git::run(project, &["init", "-q"])?;
    nido_backend::git::run(project, &["config", "user.name", "Nido native test"])?;
    nido_backend::git::run(
        project,
        &["config", "user.email", "native-test@example.invalid"],
    )?;
    nido_backend::git::run(project, &["config", "commit.gpgsign", "false"])?;
    ensure!(
        nido_backend::git::action(project, "diff", &json!(["README.md", false]))?
            .as_str()
            .is_some_and(|s| s.contains("+# Nido")),
        "Untracked Git diff is empty"
    );
    nido_backend::git::action(project, "stage", &json!(["README.md", true]))?;
    ensure!(
        array(&nido_backend::git::action(project, "status", &json!([]))?["changes"])
            .iter()
            .any(|v| v["path"] == "README.md" && v["staged"] == true),
        "Git staging failed"
    );
    nido_backend::git::action(project, "stage", &json!(["README.md", false]))?;
    nido_backend::git::action(project, "stageAll", &json!([]))?;
    nido_backend::git::action(project, "commit", &json!(["Native smoke fixture"]))?;
    ensure!(
        array(
            &nido_backend::git::action(&project.join("folder"), "history", &json!([0]))?["commits"]
        )
        .len()
            == 1,
        "Git history from a subfolder failed"
    );
    nido_backend::git::action(project, "switch", &json!(["native-check", true]))?;
    println!(
        "PASS: Git untracked diff, unborn staging/unstaging, commit, branch and history from a subfolder"
    );
    Ok(())
}
