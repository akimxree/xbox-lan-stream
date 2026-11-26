# Contributing

Thanks for taking a look. This is a Windows-only Electron app for low-latency
Xbox home streaming.

## Setup

```powershell
git clone https://github.com/OWNER/xbox-lan-stream.git
cd xbox-lan-stream
npm install
npm run setup:player
npm run lint
npm start
```

`npm run setup:player` clones and builds
[`unknownskl/xbox-xcloud-player`](https://github.com/unknownskl/xbox-xcloud-player)
into `vendor/`. It is not committed.

## Rules

- Do **not** commit `.xbox.tokens.json`, screenshots with a gamertag, console
  IDs, IP addresses, or logs containing tokens.
- Keep the media path local: no TURN/relay defaults, no cloud video.
- Do not add frame-generation claims. Any interpolation must be clearly marked
  experimental and off by default.
- Match the existing style: vanilla renderer JS, no bundler, `npm run lint`
  must pass.
- Test on Windows 10/11. If you cannot test with a console, say so in the PR.

## Pull requests

1. Fork and create a branch.
2. Keep changes focused.
3. Describe what you measured (path, RTT, decode, freeze/drop), not just what
   changed.
4. Include the console model and connection type only if relevant; do not
   include serial numbers, gamertags or IPs.

## Security

See [SECURITY.md](SECURITY.md). Never open a public issue with a token.

