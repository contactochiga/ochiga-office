# Area D — browser journeys (first-contact certification)

Run any file: `SUT_DIR=<system dir> SUT_OLD_DIR=<previous release> node <file>` (default SUT = three directories up).
Each file starts its own server (file store, private temp dir, free port) and its own headless Chrome (private profile, process group killed in `finally`),
prints `FAIL ...` lines and one final JSON line. Exit 0 = pass, 1 = failures, 2 = BLOCKED. `D_WIDTHS=390,1440` limits widths while debugging.
Files are kept below ~9 minutes each when run alone (run them one or two at a time; heavy parallel load can exceed the budget).

## Layout
- `lib/harness.js` check recorder, server launcher, raw-CDP Chrome driver (mouse/keyboard/AX/virtual authenticator), TOTP/base32, HTTP fixtures, audits
- `lib/flows.js` reusable UI flows; `lib/mailstub.cjs`, `lib/clockshift.cjs` preloads for the SUT child process only (capture the single outbound e-mail call; move the server clock forward). The SUT is never modified.

## Files and coverage (all UI journeys at 1440/1100/900/768/390 unless noted)
| file | covers |
|---|---|
| d1-signin-widths | password-first sign-in, wrong password, enumeration (UI words), deactivated account, challenge has no authority, reload during challenge, wrong/stale/empty/replayed TOTP, logout + copied cookie refused, layout, 44px targets, AX names |
| d2-keyboard-signin | keyboard-only sign-in and second factor (TOTP, recovery), tab order, focus entry/return, method switch, Escape, back link, recovery single use |
| d3-enrol-manage | first enrolment (local QR, manual key, confirm, recovery codes once: copy/download/print/ack/cleared), replace/regenerate/remove with step-up (1440, 390 full), focus trap |
| d4-securitykey | virtual authenticator: register, sign in, no-UV, missing credential, step-up with key, clone/counter rollback, foreign authenticator, browser without WebAuthn |
| d5a-failsafe | expired challenge (5 widths), second-factor lock, login throttling incl. header spoofing, server down, store fault |
| d5b/d5c-ended-sessions | server-ended sessions: revocation, deactivation/restoration, admin password change, factor added elsewhere (split by width) |
| d6a/d6c-policy | enforcement screens: preflight, blocked apply, bypass over API, purpose isolation, plain user (split by width) |
| d6b-reset | administrator reset of another person's factors, effects on target, permission denial |
| d7a-apply | governed apply, wrong factor, stale version, lowering (1440, 390) |
| d7b-grace-guard | grace banner at 5 widths, required-role last-factor guard |
| d7c-forced | forced enrolment with mailbox code at 5 widths, mailbox code expiry |
| d8-focus-dialogs | focus entry, trap and return for panel / confirm / step-up dialogs |
