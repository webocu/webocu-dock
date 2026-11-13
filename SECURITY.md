# Security policy

## Supported versions

Only the latest release receives fixes.

## Reporting a vulnerability

Please do **not** open a public issue for a security problem.

Use GitHub's private reporting instead: open the
[Security tab](https://github.com/webocu/webocu-dock/security/advisories/new) of the repository
and choose *Report a vulnerability*. Include the version, the firmware of the TV, whether the
TV is rooted, and the steps to reproduce.

## What matters here

The helper service can run as root on a rooted TV, and it answers requests from other apps over
the luna bus. Reports about the service endpoints in `source/service/service.js` are especially
welcome, for example a way to make the `/icon` method read files outside the app directories,
or to start something the user did not ask for.
