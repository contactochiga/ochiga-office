# Wave 9 security convergence — incremental record

Base: authoritative `codex/office-extraction` at 8f58aaef1263dfbd019d319651a95e8fb7617b80. Fresh source audit, not lost cloud reconstruction.

## First verified increment

- Internal Core bridge now derives staff ID, email, role and permissions exclusively from Office authentication context. Previously body.staff took precedence, allowing browser context to impersonate staff in Core requests.
- Plan Studio project list/detail GETs are no longer public API exclusions and require planstudio.read. Public static shell remains available; stored image/geometry/project data does not.
- No migration, scoring, CRM workflow or physical execution change.

Proof: test-wave9-authority-boundaries exercises spoofed body.staff and real local HTTP denial for both project routes. check, lint, build, office:oyi-internal-context:test, office:oyi-core-delegation:test, office:contract-hardening:test and security:secrets all pass.

Remaining: public CRM identity ownership, governed memory/context, Plan Studio reasoning convergence, full cross-repository closure. This record is NOT Wave 9 closure.

## Public CRM/session increment

Public session/chat now issue purpose-separated HMAC tokens using the existing server session secret. Tokens bind a random session ID, its newly-created lead, its Core thread and a seven-day expiry. Body lead_id, email, phone, thread_id, contact_ref and opportunity_ref cannot select another person's CRM context. Contact fields may capture a new enquiry but are not authentication. Repeat requests need the signed token; old clients without it receive a new isolated enquiry instead of implicit access by lead ID. The bundled widget retains/returns the token. Production refuses the development signing-secret fallback.

Public responses no longer return raw CRM lead objects, staff conversation history or internal bridge context; public Core requests omit CRM staff summaries. Internal CRM/store and authenticated intake workflows remain unchanged. Explicit verified contact-linking and token revocation before expiry are not provided by this slice; old unsigned session continuity intentionally does not survive the security boundary.

test-wave9-public-session performs actual local HTTP requests through Office and a fake Core, proving forged lead IDs and email/phone matches cannot read/update the seeded victim, signed continuity works, invalid/expired tokens fail, and staff notes are not returned. check/lint/build, public-intelligence, Core-delegation and secrets checks pass.
