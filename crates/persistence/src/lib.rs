#![forbid(unsafe_code)]

//! SQLite persistence primitives for Harbor.

mod database;

pub use database::Database;
