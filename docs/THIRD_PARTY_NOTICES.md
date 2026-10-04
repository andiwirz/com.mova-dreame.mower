# Third-party runtime notice / provenance audit 

This file documents third-party runtime material that is physically bundled in the Homey app or fetched at runtime. It does not replace the upstream licence texts. No licence terms are invented here.

## Bundled XP2P support runtime

The directory `native/xp2p/runtime/` contains an AArch64 host worker plus Android/Bionic/VNDK support files used by the Homey-local XP2P camera path. Exact file hashes are pinned in `lib/video/DreameXp2pRuntimeBootstrap.js` and runtime background is recorded in `native/xp2p/runtime/PROVENANCE.txt`.

Bundled Android-derived files include `linker64`, Bionic `libc.so`, `libm.so`, `libdl.so`, `ld-android.so`, `libc++.so` (stored as `libstdc++.so` in this package), and VNDK `liblog.so` / `libz.so`. Their binary origins are pinned to Android Open Source Project prebuilts by immutable Gitiles commit URLs/hashes in `DreameXp2pRuntimeBootstrap.js`. AOSP Bionic components have mixed applicable licence kinds; current AOSP build metadata identifies Apache-2.0, BSD, ISC, MIT and notice/unencumbered material for libc, while the linker target identifies BSD. Therefore a single blanket licence label must not be substituted for the component-specific upstream notices.

**Release note:** the exact source-level NOTICE payload corresponding to each pinned prebuilt is not bundled in this PR candidate and could not be derived solely from the binary files. Before an app-store/public binary distribution where redistribution notices are mandatory, the maintainer should attach the exact upstream NOTICE/licence material matching the pinned Android revisions. This cleanup intentionally documents the gap rather than fabricating licence text.

## Worker source

`native/xp2p/source/` and the bundled host worker are documented in `PROVENANCE.txt` as derived from the open-source `EvotecIT/homeassistant-dreamelawnmower` implementation. That upstream repository is published under the MIT licence. The local project should retain the upstream attribution/provenance when redistributing derived worker code/binaries.

## Tencent XP2P SDK

The proprietary Tencent XP2P shared library is **not bundled in this release ZIP**. At first camera use, the runtime downloads Maven artifact `com.tencent.iot.thirdparty.android:xp2p-sdk:2.4.50`, verifies the pinned AAR and shared-library SHA-256 values, and installs the verified library into Homey userdata. This document does not assert redistribution rights or a licence for that proprietary artifact.

## Local shim binaries

`libnodelab_dnsfix.so` and `libnodelab_xnettrace.so` are bundled support shims used by the Homey-local worker. Their names are historical and do not create an external NodeLab runtime dependency. `PROVENANCE.txt` states their origin from the supplied NodeLab test reference and corresponding local source is under `native/xp2p/source/`. No separate third-party licence file for these two local shims was present in the current PR input; this remains a provenance item to verify before public redistribution if their copyright/licence ownership is not already covered by the project contributor history.

## npm dependencies

Runtime npm dependency: `mqtt`. Development-only preview dependency: `sharp`. Their dependency metadata remains in `package-lock.json`; `npm run prepublish:homey` prunes devDependencies before Homey publishing.
