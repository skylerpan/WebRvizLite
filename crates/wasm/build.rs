// Stamps the git revision into the WASM module's `version()` (see server/build.rs).
fn main() {
    emit_build_version();
}

/// `<CARGO_PKG_VERSION>+g<short sha>[.dirty]` for development builds; the bare
/// package version when the source is not a git checkout (release tarballs,
/// Docker contexts without `.git`).
fn build_version() -> String {
    use std::process::Command;
    let pkg = env!("CARGO_PKG_VERSION").to_string();
    let git = |args: &[&str]| {
        Command::new("git")
            .args(args)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    };
    let Some(sha) = git(&["rev-parse", "--short=9", "HEAD"]) else {
        return pkg;
    };
    let dirty =
        git(&["status", "--porcelain", "--untracked-files=no"]).is_some_and(|s| !s.is_empty());
    format!("{pkg}+g{sha}{}", if dirty { ".dirty" } else { "" })
}

fn emit_build_version() {
    println!("cargo:rustc-env=WRL_BUILD_VERSION={}", build_version());
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    for f in ["HEAD", "index"] {
        println!(
            "cargo:rerun-if-changed={}",
            root.join(".git").join(f).display()
        );
    }
}
