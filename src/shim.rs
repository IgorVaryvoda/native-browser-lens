//! The native messaging host the browser starts. It relays frames between the browser and `lensd`,
//! and starts `lensd` when it is not running. It holds no state and makes no decisions.
use crate::framing::{read_frame, write_frame};
use crate::ipc;
use crate::paths::Paths;
use crate::protocol::{MAX_REPLY_BYTES, MAX_REQUEST_BYTES};
use interprocess::local_socket::Stream;
use std::io::{self, Read, Write};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub fn run(paths: &Paths) -> io::Result<()> {
    let stream = Arc::new(connect_or_start(paths)?);
    let to_daemon = stream.clone();
    std::thread::spawn(move || {
        // The browser closed the port: nothing more will come, so the shim ends.
        let _ = relay(&mut io::stdin().lock(), &mut &*to_daemon, MAX_REQUEST_BYTES);
        std::process::exit(0);
    });
    relay(&mut &*stream, &mut io::stdout().lock(), MAX_REPLY_BYTES)
}

fn relay(from: &mut impl Read, to: &mut impl Write, limit: usize) -> io::Result<()> {
    while let Some(frame) = read_frame(from, limit)? {
        write_frame(to, &frame)?;
    }
    Ok(())
}

pub fn connect_or_start(paths: &Paths) -> io::Result<Stream> {
    if let Ok(stream) = ipc::connect(paths) {
        return Ok(stream);
    }
    spawn_daemon(paths)?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match ipc::connect(paths) {
            Ok(stream) => return Ok(stream),
            Err(e) if Instant::now() >= deadline => {
                return Err(io::Error::new(
                    e.kind(),
                    format!("lensd did not start: {e}"),
                ));
            }
            Err(_) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

/// The daemon outlives the shim: its own process group (Unix), detached and out of the browser's
/// job object (Windows). Its stderr goes to `lensd.log` in the data folder.
fn spawn_daemon(paths: &Paths) -> io::Result<()> {
    paths.ensure()?;
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(paths.data.join("lensd.log"))?;
    let mut command = Command::new(std::env::current_exe()?);
    command
        .arg("daemon")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(log);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        command.creation_flags(
            DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB,
        );
        if command.spawn().is_ok() {
            return Ok(());
        }
        // The job forbids breakaway: the daemon then lives as long as the browser's job does.
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    command.spawn().map(drop)
}
