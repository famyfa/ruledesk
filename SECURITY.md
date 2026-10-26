# Security policy

RuleDeck manages firewalls, so security problems matter. Thank you for reporting them responsibly.

## Reporting a vulnerability

**Please don't open a public issue.** Instead use GitHub's private reporting: **Security ▸ Report a vulnerability** on this repository.

Include what you found, how to reproduce it, and what an attacker could do with it. Leave out real addresses and credentials.

This is a volunteer project without a security team. You'll get an answer as soon as possible, usually within a week. Fixes go into `dev` and are released from `main`, with credit in the changelog if you'd like.

## Supported versions

Only the latest release gets security fixes.

## Scope

In scope: the RuleDeck server, web app and container image in this repository.

Out of scope: OPNsense itself (report to the [OPNsense project](https://opnsense.org)), and problems that need an attacker who is already signed in with full OPNsense admin rights to the same firewall (RuleDeck can't do more than the signed-in user).

## Before you deploy

RuleDeck is a young, largely AI-written project with one internal security review ([docs/security.md](docs/security.md)) and **no independent audit**. Don't use it in production without your own review, keep it on a management network, and never expose it to the internet. See [docs/install.md](docs/install.md).
