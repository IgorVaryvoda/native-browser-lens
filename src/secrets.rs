//! Credentials live only in the OS store: Keychain, Windows Credential Manager, Secret Service.
//! There is no file fallback. Without a store, saving a credential fails and says why.
use crate::protocol::SecretStoreStatus;

const SERVICE: &str = "studio.sirv.lens";

/// A data folder of its own (LENS_HOME: tests, demos) keeps credentials of its own, so it never
/// reads or replaces the person's real VibeQ token.
fn service() -> String {
    service_for(std::env::var("LENS_HOME").ok().as_deref())
}

fn service_for(home: Option<&str>) -> String {
    match home.map(str::trim) {
        Some(home) if !home.is_empty() => format!("{SERVICE}:{home}"),
        _ => SERVICE.to_string(),
    }
}

pub fn status() -> SecretStoreStatus {
    match keyring::Entry::store_status() {
        Ok(()) => SecretStoreStatus::Available,
        Err(e) => SecretStoreStatus::Unavailable {
            reason: e.to_string(),
        },
    }
}

pub fn get(account: &str) -> Result<Option<String>, String> {
    match keyring::Entry::new(&service(), account).and_then(|e| e.get_password()) {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("the secret store refused: {e}")),
    }
}

pub fn set(account: &str, value: &str) -> Result<(), String> {
    keyring::Entry::new(&service(), account)
        .and_then(|e| e.set_password(value))
        .map_err(|e| format!("the secret store refused: {e}"))
}

pub fn delete(account: &str) -> Result<(), String> {
    match keyring::Entry::new(&service(), account).and_then(|e| e.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("the secret store refused: {e}")),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_separate_data_folder_has_separate_credentials() {
        assert_eq!(super::service_for(None), "studio.sirv.lens");
        assert_eq!(super::service_for(Some("")), "studio.sirv.lens");
        assert_eq!(
            super::service_for(Some("/tmp/lens-shots/lens")),
            "studio.sirv.lens:/tmp/lens-shots/lens"
        );
    }
}
