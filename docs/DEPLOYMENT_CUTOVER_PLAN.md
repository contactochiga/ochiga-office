# Ochiga Office Deployment Cutover Plan

This plan prepares the standalone Office deployment without mutating production credentials or databases automatically.

## Target Ownership

- Office runtime: `contactochiga/ochiga-office`
- Office source of truth: corporate CRM, lead intake, commercial workflows and Office intelligence surfaces
- Edge source of truth: local physical-building runtime only
- Backend source of truth: operational/building/platform state and Oyi Core intelligence

## Pre-Cutover Checks

1. Review `docs/ROTATION_CHECKLIST.md` and prepare replacement credentials where required.
2. Configure hosting secrets from `.env.example`; do not paste secrets into git.
3. Run `npm run validate:release`.
4. Run `npm run deployment:validate`.
5. Confirm `render.yaml` starts `npm run office:start`.
6. Confirm `/healthz` responds in the preview deployment.
7. Confirm `POST /api/office/intake` requires authentication.
8. Confirm the website server has `OCHIGA_OFFICE_INTAKE_ENDPOINT` and `OCHIGA_OFFICE_INTAKE_TOKEN`.
9. Apply `db/lead-agents-schema.sql` only in an approved database window.

## Cutover Sequence

1. Deploy Office from the standalone repository.
2. Verify `/healthz`.
3. Run a non-production authenticated Office intake smoke.
4. Point website intake environment variables to the Office endpoint.
5. Submit a controlled test enquiry from a staging or approved test form.
6. Verify durable CRM record creation, idempotency and timeline activity.
7. Verify email notification still sends or is explicitly skipped when not configured.
8. Keep the old Render service standby until website intake and Office dashboard checks pass.

## Rollback

1. Restore website intake variables to the previous endpoint.
2. Keep email/local fallback enabled.
3. Revert Render/Vercel routing to the last known good Office service.
4. Do not roll back database schema unless an explicitly reviewed down migration exists.

## Production Approval Required

- Applying `db/lead-agents-schema.sql`
- Rotating any credential in `docs/ROTATION_CHECKLIST.md`
- Switching website production environment variables
- Retiring the old mixed Edge/Office deployment
