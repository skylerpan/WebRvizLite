//! WebTransport endpoint (spec §2, Tier 1): QUIC on the same port number as
//! HTTP (UDP), self-signed ECDSA certificate regenerated at startup (Chrome's
//! `serverCertificateHashes` rules: ECDSA, ≤ 14 days validity). A browser
//! session connects to `/wt?token=<token>`; the token was handed out in that
//! session's `hello`, so the QUIC connection is matched to its WebSocket.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::oneshot;
use wtransport::tls::Sha256DigestFmt;
use wtransport::{Connection, Endpoint, Identity, ServerConfig};

#[derive(Clone, Debug)]
pub struct WtInfo {
    pub port: u16,
    pub cert_sha256_hex: String,
}

/// Sessions waiting for their WebTransport connection, by token.
pub type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Connection>>>>;

pub fn new_pending() -> Pending {
    Arc::new(Mutex::new(HashMap::new()))
}

pub fn new_token() -> String {
    format!("{:032x}", rand::random::<u128>())
}

/// Binds the QUIC endpoint and spawns the accept loop.
pub fn start(
    bind: &str,
    port: u16,
    pending: Pending,
) -> Result<WtInfo, Box<dyn std::error::Error>> {
    let sans: Vec<String> = ["localhost", "127.0.0.1", "::1", bind]
        .into_iter()
        .filter(|s| !s.is_empty() && *s != "0.0.0.0" && *s != "::")
        .map(String::from)
        .collect();
    let identity = Identity::self_signed(&sans)?;
    let cert = identity
        .certificate_chain()
        .as_slice()
        .first()
        .ok_or("self-signed identity has no certificate")?;
    let cert_sha256_hex = cert.hash().fmt(Sha256DigestFmt::DottedHex).replace(':', "");
    let addr: SocketAddr = format!("{bind}:{port}").parse()?;
    let config = ServerConfig::builder()
        .with_bind_address(addr)
        .with_identity(identity)
        .keep_alive_interval(Some(Duration::from_secs(3)))
        .build();
    let endpoint = Endpoint::server(config)?;
    tokio::spawn(async move {
        loop {
            let incoming = endpoint.accept().await;
            let pending = pending.clone();
            tokio::spawn(async move {
                let request = match incoming.await {
                    Ok(r) => r,
                    Err(e) => {
                        tracing::debug!("webtransport handshake failed: {e}");
                        return;
                    }
                };
                let token = request
                    .path()
                    .split_once("token=")
                    .map(|(_, t)| t.split('&').next().unwrap_or("").to_string());
                let tx = token.and_then(|t| pending.lock().unwrap().remove(&t));
                match tx {
                    Some(tx) => match request.accept().await {
                        Ok(conn) => {
                            tracing::info!(remote = %conn.remote_address(), "webtransport session accepted");
                            let _ = tx.send(conn);
                        }
                        Err(e) => tracing::warn!("webtransport accept failed: {e}"),
                    },
                    None => {
                        tracing::warn!(
                            path = request.path(),
                            "webtransport session with unknown token refused"
                        );
                        request.forbidden().await;
                    }
                }
            });
        }
    });
    Ok(WtInfo {
        port,
        cert_sha256_hex,
    })
}
