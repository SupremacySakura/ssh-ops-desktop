#![forbid(unsafe_code)]

//! SQLite persistence primitives for OpsPilot.

mod database;

pub use database::Database;
