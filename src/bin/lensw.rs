//! `lensw`: starts `lens` with the same arguments and no console window. Windows login items use
//! it, because a console program started at login opens a console window. On macOS and Linux it
//! simply runs `lens`.
#![cfg_attr(windows, windows_subsystem = "windows")]

use std::process::{Command, ExitCode};

fn main() -> ExitCode {
    let Ok(this) = std::env::current_exe() else {
        return ExitCode::FAILURE;
    };
    let lens = this.with_file_name(if cfg!(windows) { "lens.exe" } else { "lens" });
    let mut command = Command::new(lens);
    command.args(std::env::args_os().skip(1));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    match command.status() {
        Ok(status) if status.success() => ExitCode::SUCCESS,
        _ => ExitCode::FAILURE,
    }
}
