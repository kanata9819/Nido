#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod app;
mod backend;
mod files;
mod git;
mod grid;
mod history;
mod packs;
mod persistence;
mod platform;
mod rpc;
mod settings;
mod smoke;
mod updater;
mod wsl;

fn main() -> eframe::Result {
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
    let saved = persistence::read_layout(&persistence::data_dir().join("workspaces.json"))
        .unwrap_or_default();
    let width = saved.window["width"].as_f64().unwrap_or(1440.0) as f32;
    let height = saved.window["height"].as_f64().unwrap_or(940.0) as f32;
    let options = eframe::NativeOptions {
        viewport: eframe::egui::ViewportBuilder::default()
            .with_title("Nido")
            .with_app_id("com.kanata9819.nido")
            .with_icon(
                eframe::icon_data::from_png_bytes(include_bytes!("../build/icon.png"))
                    .expect("Bundled icon"),
            )
            .with_transparent(true)
            .with_inner_size([width.clamp(850.0, 3840.0), height.clamp(560.0, 2160.0)])
            .with_min_inner_size([700.0, 420.0])
            .with_maximized(saved.window["maximized"] == true),
        renderer: eframe::Renderer::Glow,
        ..Default::default()
    };
    eframe::run_native(
        "nido",
        options,
        Box::new(|cc| Ok(Box::new(app::Nido::new(cc)))),
    )
}
