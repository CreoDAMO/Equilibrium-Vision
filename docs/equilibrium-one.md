# Equilibrium One — Build 0

Status: a device we can assemble and load. It is not a custom processor, and it is not a closure of C-007.

Build 0 runs the software that exists. The research substrates in section 11 are not part of this build, and none of them may change what the protocol computes.

## 1. What this device is

A battery-powered Android instrument that searches residual candidates and reports them to `equilibriums.site`.

It is one node of participation, not a mining appliance. Docking it does not give it authority. A higher reported height does not give it authority. A secure element does not give it authority.

## 2. What it must not do

The current program does not do these things, and Build 0 must not pretend that it does.

| Forbidden claim | Why |
| --- | --- |
| Adopt a canonical successor | C-007 is open. `ADOPTION_REQUIRES_TRANSITION_PROOF` is false. The phone does not run `applySuccessor`. |
| Treat a peer tip as Ω | The site light template is a work assignment. It is not the predecessor. |
| Reconstruct the chain from a remembered hash | The app stores a network name and a miner address. It does not store Ω. |
| Use approximate hardware as the transition | Photonic, memristive, or neuromorphic results are not `Reference`. |
| Offer an APK from anywhere but this site | `GET /api/miner/release` is the only update manifest. |

The native contract remains `search_canonical` residual admission. `apkDoesNotEmbody` remains `applySuccessor`.

## 3. Software this build loads

| Item | Value |
| --- | --- |
| Package | `com.equilibrium.miner` |
| Version | 0.4.0, versionCode 4 |
| Binary | the signed APK from Actions run `40103500681`, commit `74072eb` |
| Manifest | `site/src/protocol/miner-release.ts` |
| File | `https://equilibriums.site/downloads/equilibrium-miner-0.4.0.apk` |
| Update check | `https://equilibriums.site/api/miner/release` |
| Minimum OS | Android 8, `minSdk` 26 |
| Networks | mainnet is chain id 1, testnet is chain id 2 |
| Default work target | `https://equilibriums.site` |

Mining stops before a network switch. Peer gossip stays off. A submission is a candidate. The site may refuse it. The phone does not install its own block.

The miner address is an app preference. Build 0 does not put a key in the Android hardware keystore, because the 0.4.0 program does not. Do not describe the enclosure as protecting a key the software never asks it to hold.

## 4. Participation modes

These are the modes in `participation()` in `site/src/protocol/membranes.ts`. They are local work limits. They are not validator roles.

| Condition | Mode | What the device does |
| --- | --- | --- |
| Below 38°C and battery above 40% | `solve` | Search a nonce. The result is a candidate. |
| 38–42°C, or battery from 15% to 40% | `verify` | Do not search. |
| At or above 42°C, or battery below 15% | `defer` | Do not search. Keep the preferences. |

A full-state role is not in this build. Nothing in the APK adopts, seals, or replays Ω.

## 5. Reference assembly

Any substitute must meet the interface spec in section 6. This kit is the one to buy first, because it runs the APK without a new operating system.

| Part | Specification |
| --- | --- |
| Handset | Android handheld, Android 14 or newer, `arm64-v8a` |
| Memory | 8 GB RAM minimum |
| Storage | 128 GB internal, encrypted by the platform |
| Display | Touchscreen, at least 720 × 1600 |
| Battery | At least 5000 mAh, user-accessible charge over USB-C |
| Cooling | The phone's own passive path. No added fan in Build 0 |
| Radio | Wi-Fi and LTE. Bluetooth is unused by 0.4.0 |
| Dock | USB-C dock with gigabit Ethernet and power delivery. Optional |

No accelerator board. No custom ASIC. No CNT, photonic, or memristive module in the enclosure.

## 6. Interfaces

| Interface | Requirement |
| --- | --- |
| Power | USB-C charging. The device must keep running on battery with the radios up |
| Network | HTTPS to `equilibriums.site`. Ethernet only through the dock |
| Install | Sideload the site APK. Unknown-sources is an operator step, not a store |
| Identity | The miner address is entered or taken from `equilibrium://wallet?address=` |
| Update | The app opens the manifest. If `published` is false, it stays on the installed build |
| Recovery | After power loss, the app reads the saved network and address. It does not invent a tip |

The dock may add power, Ethernet, and a cooler place to leave the device. It must not be required for `solve` on Wi-Fi or LTE. Plugging it in does not change chain id, role, or what a submission means.

## 7. Thermal and power

The thresholds in section 4 are the software contract. They are not measurements of a particular chassis. Before a second enclosure is cut, record on the reference handset:

- degrees at the skin after 30 minutes of `solve`
- battery percent per hour on Wi-Fi and on LTE
- whether the platform reports a temperature the app can read

Build 0 may show those readings. It may not change the thresholds to suit a case.

## 8. What is stored

| Stored | Not stored |
| --- | --- |
| Selected network | Ω, FS1, or a predecessor |
| Miner address | A validator key |
| Last light height the screen showed | A proof, a seal, or a carried tip |

A restart that shows a height is showing what the site last answered. That height is not local canonical state.

## 9. Screen

The screen must keep these distinct, in words a person can check:

- the network in use
- the participation mode from section 4
- the site's reported height, labeled as the site's answer
- the last submission and the site's refusal or acceptance
- whether an update is published

A peer-reported tip, an authenticated checkpoint, and a locally adopted state are three sentences. Build 0 has only the first kind of number, and only when the site sent it.

## 10. Acceptance

Build 0 is accepted only if each of these is true on the assembled device.

1. The installed package is versionName `0.4.0`, versionCode `4`, and its SHA-256 equals the manifest.
2. The update check requests `/api/miner/release` on the configured origin and does not request GitHub.
3. With the manifest unpublished, the app stays on its build. With this manifest published, a versionCode of 4 is not offered as an update over itself.
4. Switching mainnet and testnet changes the work request and the submission, and search stops before the switch.
5. A submission does not change the site's canonical tip by itself.
6. Force-stop and reboot restore the network and the address, and do not restore a private chain.
7. Airplane mode does not create a block.

## 11. Not in this build

The physical-computing program is a separate investigation. It does not gate Build 0, and it does not replace section 2.

| Track | Question | Allowed output | Not an output |
| --- | --- | --- | --- |
| R1 Materials | Can CNT or 2D logic run the deterministic operations at lower energy? | A feasibility note with a measured gate, not a product claim | A substitute for `applySuccessor` |
| R2 Workload | What does one production transition cost? | Operations, bytes moved, and energy, taken from the reference interpreter | A processor choice made from a brochure |
| R3 Memory | Can MRAM hold a journal across power loss? | A memory-hierarchy proposal | A tip hash treated as continuity |
| R4 Execution | What machine is allowed to execute `Reference`? | An architecture that matches the interpreter bit for bit | A faster approximation |
| R5 Integration | Can more than one substrate share one device? | A diagram with a supervisor and an exactness boundary | Authority created by the supervisor |
| R6 Enclosure | What is the second physical concept after Build 0 is measured? | A revision of sections 5 and 7 | A new protocol |

Category A stays on exact digital logic: the transition, FS1, the commitments, proof verification, and adoption. Category B, if it is ever built, may only rank candidates. A candidate that enters the site is checked by the site's own rules. An accelerator that disagrees with those rules is a failed part.

C-007 stays open until a proof of the carried transition is required at adoption. No material in this section closes it.

## 12. Build order

1. Load the published 0.4.0 APK onto the reference handset.
2. Run section 10.
3. Record the section 7 measurements.
4. Only then open R2 against `applySuccessor` on a machine that is not this handset.

Do not design a compute module until those measurements exist.
