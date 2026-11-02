# Stage 4B additive security gate

Read-only gate; never an authorization to migrate. It retains the frozen Stage 4A gate and all prior checks verbatim, adds exact checkout receipt/function metadata and requires P4A before P4B. The matching fixture is generated only from the reviewed local migration. Baseline, manifest and migration SHA256 pins are in build-gate.py.

Run `python3 release/phase4b-gate/build-gate.py` to reproduce. Run `TEST_CHECKOUT=true TEST_CHECKOUT_WEB=true node scripts/test-hardware-orders-postgres.js` for absent/applied, rollback and tampered-schema checks plus HTTP integration. Synthetic credentials and disposable loopback services only.

Production flags remain disabled. Production migration requires separate authorization and a fresh production preflight. Disable features and restore earlier code for post-release rollback; retain durable evidence.
