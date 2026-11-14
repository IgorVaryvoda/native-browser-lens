//! Native messaging framing: a u32 length in native byte order, then that many bytes of JSON.
//! The daemon socket uses the same framing, so the shim forwards bytes without parsing them.
use std::io::{self, Read, Write};

/// `Ok(None)` is a clean end of stream between frames.
pub fn read_frame(reader: &mut impl Read, limit: usize) -> io::Result<Option<Vec<u8>>> {
    let mut header = [0u8; 4];
    match reader.read_exact(&mut header) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let length = u32::from_ne_bytes(header) as usize;
    if length > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("frame of {length} bytes exceeds {limit}"),
        ));
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body)?;
    Ok(Some(body))
}

pub fn write_frame(writer: &mut impl Write, body: &[u8]) -> io::Result<()> {
    let length = u32::try_from(body.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "frame too large"))?;
    writer.write_all(&length.to_ne_bytes())?;
    writer.write_all(body)?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_rejects_oversize_frames() {
        let mut buffer = Vec::new();
        write_frame(&mut buffer, b"{\"id\":1}").unwrap();
        write_frame(&mut buffer, b"").unwrap();
        let mut reader = buffer.as_slice();
        assert_eq!(read_frame(&mut reader, 64).unwrap().unwrap(), b"{\"id\":1}");
        assert_eq!(read_frame(&mut reader, 64).unwrap().unwrap(), b"");
        assert!(read_frame(&mut reader, 64).unwrap().is_none());

        let mut big = Vec::new();
        write_frame(&mut big, &[b'x'; 65]).unwrap();
        assert!(read_frame(&mut big.as_slice(), 64).is_err());
    }
}
