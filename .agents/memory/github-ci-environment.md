---
name: GitHub CI environment
description: Durable GitHub Actions differences that affect Equilibrium database and integration-test validation
---

# GitHub CI environment

GitHub Actions must configure PostgreSQL explicitly as the `runner` user with
the `equilibrium` database and use
`postgresql://runner@localhost:5432/equilibrium` for schema and test steps.

**Why:** Relying on the runner's default username produced repeated
`role "root" does not exist` errors, while the application and local workflow
are built around the `runner` role.

Chain-window integration tests that mine 100+ blocks can take roughly one
minute on hosted runners. Vitest's default 20-second timeout reports false
failures; keep the suite timeout at 120 seconds rather than skipping tests or
weakening assertions.

**How to apply:** When manually copying the prepared workflow files into
GitHub, preserve the explicit PostgreSQL service health check, connection
strings, and the raised Vitest timeout.