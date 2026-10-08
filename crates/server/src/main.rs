//! WebRvizLite server: serves the built frontend and bridges ROS 2 to the
//! browser over one WebSocket per client (binary CDR frames + JSON control).

mod cli;
mod hub;
mod mesh;
mod session;
mod static_files;
#[cfg(feature = "webtransport")]
mod wt;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{State, ws::WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Router, routing::get};
use clap::Parser;
use tokio::sync::broadcast;
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;
use webrvizlite_bridge::Transport;
use webrvizlite_core::protocol::{ServerMessage, TopicInfo};

#[derive(Clone)]
pub struct AppState {
    pub hub: Arc<hub::Hub>,
    pub topics: Arc<Mutex<Vec<TopicInfo>>>,
    pub topics_tx: session::TopicsTx,
    pub mock: bool,
    pub display_config: Option<PathBuf>,
    pub fixed_frame: Option<String>,
    /// `package://NAME` roots served by /api/mesh in addition to the ament index.
    pub package_paths: Arc<Vec<(String, PathBuf)>>,
    /// WebTransport endpoint, when it could be opened.
    #[cfg(feature = "webtransport")]
    pub wt: Option<wt::WtInfo>,
    #[cfg(feature = "webtransport")]
    pub wt_pending: wt::Pending,
    session_counter: Arc<AtomicU64>,
}

impl AppState {
    /// Hello for one session; `token` identifies its WebTransport connection.
    fn hello(&self, token: &str) -> ServerMessage {
        let t = self.hub.transport();
        #[cfg(feature = "webtransport")]
        let wt = self
            .wt
            .as_ref()
            .map(|w| webrvizlite_core::protocol::WtHello {
                port: w.port,
                cert_sha256_hex: w.cert_sha256_hex.clone(),
                token: token.into(),
            });
        #[cfg(not(feature = "webtransport"))]
        let wt = {
            let _ = token;
            None
        };
        ServerMessage::Hello {
            version: env!("CARGO_PKG_VERSION").into(),
            ros_distro: t.ros_distro(),
            mock: self.mock,
            use_sim_time: t.use_sim_time(),
            display_config: self
                .display_config
                .as_ref()
                .map(|p| p.display().to_string()),
            fixed_frame: self.fixed_frame.clone(),
            wt,
        }
    }

    fn next_session_id(&self) -> u64 {
        self.session_counter.fetch_add(1, Ordering::Relaxed)
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,tower_http=warn".into()),
        )
        .init();

    let args = cli::Args::parse();
    if args.fullscreen {
        tracing::warn!(
            "--fullscreen is accepted for RViz compatibility but has no effect in a browser"
        );
    }

    let transport: Arc<dyn Transport> = if args.mock {
        tracing::info!("using mock transport (no ROS): /scan, /tf, /tf_static, /clock");
        webrvizlite_bridge::mock::MockTransport::new()
    } else {
        #[cfg(feature = "r2r")]
        {
            let t = webrvizlite_bridge::r2r_transport::R2rTransport::new()?;
            tracing::info!(distro = ?t.ros_distro(), use_sim_time = t.use_sim_time(), "ROS 2 node 'webrvizlite' started");
            t
        }
        #[cfg(not(feature = "r2r"))]
        {
            return Err("this binary was built without ROS 2 support (feature `r2r`); run with --mock, or build inside a sourced ROS 2 environment with `cargo build --features r2r`".into());
        }
    };

    let mut package_paths: Vec<(String, PathBuf)> = Vec::new();
    for spec in &args.package_paths {
        match spec.split_once('=') {
            Some((name, dir)) if !name.is_empty() => {
                package_paths.push((name.into(), PathBuf::from(dir)))
            }
            _ => return Err(format!("--package-path expects NAME=DIR, got {spec:?}").into()),
        }
    }
    if args.mock {
        let fixtures = std::env::current_dir()?.join("fixtures");
        if fixtures.is_dir() {
            package_paths.push(("webrvizlite_fixtures".into(), fixtures));
        }
    }
    for (name, dir) in &package_paths {
        tracing::info!(package = name, dir = %dir.display(), "serving package:// meshes");
    }

