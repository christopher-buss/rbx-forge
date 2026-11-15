//! Bounded HTTP identity reads from Windows IPv4 loopback; no redirects or proxies.
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::{Duration, Instant};

pub fn probe(port: u16, route: &str) -> io::Result<Vec<u8>> {
    if port == 0
        || !(route == "/api/rojo" || (route.starts_with("/capture/") && route.contains("/probe/")))
        || route.bytes().any(|b| b <= 32 || b >= 127)
    {
        return Err(io::Error::other("invalid probe route"));
    }
    let bound = Duration::from_secs(3);
    let deadline = Instant::now() + bound;
    let mut stream =
        TcpStream::connect_timeout(&SocketAddr::from((Ipv4Addr::LOCALHOST, port)), bound)?;
    stream.set_write_timeout(Some(bound))?;
    write!(
        stream,
        "GET {route} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    )?;
    let mut response = Vec::new();
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| io::Error::other("probe deadline exceeded"))?;
        stream.set_read_timeout(Some(remaining))?;
        let mut bytes = [0; 4096];
        let count = stream.read(&mut bytes)?;
        if count == 0 {
            break;
        }
        response.extend_from_slice(&bytes[..count]);
        if response.len() > 65536 {
            return Err(io::Error::other("probe response too large"));
        }
    }
    let split = response
        .windows(4)
        .position(|bytes| bytes == b"\r\n\r\n")
        .ok_or_else(|| io::Error::other("invalid HTTP response"))?;
    let headers = std::str::from_utf8(&response[..split]).map_err(io::Error::other)?;
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1));
    if status != Some("200") {
        return Err(io::Error::other("probe returned unsuccessful HTTP status"));
    }
    Ok(response[split + 4..].to_vec())
}
