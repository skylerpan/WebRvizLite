//! Serves mesh resources for MESH_RESOURCE markers and RobotModel
//! (spec §7.4): `package://pkg/path` is resolved through the ament index
//! (`AMENT_PREFIX_PATH/share/pkg`), `file://` paths are allowed only inside a
//! ROS package share directory. `http(s)://` is fetched by the browser directly.

use std::path::{Path, PathBuf};

use axum::extract::{Query, State};

use crate::AppState;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

#[derive(Deserialize)]
pub struct MeshQuery {
    pub uri: String,
}

fn ament_prefixes() -> Vec<PathBuf> {
    std::env::var("AMENT_PREFIX_PATH")
        .unwrap_or_default()
        .split(':')
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .collect()
}

/// `package://pkg/rel` → the configured `--package-path` root for `pkg`, else the
/// first `<prefix>/share/pkg/rel` that exists.
fn resolve_package(rest: &str, extra: &[(String, PathBuf)]) -> Option<PathBuf> {
    let (pkg, rel) = rest.split_once('/')?;
    if let Some((_, dir)) = extra.iter().find(|(n, _)| n == pkg) {
        let p = dir.join(rel);
        return p.is_file().then_some(p);
    }
    ament_prefixes()
        .into_iter()
        .map(|p| p.join("share").join(pkg).join(rel))
        .find(|p| p.is_file())
}

/// A file is served only when it lives under some `<prefix>/share/` or a `--package-path` root.
fn allowed(path: &Path, extra: &[(String, PathBuf)]) -> bool {
    let Ok(canon) = path.canonicalize() else {
        return false;
    };
    let prefixes = ament_prefixes();
    let mut roots = prefixes
        .iter()
        .map(|p| p.join("share"))
        .chain(extra.iter().map(|(_, d)| d.clone()));
    roots.any(|root| {
        root.canonicalize()
            .map(|s| canon.starts_with(s))
            .unwrap_or(false)
    })
}

pub async fn handler(State(state): State<AppState>, Query(q): Query<MeshQuery>) -> Response {
    let extra = &state.package_paths;
    let path = if let Some(rest) = q.uri.strip_prefix("package://") {
        resolve_package(rest, extra)
    } else if let Some(rest) = q.uri.strip_prefix("file://") {
        Some(PathBuf::from(rest))
    } else {
        return (
            StatusCode::BAD_REQUEST,
            "only package:// and file:// URIs are served here",
        )
            .into_response();
    };
    let Some(path) = path else {
        return (StatusCode::NOT_FOUND, format!("cannot resolve {}", q.uri)).into_response();
    };
    if !allowed(&path, extra) {
        return (
            StatusCode::FORBIDDEN,
            "mesh path is outside every ROS package share directory",
        )
            .into_response();
    }
    match tokio::fs::read(&path).await {
        Ok(bytes) => {
            let mime = mime_guess::from_path(&path).first_or_octet_stream();
            ([(header::CONTENT_TYPE, mime.as_ref().to_string())], bytes).into_response()
        }
        Err(e) => (
            StatusCode::NOT_FOUND,
            format!("cannot read {}: {e}", path.display()),
        )
            .into_response(),
    }
}
