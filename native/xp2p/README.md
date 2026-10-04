# App-internal XP2P runtime

This directory contains the AArch64 worker and support runtime used by the optional Homey-local live-video path. The app installs the runtime on demand under `/userdata/dreame-xp2p`; no external server or manual setup is required.

The current integration is **video-only**. It exposes H.264 video through the XP2P -> FLV -> Homey/widget path. Camera audio, speaker controls and audio/AAC diagnostics are intentionally not part of this runtime contract. Ordinary mower volume and voice settings are unrelated and remain supported.

The runtime is hash-pinned in `lib/video/DreameXp2pRuntimeBootstrap.js`. The proprietary Tencent XP2P library is not bundled; it is fetched from the pinned Maven artifact at first camera use and accepted only after SHA-256 verification. Source/provenance information for the bundled worker and local shims is recorded in `runtime/PROVENANCE.txt`; third-party redistribution notes are in `docs/THIRD_PARTY_NOTICES.md`.
