//! The standalone binary of the local browser service: a thin shell around the [`sevenshell_web`]
//! library.
//!
//! Everything this program does is [`sevenshell_web::run_cli`]; the binary exists so the interface
//! can be served headlessly, on a machine without the desktop application. Its flags, environment
//! variables and output are the library's published command line and do not change here.

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    sevenshell_web::run_cli().await
}
