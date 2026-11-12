// The named-pipe connection to the DSH host bridge.
//
// Line-delimited JSON over `\\.\pipe\coucou-dsh-<sid>`. The plugin owns the
// server; there is exactly one instance at a time, so a busy pipe means another
// client is attached (or the host is between instances) and is worth retrying.

use std::io;
use std::path::PathBuf;
use std::time::Duration;

#[cfg(windows)]
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
#[cfg(windows)]
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};

/// `ERROR_PIPE_BUSY`: every instance is serving somebody else right now.
#[cfg(windows)]
const ERROR_PIPE_BUSY: i32 = 231;
/// `ERROR_FILE_NOT_FOUND`: nothing is listening under that name yet.
#[cfg(windows)]
const ERROR_FILE_NOT_FOUND: i32 = 2;

/// Where the plugin keeps `runtime.json` (pipe name + token).
///
/// This is the DSH add-on's own folder, named after the product rather than the
/// build: a test build of Coucou must find the same bridge as the installed one,
/// because there is only one DSH. `COUCOU_DSH_STATE_DIR` overrides it for tests.
pub fn state_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("COUCOU_DSH_STATE_DIR") {
        return PathBuf::from(dir);
    }
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("Coucou").join("dsh").join("state")
}

/// What `runtime.json` holds. Written fresh by the plugin on every host start.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct Runtime {
    pub protocol: u32,
    pub pipe: String,
    pub token: String,
    #[serde(default)]
    pub pid: Option<u32>,
}

/// Reads the handshake material, or says why it cannot.
pub fn read_runtime() -> Result<Runtime, String> {
    let path = state_dir().join("runtime.json");
    let bytes = std::fs::read(&path).map_err(|err| match err.kind() {
        io::ErrorKind::NotFound => format!(
            "the DSH bridge is not running ({} is missing); start DSH to connect",
            path.display()
        ),
        _ => format!("cannot read {}: {err}", path.display()),
    })?;
    serde_json::from_slice(&bytes).map_err(|err| format!("{} is not valid JSON: {err}", path.display()))
}

/// A live connection, split so reads and writes never wait for each other.
#[cfg(windows)]
pub struct Conn {
    reader: BufReader<tokio::io::ReadHalf<NamedPipeClient>>,
    writer: tokio::io::WriteHalf<NamedPipeClient>,
    line: String,
}

/// The bridge is a Windows named pipe. On other systems Coucou simply has no
/// DSH connection, and the island shows DSH as unavailable rather than failing.
#[cfg(not(windows))]
pub struct Conn;

#[cfg(windows)]
impl Conn {
    /// Opens the pipe, retrying while the single instance is busy.
    pub async fn open(pipe: &str, wait: Duration) -> io::Result<Self> {
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            match ClientOptions::new().open(pipe) {
                Ok(client) => {
                    let (reader, writer) = tokio::io::split(client);
                    return Ok(Self { reader: BufReader::new(reader), writer, line: String::new() });
                }
                Err(err) => {
                    let busy = matches!(
                        err.raw_os_error(),
                        Some(ERROR_PIPE_BUSY) | Some(ERROR_FILE_NOT_FOUND)
                    );
                    if !busy || tokio::time::Instant::now() >= deadline {
                        return Err(err);
                    }
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            }
        }
    }

    /// Writes one frame. The trailing newline is the frame boundary.
    pub async fn send(&mut self, frame: &str) -> io::Result<()> {
        if frame.contains('\n') {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "a frame cannot contain a newline"));
        }
        self.writer.write_all(frame.as_bytes()).await?;
        self.writer.write_all(b"\n").await?;
        self.writer.flush().await
    }

    /// Reads the next frame. `None` means the host closed the pipe.
    pub async fn next(&mut self) -> io::Result<Option<String>> {
        self.line.clear();
        let read = self.reader.read_line(&mut self.line).await?;
        if read == 0 {
            return Ok(None);
        }
        // A frame larger than this is not something the plugin sends; refusing
        // it keeps a broken or hostile peer from growing the buffer forever.
        if self.line.len() > 1024 * 1024 {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "frame too large"));
        }
        Ok(Some(self.line.trim_end_matches(['\r', '\n']).to_string()))
    }
}
#[cfg(not(windows))]
impl Conn {
    pub async fn open(_pipe: &str, _wait: Duration) -> io::Result<Self> {
        Err(io::Error::new(io::ErrorKind::Unsupported, "the DSH bridge is a Windows named pipe"))
    }

