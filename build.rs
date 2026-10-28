fn main() {
    println!("cargo:rerun-if-changed=build/icon.ico");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        winresource::WindowsResource::new()
            .set_icon("build/icon.ico")
            .set("ProductName", "Nido")
            .set("FileDescription", "Nido Neovim desktop editor")
            .set("OriginalFilename", "nido.exe")
            .compile()
            .expect("Unable to embed Windows icon and version");
    }
}
