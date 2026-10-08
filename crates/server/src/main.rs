//! WebRvizLite server: serves the built frontend and bridges ROS 2 to the
//! browser over one WebSocket per client (binary CDR frames + JSON control).

mod cli;
mod hub;
mod mesh;
mod session;
mod static_files;

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
    session_counter: Arc<AtomicU64>,
}

impl AppState {
    fn hello(&self) -> ServerMessage {
        let t = self.hub.transport();
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

    let (topics_tx, _) = broadcast::channel(16);
    let state = AppState {
        hub: hub::Hub::new(transport),
        topics: Arc::new(Mutex::new(Vec::new())),
        topics_tx,
        mock: args.mock,
        display_config: args.display_config.clone(),
        fixed_frame: args.fixed_frame.clone(),
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
    axum::serve(listener, app).await?;
    Ok(())
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
