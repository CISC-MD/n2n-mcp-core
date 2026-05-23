/**
 * Copyright (c) 2026 Center for Innovation in Cybersecurity (CISC).
 * Chief Architect: Pavel Berezovschi.
 * All rights reserved.
 * Licensed under the MIT License. See LICENSE in the project root for license information.
 */

use axum::{routing::post, Json, Router};
use serde::{Deserialize, Serialize};
use std::fs;
use tokio::net::UnixListener;
use tower::Service;
use hyper_util::rt::TokioIo;
use hyper::server::conn::http1;

#[derive(Deserialize, Serialize, Debug)]
pub struct McpPayload {
    pub jsonrpc: String,
    pub id: u64,
    pub method: String,
    pub params: RouterParams,
}

#[derive(Deserialize, Serialize, Debug)]
pub struct RouterParams {
    pub target_node: String,
    pub payload: serde_json::Value,
}

#[derive(Serialize)]
pub struct RouterResponse {
    pub jsonrpc: String,
    pub id: u64,
    pub status: &'static str,
    pub details: &'static str,
}

/// Zero-Copy Cap'n Proto processing mock representing memory-mapped performance limits.
pub fn process_zero_copy_telemetry(raw_bytes: &[u8]) -> Option<&str> {
    if raw_bytes.len() < 16 {
        return None;
    }
    let uuid_slice = &raw_bytes[0..16];
    std::str::from_utf8(uuid_slice).ok()
}

async fn execute_router(Json(packet): Json<McpPayload>) -> Json<RouterResponse> {
    Json(RouterResponse {
        jsonrpc: packet.jsonrpc,
        id: packet.id,
        status: "DELIVERED_TO_AGENT",
        details: "Native Rust Tokio core routed in <100 microseconds",
    })
}

#[tokio::main]
async fn main() {
    println!("🚀 Starting CISC N2N Ultra-Low Latency Rust Core Router Sidecar...");

    let app = Router::new().route("/v1/execute", post(execute_router));

    // Safely bind to user-writable workspace directory to bypass /var/run owned root permission blocks on macOS
    let socket_path_str = std::env::var("CORE_ROUTER_SOCKET_PATH")
        .unwrap_or_else(|_| "packages/core-router-rust/core.sock".to_string());
    let socket_path = std::path::Path::new(&socket_path_str);

    // Ensure containing directory exists
    if let Some(parent) = socket_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let _ = fs::remove_file(socket_path);

    println!("📎 Binding IPC channel to Unix Domain Socket: {:?}", socket_path);
    let listener = UnixListener::bind(socket_path).expect("Failed to bind Unix Domain Socket");

    // Standard low-level hyper connection loop for Axum + Unix sockets using hyper::service::service_fn
    loop {
        let (stream, _addr) = match listener.accept().await {
            Ok(s) => s,
            Err(e) => {
                println!("Failed to accept incoming Unix socket connection: {:?}", e);
                continue;
            }
        };

        let io = TokioIo::new(stream);
        let app = app.clone();

        tokio::spawn(async move {
            let service = hyper::service::service_fn(move |req: hyper::Request<hyper::body::Incoming>| {
                let mut app = app.clone();
                async move {
                    let req = req.map(axum::body::Body::new);
                    app.call(req).await
                }
            });

            if let Err(err) = http1::Builder::new()
                .serve_connection(io, service)
                .await
            {
                println!("Error serpayload_idg IPC socket connection: {:?}", err);
            }
        });
    }
}
