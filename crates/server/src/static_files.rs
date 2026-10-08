//! Frontend static files: embedded `web/dist` by default, or a directory on
//! disk when `--web-dir` is given. Unknown paths fall back to `index.html`.

use std::path::PathBuf;

use axum::{
    body::Body,
    extract::Request,
    http::{StatusCode, Uri, header},
    response::{IntoResponse, Response},
};
use tower_http::services::{ServeDir, ServeFile};

#[derive(rust_embed::Embed)]
#[folder = "../../web/dist"]
struct Dist;

pub fn handler(web_dir: Option<PathBuf>) -> axum::routing::MethodRouter {
    match web_dir {
        Some(dir) => {
            let index = dir.join("index.html");
            let svc = ServeDir::new(dir).fallback(ServeFile::new(index));
            axum::routing::get_service(svc)
        }
        None => axum::routing::get(embedded),
    }
}

async fn embedded(uri: Uri, _req: Request) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    match Dist::get(path).or_else(|| Dist::get("index.html")) {
        Some(file) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            (
                [(header::CONTENT_TYPE, mime.as_ref())],
                Body::from(file.data.into_owned()),
            )
                .into_response()
        }
        None => (
            StatusCode::NOT_FOUND,
            "frontend not built: run `make web` or pass --web-dir",
        )
            .into_response(),
    }
}
