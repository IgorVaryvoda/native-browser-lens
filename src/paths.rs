use std::io;
use std::path::PathBuf;

/// Where Lens keeps its data and its daemon socket. Binaries never live here, so an update never
/// touches the notebook. `LENS_HOME` puts everything under one folder (tests, portable runs).
#[derive(Clone, Debug)]
pub struct Paths {
    pub data: PathBuf,
    pub runtime: PathBuf,
}

impl Paths {
    pub fn resolve() -> io::Result<Self> {
        if let Some(home) = std::env::var_os("LENS_HOME").filter(|v| !v.is_empty()) {
            let data = PathBuf::from(home);
            return Ok(Self {
                runtime: data.join("run"),
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
        Ok(Self { data, runtime })
    }

    pub fn ensure(&self) -> io::Result<()> {
        for dir in [&self.data, &self.runtime, &self.blobs()] {
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

    pub fn database(&self) -> PathBuf {
        self.data.join("lens.sqlite")
    }

    pub fn blobs(&self) -> PathBuf {
        self.data.join("blobs")
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
