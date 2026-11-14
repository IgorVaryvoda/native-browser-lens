mod daemon;
mod framing;
mod ipc;
mod paths;
mod protocol;
mod register;
mod secrets;
mod shim;
mod store;

use paths::Paths;
use protocol::{MAX_REPLY_BYTES, ReplyFrame, Request, RequestFrame};
use std::process::ExitCode;

const USAGE: &str = "Usage: lens <command>

  status       Show the data folder and whether the daemon runs
  register     Register Lens with every installed browser (per user)
  unregister   Remove those registrations
  stop         Stop the daemon (a browser connection starts it again)
  daemon       Run the Lens daemon in the foreground
  version      Print the version";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        // Chromium passes the caller's origin; Firefox passes the path of the host manifest.
        Some(a) if a.starts_with("chrome-extension://") || a.ends_with(".json") => {
            with_paths(shim::run)
        }
        Some("daemon") => with_paths(daemon::run),
        Some("register") => {
            with_paths(|p| print_report(register::register(p, &std::env::current_exe()?)?))
        }
        Some("unregister") => with_paths(|p| print_report(register::unregister(p)?)),
        Some("status") => with_paths(status),
        Some("stop") => with_paths(stop),
        Some("version" | "--version" | "-V") => {
            println!("lens {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Some("help" | "--help" | "-h") => {
            println!("{USAGE}");
            Ok(())
        }
        _ => {
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("lens: {e}");
            ExitCode::FAILURE
        }
    }
}

fn with_paths(run: impl FnOnce(&Paths) -> std::io::Result<()>) -> std::io::Result<()> {
    run(&Paths::resolve()?)
}

fn print_report(report: register::Report) -> std::io::Result<()> {
    for (browser, line) in report {
        println!("{browser:<16} {line}");
    }
    Ok(())
}

fn ask(paths: &Paths, request: Request) -> std::io::Result<Option<ReplyFrame>> {
    let Ok(mut stream) = ipc::connect(paths) else {
        return Ok(None);
    };
    framing::write_frame(
        &mut stream,
        &serde_json::to_vec(&RequestFrame { id: 1, request })?,
    )?;
    let reply = framing::read_frame(&mut stream, MAX_REPLY_BYTES)?
        .ok_or_else(|| std::io::Error::other("the daemon closed the connection"))?;
    Ok(Some(serde_json::from_slice(&reply)?))
}

fn status(paths: &Paths) -> std::io::Result<()> {
    println!("data folder      {}", paths.data.display());
    match ask(paths, Request::Hello)? {
        Some(reply) => println!(
            "daemon           {}",
            serde_json::to_string(&reply.outcome)?
        ),
        None => println!("daemon           not running (a browser connection starts it)"),
    }
    Ok(())
}

fn stop(paths: &Paths) -> std::io::Result<()> {
    println!(
        "{}",
        if ask(paths, Request::Shutdown)?.is_some() {
            "stopped"
        } else {
            "not running"
        }
    );
    Ok(())
}
