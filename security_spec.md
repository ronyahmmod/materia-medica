# Security Specification — Tightened Multi-Tenant Homeopathy SaaS Platform

## Data Invariants
1. **Strict Role & Provider Separation**:
   - **Super Admin (`rony.jib@gmail.com`)**: Must authenticate via verified `google.com` provider (`email_verified == true`). Only Super Admin may create, customize, suspend, or delete `/clinics/{clinicId}`, `/clinic_public/{slug}`, and `/platform_config/{configId}`, or access legacy root collections.
   - **Client Clinic Admins**: Must authenticate exclusively via Super-Admin-provisioned **Email & Password** (`sign_in_provider == 'password'`). Google login is disabled on client portals and rejected by both Firestore rules and Express API routes for non-Super-Admin users.
2. **Cryptographic UID + Email Binding (Anti-Pre-Hijack Guard)**:
   - Every clinic stores `authorizedUids` (1–10 Firebase Auth UIDs created/assigned by the Super Admin) alongside `accessEmails`.
   - Every tenant clinical record mirrors `clinicAccessUids` and `clinicAccessEmails` from its parent `/clinics/{clinicId}` document.
   - An attacker who self-registers via client Auth endpoints receives an untrusted UID not in `authorizedUids` and is rejected.
3. **Zero-PII Public Storefront**: `/clinic_public/{slug}` exposes single-document `get` (never unauthenticated `list`) with non-PII branding fields only (`clinicId`, `slug`, `clinicName`, `practitionerName`, `tagline`, `accentColor`, `planTier`, `subscriptionStatus`).
4. **Master Gate & Active Subscription Enforcement**:
   - Tenant subcollection reads (`get`) and all writes require an existing parent `/clinics/{clinicId}` with `subscriptionStatus != 'suspended'` for client users.
   - `consultations`, `photos`, `clinical_notes`, and `fee_records` require an existing parent `/clinics/{clinicId}/patients/{patientId}` document.
5. **Immutable Ownership & Temporal Integrity**: `createdBy`, `createdAt`, `clinicId`, and `patientId` cannot be altered after creation; `createdAt` and `updatedAt` must equal `request.time`.
6. **Strict Schema & Cash Accounting Invariants**: All strings enforce `size()` bounds, arrays enforce `size() <= 10` (`accessEmails`, `authorizedUids`, `photoIds`), cash fee invariants enforce `netAmount == feeAmount - discountAmount` and `dueAmount == netAmount - cashPaid`, and ghost fields are rejected via `keys().hasOnly(...)` and `affectedKeys().hasOnly(...)`.

## Dirty Dozen Adversarial Payloads
1. **Unauthenticated Patient Read**: Anonymous `get` on `/clinics/c1/patients/pat-1` -> `PERMISSION_DENIED`.
2. **Client Google Login Attempt**: External Google user (`sign_in_provider == 'google.com'`, not Super Admin) attempting to `list` or `get` `/clinics/c1` -> `PERMISSION_DENIED`.
3. **Self-Signup Pre-Hijack Attack**: Attacker signing up via email/password and attempting to `get` or `list` `/clinics/c1` -> `PERMISSION_DENIED` (`request.auth.uid` absent from `authorizedUids` / `clinicAccessUids`).
4. **Cross-Tenant Lateral Access**: Password client of Clinic A attempting `list`, `get`, or `create` on `/clinics/clinicB/patients` -> `PERMISSION_DENIED`.
5. **Client Self-Promotion / Subscription Bypass**: Client attempting `update` on `/clinics/clinicA` to raise `patientLimit` or reactivate a `suspended` clinic -> `PERMISSION_DENIED`.
6. **Suspended Clinic Access & Mutation**: Client of a `suspended` clinic attempting to `get`, `create`, or `update` a patient or fee record -> `PERMISSION_DENIED`.
7. **Tenant ACL Forgery**: Client attempting to create `/clinics/clinicA/patients/p1` with forged `clinicAccessUids: ['attackerUid']` -> `PERMISSION_DENIED`.
8. **Ghost Field Injection**: Sending `{ ...validClinic, superAdminOverride: true }` -> `PERMISSION_DENIED`.
9. **Path ID / Slug Poisoning**: Creating `/clinic_public/Bad Slug!` or `/clinics/bad id/patients/p1` -> `PERMISSION_DENIED`.
10. **Orphaned Subcollection Write**: Creating `/clinics/c1/patients/nonexistent/consultations/con1` -> `PERMISSION_DENIED`.
11. **Cash Math Tampering**: Creating a `FeeRecord` with `feeAmount: 500, discountAmount: 0, cashPaid: 200, dueAmount: 0` -> `PERMISSION_DENIED`.
12. **Client Timestamp Forgery**: Creating a clinic or patient with `createdAt: Timestamp(2020-01-01)` -> `PERMISSION_DENIED`.
