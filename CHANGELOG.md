# Changelog

## 0.1.0 — 2026-11-26

First public MVP.

### Streaming

- MSAL device-code sign-in; xHome streaming token; loopback control-plane proxy
  so the token never reaches the renderer.
- Console discovery and `xHome` session provisioning.
- WebRTC H.264 + Opus receive; LAN-only ICE policy applied to both the `/ice`
  payload and `a=candidate` lines in SDP.
- Codec preference order and SDP bandwidth hints.
- `--disable-gpu-vsync` + `--disable-frame-rate-limit` by default
  (pipeline ~20 ms → 7–10 ms).
- Stall detection with automatic I-frame request.

### Quality

- WebGL2 Catmull-Rom upscale + RCAS-like sharpening (default 0.42).
- Experimental Smooth 30→45/60 crossfade (off by default).
- H.264 High offered first; Series X still answers Main 4.2.

### Input

- Keyboard/mouse passthrough with raw pointer lock.
- KBM → virtual Xbox gamepad with four context profiles
  (`ON FOOT`, `VEHICLE`, `AIRCRAFT`, `BICYCLE`) and GTA 6 mapping.

### Metrics / UI

- One-screen UI with a compact HUD: latency, RTT, ICMP, bitrate, FPS, decode,
  jitter buffer, loss, jitter, freeze, drop, path.
- `F1` HUD, `F3` decode overlay, `F4` pad profile, `F11` fullscreen, `Esc` stop.

### Network tooling

- `scripts/ics.ps1` — ICS enable/disable with firewall rules.
- `scripts/nat.ps1` — `New-NetNat` fallback when ICS COM is unavailable.
- `scripts/tune-nic.ps1` — interrupt moderation / EEE / power saving.
- `scripts/net-check.ps1` — adapter and offload diagnostics.
