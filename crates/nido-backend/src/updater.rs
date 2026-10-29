use crate::{
    files::digest,
    rpc::{Event, command},
};
use anyhow::{Context, Result, bail};
use nido_core::persistence::write_json;
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
    sync::{Arc, mpsc::Sender},
    time::Duration,
};

pub fn run(
    action: &str,
    data: &Path,
    events: Sender<Event>,
    repaint: Arc<dyn Fn() + Send + Sync>,
) -> Result<()> {
    let publish = |value: Value| {
        let _ = events.send(Event::Result(String::new(), "update".into(), value));
        repaint();
    };
    let client = reqwest::blocking::Client::builder()
        .user_agent(concat!("Nido/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(180))
        .build()?;
    let metadata = data.join("update.json");
    if action == "check" {
        publish(json!({"status":"checking"}));
        let release: Value = client
            .get("https://api.github.com/repos/kanata9819/Nido/releases/latest")
            .send()?
            .error_for_status()?
            .json()?;
        let version = release["tag_name"]
            .as_str()
            .context("Release version missing")?
            .trim_start_matches('v');
        let newer = version_parts(version) > version_parts(env!("CARGO_PKG_VERSION"));
        let name = format!("nido-{version}-setup.exe");
        let asset = release["assets"]
            .as_array()
            .and_then(|a| a.iter().find(|a| a["name"] == name))
            .cloned();
        let checksum = release["assets"]
            .as_array()
            .and_then(|a| a.iter().find(|a| a["name"] == format!("{name}.sha256")))
            .cloned();
        if newer && asset.is_some() && checksum.is_some() {
            let state =
                json!({"status":"available","version":version,"asset":asset,"checksum":checksum});
            write_json(&metadata, &state)?;
            publish(state);
        } else {
            publish(json!({"status":"current","version":env!("CARGO_PKG_VERSION")}));
        }
    } else if action == "download" {
        let state: Value = serde_json::from_slice(&fs::read(&metadata)?)?;
        let url = validated_url(&state["asset"]["browser_download_url"])?;
        let checksum_url = validated_url(&state["checksum"]["browser_download_url"])?;
        let checksum = client
            .get(checksum_url)
            .send()?
            .error_for_status()?
            .text()?;
        let expected = checksum
            .split_whitespace()
            .next()
            .context("Missing installer checksum")?;
        if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
            bail!("Invalid installer checksum")
        }
        let mut response = client.get(url).send()?.error_for_status()?;
        let size = response.content_length().unwrap_or(0);
        if size > 1024 * 1024 * 1024 {
            bail!("Installer is too large")
        }
        let folder = data.join("updates");
        fs::create_dir_all(&folder)?;
        let path = folder.join("nido-setup.exe.download");
        let mut file = fs::File::create(&path)?;
        let mut buffer = [0u8; 65536];
        let mut total = 0;
        loop {
            let count = response.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            total += count as u64;
            if total > 1024 * 1024 * 1024 {
                bail!("Installer exceeds size limit")
            }
            file.write_all(&buffer[..count])?;
            publish(
                json!({"status":"downloading","percent":if size>0{total as f64*100.0/size as f64}else{0.0}}),
            );
        }
        file.sync_all()?;
        drop(file);
        if digest(&fs::read(&path)?) != expected.to_lowercase() {
            fs::remove_file(&path)?;
            bail!("Installer checksum does not match")
        }
        let final_path = folder.join("nido-setup.exe");
        fs::rename(path, &final_path)?;
        write_json(
            &metadata,
            &json!({"status":"downloaded","version":state["version"],"sha256":expected.to_lowercase()}),
        )?;
        publish(json!({"status":"downloaded","version":state["version"]}));
    } else if action == "install" {
        install(data)?;
        publish(json!({"status":"installing"}));
    } else {
        bail!("Unknown update action")
    }
    Ok(())
}
pub fn install(data: &Path) -> Result<()> {
    let state: Value = serde_json::from_slice(&fs::read(data.join("update.json"))?)?;
    let path = data.join("updates/nido-setup.exe");
    if state["status"] != "downloaded"
        || state["sha256"].as_str() != Some(digest(&fs::read(&path)?).as_str())
    {
        bail!("Download and verify the installer first")
    }
    command(path).spawn()?;
    Ok(())
}
fn validated_url(value: &Value) -> Result<&str> {
    let url = value.as_str().context("Missing release URL")?;
    if !url.starts_with("https://github.com/kanata9819/Nido/releases/download/") {
        bail!("Invalid release download URL")
    }
    Ok(url)
}
fn version_parts(value: &str) -> Vec<u64> {
    value
        .split('.')
        .take(3)
        .map(|n| n.parse().unwrap_or(0))
        .collect()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn update_links_cannot_run_untrusted_installers() {
        assert!(validated_url(&json!("file:///evil.exe")).is_err());
        assert!(version_parts("0.10.0") > version_parts("0.9.9"));
    }
}
