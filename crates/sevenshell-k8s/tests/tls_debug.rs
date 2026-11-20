//! Temporary: prints what macOS says about the fixture certificates, one variable at a time.

mod common;

use std::io::Write;

use common::{pem, tls_server};

fn attempt(label: &str, base: &str, domain: &str, only_anchors: bool, ignore_hostname: bool, ignore_certs: bool) {
    let mut builder = native_tls::TlsConnector::builder();
    builder.add_root_certificate(native_tls::Certificate::from_pem(&pem("ca1.pem")).expect("the authority"));
    builder.disable_built_in_roots(only_anchors);
    builder.danger_accept_invalid_hostnames(ignore_hostname);
    builder.danger_accept_invalid_certs(ignore_certs);
    let connector = builder.build().expect("a connector");
    let address = base.trim_start_matches("https://");
    let stream = std::net::TcpStream::connect(address).expect("a connection");
    match connector.connect(domain, stream) {
        Ok(mut stream) => {
            let _ = stream.write_all(b"GET / HTTP/1.1\r\nhost: x\r\n\r\n");
            println!("{label}: OK");
        }
        Err(error) => {
            println!("{label}: ERR {error}");
            let mut source = std::error::Error::source(&error);
            while let Some(cause) = source {
                println!("  cause: {cause}");
                source = cause.source();
            }
        }
    }
}

#[test]
fn diagnose() {
    println!("target: {} / {}", std::env::consts::OS, std::env::consts::ARCH);
    let server = tls_server(&pem("server1.pem"), &pem("server1.key"));
    let base = server.base.as_str();
    attempt("ip, anchors only", base, "127.0.0.1", true, false, false);
    attempt("ip, system+anchors", base, "127.0.0.1", false, false, false);
    attempt("ip, anchors only, hostname ignored", base, "127.0.0.1", true, true, false);
    attempt("localhost, anchors only", base, "localhost", true, false, false);
    attempt("ip, verification off", base, "127.0.0.1", false, false, true);
}
