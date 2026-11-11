// The DSH Host Bridge client.
//
// DeepSeek Harness runs a plugin that publishes its sessions, catalog and
// approval requests over a private named pipe. This module is Coucou's side of
// that conversation: it connects, authenticates with the token the plugin wrote
// into its own state folder, keeps the connection alive, and exposes what it
// learns to the island.
//
// Nothing here can grant a permission on its own. An approval is answered only
// by an explicit click on a card that belongs to a specific request.

pub mod client;
pub mod protocol;
pub mod wire;

#[allow(unused_imports)]
pub use client::{start, Dsh, Snapshot};