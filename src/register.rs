//! Native messaging registration for every supported browser, per user, no admin rights.
//! macOS and Linux: one manifest file per browser. Windows: the manifest in the data folder plus
//! an HKCU registry key per browser that points at it.
use crate::paths::Paths;
use serde_json::json;
use std::io;
use std::path::Path;
#[cfg(unix)]
use std::path::PathBuf;

pub const HOST_NAME: &str = "studio.sirv.lens";
/// The unpacked development ID (from the `key` in the extension manifest). The store IDs join
/// this list when the listings exist.
pub const CHROMIUM_EXTENSION_IDS: &[&str] = &["cggibhoaigdeemmdlfcncfkmoknndbfd"];
pub const FIREFOX_EXTENSION_ID: &str = "lens@sirv.studio";

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Family {
    Chromium,
    Firefox,
}

pub struct Browser {
    pub name: &'static str,
    pub family: Family,
    /// macOS/Linux: the folder holding the browser's profile data. Registration happens only when it
    /// exists, so Lens never creates folders for browsers that are not installed.
    #[cfg(unix)]
    pub root: PathBuf,
    #[cfg(windows)]
    pub registry_key: &'static str,
}

pub fn manifest(family: Family, executable: &Path) -> serde_json::Value {
    let mut manifest = json!({
        "name": HOST_NAME,
        "description": "Sirv Lens",
        "path": executable,
        "type": "stdio",
    });
    match family {
        Family::Chromium => {
            manifest["allowed_origins"] = CHROMIUM_EXTENSION_IDS
                .iter()
                .map(|id| format!("chrome-extension://{id}/"))
                .collect()
        }
        Family::Firefox => manifest["allowed_extensions"] = json!([FIREFOX_EXTENSION_ID]),
    }
    manifest
}

