//! The daemon's local endpoint: a Unix socket in a 0700 folder on macOS and Linux, a named pipe
//! that admits only its owner on Windows. Never a TCP port.
use crate::paths::Paths;
use interprocess::local_socket::{Listener, ListenerOptions, Stream, prelude::*};
use std::io;

#[cfg(unix)]
pub fn listen(paths: &Paths) -> io::Result<Listener> {
    use interprocess::local_socket::GenericFilePath;
    use interprocess::os::unix::local_socket::ListenerOptionsExt;
    let path = paths.socket();
    // Only the lock holder calls this, so a socket file left here belongs to a dead daemon.
    match std::fs::remove_file(&path) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    ListenerOptions::new()
        .name(path.as_path().to_fs_name::<GenericFilePath>()?)
        .mode(0o600)
        .create_sync()
}

#[cfg(unix)]
pub fn connect(paths: &Paths) -> io::Result<Stream> {
    use interprocess::local_socket::GenericFilePath;
    Stream::connect(paths.socket().as_path().to_fs_name::<GenericFilePath>()?)
}

#[cfg(windows)]
pub fn listen(paths: &Paths) -> io::Result<Listener> {
    use interprocess::local_socket::GenericNamespaced;
    use interprocess::os::windows::{
        local_socket::ListenerOptionsExt, security_descriptor::SecurityDescriptor,
    };
    // Protected DACL, one ACE: full access for the pipe's owner (OW), nobody else.
    let sddl = widestring::U16CString::from_str("D:P(A;;GA;;;OW)").map_err(io::Error::other)?;
    ListenerOptions::new()
        .name(paths.pipe_name().to_ns_name::<GenericNamespaced>()?)
        .security_descriptor(SecurityDescriptor::deserialize(&sddl)?)
        .create_sync()
}

#[cfg(windows)]
pub fn connect(paths: &Paths) -> io::Result<Stream> {
    use interprocess::local_socket::GenericNamespaced;
    Stream::connect(paths.pipe_name().to_ns_name::<GenericNamespaced>()?)
}