    #[cfg(feature = "webtransport")]
    let wt_pending = wt::new_pending();
    #[cfg(feature = "webtransport")]
    let wt_info = if args.no_webtransport {
        None
    } else {
        match wt::start(&args.bind, args.port, wt_pending.clone()) {
            Ok(info) => {
                tracing::info!(port = info.port, cert_sha256 = %info.cert_sha256_hex, "WebTransport endpoint ready (UDP)");
                Some(info)
            }
            Err(e) => {
                tracing::warn!("WebTransport disabled: {e}");
                None
            }
        }
    };

    let (topics_tx, _) = broadcast::channel(16);
    let state = AppState {
        hub: hub::Hub::new(transport),
        topics: Arc::new(Mutex::new(Vec::new())),
        topics_tx,
        mock: args.mock,
        display_config: args.display_config.clone(),
        fixed_frame: args.fixed_frame.clone(),
        package_paths: Arc::new(package_paths),
        #[cfg(feature = "webtransport")]
        wt: wt_info,
        #[cfg(feature = "webtransport")]
        wt_pending,
        session_counter: Arc::new(AtomicU64::new(1)),
    };
    state.refresh_topics().await;
    tokio::spawn(session::topic_watcher(
        state.clone(),
        Duration::from_secs(1),
    ));

    let app = Router::new()
        .route("/api/health", get(|| async { "ok" }))
        .route(
            "/api/display-config",
            get(display_config).post(save_display_config),
        )
        .route("/api/mesh", get(mesh::handler))
        .route("/ws", get(ws_upgrade))
        .with_state(state)
        .fallback(static_files::handler(args.web_dir.clone()))
        .layer(TraceLayer::new_for_http());

    let addr: SocketAddr = format!("{}:{}", args.bind, args.port).parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(
        "WebRvizLite listening on http://{}/",
        listener.local_addr()?
    );
    tokio::select! {
        r = axum::serve(listener, app) => r?,
        () = shutdown_signal() => tracing::info!("shutdown signal received"),
    }
    // Returning ends the process (r2r spin thread, sessions, ROS subscriptions);
    // browsers reconnect on their own. A graceful shutdown would wait for the
    // long-lived WebSockets and never finish.
    Ok(())
}

/// Resolves on Ctrl+C or, on Unix, SIGTERM (`docker stop`).
async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(e) = tokio::signal::ctrl_c().await {
            tracing::error!(%e, "failed to install Ctrl+C handler");
            std::future::pending::<()>().await;
        }
    };
    #[cfg(unix)]
    let terminate = async {
        use tokio::signal::unix::{SignalKind, signal};
        match signal(SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(e) => {
                tracing::error!(%e, "failed to install SIGTERM handler");
                std::future::pending::<()>().await;
            }
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {}
        () = terminate => {}
    }
}

/// Save (Ctrl+S) writes the `-d` file back in place (spec §5.1).
async fn save_display_config(State(state): State<AppState>, body: Bytes) -> Response {
    let Some(path) = &state.display_config else {
        return (
            StatusCode::NOT_FOUND,
            "no display config (-d) given; use Save As",
        )
            .into_response();
    };
    match tokio::fs::write(path, &body).await {
        Ok(()) => {
            tracing::info!(path = %path.display(), bytes = body.len(), "display config saved");
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("cannot write {}: {e}", path.display()),
        )
            .into_response(),
    }
}

async fn ws_upgrade(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| session::run(socket, state))
}

/// The `.rviz` file given with `-d`, for the client to load at startup (M2).
async fn display_config(State(state): State<AppState>) -> Response {
    match &state.display_config {
        Some(path) => match tokio::fs::read_to_string(path).await {
            Ok(text) => (
                [(axum::http::header::CONTENT_TYPE, "application/yaml")],
                text,
            )
                .into_response(),
            Err(e) => (
                StatusCode::NOT_FOUND,
                format!("cannot read {}: {e}", path.display()),
            )
                .into_response(),
        },
        None => (StatusCode::NOT_FOUND, "no display config (-d) given").into_response(),
    }
}
