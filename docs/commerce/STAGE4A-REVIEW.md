# Stage 4A review for Stage 4B

Reviewed candidate d4cafc6. Local changes only; original accepted worktree retained.

- HIGH, corrected: service-role inserts could append financial lines or status events independently of the immutable header and its audit/CRM evidence. Deferred consistency triggers now reject incomplete or inconsistent transactions. Mutation tests cover direct status and event injection.
- HIGH, corrected: immutable lines omitted published variant options. Lines now preserve the approved options JSON alongside name, SKU, product version and approved price reference.
- MEDIUM, corrected: an omitted organization could allow an opportunity with an inconsistent organization. The contact's organization is inferred and opportunity matching is exact.
- MEDIUM, corrected: an identical cancellation retry returned conflict. It now returns the original cancellation without duplicating history.
- Product-before-variant stable locking aligns with catalogue writes. Amounts and inclusive VAT remain integer kobo, derived from approved database values. No browser amount is accepted.

Staff customer-data access remains separately authorized and audited; anonymous and authenticated Data API roles have no access. CRM rows are reused rather than introducing a second customer database. The foundation remains non-payable and does not reserve stock.

The migration is still unapplied to production. This is a revision of the local candidate, not a production repair. Frozen schema expectations and hashes were regenerated only from the reviewed disposable fixture. Rollback before commit is transactional; after a future authorized release, disable the module and restore older code while retaining all financial, CRM and audit records. No destructive down migration.
