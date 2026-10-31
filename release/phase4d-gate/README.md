# Stage4D migration-aware security gate

build-gate.py pins migration and reviewed metadata manifests. The generated read-only SQL retains earlier phase checks and requires precise reviewed order/reservation/payment shapes. Only four exact immutable payment table names receive a narrow CRUD exception, and only while the complete payment shape is intact. RLS, grants, owners, search paths, guards and immutable definitions are compared, not inferred from table existence.

Run before and after an explicitly approved migration. Require the expected migration stage and GO. Separately require the Stage4C scheduler runtime gate and Backend payment gate. This is local evidence, not authorization to apply migrations or start payments.
