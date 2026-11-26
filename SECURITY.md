# Security

## Tokens

The app stores Xbox authentication tokens locally:

- `%APPDATA%\xbox-lan-stream\.xbox.tokens.json`, or
- `.xbox.tokens.json` in the project directory if it exists there.

That file is a **bearer credential**. Do not commit it, paste it into an issue,
attach it to a log, or share screenshots of the settings drawer while it is
visible.

`.gitignore` excludes it. If you accidentally publish it, sign out of the app
(“Выйти” / logout) and revoke the session in your Microsoft account.

## Reporting

For a vulnerability, open a private security advisory on GitHub or contact the
maintainer directly. Do not include tokens, gamertags, console IDs, or private
IP addresses in a public issue.

## Scope

This is an unofficial client for a protocol without public documentation. It is
not affiliated with Microsoft. Use it at your own risk and in accordance with
the Xbox / Microsoft service terms.
