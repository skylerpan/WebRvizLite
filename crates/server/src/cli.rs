use std::path::PathBuf;

/// Command-line options (spec §5.3). RViz-compatible flags are accepted even
/// where they have no browser equivalent.
#[derive(Debug, clap::Parser)]
#[command(
    name = "webrvizlite",
    version,
    about = "ROS 2 visualization in the browser"
)]
pub struct Args {
    /// .rviz config file to load at startup.
    #[arg(short = 'd', long)]
    pub display_config: Option<PathBuf>,

    /// Override the Fixed Frame.
    #[arg(short = 'f', long)]
    pub fixed_frame: Option<String>,

    /// Browser tab title format; supports {NAMESPACE}, {CONFIG_PATH}, {CONFIG_FILENAME}.
    #[arg(short = 't', long)]
    pub display_title_format: Option<String>,

    /// Custom splash screen image (Tier 2).
    #[arg(short = 's', long)]
    pub splash_screen: Option<PathBuf>,

    /// Accepted for RViz compatibility; browsers require a user gesture for fullscreen.
    #[arg(long)]
    pub fullscreen: bool,

    /// Address to listen on.
    #[arg(long, default_value = "127.0.0.1")]
    pub bind: String,

    /// Port to listen on.
    #[arg(long, default_value_t = 8765)]
    pub port: u16,

    /// Serve the frontend from this directory instead of the embedded build
    /// (development convenience).
    #[arg(long)]
    pub web_dir: Option<PathBuf>,

    /// Extra `package://NAME/...` roots for /api/mesh, as NAME=DIR (repeatable).
    /// `--mock` adds `webrvizlite_fixtures=<cwd>/fixtures` automatically.
    #[arg(long = "package-path", value_name = "NAME=DIR")]
    pub package_paths: Vec<String>,

    /// Do not open the WebTransport (QUIC/UDP) endpoint; everything goes over the WebSocket.
    #[arg(long)]
    pub no_webtransport: bool,

    /// Use the built-in mock transport (synthetic /scan, /tf, /tf_static, /clock)
    /// instead of ROS 2. Works without a ROS installation.
    #[arg(long)]
    pub mock: bool,

    /// ROS CLI arguments, e.g. `--ros-args -p use_sim_time:=true`. Parsed by rcl
    /// from the raw process arguments; listed here only so clap lets them through.
    #[arg(long = "ros-args", num_args = 0.., allow_hyphen_values = true, hide = true)]
    pub ros_args: Vec<String>,
}