#[cfg(target_os = "macos")]
pub fn browsers(home: &Path, _config: &Path) -> Vec<Browser> {
    let support = home.join("Library/Application Support");
    [
        ("Google Chrome", Family::Chromium, "Google/Chrome"),
        ("Chromium", Family::Chromium, "Chromium"),
        ("Microsoft Edge", Family::Chromium, "Microsoft Edge"),
        ("Brave", Family::Chromium, "BraveSoftware/Brave-Browser"),
        ("Firefox", Family::Firefox, "Mozilla"),
    ]
    .into_iter()
    .map(|(name, family, dir)| Browser {
        name,
        family,
        root: support.join(dir),
    })
    .collect()
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn browsers(home: &Path, config: &Path) -> Vec<Browser> {
    vec![
        Browser {
            name: "Google Chrome",
            family: Family::Chromium,
            root: config.join("google-chrome"),
        },
        Browser {
            name: "Chromium",
            family: Family::Chromium,
            root: config.join("chromium"),
        },
        Browser {
            name: "Microsoft Edge",
            family: Family::Chromium,
            root: config.join("microsoft-edge"),
        },
        Browser {
            name: "Brave",
            family: Family::Chromium,
            root: config.join("BraveSoftware/Brave-Browser"),
        },
        Browser {
            name: "Firefox",
            family: Family::Firefox,
            root: home.join(".mozilla"),
        },
    ]
}

#[cfg(unix)]
fn manifest_path(browser: &Browser) -> PathBuf {
    let folder = match (cfg!(target_os = "macos"), browser.family) {
        (false, Family::Firefox) => "native-messaging-hosts",
        _ => "NativeMessagingHosts",
    };
    browser.root.join(folder).join(format!("{HOST_NAME}.json"))
}

#[cfg(windows)]
pub fn browsers() -> Vec<Browser> {
    [
        (
            "Google Chrome",
            Family::Chromium,
            r"Software\Google\Chrome\NativeMessagingHosts",
        ),
        (
            "Chromium",
            Family::Chromium,
            r"Software\Chromium\NativeMessagingHosts",
        ),
        (
            "Microsoft Edge",
            Family::Chromium,
            r"Software\Microsoft\Edge\NativeMessagingHosts",
        ),
        (
            "Brave",
            Family::Chromium,
            r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
        ),
        (
            "Firefox",
            Family::Firefox,
            r"Software\Mozilla\NativeMessagingHosts",
        ),
    ]
    .into_iter()
    .map(|(name, family, registry_key)| Browser {
        name,
        family,
        registry_key,
    })
    .collect()
}

/// One line per browser, for `lens register` and `lens status`.
pub type Report = Vec<(&'static str, String)>;

#[cfg(unix)]
pub fn register(_paths: &Paths, executable: &Path) -> io::Result<Report> {
    let (home, config) = home_and_config()?;
    register_unix(&browsers(&home, &config), executable)
}

#[cfg(unix)]
pub fn register_unix(browsers: &[Browser], executable: &Path) -> io::Result<Report> {
    let mut report = Vec::new();
    for browser in browsers {
        if !browser.root.is_dir() {
            report.push((browser.name, "not installed".to_string()));
            continue;
        }
        let path = manifest_path(browser);
        std::fs::create_dir_all(path.parent().expect("manifest has a folder"))?;
        let body = serde_json::to_vec_pretty(&manifest(browser.family, executable))?;
        write_atomically(&path, &body)?;
        report.push((browser.name, path.display().to_string()));
    }
    Ok(report)
}

#[cfg(unix)]
pub fn unregister(_paths: &Paths) -> io::Result<Report> {
    let (home, config) = home_and_config()?;
    let mut report = Vec::new();
    for browser in browsers(&home, &config) {
        let path = manifest_path(&browser);
        match std::fs::remove_file(&path) {
            Ok(()) => report.push((browser.name, format!("removed {}", path.display()))),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    Ok(report)
}

#[cfg(unix)]
fn home_and_config() -> io::Result<(PathBuf, PathBuf)> {
    let base = directories::BaseDirs::new()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no home directory"))?;
    Ok((
        base.home_dir().to_path_buf(),
        base.config_dir().to_path_buf(),
    ))
}

#[cfg(windows)]
pub fn register(paths: &Paths, executable: &Path) -> io::Result<Report> {
    use winreg::{RegKey, enums::HKEY_CURRENT_USER};
    let hosts = paths.data.join("hosts");
    std::fs::create_dir_all(&hosts)?;
    let mut report = Vec::new();
    for browser in browsers() {
        let file = hosts.join(match browser.family {
            Family::Chromium => "chromium.json",
            Family::Firefox => "firefox.json",
        });
        write_atomically(
            &file,
            &serde_json::to_vec_pretty(&manifest(browser.family, executable))?,
        )?;
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
            .create_subkey(format!(r"{}\{HOST_NAME}", browser.registry_key))?;
        key.set_value("", &file.as_os_str())?;
        report.push((browser.name, file.display().to_string()));
    }
    Ok(report)
}

#[cfg(windows)]
pub fn unregister(paths: &Paths) -> io::Result<Report> {
    use winreg::{RegKey, enums::HKEY_CURRENT_USER};
    let mut report = Vec::new();
    for browser in browsers() {
        match RegKey::predef(HKEY_CURRENT_USER)
            .delete_subkey(format!(r"{}\{HOST_NAME}", browser.registry_key))
        {
            Ok(()) => report.push((browser.name, "removed".to_string())),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    let _ = std::fs::remove_dir_all(paths.data.join("hosts"));
    Ok(report)
}

fn write_atomically(path: &Path, body: &[u8]) -> io::Result<()> {
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, body)?;
    std::fs::rename(&temporary, path)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn writes_manifests_only_for_installed_browsers() {
        let home = tempfile::tempdir().unwrap();
        let config = home.path().join(".config");
        let browsers = browsers(home.path(), &config);
        let chrome = browsers.iter().find(|b| b.name == "Google Chrome").unwrap();
        std::fs::create_dir_all(&chrome.root).unwrap();

        let report = register_unix(&browsers, Path::new("/opt/lens/lens")).unwrap();
        let written: Vec<_> = report
            .iter()
            .filter(|(_, line)| line != "not installed")
            .collect();
        assert_eq!(written.len(), 1);

        let manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(manifest_path(chrome)).unwrap()).unwrap();
        assert_eq!(manifest["name"], HOST_NAME);
        assert_eq!(manifest["path"], "/opt/lens/lens");
        assert_eq!(
            manifest["allowed_origins"][0],
            "chrome-extension://cggibhoaigdeemmdlfcncfkmoknndbfd/"
        );
        assert!(
            !browsers
                .iter()
                .find(|b| b.name == "Firefox")
                .unwrap()
                .root
                .exists()
        );
    }

    #[test]
    fn firefox_manifests_name_the_addon() {
        assert_eq!(
            manifest(Family::Firefox, Path::new("/x"))["allowed_extensions"][0],
            FIREFOX_EXTENSION_ID
        );
    }
}
