---
name: Android network security config
description: Correct structure for network_security_config.xml; what is and isn't allowed in debug-overrides
---

## Rule
`<debug-overrides>` may ONLY contain `<trust-anchors>`. Putting a `<domain-config>` inside it is a lint error that **fails the release build** (`NetworkSecurityConfig` fatal lint).

**Why:** Android's Network Security Config schema is strict; AGP's lint-vital task enforces it at release time.

## How to apply
- `src/main/res/xml/network_security_config.xml` — production-safe config:
  ```xml
  <base-config cleartextTrafficPermitted="false">…</base-config>
  <debug-overrides><trust-anchors>…</trust-anchors></debug-overrides>
  ```
- `src/debug/res/xml/network_security_config.xml` — debug-only override (Gradle merges src/debug/ into debug APKs only):
  ```xml
  <base-config cleartextTrafficPermitted="false">…</base-config>
  <domain-config cleartextTrafficPermitted="true">
    <domain>10.0.2.2</domain>  <!-- emulator host alias -->
    <domain>localhost</domain>
  </domain-config>
  ```
  This file never ships in release APKs.
