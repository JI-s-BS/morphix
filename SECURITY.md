# Security policy

Morphix controls real machines that heat up and move, and it stores API keys and passwords. Security reports are very welcome.

## Reporting a vulnerability

Please **don't open a public issue** for a vulnerability.

1. Use GitHub's private reporting: the repository's **Security** tab → **Report a vulnerability**.
2. If that button isn't available, open an issue that says only "Security report: please contact me" (no details), and a maintainer
   will reach out privately.

Please include the version (`morphix version` or the commit), how Morphix is installed, what an attacker can do, and the steps to
reproduce it. Never include your real API keys, passwords or printer access codes; use placeholders.

We aim to reply within a week. Fixes go out through `morphix update`. Credit is given in the release notes unless you'd rather not be named.

## Scope

In scope: the server (`apps/server`), sign-in and settings (`packages/config`), printer drivers (`packages/printer`), the installer and
`morphix` command (`scripts/install`), and the web UI.

Especially interesting:
- getting past sign-in, CSRF or the admin/user roles;
- reading keys, passwords or files outside the library;
- making a printer heat, move or start without a user's confirmation, or beyond its catalog limits;
- the installer or updater running something it shouldn't.

Out of scope: problems that need someone already signed in as the admin, attacks that need the server exposed to the internet against
the [security advice](README.md#security), and bugs in third-party services or printer firmware (please report those to their makers).

## Supported versions

Only the latest release and `main` get security fixes.
