// rust-embed needs the folder to exist at compile time; `cargo test --workspace`
// on a fresh checkout runs before the web build, so create it empty.
fn main() {
    let dist = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web/dist");
    let _ = std::fs::create_dir_all(&dist);
    println!("cargo:rerun-if-changed=../../web/dist");
}
