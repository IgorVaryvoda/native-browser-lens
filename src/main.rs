mod blobs;
mod client;
mod daemon;
mod export;
mod filing;
mod framing;
mod investigate;
mod ipc;
mod mcp;
mod paths;
mod protocol;
mod register;
mod render;
mod repro;
mod secrets;
mod service;
mod setup;
mod shim;
mod store;
mod tray;
mod update;
mod vibeq;

use paths::Paths;
use protocol::{MAX_REPLY_BYTES, ReplyFrame, Request, RequestFrame};
use std::process::ExitCode;

const USAGE: &str = "Usage: lens <command>

  setup              Set Lens up step by step, checking each step
  doctor             Check every setup step once
  status             Show the version, folders, service and daemon
  paths <name>       Print one folder: data, logs or extension (for scripts)
  start              Start Lens in the background
  stop               Stop Lens (the service does not restart it)
  restart            Stop, then start
  update [--check]   Install the newest signed release (--check only reports it)
  service install    Start Lens at login (per user, no admin rights)
  service uninstall  Stop starting Lens at login
  register           Register Lens with every installed browser (per user)
  unregister         Remove those registrations
  mcp                Serve reviewed defects to coding agents over MCP (stdio)
  tray               Show the Lens menu-bar / tray icon
  daemon             Run the Lens daemon in the foreground
  version            Print the version";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        // Chromium passes the caller's origin; Firefox passes the path of the host manifest.
        Some(a) if a.starts_with("chrome-extension://") || a.ends_with(".json") => {
            with_paths(shim::run)
        }
        Some("daemon") => {
            let service = args.get(1).is_some_and(|a| a == "--service");
            with_paths(|p| daemon::run(p, service))
        }
        Some("start") => with_paths(|p| service::start(p).map(|()| println!("started"))),
        Some("restart") => with_paths(|p| {
            if args.get(1).is_some_and(|a| a == "--after") {
                let seconds = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(2);
                std::thread::sleep(std::time::Duration::from_secs(seconds));
            }
            stop_daemon(p)?;
            service::start(p)?;
            println!("restarted");
            Ok(())
        }),
        Some("service") => match args.get(1).map(String::as_str) {
            Some("install") => with_paths(|p| {
                service::install(p, &std::env::current_exe()?)?;
                println!("Lens now starts at login and runs in the background.");
                Ok(())
            }),
            Some("uninstall") => with_paths(|p| {
                service::uninstall(p)?;
                println!("Lens no longer starts at login.");
                Ok(())
            }),
            _ => {
                eprintln!("{USAGE}");
                return ExitCode::from(2);
            }
        },
        Some("register") => {
            with_paths(|p| print_report(register::register(p, &std::env::current_exe()?)?))
        }
        Some("unregister") => with_paths(|p| print_report(register::unregister(p)?)),
        Some("status") => with_paths(status),
        Some("setup") => with_paths(setup::setup),
        Some("update") => with_paths(|p| {
            let executable = std::env::current_exe()?;
            if let Some(manager) = update::managed_by(&executable) {
                println!("{manager} updates this copy of Lens.");
                return Ok(());
            }
            match update::check().map_err(std::io::Error::other)? {
                None => println!("Lens {} is the newest version.", env!("CARGO_PKG_VERSION")),
                Some(manifest) if args.get(1).is_some_and(|a| a == "--check") => {
                    println!(
                        "Lens {} is available; lens update installs it.",
                        manifest.version
                    )
                }
                Some(manifest) => {
                    update::install(p, &manifest).map_err(std::io::Error::other)?;
                    // This process still runs the old file, which Linux now reports as deleted:
                    // the new binary, at the path read before the update, does the restart.
                    if ipc::connect(p).is_ok() || service::state(p) != service::State::NotInstalled
                    {
                        std::process::Command::new(&executable)
                            .arg("restart")
                            .status()?;
                    }
                    println!("Lens {} is installed.", manifest.version);
                }
            }
            Ok(())
        }),
        Some("paths") => with_paths(|p| {
            let folder = match args.get(1).map(String::as_str) {
                Some("data") => p.data.clone(),
                Some("logs") => p.logs.clone(),
                Some("extension") => p.data.join("extension"),
                _ => return Err(std::io::Error::other("lens paths data|logs|extension")),
            };
            println!("{}", folder.display());
            Ok(())
        }),
        Some("doctor") => with_paths(setup::doctor),
        Some("mcp") => with_paths(mcp::run),
        Some("tray") => with_paths(tray::run),
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
    println!("version          {}", env!("CARGO_PKG_VERSION"));
    println!("binary           {}", std::env::current_exe()?.display());
    println!("data             {}", paths.data.display());
    println!("logs             {}", paths.logs.display());
    match service::state(paths) {
        service::State::Installed { manager } => {
            println!("service          starts at login ({manager})")
        }
        service::State::NotInstalled => {
            println!("service          not installed (lens service install)")
        }
    }
    match ask(paths, Request::Hello)? {
        Some(ReplyFrame {
            outcome: protocol::Outcome::Ok { result },
            ..
        }) => match *result {
            protocol::Reply::Hello(hello) => {
                println!("daemon           running, version {}", hello.version)
            }
            _ => println!("daemon           running"),
        },
        Some(_) => println!("daemon           running, but it refused the status request"),
        None => println!("daemon           stopped"),
    }
    Ok(())
}

/// Asks the daemon to exit and waits until it has; Ok when none was running.
pub fn stop_daemon(paths: &Paths) -> std::io::Result<bool> {
    if ask(paths, Request::Shutdown)?.is_none() {
        return Ok(false);
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while ipc::connect(paths).is_ok() {
        if std::time::Instant::now() > deadline {
            return Err(std::io::Error::other(
                "the daemon did not stop within 10 seconds",
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    Ok(true)
}

fn stop(paths: &Paths) -> std::io::Result<()> {
    println!(
        "{}",
        if stop_daemon(paths)? {
            "stopped"
        } else {
            "not running"
        }
    );
    Ok(())
}
