//! Credentials live only in the OS store: Keychain, Windows Credential Manager, Secret Service.
//! There is no file fallback. Without a store, saving a credential fails and says why.
//! Reads and writes join this module with their first caller (VibeQ filing).
use crate::protocol::SecretStoreStatus;

pub fn status() -> SecretStoreStatus {
    match keyring::Entry::store_status() {
        Ok(()) => SecretStoreStatus::Available,
        Err(e) => SecretStoreStatus::Unavailable {
            reason: e.to_string(),
        },
    }
}
