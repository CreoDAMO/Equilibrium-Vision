---
name: Android Activity manifest rule
description: Every Activity must be declared in AndroidManifest.xml — missing registrations cause a silent hard crash
---

## Rule
Every `Activity` subclass that can be started with `startActivity()` **must** be declared in `AndroidManifest.xml`. If it's missing, Android throws `ActivityNotFoundException` the instant `startActivity()` is called — the app crashes immediately with "keeps stopping".

**Why:** Equilibrium Miner had `BootstrapQrActivity` implemented and reachable via the "Join Network" button in `MainActivity`, but it was never added to the manifest. The activity, its layout, and its strings all existed; only the manifest entry was absent. The crash had no obvious log trail on the device side.

## How to apply
Any time a new `Activity` is created:
1. Add it to `AndroidManifest.xml` under `<application>`:
   ```xml
   <activity
       android:name=".MyNewActivity"
       android:exported="false" />
   ```
2. If it handles deep-links, add `<intent-filter>` with the scheme/host.
3. If it should receive `onNewIntent` when already on top, add `android:launchMode="singleTop"`.

Non-exported activities (launched only from within the app) must still be listed — `exported="false"` is not an excuse to omit them.

## Detection
If `startActivity(Intent(this, Foo::class.java))` crashes immediately and LogCat shows `ActivityNotFoundException: Unable to find explicit activity class`, the class is not in the manifest.
