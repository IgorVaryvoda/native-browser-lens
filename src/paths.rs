use std::io;
use std::path::PathBuf;

/// Where Lens keeps its data and its daemon socket. Binaries never live here, so an update never
/// touches the notebook. `LENS_HOME` puts everything under one folder (tests, portable runs).
#[derive(Clone, Debug)]
pub struct Paths {
    pub data: PathBuf,
    pub runtime: PathBuf,
    pub logs: PathBuf,
}

impl Paths {
    pub fn resolve() -> io::Result<Self> {
        if let Some(home) = std::env::var_os("LENS_HOME").filter(|v| !v.is_empty()) {
            let data = PathBuf::from(home);
            return Ok(Self {
                runtime: data.join("run"),
                logs: data.join("logs"),
                data,
            });
        }
        let base = directories::BaseDirs::new()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no home directory"))?;
        #[cfg(target_os = "macos")]
        let data = base.data_local_dir().join("Sirv Lens");
        #[cfg(windows)]
        let data = base.data_local_dir().join("Sirv").join("Lens");
        #[cfg(all(unix, not(target_os = "macos")))]
        let data = base.data_local_dir().join("sirv-lens");
        // $XDG_RUNTIME_DIR is per user, mode 0700 and cleared at logout: the right home for a socket.
        #[cfg(all(unix, not(target_os = "macos")))]
        let runtime = base
            .runtime_dir()
            .map(|r| r.join("sirv-lens"))
            .unwrap_or_else(|| data.join("run"));
        #[cfg(not(all(unix, not(target_os = "macos"))))]
        let runtime = data.join("run");
        #[cfg(target_os = "macos")]
        let logs = base.home_dir().join("Library/Logs/Sirv Lens");
        #[cfg(windows)]
        let logs = data.join("logs");
        // $XDG_STATE_HOME is where the XDG spec puts logs; ~/.local/state when unset.
        #[cfg(all(unix, not(target_os = "macos")))]
        let logs = base
            .state_dir()
            .map(|s| s.join("sirv-lens"))
            .unwrap_or_else(|| base.home_dir().join(".local/state/sirv-lens"));
        Ok(Self {
            data,
            runtime,
            logs,
        })
    }

    pub fn ensure(&self) -> io::Result<()> {
        for dir in [&self.data, &self.runtime, &self.blobs(), &self.logs] {
            private_dir(dir)?;
        }
        Ok(())
    }

    /// Where exports go: the person's Downloads folder, else `~/Downloads`.
    pub fn downloads(&self) -> PathBuf {
        directories::UserDirs::new()
            .and_then(|dirs| dirs.download_dir().map(PathBuf::from))
            .or_else(|| directories::BaseDirs::new().map(|b| b.home_dir().join("Downloads")))
            .unwrap_or_else(|| self.data.join("exports"))
    }

    /// Frozen filing attempts: what was reviewed, byte for byte, until VibeQ confirms it.
    pub fn filings(&self) -> PathBuf {
        self.data.join("filings")
    }

    pub fn database(&self) -> PathBuf {
        self.data.join("lens.sqlite")
    }

    pub fn blobs(&self) -> PathBuf {
        self.data.join("blobs")
    }

    /// A log file; it restarts empty when it passes 1 MiB, so logs never grow without bound.
    pub fn log(&self, name: &str) -> std::io::Result<std::fs::File> {
        private_dir(&self.logs)?;
        let path = self.logs.join(name);
        let full = std::fs::metadata(&path).is_ok_and(|m| m.len() > 1024 * 1024);
        std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(!full)
            .truncate(full)
            .open(path)
    }

    pub fn lock(&self) -> PathBuf {
        self.runtime.join("lensd.lock")
    }

    #[cfg(unix)]
    pub fn socket(&self) -> PathBuf {
        self.runtime.join("lensd.sock")
    }

    /// Named pipes share one machine-wide namespace, so the name carries the data folder: two users,
    /// or a test with its own LENS_HOME, never meet. The pipe's DACL admits only its owner.
    #[cfg(windows)]
    pub fn pipe_name(&self) -> String {
        let digest = self
            .data
            .to_string_lossy()
            .to_lowercase()
            .bytes()
            .fold(0xcbf29ce484222325u64, |h, b| {
                (h ^ b as u64).wrapping_mul(0x100000001b3)
            });
        format!("sirv-lens-{digest:016x}")
    }
}

#[cfg(unix)]
fn private_dir(dir: &PathBuf) -> io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
}

#[cfg(windows)]
fn private_dir(dir: &PathBuf) -> io::Result<()> {
    // %LOCALAPPDATA% is already private to the account.
    std::fs::create_dir_all(dir)
}
