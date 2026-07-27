# GitHub Actions CI error fixes

This guide is for the Equilibrium repository when the GitHub workflow files
cannot be edited or pushed from the current environment. The source fixes are
already in the project checkout; copy the workflow files or snippets below
manually into the GitHub repository.

## 1. Copy the current workflow files

The root-level files are the copy-ready workflow definitions:

```text
android-apk-ci.yml  -> .github/workflows/android-apk.yml
.github/workflows/ci.yml -> .github/workflows/ci.yml
```

Do not use an older copy of either workflow from the GitHub repository. The
current CI workflow uses Node 24, builds the required WASM contracts, and
connects the test job to PostgreSQL as the `runner` role.

## 2. Rust `BlockHeader` compilation errors

`BlockHeader` now includes the `state_root` field. Every Rust initializer must
include a value, including test helpers, JNI/FFI callers, the consensus API,
the testnet binary, and the Android build.

For compatibility with callers that do not have a state commitment, use:

```rust
state_root: [0u8; 32],
```

The current checkout includes this field at all known construction sites.

## 3. Rust Clippy failures

The current checkout also contains the fixes required by the newer stable
Clippy used by GitHub:

- use `clamp(0.0, 1.0)` instead of a `.max(0.0).min(1.0)` chain;
- use captured format arguments such as `{value}`;
- use `map` when a `Result` closure only returns `Ok(())`;
- use the corrected Kademlia pattern match in `p2p-sidecar`;
- keep Rust doc-list continuation indentation at two spaces.

The validation commands are:

```bash
cd equilibrium
cargo check --all-targets
cargo clippy --all-targets -- -D warnings

cd ../variational-ai
cargo check --all-targets
cargo clippy --all-targets -- -D warnings
```

## 4. PostgreSQL service configuration

The GitHub test job must create and use the same role/database pair as the
application. In the `ts-test` job, use this service definition:

```yaml
services:
  postgres:
    image: postgres:16
    env:
      POSTGRES_USER: runner
      POSTGRES_PASSWORD: ""
      POSTGRES_DB: equilibrium
      POSTGRES_HOST_AUTH_METHOD: trust
    ports:
      - 5432:5432
    options: >-
      --health-cmd "pg_isready -U runner -d equilibrium"
      --health-interval 10s
      --health-timeout 5s
      --health-retries 5
```

Use explicit connection strings in schema and test steps:

```yaml
- name: Push DB schema
  run: DATABASE_URL="postgresql://runner@localhost:5432/equilibrium" pnpm --filter @workspace/db run push --config ./drizzle.config.ts

- name: Run all Vitest tests
  run: pnpm --filter @workspace/api-server run test
  env:
    DATABASE_URL: postgresql://runner@localhost:5432/equilibrium
```

This avoids the `FATAL: role "root" does not exist` messages from a workflow
that relies on the runner's default PostgreSQL username.

## 5. Vitest timeouts

Several integration tests intentionally advance the chain by 100 or more
blocks. That work takes roughly one minute on a GitHub-hosted runner because
each block exercises finality and persistence. The old 20-second timeout
reported failures even when the test eventually passed.

The project now sets:

```ts
testTimeout: 120_000,
```

No test is being skipped and no assertion was weakened. The timeout only
allows the existing chain-window integration scenarios to finish.

## 6. Manual verification before rerunning Actions

From a clean checkout, run:

```bash
pnpm install --frozen-lockfile
pnpm run typecheck:libs
pnpm run typecheck

cd equilibrium && cargo check --all-targets
cargo clippy --all-targets -- -D warnings
cargo test --all-targets

cd ../variational-ai && cargo check --all-targets
cargo clippy --all-targets -- -D warnings
cargo test --lib
```

Then copy the current workflow files into GitHub and rerun the APK and CI
jobs. The APK job still requires the Android keystore secrets documented in
`docs/mobile-apk-release.md`.