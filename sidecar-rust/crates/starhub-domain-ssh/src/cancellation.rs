//! Request-scoped cancellation shared by queued and running domain work.

/// Sticky cancellation: late subscribers also observe an earlier stop.
pub use tokio_util::sync::CancellationToken as Cancellation;
