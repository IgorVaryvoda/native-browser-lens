//! What an installer puts beside Lens: the browser extensions, built for Chrome-family browsers and
//! for Firefox. They are unpacked into the data folder, the stable place people load them from, and
//! refreshed there whenever an installer brings a different build.
use crate::paths::Paths;
use std::io;
use std::path::{Path, PathBuf};

pub const EXTENSIONS: [&str; 2] = ["extension", "extension-firefox"];

/// Where the installers put resources: the macOS app bundle, the Linux packages and AppImage, or
/// the Windows install folder. None for a plain binary (development, install.sh).
fn resources() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    let dir = executable.parent()?;
    [
        dir.join("../Resources"),
        dir.join("../lib/sirv-lens"),
        dir.join("../lib/lens"),
        dir.to_path_buf(),
    ]
    .into_iter()
    .find(|d| d.join("extension").join("manifest.json").is_file())
}

/// Copies each bundled extension into the data folder when the copy there differs. Returns
/// whether one changed, so the caller can say that the browser must reload it.
pub fn sync_extensions(paths: &Paths) -> io::Result<bool> {
    let Some(from) = resources() else {
        return Ok(false);
    };
    let mut changed = false;
    for name in EXTENSIONS {
        let source = from.join(name);
        let target = paths.data.join(name);
        if !source.join("manifest.json").is_file() || fingerprint(&source) == fingerprint(&target) {
            continue;
        }
        // Next to the target, then swapped in: a browser never sees half a folder.
        let fresh = paths.data.join(format!(".{name}.new"));
        let _ = std::fs::remove_dir_all(&fresh);
        copy_dir(&source, &fresh)?;
        let _ = std::fs::remove_dir_all(&target);
        std::fs::rename(&fresh, &target)?;
        changed = true;
    }
    Ok(changed)
}

/// Every file's relative path and size, plus a hash of the manifest: equal for two copies of one
/// build.
fn fingerprint(dir: &Path) -> Option<Vec<(String, u64)>> {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::hash::DefaultHasher::new();
    std::fs::read(dir.join("manifest.json"))
        .ok()?
        .hash(&mut hasher);
    let mut files = vec![(String::new(), hasher.finish())];
    let mut stack = vec![dir.to_path_buf()];
    while let Some(folder) = stack.pop() {
        for entry in std::fs::read_dir(&folder).ok()?.flatten() {
            let path = entry.path();
            let meta = entry.metadata().ok()?;
            if meta.is_dir() {
                stack.push(path);
            } else {
                let relative = path.strip_prefix(dir).ok()?.to_string_lossy().into_owned();
                files.push((relative, meta.len()));
            }
        }
    }
    files.sort();
    Some(files)
}

fn copy_dir(from: &Path, to: &Path) -> io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_copy_matches_and_a_change_does_not() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a");
        std::fs::create_dir_all(a.join("chunks")).unwrap();
        std::fs::write(a.join("manifest.json"), "{\"version\":\"1\"}").unwrap();
        std::fs::write(a.join("chunks/x.js"), "x").unwrap();
        let b = dir.path().join("b");
        copy_dir(&a, &b).unwrap();
        assert_eq!(fingerprint(&a), fingerprint(&b));
        std::fs::write(b.join("chunks/x.js"), "xy").unwrap();
        assert_ne!(fingerprint(&a), fingerprint(&b));
        assert!(fingerprint(&dir.path().join("none")).is_none());
    }
}
