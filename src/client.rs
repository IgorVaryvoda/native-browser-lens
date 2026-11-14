//! A blocking client of the daemon for the CLI and the MCP server: one request, one reply.
use crate::framing::{read_frame, write_frame};
use crate::paths::Paths;
use crate::protocol::{
    MAX_REPLY_BYTES, Outcome, ProtocolError, Reply, ReplyFrame, Request, RequestFrame,
};
use crate::shim;
use std::io;

pub struct Client {
    stream: interprocess::local_socket::Stream,
    next: u32,
}

impl Client {
    /// Connects, starting the daemon when none runs.
    pub fn connect(paths: &Paths) -> io::Result<Self> {
        Ok(Self {
            stream: shim::connect_or_start(paths)?,
            next: 1,
        })
    }

    pub fn call(&mut self, request: Request) -> Result<Reply, String> {
        let id = self.next;
        self.next += 1;
        let frame = serde_json::to_vec(&RequestFrame { id, request }).expect("requests serialize");
        let mut stream = &self.stream;
        write_frame(&mut stream, &frame).map_err(|e| e.to_string())?;
        let reply = read_frame(&mut stream, MAX_REPLY_BYTES)
            .map_err(|e| e.to_string())?
            .ok_or("the daemon closed the connection")?;
        let reply: ReplyFrame = serde_json::from_slice(&reply).map_err(|e| e.to_string())?;
        match reply.outcome {
            Outcome::Ok { result } => Ok(*result),
            Outcome::Error {
                error: ProtocolError { message, .. },
            } => Err(message),
        }
    }

    /// A whole blob, read in chunks under the reply limit.
    pub fn blob(&mut self, sha256: &str, size: u64) -> Result<Vec<u8>, String> {
        use base64::Engine;
        let mut bytes = Vec::with_capacity(size as usize);
        while (bytes.len() as u64) < size {
            let reply = self.call(Request::ReadBlob {
                sha256: sha256.into(),
                offset: bytes.len() as u64,
                length: crate::protocol::MAX_BLOB_CHUNK,
            })?;
            let Reply::Blob(chunk) = reply else {
                return Err("unexpected reply".into());
            };
            let data = base64::engine::general_purpose::STANDARD
                .decode(chunk.data)
                .map_err(|e| e.to_string())?;
            if data.is_empty() {
                break;
            }
            bytes.extend(data);
        }
        Ok(bytes)
    }
}
