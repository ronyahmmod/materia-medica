# Security Specification — Homeopathy Clinic Admin System

## Data Invariants
1. **Admin-Only Isolation**: Customers/patients never access the application. Every read, list, create, update, and delete on `/patients`, `/consultations`, `/photos`, `/clinic_settings`, and `/admins` requires a verified Firebase Auth token (`request.auth.token.email_verified == true`) belonging to the primary clinic admin (`rony.jib@gmail.com`) or an admin registered in `/admins/{uid}` by the primary owner.
2. **Master Gate Relational Integrity**: No `/consultations/{consultationId}` or `/photos/{photoId}` document can exist without a parent `/patients/{patientId}` document, and `incoming().patientId` must match `{patientId}`.
3. **Immutable Ownership & Temporal Integrity**: `createdBy` and `createdAt` cannot be altered after creation; `createdAt` and `updatedAt` must equal `request.time`.
4. **Strict Schema & Bounds Enforcement**: Every string enforces `size()` limits, arrays (`photoIds`) enforce `size() <= 10`, and unknown/ghost fields are blocked via `keys().hasOnly(...)` and `affectedKeys().hasOnly(...)`.

## Dirty Dozen Adversarial Payloads
1. **Unauthenticated Patient Read**: Anonymous/unauthenticated `get` on `/patients/pat-1` -> `PERMISSION_DENIED`.
2. **Unverified Email Spoof**: Signed-in user with `email: "rony.jib@gmail.com"` and `email_verified: false` -> `PERMISSION_DENIED`.
3. **Non-Admin Customer Access**: Signed-in patient/external user (`email: "patient@example.com"`, `email_verified: true`) attempting `list` or `get` on `/patients` -> `PERMISSION_DENIED`.
4. **Self-Assigned Admin Escalation**: Non-owner user attempting `create` on `/admins/{uid}` -> `PERMISSION_DENIED`.
5. **Ghost Field Injection (Shadow Update)**: Admin sending `{ ...validPatient, isSuperAdmin: true }` -> `PERMISSION_DENIED`.
6. **Path ID Poisoning**: Document ID containing spaces/slashes or >128 chars (`/patients/bad id!`) -> `PERMISSION_DENIED`.
7. **Orphaned Consultation Write**: Creating `/patients/nonexistent/consultations/c1` -> `PERMISSION_DENIED`.
8. **Parent Mismatch**: Creating `/patients/pat-1/consultations/c1` with `patientId: "pat-2"` -> `PERMISSION_DENIED`.
9. **Client Timestamp Forgery**: Creating a patient with `createdAt: Timestamp(2020-01-01)` instead of `serverTimestamp()` -> `PERMISSION_DENIED`.
10. **Immutable Owner Tampering**: Updating a patient's `createdBy` or `createdAt` -> `PERMISSION_DENIED`.
11. **Unbounded Array / Resource Exhaustion**: Sending `photoIds` with 25 items or `chiefComplaint` > 500 chars -> `PERMISSION_DENIED`.
12. **Photo Size Spoofing**: Registering photo metadata with `sizeBytes: 50000000` (50 MB) or invalid `mimeType: "text/html"` -> `PERMISSION_DENIED`.
