#![forbid(unsafe_code)]

//! SQLite persistence primitives for OpsPilot.

mod database;
mod server_repository;

pub use database::Database;
pub use server_repository::ServerRepository;
