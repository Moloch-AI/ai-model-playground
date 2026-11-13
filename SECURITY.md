# Security policy

## Reporting a vulnerability in this repository

Report vulnerabilities in the playground (the server in `server/` or the web app in `src/`)
through GitHub private vulnerability reporting: open this repository's **Security** tab and choose
**Report a vulnerability**. Please do not open a public issue for a security problem.

Useful details: the version or commit, how the server was configured (without secrets), the
steps to reproduce, and what an attacker could do.

## Problems with the hosted API

Problems with the MolochAI API itself (`api.molochai.dev`) or your account go to
https://molochai.dev/contact?utm_source=github&utm_medium=oss&utm_campaign=ai-model-playground,
not to this repository.

## Never post API keys

Never paste an API key, a `.env` file or a `PLAYGROUND_ACCESS_TOKEN` into an issue, pull request
or discussion. If a key was exposed, revoke it in the dashboard
(https://dash.molochai.dev/account?utm_source=github&utm_medium=oss&utm_campaign=ai-model-playground)
and create a new one.

## Scope notes

The playground is a proxy that holds an API key. The README's
[Security considerations](README.md#security-considerations) section and
[docs/deployment.md](docs/deployment.md) describe the defaults and the risk of exposing it to a
network; reports about configurations they already warn against (for example running with an
access token over plain HTTP on a public network, or `PLAYGROUND_ALLOW_NO_TOKEN` with a port
published on every interface) are still welcome, but may be answered with documentation changes.
