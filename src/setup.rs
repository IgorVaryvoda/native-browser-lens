//! `lens setup` and `lens doctor`: one checklist, built from the daemon's live checks. Setup fixes
//! what it can by itself (service, registrations) and then waits, step by step, for what only the
//! person can do in the browser. Doctor prints the same checks once.
use crate::client::Client;
use crate::paths::Paths;
use crate::protocol::{PROTOCOL_VERSION, Reply, Request, SetupStatus};
use std::io::{self, Write};
use std::time::Duration;

/// Store listings, once they exist. Until then setup explains Load unpacked.
const CHROME_STORE: Option<&str> = None;
const FIREFOX_STORE: Option<&str> = None;

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Mark {
    Done,
    Todo,
    /// Not required; shown as a suggestion.
    Optional,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct Step {
    pub name: String,
    pub mark: Mark,
    pub detail: String,
}

pub fn steps(status: &SetupStatus, paths: &Paths) -> Vec<Step> {
    let step = |name: &str, mark, detail: String| Step {
        name: name.into(),
        mark,
        detail,
    };
    let mut steps = vec![step(
        "Lens app",
        Mark::Done,
        format!("version {} at {}", status.version, status.binary),
    )];

    steps.push(match &status.service {
        Some(manager) => step("Starts at login", Mark::Done, manager.to_string()),
        None => step(
            "Starts at login",
            Mark::Todo,
            "run: lens service install".into(),
        ),
    });

    let usable: Vec<_> = status.browsers.iter().filter(|b| b.registered).collect();
    let problems: Vec<String> = status
        .browsers
        .iter()
        .filter_map(|b| b.problem.as_ref().map(|p| format!("{}: {p}", b.name)))
        .collect();
    steps.push(match (usable.is_empty(), status.browsers.is_empty()) {
        (_, true) => step(
            "Browser",
            Mark::Todo,
            "install Chrome, Edge, Brave, Chromium or Firefox".into(),
        ),
        (true, false) => step("Browser", Mark::Todo, problems.join("; ")),
        (false, false) => {
            let names: Vec<&str> = usable.iter().map(|b| b.name.as_str()).collect();
            let mut detail = format!("ready: {}", names.join(", "));
            if !problems.is_empty() {
                detail.push_str(&format!(" (also: {})", problems.join("; ")));
            }
            step("Browser", Mark::Done, detail)
        }
    });

    let current = status
        .extensions
        .iter()
        .find(|e| e.client.protocol == PROTOCOL_VERSION);
    let outdated = status
        .extensions
        .iter()
        .find(|e| e.client.protocol != PROTOCOL_VERSION);
    steps.push(match (current, outdated) {
        (Some(seen), _) => step(
            "Browser extension",
            Mark::Done,
            format!(
                "connected from {} (extension {})",
                seen.client.browser, seen.client.extension_version
            ),
        ),
        (None, Some(old)) if old.client.protocol < PROTOCOL_VERSION => step(
            "Browser extension",
            Mark::Todo,
            "the extension is older than this app; update the extension".into(),
        ),
        (None, Some(_)) => step(
            "Browser extension",
            Mark::Todo,
            "the extension is newer than this app; update Lens".into(),
        ),
        (None, None) => step(
            "Browser extension",
            Mark::Todo,
            extension_instructions(paths),
        ),
    });

    let granted: usize = status
        .extensions
        .iter()
        .map(|e| e.client.granted_origins.len())
        .sum();
    steps.push(if status.projects > 0 && granted > 0 {
        step(
            "A site to collect on",
            Mark::Done,
            format!("{granted} site(s) allowed"),
        )
    } else {
        step(
            "A site to collect on",
            Mark::Todo,
            "open the site you test, click the Lens button, then Collect evidence on this site"
                .into(),
        )
    });

    steps.push(if status.captures > 0 {
        step(
            "First capture",
            Mark::Done,
            format!("{} capture(s)", status.captures),
        )
    } else {
        step(
            "First capture",
            Mark::Optional,
            "on that site, click Capture in the Lens side panel, or press Alt+Shift+L".into(),
        )
    });

    steps.push(if status.vibeq_configured {
        step("VibeQ", Mark::Done, "address saved".into())
    } else {
        step(
            "VibeQ",
            Mark::Optional,
            "to file defects: Lens Settings, VibeQ address and personal token".into(),
        )
    });
    steps
}

fn extension_instructions(paths: &Paths) -> String {
    match CHROME_STORE.or(FIREFOX_STORE) {
        Some(url) => format!("add the Lens extension: {url}"),
        None => {
            let folder = paths.data.join("extension");
            if folder.is_dir() {
                format!(
                    "add the extension: open chrome://extensions, turn on Developer mode, choose Load unpacked, select {}",
                    folder.display()
                )
            } else {
                "add the Lens extension to your browser".into()
            }
        }
    }
}

fn status(client: &mut Client) -> io::Result<SetupStatus> {
    match client
        .call(Request::SetupStatus)
        .map_err(io::Error::other)?
    {
        Reply::Setup(status) => Ok(*status),
        _ => Err(io::Error::other("unexpected reply")),
    }
}

fn print(steps: &[Step]) {
    for step in steps {
        let mark = match step.mark {
            Mark::Done => "✓",
            Mark::Todo => "✗",
            Mark::Optional => "○",
        };
        println!("{mark} {:<22} {}", step.name, step.detail);
    }
}

/// Prints every check once. Fails when a required step is open.
pub fn doctor(paths: &Paths) -> io::Result<()> {
    let mut client = Client::connect(paths)?;
    let steps = status(&mut client)?.steps;
    print(&steps);
    match steps.iter().filter(|s| s.mark == Mark::Todo).count() {
        0 => {
            println!("\nEverything required is in order.");
            Ok(())
        }
        open => Err(io::Error::other(format!(
            "{open} step(s) need attention; lens setup walks through them"
        ))),
    }
}

/// Fixes what it can, then waits for each browser step, showing the checklist when it changes.
pub fn setup(paths: &Paths) -> io::Result<()> {
    let executable = std::env::current_exe()?;
    println!(
        "Setting up Lens. Press Ctrl+C at any time; lens setup continues where you stopped.\n"
    );
    if crate::service::state(paths) == crate::service::State::NotInstalled {
        crate::service::install(paths, &executable)?;
        println!("Lens now starts at login.");
    }
    crate::register::register(paths, &executable)?;
    let mut client = Client::connect(paths)?;
    let mut shown: Option<Vec<Step>> = None;
    let mut opened = false;
    loop {
        let steps = status(&mut client)?.steps;
        if shown.as_ref() != Some(&steps) {
            println!();
            print(&steps);
            shown = Some(steps.clone());
        }
        let Some(open) = steps.iter().find(|s| s.mark == Mark::Todo) else {
            println!(
                "\nLens is ready. Capture a defect from the Lens side panel whenever you see one."
            );
            return Ok(());
        };
        if open.name == "Browser extension" && !opened {
            opened = true;
            if let Some(url) = CHROME_STORE.or(FIREFOX_STORE) {
                let _ = open_url(url);
            }
        }
        if matches!(
            open.name.as_str(),
            "Lens app" | "Starts at login" | "Browser"
        ) {
            return Err(io::Error::other(format!("{}: {}", open.name, open.detail)));
        }
        print!("\rWaiting: {:<60}", open.name);
        io::stdout().flush()?;
        std::thread::sleep(Duration::from_secs(2));
    }
}

fn open_url(url: &str) -> io::Result<()> {
    let (program, arguments): (&str, Vec<&str>) = if cfg!(target_os = "macos") {
        ("open", vec![url])
    } else if cfg!(windows) {
        ("cmd", vec!["/C", "start", "", url])
    } else {
        ("xdg-open", vec![url])
    };
    std::process::Command::new(program)
        .args(arguments)
        .spawn()
        .map(drop)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{BrowserCheck, ClientInfo, ClientSeen};

    fn status() -> SetupStatus {
        SetupStatus {
            version: "1.0.0".into(),
            protocol: PROTOCOL_VERSION,
            binary: "/bin/lens".into(),
            service: None,
            browsers: vec![],
            extensions: vec![],
            projects: 0,
            captures: 0,
            vibeq_configured: false,
            steps: vec![],
        }
    }

    fn paths() -> Paths {
        Paths {
            data: "/nowhere".into(),
            runtime: "/nowhere/run".into(),
            logs: "/nowhere/logs".into(),
        }
    }

    fn mark(steps: &[Step], name: &str) -> Mark {
        steps.iter().find(|s| s.name == name).unwrap().mark
    }

    #[test]
    fn a_fresh_install_needs_every_browser_step() {
        let steps = steps(&status(), &paths());
        for name in [
            "Starts at login",
            "Browser",
            "Browser extension",
            "A site to collect on",
        ] {
            assert_eq!(mark(&steps, name), Mark::Todo, "{name}");
        }
        assert_eq!(mark(&steps, "First capture"), Mark::Optional);
    }

    #[test]
    fn a_connected_extension_with_a_site_completes_setup() {
        let mut ready = status();
        ready.service = Some("systemd".into());
        ready.browsers = vec![BrowserCheck {
            name: "Google Chrome".into(),
            installed: true,
            registered: true,
            problem: None,
        }];
        ready.projects = 1;
        ready.extensions = vec![ClientSeen {
            client: ClientInfo {
                browser: "chrome".into(),
                extension_version: "1.0.0".into(),
                profile: "p".into(),
                protocol: PROTOCOL_VERSION,
                granted_origins: vec!["https://shop.test".into()],
            },
            last_seen: 1,
        }];
        assert!(steps(&ready, &paths()).iter().all(|s| s.mark != Mark::Todo));

        ready.extensions[0].client.protocol = PROTOCOL_VERSION + 1;
        let steps = steps(&ready, &paths());
        assert!(
            steps
                .iter()
                .find(|s| s.name == "Browser extension")
                .unwrap()
                .detail
                .contains("update Lens")
        );
    }
}
