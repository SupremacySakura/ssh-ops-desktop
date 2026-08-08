# SSH compatibility boundary

OpsPilot uses `russh` as the default SSH transport. Host identity is verified through the
SQLite-backed TOFU store before authentication, and a changed key is never accepted silently.
Password values and key passphrases are resolved from the native secret store inside Rust.

The native path supports password, private-key, OpenSSH certificate, and SSH-agent
authentication; PTY shell channels; the SFTP subsystem; direct TCP/IP forwarding; dynamic
SOCKS5 forwarding; and `direct-streamlocal@openssh.com` for remote Unix sockets. Remote TCP
forwarding remains capability-gated until the server-initiated channel lifecycle is connected
to the desktop event loop.

OpenSSH fallback is limited to compatibility cases. It builds an executable plus an argument
vector, clears the environment, passes only an allowlist, and never invokes a shell. Importing
`~/.ssh/config` previews only `Host`, `HostName`, `User`, `Port`, `IdentityFile`, and `ProxyJump`;
unsupported directives are reported and never executed. Import does not copy private keys or
trust host keys.
