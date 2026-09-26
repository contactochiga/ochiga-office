# Wave 9 security convergence — incremental record

Base: authoritative `codex/office-extraction` at 8f58aaef1263dfbd019d319651a95e8fb7617b80. Fresh source audit, not lost cloud reconstruction.

## First verified increment

- Internal Core bridge now derives staff ID, email, role and permissions exclusively from Office authentication context. Previously body.staff took precedence, allowing browser context to impersonate staff in Core requests.
- Plan Studio project list/detail GETs are no longer public API exclusions and require planstudio.read. Public static shell remains available; stored image/geometry/project data does not.
- No migration, scoring, CRM workflow or physical execution change.

Proof: test-wave9-authority-boundaries exercises spoofed body.staff and real local HTTP denial for both project routes. check, lint, build, office:oyi-internal-context:test, office:oyi-core-delegation:test, office:contract-hardening:test and security:secrets all pass.

Remaining: public CRM identity ownership, governed memory/context, Plan Studio reasoning convergence, full cross-repository closure. This record is NOT Wave 9 closure.
