#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#[cfg(windows)]
mod accessibility;
mod app;
mod assets;
mod grid;
mod smoke;
mod text_input;

fn main() -> anyhow::Result<()> {
    if std::env::args().any(|arg| arg == "--version") {
        println!("Nido {} (Rust)", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    if std::env::args().any(|arg| arg == "--smoke-test") {
        if let Err(error) = smoke::run() {
            eprintln!("{error:#}");
            std::process::exit(1);
        }
        return Ok(());
    }
    if std::env::args().any(|arg| arg == "--ui-smoke-test") {
        return app::verify_gui();
    }
    app::run()
}