    pub async fn send(&mut self, _frame: &str) -> io::Result<()> {
        Err(io::Error::new(io::ErrorKind::Unsupported, "the DSH bridge is a Windows named pipe"))
    }

    pub async fn next(&mut self) -> io::Result<Option<String>> {
        Err(io::Error::new(io::ErrorKind::Unsupported, "the DSH bridge is a Windows named pipe"))
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::windows::named_pipe::ServerOptions;

    /// `COUCOU_DSH_STATE_DIR` is process-global, so the tests that set it take
    /// this lock. Without it they race and read each other's state directory.
    static STATE_DIR_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn pipe_name(tag: &str) -> String {
        format!(r"\\.\pipe\coucou-test-{tag}-{}", std::process::id())
    }

    /// One frame out, one frame back, over a real named pipe.
    #[tokio::test]
    async fn a_frame_travels_both_ways() {
        let name = pipe_name("roundtrip");
        let server = ServerOptions::new().first_pipe_instance(true).create(&name).unwrap();

        let peer = tokio::spawn(async move {
            let mut server = server;
            server.connect().await.unwrap();
            let mut buffer = [0u8; 256];
            let read = server.read(&mut buffer).await.unwrap();
            let got = String::from_utf8_lossy(&buffer[..read]).to_string();
            server.write_all(b"{\"t\":\"ready\"}\n").await.unwrap();
            server.flush().await.unwrap();
            got
        });

        let mut client = Conn::open(&name, Duration::from_secs(2)).await.expect("client opens");
        client.send("{\"t\":\"hello\",\"protocol\":1}").await.expect("send");

        let seen = peer.await.unwrap();
        assert_eq!(seen.trim_end(), "{\"t\":\"hello\",\"protocol\":1}");

        let back = client.next().await.expect("read").expect("a frame");
        assert_eq!(back, "{\"t\":\"ready\"}");
    }

    /// A closed pipe is reported as the end of the stream, not as an error the
    /// caller has to guess about.
    #[tokio::test]
    async fn a_closed_pipe_reads_as_the_end() {
        let name = pipe_name("eof");
        let server = ServerOptions::new().first_pipe_instance(true).create(&name).unwrap();

        let peer = tokio::spawn(async move {
            let mut server = server;
            server.connect().await.unwrap();
            drop(server);
        });

        let mut client = Conn::open(&name, Duration::from_secs(2)).await.expect("client opens");
        peer.await.unwrap();
        let frame = client.next().await.expect("read");
        assert!(frame.is_none(), "a closed pipe must read as the end");
    }

    /// A frame with a newline inside would silently become two frames.
    #[tokio::test]
    async fn a_frame_cannot_carry_a_newline() {
        let name = pipe_name("newline");
        let server = ServerOptions::new().first_pipe_instance(true).create(&name).unwrap();
        let peer = tokio::spawn(async move {
            let mut server = server;
            server.connect().await.unwrap();
            tokio::time::sleep(Duration::from_millis(200)).await;
            drop(server);
        });

        let mut client = Conn::open(&name, Duration::from_secs(2)).await.expect("client opens");
        let error = client.send("a\nb").await.expect_err("must refuse");
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        peer.abort();
    }

    /// A pipe disconnected by its server must surface as an error the caller
    /// can act on — not as a hang, and not as a clean end of stream.
    ///
    /// This is the shape of a DSH host restart: the plugin's pipe host is
    /// terminated, Windows disconnects the instance, and a pending read fails
    /// with ERROR_PIPE_NOT_CONNECTED (233).
    #[tokio::test]
    async fn a_disconnected_pipe_reports_an_error() {
        use std::os::windows::io::AsRawHandle;

        #[link(name = "kernel32")]
        extern "system" {
            fn DisconnectNamedPipe(handle: *mut std::ffi::c_void) -> i32;
        }

        let name = pipe_name("disconnect");
        let mut server = ServerOptions::new().first_pipe_instance(true).create(&name).unwrap();

        let peer = tokio::spawn(async move {
            server.connect().await.unwrap();
            // Give the client time to be blocked in a read, then pull the plug
            // the way a dying host does.
            tokio::time::sleep(Duration::from_millis(200)).await;
            let disconnected = unsafe { DisconnectNamedPipe(server.as_raw_handle()) };
            assert_ne!(disconnected, 0, "DisconnectNamedPipe failed");
            // Keep the instance alive so the name stays taken for a moment.
            tokio::time::sleep(Duration::from_millis(200)).await;
            drop(server);
        });

        let mut client = Conn::open(&name, Duration::from_secs(2)).await.expect("client opens");
        // Bounded: a hang here is the bug this test exists to catch.
        let outcome = tokio::time::timeout(Duration::from_secs(5), client.next())
            .await
            .expect("the read must not hang after the server disconnects");

        match outcome {
            Err(err) => {
                // 233 is ERROR_PIPE_NOT_CONNECTED; 109 is ERROR_BROKEN_PIPE.
                // Either way the caller must see an error and reconnect.
                let code = err.raw_os_error().unwrap_or(0);
                assert!(
                    code == 233 || code == 109,
                    "unexpected error after disconnect: {err} (os {code})"
                );
            }
            Ok(None) => {
                // A clean end is also recoverable, but it must not be a hang.
            }
            Ok(Some(frame)) => panic!("a disconnected pipe must not deliver a frame: {frame}"),
        }

        peer.await.unwrap();
    }

    /// After a disconnect the name can be taken by a new server, and a fresh
    /// connection works: the client recovers without being restarted.
    #[tokio::test]
    async fn a_new_server_on_the_same_name_is_reachable() {
        let name = pipe_name("recover");

        let first = ServerOptions::new().first_pipe_instance(true).create(&name).unwrap();
        {
            let mut client = Conn::open(&name, Duration::from_secs(2)).await.expect("first open");
            drop(client);
        }
        drop(first);

        // A moment for Windows to release the name.
        tokio::time::sleep(Duration::from_millis(300)).await;

        let second = ServerOptions::new().first_pipe_instance(true).create(&name).expect("name is free again");
        let peer = tokio::spawn(async move {
            let mut server = second;
            server.connect().await.unwrap();
            let mut buffer = [0u8; 64];
            let read = server.read(&mut buffer).await.unwrap();
            String::from_utf8_lossy(&buffer[..read]).to_string()
        });

        let mut client = Conn::open(&name, Duration::from_secs(2)).await.expect("reopen after disconnect");
        client.send("{\"t\":\"hello\"}").await.expect("send on the new connection");
        let seen = peer.await.unwrap();
        assert_eq!(seen.trim_end(), "{\"t\":\"hello\"}");
    }
    /// A restarted host rewrites runtime.json with a new token. The client reads
    /// it on every attempt, so the token in force is always the current one.
    #[test]
    fn the_token_is_reread_after_the_host_restarts() {
        let _guard = STATE_DIR_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("coucou-dsh-rotate-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("runtime.json");
        std::env::set_var("COUCOU_DSH_STATE_DIR", &dir);

        std::fs::write(&file, r#"{"protocol":1,"pipe":"\\\\.\\pipe\\coucou-dsh-X","token":"old","pid":1}"#).unwrap();
        assert_eq!(read_runtime().expect("first read").token, "old");

        // The host restarts: same pipe name, new token.
        std::fs::write(&file, r#"{"protocol":1,"pipe":"\\\\.\\pipe\\coucou-dsh-X","token":"new","pid":2}"#).unwrap();
        let second = read_runtime().expect("second read");
        assert_eq!(second.token, "new", "a stale token must never be reused");
        assert_eq!(second.pid, Some(2));

        let _ = std::fs::remove_dir_all(&dir);
    }
    /// The token file is the only thing standing between a stranger and the
    /// bridge, so a missing or unreadable one must be a clear message.
    #[test]
    fn a_missing_runtime_file_says_the_bridge_is_not_running() {
        let _guard = STATE_DIR_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("coucou-dsh-empty-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("COUCOU_DSH_STATE_DIR", &dir);
        let error = read_runtime().expect_err("no runtime.json");
        assert!(error.contains("not running"), "{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A runtime file from a newer plugin is rejected rather than guessed at.
    #[test]
    fn a_runtime_file_is_read_as_written() {
        let _guard = STATE_DIR_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("coucou-dsh-state-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("runtime.json"),
            r#"{"protocol":1,"pipe":"\\\\.\\pipe\\coucou-dsh-S-1-5-21-1","token":"abc","pid":7}"#,
        )
        .unwrap();
        std::env::set_var("COUCOU_DSH_STATE_DIR", &dir);
        let runtime = read_runtime().expect("reads");
        assert_eq!(runtime.protocol, 1);
        assert_eq!(runtime.token, "abc");
        assert_eq!(runtime.pipe, r"\\.\pipe\coucou-dsh-S-1-5-21-1");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
