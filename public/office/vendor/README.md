# Vendored browser code

| File | Package | Version | Licence | Source | sha-256 |
|---|---|---|---|---|---|
| `qrcode-generator.mjs` | `qrcode-generator` (Kazuhiko Arase) | 2.0.4 | MIT | `dist/qrcode.mjs` from the npm tarball | `ea91d7118a5395289170da848b7c6758b996163bfbccf312591ab65a4911b7c0` |

Unmodified. Review (S7.5.8): no network code (`fetch`/`XMLHttpRequest` absent; the only URLs are licence comments and the SVG namespace), no dependencies. Office uses it only to compute the QR module matrix in the browser; the SVG is built by `mfa-ui.mjs` from booleans. Enrolment secrets never leave the page except to Office's own endpoints. The MIT licence text is the header of the file.
