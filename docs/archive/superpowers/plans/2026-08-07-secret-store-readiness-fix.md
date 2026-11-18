# Secret Store Readiness Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `core_health.secretStoreReady` reflect a real, non-mutating operating-system credential-store access probe instead of a hard-coded `true`.

**Architecture:** Add a narrow `SecretStoreReadiness` boundary implemented by the system keyring and memory store. The keyring probe reads a reserved, normally absent account and treats either a value or `NoEntry` as healthy; all backend-access errors remain failures. `CoreServices` becomes generic over this boundary so the health command can be tested deterministically without accessing the developer's credential store.

**Tech Stack:** Rust 2024, `async-trait`, `keyring` 4.1.6, Tokio, Tauri 2

## Global Constraints

- The readiness probe must not write or delete credentials.
- The health response must expose only the readiness boolean, never keyring paths, account data, or backend error details.
- Existing database readiness behavior and Tauri command names must remain unchanged.
- Tests must prove the existing hard-coded implementation fails before production code changes.
- Preserve all unrelated uncommitted work in the current worktree.

---

### Task 1: Replace the hard-coded secret-store health signal

**Files:**
- Modify: `crates/secrets/src/lib.rs`
- Modify: `crates/secrets/src/keyring_store.rs`
- Modify: `crates/secrets/src/memory_store.rs`
- Modify: `src-tauri/src/commands/health.rs`

**Interfaces:**
- Consumes: `keyring::Entry::new`, `keyring::Entry::get_password`, `keyring::Error::NoEntry`, `CoreError`.
- Produces: `SecretStoreReadiness::probe_readiness(&self) -> Result<(), CoreError>` and an accurate `CoreHealth.secret_store_ready` boolean.

- [x] **Step 1: Write failing tests for unavailable and accessible stores**

Add a health-command test with a test double whose readiness probe returns `CoreErrorCode::SecretUnavailable`, and assert that `secret_store_ready` is `false`. Add keyring-local tests proving `NoEntry` is accepted as an operational read while `NoDefaultStore` remains an error.

```rust
#[tokio::test]
async fn reports_an_unavailable_secret_store_as_not_ready() {
    let database = Database::open(":memory:")
        .await
        .expect("in-memory database should open");
    let services = CoreServices::new(database, UnavailableSecretStore);
    let health = read_core_health(&services).await.expect("health should be readable");
    assert!(!health.secret_store_ready);
}

#[test]
fn missing_probe_entry_still_means_the_store_is_readable() {
    assert!(classify_readiness_probe(Err(keyring::Error::NoEntry)).is_ok());
}
```

- [x] **Step 2: Run the focused test and verify RED**

Run: `cargo test -p opspilot-desktop reports_an_unavailable_secret_store_as_not_ready`

Expected: FAIL because the current `CoreServices` only accepts `KeyringSecretStore` and the readiness boundary does not exist.

- [x] **Step 3: Implement the non-mutating readiness boundary**

Define the trait in `crates/secrets/src/lib.rs`, return `Ok(())` from the in-memory implementation, and have the keyring implementation run this blocking operation through the existing `run_keyring` adapter:

```rust
let entry = keyring::Entry::new(SERVICE, READINESS_ACCOUNT)?;
classify_readiness_probe(entry.get_password())
```

The classifier maps `Ok(_)` and `Err(keyring::Error::NoEntry)` to `Ok(())`, forwarding every other keyring error. Make `CoreServices<S = KeyringSecretStore>` generic over the readiness boundary and set `secret_store_ready` from `probe_readiness().await.is_ok()`.

- [x] **Step 4: Run focused tests and verify GREEN**

Run: `cargo test -p opspilot-desktop commands::health`

Expected: all health tests PASS, including the unavailable-store regression.

- [x] **Step 5: Run affected-crate and static verification**

Run these commands independently:

```bash
cargo test -p opspilot-secrets
cargo test -p opspilot-desktop --features native-e2e
cargo fmt --check
cargo clippy -p opspilot-secrets -p opspilot-desktop --all-targets --features native-e2e -- -D warnings
git diff --check
```

Expected: every command exits 0 with no test failures or warnings.
