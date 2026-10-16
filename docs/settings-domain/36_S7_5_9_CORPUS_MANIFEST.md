# S7.5.9 certification corpus manifest (frozen before the official run)

Evaluated runtime commit: `fc58ec47bcb107e0b7ade77fe2cd71e4694153a8`. Digests are SHA-256 of the committed files. The official run uses exactly these files; any later change to a test is listed in the report with its reason.

| File | SHA-256 |
|---|---|
| `scripts/cert/cert-lib.js` | `88f70a7a7a92999ecb4f0d8a1ceaf947bd2bbf491a1f5fde955e247989d7d2c1` |
| `scripts/cert/cert-auth-session.js` | `76980193f8a23b9313b35064fe9910433b943719e7bc482f9bf3c7fee7a468ef` |
| `scripts/cert/cert-mfa-lifecycle.js` | `4bed12f02e448df78baea3495564e51f536a5241ad08006842112a22084b5b95` |
| `scripts/cert/cert-database.js` | `d890648d483b48bb827aada3cf1009063be7bc64a2dac172352ecaccb95345fd` |
| `scripts/cert/cert-browser.js` | `3c081249b4d5d56427cee544e9aea085c1adbfcbcd3c05558e62757592400918` |

Harness development note: the tests were smoke-run against the evaluated code while being written. Defects **in the tests** found that way (wrong selectors, a reused TOTP step, a stale-cookie binding, a constraint name, an accessibility role name, a fixture that tripped the lock) were corrected before this freeze; no test was changed to make a control pass.
