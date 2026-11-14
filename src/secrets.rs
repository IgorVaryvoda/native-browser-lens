//! Credentials live only in the OS store: Keychain, Windows Credential Manager, Secret Service.
//! There is no file fallback. Without a store, saving a credential fails and says why.
use crate::protocol::SecretStoreStatus;

const SERVICE: &str = "studio.sirv.lens";

pub fn status() -> SecretStoreStatus {
    match keyring::Entry::store_status() {
        Ok(()) => SecretStoreStatus::Available,
        Err(e) => SecretStoreStatus::Unavailable {
            reason: e.to_string(),
        },
    }
}

pub fn get(account: &str) -> Result<Option<String>, String> {
    match keyring::Entry::new(SERVICE, account).and_then(|e| e.get_password()) {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("the secret store refused: {e}")),
    }
}

pub fn set(account: &str, value: &str) -> Result<(), String> {
    keyring::Entry::new(SERVICE, account)
        .and_then(|e| e.set_password(value))
        .map_err(|e| format!("the secret store refused: {e}"))
}

pub fn delete(account: &str) -> Result<(), String> {
    match keyring::Entry::new(SERVICE, account).and_then(|e| e.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("the secret store refused: {e}")),
    }
}
