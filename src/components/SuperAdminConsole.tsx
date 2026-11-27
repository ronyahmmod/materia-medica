import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import {
  ArchiveRestore,
  ArrowRight,
  Building2,
  CreditCard,
  Database,
  Edit3,
  HardDrive,
  Loader2,
  PauseCircle,
  PlayCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { auth, db, OperationType, reportFirestoreError } from '../firebase';
import { useLanguage } from '../i18n/LanguageContext';
import {
  BILLING_CYCLE_LABELS_I18N,
  PLAN_LABELS_I18N,
  SUBSCRIPTION_STATUS_LABELS_I18N,
} from '../i18n/translations';
import { formatBytes } from '../lib/imageCompressor';
import { type SaasPlatformHealthResponse } from '../lib/photoApi';
import {
  ACCENT_THEME_PALETTES,
  DEFAULT_PLATFORM_CONFIG_ID,
  isPrivateDevPreviewUrl,
  sanitizeShareBaseUrl,
  tenantConsultationDoc,
  tenantConsultationsCol,
  tenantDiseaseRemediesCol,
  tenantDiseaseRemedyDoc,
  tenantFeeDoc,
  tenantFeesCol,
  tenantNoteDoc,
  tenantNotesCol,
  tenantPatientDoc,
  tenantPatientsCol,
  tenantPhotoDoc,
  tenantPhotosCol,
  tenantRepertoryCol,
  tenantRepertoryDoc,
} from '../lib/tenantPaths';
import {
  FIELD_LIMITS,
  PLAN_CATALOG,
  type ClinicTenant,
  type PlanTier,
  type PlatformHostingConfig,
} from '../types/clinic';

type ConsoleTab = 'clients' | 'subscriptions' | 'hosting' | 'backup';

type DeletedRecordKind =
  | 'patient'
  | 'consultation'
  | 'photo'
  | 'note'
  | 'fee'
  | 'repertory'
  | 'disease';

interface DeletedBackupItem {
  key: string;
  kind: DeletedRecordKind;
  clinicId: string;
  clinicName: string;
  docId: string;
  patientId?: string;
  title: string;
  subtitle: string;
  deletedAt: string;
  deletedBy?: string;
  ref: ReturnType<typeof doc>;
  hasUpdatedAt: boolean;
  photoCategory?: string;
  photoUrl?: string;
}

interface LegacyScanSummary {
  patients: number;
  fees: number;
  repertory: number;
  scannedAt: string;
}

interface SuperAdminConsoleProps {
  clinics: ClinicTenant[];
  platformConfig: PlatformHostingConfig;
  saasHealth: SaasPlatformHealthResponse | null;
  loadingHealth: boolean;
  onRefreshHealth: () => void;
  onOpenClinicWorkspace: (clinicId: string) => void;
  onCreateClinic: () => void;
  onEditClinic: (clinic: ClinicTenant) => void;
}

const ONLINE_WINDOW_MS = 3 * 60 * 1000;

interface ClientPresenceSummary {
  isOnline: boolean;
  hasSeenBefore: boolean;
  relativeLabel: string;
  exactLabel: string | null;
  activeEmail: string | null;
}

function formatClientPresence(
  clinic: ClinicTenant,
  language: 'en' | 'bn',
  nowMs: number
): ClientPresenceSummary {
  const email = clinic.lastActiveEmail?.trim() || null;
  let lastMs = 0;
  try {
    lastMs = clinic.lastActiveAt?.toMillis?.() ?? 0;
  } catch {
    lastMs = 0;
  }

  if (!lastMs) {
    return {
      isOnline: false,
      hasSeenBefore: false,
      relativeLabel: language === 'bn' ? 'এখনো লগইন করেনি' : 'Never logged in',
      exactLabel: null,
      activeEmail: email,
    };
  }

  const diffMs = Math.max(0, nowMs - lastMs);
  const isOnline = diffMs <= ONLINE_WINDOW_MS;
  const totalMins = Math.floor(diffMs / 60_000);
  const totalHours = Math.floor(totalMins / 60);
  const totalDays = Math.floor(totalHours / 24);

  let relativeLabel: string;
  if (totalMins < 1) {
    relativeLabel = language === 'bn' ? 'এইমাত্র' : 'Just now';
  } else if (totalMins < 60) {
    relativeLabel =
      language === 'bn' ? `${totalMins} মিনিট আগে` : `${totalMins}m ago`;
  } else if (totalHours < 24) {
    relativeLabel =
      language === 'bn' ? `${totalHours} ঘণ্টা আগে` : `${totalHours}h ago`;
  } else {
    relativeLabel =
      language === 'bn' ? `${totalDays} দিন আগে` : `${totalDays}d ago`;
  }

  const exactLabel = new Date(lastMs).toLocaleString(
    language === 'bn' ? 'bn-BD' : 'en-US',
    {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }
  );

  return {
    isOnline,
    hasSeenBefore: true,
    relativeLabel,
    exactLabel,
    activeEmail: email,
  };
}

function pickDefined<T extends Record<string, unknown>>(obj: T, allowedKeys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    if (obj[key] !== undefined) {
      out[key] = obj[key];
    }
  }
  return out;
}

export function SuperAdminConsole({
  clinics,
  platformConfig,
  saasHealth,
  loadingHealth,
  onRefreshHealth,
  onOpenClinicWorkspace,
  onCreateClinic,
  onEditClinic,
}: SuperAdminConsoleProps) {
  const { language, t } = useLanguage();
  const planLabels = PLAN_LABELS_I18N[language];
  const subStatusLabels = SUBSCRIPTION_STATUS_LABELS_I18N[language];
  const billingLabels = BILLING_CYCLE_LABELS_I18N[language];

  const [activeTab, setActiveTab] = useState<ConsoleTab>('clients');
  const [togglingClinicId, setTogglingClinicId] = useState<string | null>(null);
  const [confirmDeleteClinicId, setConfirmDeleteClinicId] = useState<string | null>(null);
  const [deletingClinicId, setDeletingClinicId] = useState<string | null>(null);
  const [consoleError, setConsoleError] = useState<string | null>(null);

  // Hosting Config Form State
  const [platformName, setPlatformName] = useState(platformConfig.platformName);
  const [supportEmail, setSupportEmail] = useState(platformConfig.supportEmail);
  const [defaultHostingProvider, setDefaultHostingProvider] = useState(
    platformConfig.defaultHostingProvider
  );
  const [defaultRegion, setDefaultRegion] = useState(platformConfig.defaultRegion);
  const [publicBaseUrl, setPublicBaseUrl] = useState(platformConfig.publicBaseUrl || '');
  const [freeTierSummary, setFreeTierSummary] = useState(platformConfig.freeTierSummary || '');
  const [maintenanceNotice, setMaintenanceNotice] = useState(
    platformConfig.maintenanceNotice || ''
  );
  const [savingHosting, setSavingHosting] = useState(false);
  const [hostingSavedNotice, setHostingSavedNotice] = useState(false);

  // Legacy Migration State
  const [legacySummary, setLegacySummary] = useState<LegacyScanSummary | null>(null);
  const [scanningLegacy, setScanningLegacy] = useState(false);
  const [migrationTargetClinicId, setMigrationTargetClinicId] = useState<string>(
    clinics[0]?.id || ''
  );
  const [migratingLegacy, setMigratingLegacy] = useState(false);
  const [migrationNotice, setMigrationNotice] = useState<string | null>(null);

  // Deleted Backup & Restore State
  const [backupClinicFilter, setBackupClinicFilter] = useState<string>('all');
  const [backupKindFilter, setBackupKindFilter] = useState<'all' | DeletedRecordKind>('all');
  const [backupSearchQuery, setBackupSearchQuery] = useState<string>('');
  const [backupItems, setBackupItems] = useState<DeletedBackupItem[]>([]);
  const [scanningBackup, setScanningBackup] = useState(false);
  const [backupScannedOnce, setBackupScannedOnce] = useState(false);
  const [restoringKey, setRestoringKey] = useState<string | null>(null);
  const [backupNotice, setBackupNotice] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => {
      setNowMs(Date.now());
    }, 30_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    setPlatformName(platformConfig.platformName);
    setSupportEmail(platformConfig.supportEmail);
    setDefaultHostingProvider(platformConfig.defaultHostingProvider);
    setDefaultRegion(platformConfig.defaultRegion);
    setPublicBaseUrl(platformConfig.publicBaseUrl || '');
    setFreeTierSummary(platformConfig.freeTierSummary || '');
    setMaintenanceNotice(platformConfig.maintenanceNotice || '');
  }, [platformConfig]);

  useEffect(() => {
    if (!migrationTargetClinicId && clinics.length > 0) {
      setMigrationTargetClinicId(clinics[0].id);
    }
  }, [clinics, migrationTargetClinicId]);

  const counts = useMemo(() => {
    let active = 0;
    let trial = 0;
    let suspended = 0;
    let payingClinics = 0;
    let onlineNow = 0;
    const mrrByCurrency: Record<string, number> = {};

    for (const c of clinics) {
      if (c.subscriptionStatus === 'active') active += 1;
      else if (c.subscriptionStatus === 'trial') trial += 1;
      else suspended += 1;

      const lastMs = c.lastActiveAt?.toMillis?.() ?? 0;
      if (lastMs > 0 && Math.max(0, nowMs - lastMs) <= ONLINE_WINDOW_MS) {
        onlineNow += 1;
      }

      if (c.subscriptionStatus !== 'suspended' && c.monthlyFeeAmount > 0) {
        payingClinics += 1;
        const monthlyEq =
          c.billingCycle === 'yearly' ? c.monthlyFeeAmount / 12 : c.monthlyFeeAmount;
        mrrByCurrency[c.currencySymbol] =
          (mrrByCurrency[c.currencySymbol] || 0) + monthlyEq;
      }
    }
    return { active, trial, suspended, payingClinics, onlineNow, mrrByCurrency };
  }, [clinics, nowMs]);

  const formattedMrrSummary = useMemo(() => {
    const entries = Object.entries(counts.mrrByCurrency);
    if (entries.length === 0) return '$0';
    return entries
      .map(([cur, val]) => `${cur}${Math.round(val).toLocaleString()}`)
      .join(' + ');
  }, [counts.mrrByCurrency]);

  const handleToggleSuspend = async (clinic: ClinicTenant) => {
    const nextStatus = clinic.subscriptionStatus === 'suspended' ? 'active' : 'suspended';
    setTogglingClinicId(clinic.id);
    setConsoleError(null);
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, 'clinics', clinic.id), {
        subscriptionStatus: nextStatus,
        updatedAt: serverTimestamp(),
      });
      batch.update(doc(db, 'clinic_public', clinic.slug), {
        subscriptionStatus: nextStatus,
        updatedAt: serverTimestamp(),
      });
      await batch.commit();
    } catch (err) {
      const msg = reportFirestoreError(err, OperationType.UPDATE, `clinics/${clinic.id}`);
      setConsoleError(msg);
    } finally {
      setTogglingClinicId(null);
    }
  };

  const handleDeleteClinic = async (clinic: ClinicTenant) => {
    setDeletingClinicId(clinic.id);
    setConsoleError(null);
    try {
      const refsToDelete: Array<ReturnType<typeof doc>> = [];

      const patientsSnap = await getDocs(tenantPatientsCol(clinic.id));
      for (const pat of patientsSnap.docs) {
        const [consSnap, photosSnap, notesSnap] = await Promise.all([
          getDocs(tenantConsultationsCol(clinic.id, pat.id)),
          getDocs(tenantPhotosCol(clinic.id, pat.id)),
          getDocs(tenantNotesCol(clinic.id, pat.id)),
        ]);
        for (const c of consSnap.docs) refsToDelete.push(c.ref);
        for (const p of photosSnap.docs) refsToDelete.push(p.ref);
        for (const n of notesSnap.docs) refsToDelete.push(n.ref);
        refsToDelete.push(pat.ref);
      }

      const [feesSnap, repSnap, diseaseSnap] = await Promise.all([
        getDocs(tenantFeesCol(clinic.id)),
        getDocs(tenantRepertoryCol(clinic.id)),
        getDocs(tenantDiseaseRemediesCol(clinic.id)),
      ]);
      for (const f of feesSnap.docs) refsToDelete.push(f.ref);
      for (const r of repSnap.docs) refsToDelete.push(r.ref);
      for (const d of diseaseSnap.docs) refsToDelete.push(d.ref);

      refsToDelete.push(doc(db, 'clinics', clinic.id));
      refsToDelete.push(doc(db, 'clinic_public', clinic.slug));

      const CHUNK_SIZE = 400;
      for (let i = 0; i < refsToDelete.length; i += CHUNK_SIZE) {
        const chunk = refsToDelete.slice(i, i + CHUNK_SIZE);
        const batch = writeBatch(db);
        for (const ref of chunk) {
          batch.delete(ref);
        }
        await batch.commit();
      }
      setConfirmDeleteClinicId(null);
    } catch (err) {
      const msg = reportFirestoreError(err, OperationType.DELETE, `clinics/${clinic.id}`);
      setConsoleError(msg);
    } finally {
      setDeletingClinicId(null);
    }
  };

  const handleSaveHostingConfig = async (e: FormEvent) => {
    e.preventDefault();
    const uid = auth.currentUser?.uid;
    if (!uid) return;

    setSavingHosting(true);
    setHostingSavedNotice(false);
    setConsoleError(null);

    try {
      const cleanedBaseUrl = publicBaseUrl.trim().replace(/\/+$/, '');
      const normalizedBaseUrl = isPrivateDevPreviewUrl(cleanedBaseUrl)
        ? sanitizeShareBaseUrl(cleanedBaseUrl)
        : cleanedBaseUrl;

      const payload: Record<string, unknown> = {
        platformName: platformName.trim() || 'Materia Medica SaaS',
        supportEmail: supportEmail.trim() || 'rony.jib@gmail.com',
        defaultHostingProvider: defaultHostingProvider.trim() || 'Cloud Run / Render Free Tier',
        defaultRegion: defaultRegion.trim() || 'asia-southeast1',
        publicBaseUrl: normalizedBaseUrl,
        freeTierSummary: freeTierSummary.trim(),
        maintenanceNotice: maintenanceNotice.trim(),
        updatedBy: uid,
        updatedAt: serverTimestamp(),
      };

      await setDoc(doc(db, 'platform_config', DEFAULT_PLATFORM_CONFIG_ID), payload);
      setHostingSavedNotice(true);
      window.setTimeout(() => setHostingSavedNotice(false), 3000);
    } catch (err) {
      const msg = reportFirestoreError(err, OperationType.WRITE, 'platform_config/hosting');
      setConsoleError(msg);
    } finally {
      setSavingHosting(false);
    }
  };

  const handleScanLegacy = async () => {
    setScanningLegacy(true);
    setConsoleError(null);
    setMigrationNotice(null);
    try {
      const [patSnap, feeSnap, repSnap] = await Promise.all([
        getDocs(collection(db, 'patients')),
        getDocs(collection(db, 'fee_records')),
        getDocs(collection(db, 'repertory_entries')),
      ]);
      setLegacySummary({
        patients: patSnap.size,
        fees: feeSnap.size,
        repertory: repSnap.size,
        scannedAt: new Date().toLocaleTimeString(),
      });
    } catch (err) {
      setConsoleError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanningLegacy(false);
    }
  };

  const handleMigrateLegacyData = async () => {
    const uid = auth.currentUser?.uid;
    const targetClinic = clinics.find((c) => c.id === migrationTargetClinicId);
    if (!uid || !targetClinic) return;

    if (!targetClinic.authorizedUids || targetClinic.authorizedUids.length === 0) {
      setConsoleError(
        t(
          `Please edit "${targetClinic.clinicName}" and assign its Client Admin password/UID lock before migrating legacy records.`,
          `লিগ্যাসি ডেটা মাইগ্রেট করার আগে অনুগ্রহ করে "${targetClinic.clinicName}"-এর ক্লায়েন্ট অ্যাডমিন পাসওয়ার্ড/UID নির্ধারণ করুন।`
        )
      );
      return;
    }

    setMigratingLegacy(true);
    setConsoleError(null);
    setMigrationNotice(null);

    try {
      const [patSnap, feeSnap, repSnap] = await Promise.all([
        getDocs(collection(db, 'patients')),
        getDocs(collection(db, 'fee_records')),
        getDocs(collection(db, 'repertory_entries')),
      ]);

      let migratedPatients = 0;
      let migratedNested = 0;
      let migratedFees = 0;
      let migratedRepertory = 0;

      // Phase 1: Migrate Patients FIRST so subcollections & fee_records satisfy exists(.../patients/{id})
      const patientPayloads: Array<{ ref: ReturnType<typeof doc>; data: Record<string, unknown> }> = [];
      const nestedPayloads: Array<{ ref: ReturnType<typeof doc>; data: Record<string, unknown> }> = [];

      for (const patDoc of patSnap.docs) {
        const raw = patDoc.data() as Record<string, unknown>;
        const cleanPat = pickDefined(raw, [
          'caseNumber',
          'fullName',
          'age',
          'gender',
          'phone',
          'email',
          'address',
          'chiefComplaint',
          'thermalState',
          'constitutionNotes',
          'allergies',
          'portraitUrl',
          'portraitPhotoId',
          'status',
          'lastVisitDate',
          'nextFollowUpDate',
          'lastRemedy',
        ]);
        if (typeof cleanPat.phone !== 'string' || cleanPat.phone.length < 3) {
          cleanPat.phone = '000000';
        }
        patientPayloads.push({
          ref: tenantPatientDoc(targetClinic.id, patDoc.id),
          data: {
            ...cleanPat,
            clinicId: targetClinic.id,
            clinicAccessEmails: targetClinic.accessEmails,
            clinicAccessUids: targetClinic.authorizedUids,
            createdBy: uid,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          },
        });
        migratedPatients += 1;

        const [consSnap, photosSnap, notesSnap] = await Promise.all([
          getDocs(collection(db, 'patients', patDoc.id, 'consultations')),
          getDocs(collection(db, 'patients', patDoc.id, 'photos')),
          getDocs(collection(db, 'patients', patDoc.id, 'clinical_notes')),
        ]);

        for (const cDoc of consSnap.docs) {
          const cleanCon = pickDefined(cDoc.data() as Record<string, unknown>, [
            'patientId',
            'visitDate',
            'presentingSymptoms',
            'mentalGenerals',
            'physicalGenerals',
            'modalitiesWorse',
            'modalitiesBetter',
            'remedyName',
            'potency',
            'dosage',
            'clinicalNotes',
            'nextFollowUpDate',
            'photoIds',
          ]);
          nestedPayloads.push({
            ref: tenantConsultationDoc(targetClinic.id, patDoc.id, cDoc.id),
            data: {
              ...cleanCon,
              patientId: patDoc.id,
              clinicId: targetClinic.id,
              clinicAccessEmails: targetClinic.accessEmails,
              clinicAccessUids: targetClinic.authorizedUids,
              createdBy: uid,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            },
          });
          migratedNested += 1;
        }

        for (const phDoc of photosSnap.docs) {
          const cleanPh = pickDefined(phDoc.data() as Record<string, unknown>, [
            'patientId',
            'fileName',
            'url',
            'mimeType',
            'sizeBytes',
            'category',
            'caption',
            'consultationId',
          ]);
          nestedPayloads.push({
            ref: tenantPhotoDoc(targetClinic.id, patDoc.id, phDoc.id),
            data: {
              ...cleanPh,
              patientId: patDoc.id,
              clinicId: targetClinic.id,
              clinicAccessEmails: targetClinic.accessEmails,
              clinicAccessUids: targetClinic.authorizedUids,
              uploadedBy: uid,
              createdAt: serverTimestamp(),
            },
          });
          migratedNested += 1;
        }

        for (const nDoc of notesSnap.docs) {
          const cleanNote = pickDefined(nDoc.data() as Record<string, unknown>, [
            'patientId',
            'observedDate',
            'focusArea',
            'content',
          ]);
          nestedPayloads.push({
            ref: tenantNoteDoc(targetClinic.id, patDoc.id, nDoc.id),
            data: {
              ...cleanNote,
              patientId: patDoc.id,
              clinicId: targetClinic.id,
              clinicAccessEmails: targetClinic.accessEmails,
              clinicAccessUids: targetClinic.authorizedUids,
              createdBy: uid,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            },
          });
          migratedNested += 1;
        }
      }

      const commitInChunks = async (
        items: Array<{ ref: ReturnType<typeof doc>; data: Record<string, unknown> }>
      ) => {
        const CHUNK = 350;
        for (let i = 0; i < items.length; i += CHUNK) {
          const batch = writeBatch(db);
          for (const item of items.slice(i, i + CHUNK)) {
            batch.set(item.ref, item.data);
          }
          await batch.commit();
        }
      };

      await commitInChunks(patientPayloads);

      // Phase 2: Migrate nested patient docs, fees, and repertory entries
      for (const fDoc of feeSnap.docs) {
        const cleanFee = pickDefined(fDoc.data() as Record<string, unknown>, [
          'patientId',
          'patientName',
          'caseNumber',
          'consultationId',
          'collectedDate',
          'feeType',
          'feeAmount',
          'discountAmount',
          'netAmount',
          'cashPaid',
          'dueAmount',
          'notes',
        ]);
        nestedPayloads.push({
          ref: tenantFeeDoc(targetClinic.id, fDoc.id),
          data: {
            ...cleanFee,
            clinicId: targetClinic.id,
            clinicAccessEmails: targetClinic.accessEmails,
            clinicAccessUids: targetClinic.authorizedUids,
            createdBy: uid,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          },
        });
        migratedFees += 1;
      }

      for (const rDoc of repSnap.docs) {
        const cleanRep = pickDefined(rDoc.data() as Record<string, unknown>, [
          'chapter',
          'rubric',
          'primaryRemedy',
          'remedies',
          'modalities',
          'symptomNotes',
        ]);
        nestedPayloads.push({
          ref: tenantRepertoryDoc(targetClinic.id, rDoc.id),
          data: {
            ...cleanRep,
            clinicId: targetClinic.id,
            clinicAccessEmails: targetClinic.accessEmails,
            clinicAccessUids: targetClinic.authorizedUids,
            createdBy: uid,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          },
        });
        migratedRepertory += 1;
      }

      await commitInChunks(nestedPayloads);

      setMigrationNotice(
        t(
          `Migrated ${migratedPatients} patients, ${migratedNested} clinical records, ${migratedFees} cash fees, and ${migratedRepertory} repertory entries into "${targetClinic.clinicName}".`,
          `"${targetClinic.clinicName}"-এ ${migratedPatients} জন রোগী, ${migratedNested}টি ক্লিনিক্যাল রেকর্ড, ${migratedFees}টি নগদ ফি এবং ${migratedRepertory}টি রেপার্টরি এন্ট্রি মাইগ্রেট হয়েছে।`
        )
      );
    } catch (err) {
      setConsoleError(err instanceof Error ? err.message : String(err));
    } finally {
      setMigratingLegacy(false);
    }
  };

  const handleScanDeletedBackup = useCallback(async () => {
    setScanningBackup(true);
    setConsoleError(null);
    setBackupNotice(null);
    try {
      const targetClinics =
        backupClinicFilter === 'all'
          ? clinics
          : clinics.filter((c) => c.id === backupClinicFilter);

      const collected: DeletedBackupItem[] = [];

      for (const clinic of targetClinics) {
        const [patientsSnap, feesSnap, repSnap, diseaseSnap] = await Promise.all([
          getDocs(tenantPatientsCol(clinic.id)),
          getDocs(tenantFeesCol(clinic.id)),
          getDocs(tenantRepertoryCol(clinic.id)),
          getDocs(tenantDiseaseRemediesCol(clinic.id)),
        ]);

        for (const patDoc of patientsSnap.docs) {
          const patData = patDoc.data() as Record<string, unknown>;
          const patName = String(patData.fullName || patDoc.id);
          const caseNo = String(patData.caseNumber || '');

          if (patData.isDeleted === true) {
            const patientDetails = [
              String(patData.phone || '').trim(),
              String(patData.address || '').trim(),
              String(patData.chiefComplaint || '').trim(),
            ]
              .filter(Boolean)
              .join(' · ');

            collected.push({
              key: `pat:${clinic.id}:${patDoc.id}`,
              kind: 'patient',
              clinicId: clinic.id,
              clinicName: clinic.clinicName,
              docId: patDoc.id,
              patientId: patDoc.id,
              title: `${patName}${caseNo ? ` (${caseNo})` : ''}`,
              subtitle: patientDetails,
              deletedAt: String(patData.deletedAt || ''),
              deletedBy: typeof patData.deletedBy === 'string' ? patData.deletedBy : undefined,
              ref: patDoc.ref,
              hasUpdatedAt: true,
            });
          }

          const [consSnap, photosSnap, notesSnap] = await Promise.all([
            getDocs(tenantConsultationsCol(clinic.id, patDoc.id)),
            getDocs(tenantPhotosCol(clinic.id, patDoc.id)),
            getDocs(tenantNotesCol(clinic.id, patDoc.id)),
          ]);

          for (const cDoc of consSnap.docs) {
            const cData = cDoc.data() as Record<string, unknown>;
            if (cData.isDeleted === true) {
              collected.push({
                key: `con:${clinic.id}:${patDoc.id}:${cDoc.id}`,
                kind: 'consultation',
                clinicId: clinic.id,
                clinicName: clinic.clinicName,
                docId: cDoc.id,
                patientId: patDoc.id,
                title: `${patName} · ${String(cData.visitDate || '')}`,
                subtitle: `${String(cData.remedyName || '')} ${String(cData.potency || '')} — ${String(cData.presentingSymptoms || '').slice(0, 90)}`,
                deletedAt: String(cData.deletedAt || ''),
                deletedBy: typeof cData.deletedBy === 'string' ? cData.deletedBy : undefined,
                ref: cDoc.ref,
                hasUpdatedAt: true,
              });
            }
          }

          for (const phDoc of photosSnap.docs) {
            const phData = phDoc.data() as Record<string, unknown>;
            if (phData.isDeleted === true) {
              collected.push({
                key: `pho:${clinic.id}:${patDoc.id}:${phDoc.id}`,
                kind: 'photo',
                clinicId: clinic.id,
                clinicName: clinic.clinicName,
                docId: phDoc.id,
                patientId: patDoc.id,
                title: `${patName} · ${String(phData.caption || phData.fileName || phDoc.id)}`,
                subtitle: `${String(phData.category || 'photo')} · ${formatBytes(Number(phData.sizeBytes || 0))}`,
                deletedAt: String(phData.deletedAt || ''),
                deletedBy: typeof phData.deletedBy === 'string' ? phData.deletedBy : undefined,
                ref: phDoc.ref,
                hasUpdatedAt: false,
                photoCategory: String(phData.category || ''),
                photoUrl: String(phData.url || ''),
              });
            }
          }

          for (const nDoc of notesSnap.docs) {
            const nData = nDoc.data() as Record<string, unknown>;
            if (nData.isDeleted === true) {
              collected.push({
                key: `note:${clinic.id}:${patDoc.id}:${nDoc.id}`,
                kind: 'note',
                clinicId: clinic.id,
                clinicName: clinic.clinicName,
                docId: nDoc.id,
                patientId: patDoc.id,
                title: `${patName} · ${String(nData.observedDate || '')} (${String(nData.focusArea || '')})`,
                subtitle: String(nData.content || '').slice(0, 100),
                deletedAt: String(nData.deletedAt || ''),
                deletedBy: typeof nData.deletedBy === 'string' ? nData.deletedBy : undefined,
                ref: nDoc.ref,
                hasUpdatedAt: true,
              });
            }
          }
        }

        for (const fDoc of feesSnap.docs) {
          const fData = fDoc.data() as Record<string, unknown>;
          if (fData.isDeleted === true) {
            collected.push({
              key: `fee:${clinic.id}:${fDoc.id}`,
              kind: 'fee',
              clinicId: clinic.id,
              clinicName: clinic.clinicName,
              docId: fDoc.id,
              patientId: typeof fData.patientId === 'string' ? fData.patientId : undefined,
              title: `${String(fData.patientName || '')} (${String(fData.caseNumber || '')}) · ${String(fData.collectedDate || '')}`,
              subtitle: `${String(fData.feeType || 'fee')} · Net ${String(fData.netAmount ?? 0)} · Cash ${String(fData.cashPaid ?? 0)}`,
              deletedAt: String(fData.deletedAt || ''),
              deletedBy: typeof fData.deletedBy === 'string' ? fData.deletedBy : undefined,
              ref: fDoc.ref,
              hasUpdatedAt: true,
            });
          }
        }

        for (const rDoc of repSnap.docs) {
          const rData = rDoc.data() as Record<string, unknown>;
          if (rData.isDeleted === true) {
            collected.push({
              key: `rep:${clinic.id}:${rDoc.id}`,
              kind: 'repertory',
              clinicId: clinic.id,
              clinicName: clinic.clinicName,
              docId: rDoc.id,
              title: `${String(rData.chapter || '')} · ${String(rData.primaryRemedy || '')}`,
              subtitle: String(rData.rubric || ''),
              deletedAt: String(rData.deletedAt || ''),
              deletedBy: typeof rData.deletedBy === 'string' ? rData.deletedBy : undefined,
              ref: rDoc.ref,
              hasUpdatedAt: true,
            });
          }
        }

        for (const dDoc of diseaseSnap.docs) {
          const dData = dDoc.data() as Record<string, unknown>;
          if (dData.isDeleted === true) {
            collected.push({
              key: `dis:${clinic.id}:${dDoc.id}`,
              kind: 'disease',
              clinicId: clinic.id,
              clinicName: clinic.clinicName,
              docId: dDoc.id,
              title: `${String(dData.diseaseName || '')} (${String(dData.patientScope || 'All')})`,
              subtitle: `${String(dData.firstRemedyMorning || '')} ${String(dData.firstRemedyPotency || '')}`,
              deletedAt: String(dData.deletedAt || ''),
              deletedBy: typeof dData.deletedBy === 'string' ? dData.deletedBy : undefined,
              ref: dDoc.ref,
              hasUpdatedAt: true,
            });
          }
        }
      }

      collected.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
      setBackupItems(collected);
      setBackupScannedOnce(true);
    } catch (err) {
      setConsoleError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanningBackup(false);
    }
  }, [backupClinicFilter, clinics]);

  useEffect(() => {
    if (activeTab === 'backup' && !backupScannedOnce && !scanningBackup && clinics.length > 0) {
      void handleScanDeletedBackup();
    }
  }, [activeTab, backupScannedOnce, clinics.length, handleScanDeletedBackup, scanningBackup]);

  const handleRestoreBackupItem = async (item: DeletedBackupItem) => {
    setRestoringKey(item.key);
    setConsoleError(null);
    setBackupNotice(null);
    const restoredIso = new Date().toISOString().slice(0, 32);

    try {
      if (item.kind === 'patient' && item.patientId) {
        // Restore patient AND cascade-restore all soft-deleted sub-records belonging to this patient
        const childMatches = backupItems.filter(
          (other) =>
            other.clinicId === item.clinicId &&
            other.patientId === item.patientId &&
            other.key !== item.key
        );

        const updates: Array<{
          ref: ReturnType<typeof doc>;
          data: Record<string, unknown>;
        }> = [
          {
            ref: item.ref,
            data: {
              isDeleted: false,
              restoredAt: restoredIso,
              updatedAt: serverTimestamp(),
            },
          },
          ...childMatches.map((child) => ({
            ref: child.ref,
            data: {
              isDeleted: false,
              restoredAt: restoredIso,
              ...(child.hasUpdatedAt ? { updatedAt: serverTimestamp() } : {}),
            },
          })),
        ];

        const CHUNK_SIZE = 400;
        for (let i = 0; i < updates.length; i += CHUNK_SIZE) {
          const chunk = updates.slice(i, i + CHUNK_SIZE);
          const batch = writeBatch(db);
          for (const op of chunk) {
            batch.update(op.ref, op.data);
          }
          await batch.commit();
        }

        const restoredKeys = new Set([item.key, ...childMatches.map((c) => c.key)]);
        setBackupItems((prev) => prev.filter((x) => !restoredKeys.has(x.key)));
        setBackupNotice(
          t(
            `Restored patient "${item.title}" along with ${childMatches.length} linked record(s).`,
            `রোগী "${item.title}" এবং সংযুক্ত ${childMatches.length}টি রেকর্ড পুনরুদ্ধার করা হয়েছে।`
          )
        );
      } else {
        // If restoring a child sub-record of a soft-deleted patient, also ensure parent patient is restored
        const parentPatientDeleted = item.patientId
          ? backupItems.find(
              (other) =>
                other.kind === 'patient' &&
                other.clinicId === item.clinicId &&
                other.patientId === item.patientId
            )
          : undefined;

        const shouldRestorePortrait =
          item.kind === 'photo' &&
          item.photoCategory === 'portrait' &&
          Boolean(item.photoUrl) &&
          Boolean(item.patientId);

        if (parentPatientDeleted) {
          const batch = writeBatch(db);
          batch.update(parentPatientDeleted.ref, {
            isDeleted: false,
            restoredAt: restoredIso,
            ...(shouldRestorePortrait
              ? { portraitUrl: item.photoUrl, portraitPhotoId: item.docId }
              : {}),
            updatedAt: serverTimestamp(),
          });
          batch.update(item.ref, {
            isDeleted: false,
            restoredAt: restoredIso,
            ...(item.hasUpdatedAt ? { updatedAt: serverTimestamp() } : {}),
          });
          await batch.commit();
          const restoredKeys = new Set([item.key, parentPatientDeleted.key]);
          setBackupItems((prev) => prev.filter((x) => !restoredKeys.has(x.key)));
        } else {
          await updateDoc(item.ref, {
            isDeleted: false,
            restoredAt: restoredIso,
            ...(item.hasUpdatedAt ? { updatedAt: serverTimestamp() } : {}),
          });
          if (shouldRestorePortrait && item.patientId) {
            const patRef = tenantPatientDoc(item.clinicId, item.patientId);
            const patSnap = await getDoc(patRef);
            if (patSnap.exists() && !patSnap.data()?.portraitUrl) {
              await updateDoc(patRef, {
                portraitUrl: item.photoUrl,
                portraitPhotoId: item.docId,
                updatedAt: serverTimestamp(),
              });
            }
          }
          setBackupItems((prev) => prev.filter((x) => x.key !== item.key));
        }

        setBackupNotice(
          t(
            `Restored "${item.title}" back into "${item.clinicName}".`,
            `"${item.title}" সফলভাবে "${item.clinicName}"-এ পুনরুদ্ধার করা হয়েছে।`
          )
        );
      }
    } catch (err) {
      const msg = reportFirestoreError(err, OperationType.UPDATE, item.ref.path);
      setConsoleError(msg);
    } finally {
      setRestoringKey(null);
    }
  };

  const filteredBackupItems = useMemo(() => {
    const q = backupSearchQuery.trim().toLowerCase();
    return backupItems.filter((item) => {
      if (backupClinicFilter !== 'all' && item.clinicId !== backupClinicFilter) return false;
      if (backupKindFilter !== 'all' && item.kind !== backupKindFilter) return false;
      if (!q) return true;
      return (
        item.title.toLowerCase().includes(q) ||
        item.subtitle.toLowerCase().includes(q) ||
        item.clinicName.toLowerCase().includes(q) ||
        item.kind.toLowerCase().includes(q)
      );
    });
  }, [backupItems, backupClinicFilter, backupKindFilter, backupSearchQuery]);

  const backupKindLabel = (kind: DeletedRecordKind): string => {
    switch (kind) {
      case 'patient':
        return t('Patient', 'রোগী');
      case 'consultation':
        return t('Visit / Remedy', 'ভিজিট / ঔষধ');
      case 'photo':
        return t('Photo', 'ছবি');
      case 'note':
        return t('Clinical Note', 'ক্লিনিক্যাল নোট');
      case 'fee':
        return t('Cash Fee', 'নগদ ফি');
      case 'repertory':
        return t('Repertory', 'রেপার্টরি');
      case 'disease':
        return t('Disease Guide', 'রোগ ও ঔষধ');
    }
  };

  return (
    <div className="space-y-6">
      {/* Super Admin Hero Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-medium text-teal-800 mb-1">
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>{platformConfig.platformName}</span>
            <span aria-hidden="true">·</span>
            <span>{t('Super Admin Control Plane', 'সুপার অ্যাডমিন কন্ট্রোল প্যানেল')}</span>
          </div>
          <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
            {t('SaaS Platform, Clients & Hosting', 'SaaS প্ল্যাটফর্ম, ক্লায়েন্ট ও হোস্টিং')}
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {t(
              'Provision white-labeled client clinic URLs, customize branding, and govern database subscriptions and free-tier hosting.',
              'ক্লায়েন্টদের জন্য আলাদা ক্লিনিক URL তৈরি, ব্র্যান্ডিং কাস্টমাইজেশন, ডেটাবেস সাবস্ক্রিপশন এবং ফ্রি-টিয়ার হোস্টিং পরিচালনা করুন।'
            )}
          </p>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={onRefreshHealth}
            disabled={loadingHealth}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer whitespace-nowrap"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loadingHealth ? 'animate-spin' : ''}`} />
            {t('Refresh Health', 'হেলথ রিফ্রেশ')}
          </button>
          <button
            type="button"
            onClick={onCreateClinic}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-lg hover:bg-teal-800 transition-colors cursor-pointer whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            {t('New Client Clinic', 'নতুন ক্লায়েন্ট ক্লিনিক')}
          </button>
        </div>
      </div>

      {consoleError && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-xs text-red-800" role="alert">
          {consoleError}
        </div>
      )}

      {/* 4-Column Platform KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-slate-500">
              {t('Hosted Clinics', 'হোস্টেড ক্লিনিক')}
            </p>
            <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-emerald-700 tabular-nums">
              <span
                className={`w-2 h-2 rounded-full ${
                  counts.onlineNow > 0 ? 'bg-emerald-500 animate-pulse' : 'bg-slate-300'
                }`}
              />
              {counts.onlineNow} {t('online now', 'এখন সক্রিয়')}
            </span>
          </div>
          <p className="font-display text-2xl font-semibold text-slate-900 mt-1 tabular-nums">
            {clinics.length}
          </p>
          <p className="text-xs text-slate-500 mt-1 tabular-nums">
            {counts.active} {t('active', 'সক্রিয়')} · {counts.trial} {t('trial', 'ট্রায়াল')} ·{' '}
            {counts.suspended} {t('paused', 'স্থগিত')}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">
            {t('Monthly Subscription Value', 'মাসিক সাবস্ক্রিপশন আয়')}
          </p>
          <p className="font-display text-2xl font-semibold text-slate-900 mt-1 font-mono tabular-nums">
            {formattedMrrSummary}
          </p>
          <p className="text-xs text-slate-500 mt-1 tabular-nums">
            {counts.payingClinics} {t('paid clinics', 'টি পেইড ক্লিনিক')}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">
            {t('Total Photo Storage', 'মোট ফটো স্টোরেজ')}
          </p>
          <p className="font-display text-2xl font-semibold text-slate-900 mt-1 tabular-nums">
            {saasHealth ? formatBytes(saasHealth.storage.totalBytes) : '—'}
          </p>
          <p className="text-xs text-slate-500 mt-1 tabular-nums">
            {saasHealth
              ? `${saasHealth.storage.totalFiles} ${
                  saasHealth.b2Configured
                    ? t('files in Backblaze B2', 'টি ফাইল Backblaze B2-এ')
                    : t('files on disk', 'টি ফাইল ডিস্কে')
                }`
              : t('Checking storage...', 'স্টোরেজ যাচাই হচ্ছে...')}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">
            {t('Hosting Readiness', 'হোস্টিং স্ট্যাটাস')}
          </p>
          <p className="font-display text-2xl font-semibold text-slate-900 mt-1">
            {saasHealth?.ok ? t('Healthy', 'সচল') : t('Checking', 'যাচাই')}
          </p>
          <p className="text-xs text-slate-500 mt-1">
            {saasHealth
              ? `Gemini ${saasHealth.geminiConfigured ? 'ON' : 'OFF'} · ${
                  saasHealth.b2Configured
                    ? 'B2 Cloud ON'
                    : `Disk ${saasHealth.uploadRootWritable ? 'RW' : 'RO'}`
                }`
              : defaultHostingProvider}
          </p>
        </div>
      </div>

      {/* Sub-navigation Tabs */}
      <div className="border-b border-slate-200 flex items-center gap-6 overflow-x-auto">
        {(
          [
            {
              id: 'clients',
              label: t('Clients & Workspaces', 'ক্লায়েন্ট ও ওয়ার্কস্পেস'),
              icon: Building2,
            },
            {
              id: 'subscriptions',
              label: t('Database & Subscriptions', 'ডেটাবেস ও সাবস্ক্রিপশন'),
              icon: CreditCard,
            },
            {
              id: 'hosting',
              label: t('Hosting, Health & Migration', 'হোস্টিং, হেলথ ও মাইগ্রেশন'),
              icon: Server,
            },
            {
              id: 'backup',
              label: t('Deleted Backup & Restore', 'ডিলিট ব্যাকআপ ও রিস্টোর'),
              icon: ArchiveRestore,
            },
          ] as const
        ).map((tab) => {
          const Icon = tab.icon;
          const isCurrent = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`inline-flex items-center gap-2 py-3 text-xs font-medium border-b-2 transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                isCurrent
                  ? 'border-teal-700 text-teal-800'
                  : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* TAB 1: CLIENTS & WORKSPACES */}
      {activeTab === 'clients' && (
        <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          {clinics.length === 0 ? (
            <div className="p-12 text-center">
              <Building2 className="w-7 h-7 text-slate-400 mx-auto mb-3" />
              <h2 className="font-display text-base font-semibold text-slate-900">
                {t('No client clinics provisioned yet', 'এখনো কোনো ক্লায়েন্ট ক্লিনিক তৈরি হয়নি')}
              </h2>
              <p className="text-xs text-slate-500 mt-1 mb-5 max-w-md mx-auto">
                {t(
                  'Create your first client clinic to generate a dedicated shareable URL and isolated patient database.',
                  'একটি শেয়ারযোগ্য URL এবং আলাদা রোগী ডেটাবেস পেতে আপনার প্রথম ক্লায়েন্ট ক্লিনিক তৈরি করুন।'
                )}
              </p>
              <button
                type="button"
                onClick={onCreateClinic}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-lg hover:bg-teal-800 transition-colors cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                {t('Create First Clinic', 'প্রথম ক্লিনিক তৈরি করুন')}
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold text-slate-500">
                    <th className="py-3 px-4 whitespace-nowrap">{t('Clinic & Branding', 'ক্লিনিক ও ব্র্যান্ডিং')}</th>
                    <th className="py-3 px-4 whitespace-nowrap">{t('Client Access', 'ক্লায়েন্ট অ্যাক্সেস')}</th>
                    <th className="py-3 px-4 whitespace-nowrap">{t('Live Activity & Last Seen', 'সক্রিয়তা ও সর্বশেষ উপস্থিতি')}</th>
                    <th className="py-3 px-4 whitespace-nowrap">{t('Plan & Storage', 'প্ল্যান ও স্টোরেজ')}</th>
                    <th className="py-3 px-4 whitespace-nowrap">{t('Status', 'অবস্থা')}</th>
                    <th className="py-3 px-4 whitespace-nowrap text-right">{t('Actions', 'কার্যক্রম')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 text-xs">
                  {clinics.map((clinic) => {
                    const palette =
                      ACCENT_THEME_PALETTES[clinic.accentColor] || ACCENT_THEME_PALETTES.teal;
                    const diskStats = saasHealth?.storage.byClinic[clinic.id];
                    const isSuspended = clinic.subscriptionStatus === 'suspended';
                    const isConfirmingDelete = confirmDeleteClinicId === clinic.id;
                    const presence = formatClientPresence(clinic, language, nowMs);

                    return (
                      <tr key={clinic.id} className="hover:bg-slate-50/70 transition-colors">
                        <td className="py-3.5 px-4 align-top">
                          <div className="flex items-start gap-2.5">
                            <span
                              className={`w-2.5 h-2.5 rounded-sm mt-1 shrink-0 ${palette.swatchHex}`}
                            />
                            <div className="min-w-0">
                              <p className="font-semibold text-slate-900">{clinic.clinicName}</p>
                              <p className="text-[11px] text-slate-500 mt-0.5">
                                {clinic.practitionerName} · {clinic.currencySymbol}
                              </p>
                              {clinic.tagline && (
                                <p className="text-[11px] text-slate-400 truncate max-w-[220px]">
                                  {clinic.tagline}
                                </p>
                              )}
                            </div>
                          </div>
                        </td>

                        <td className="py-3.5 px-4 align-top">
                          <p className="font-mono text-slate-800">{clinic.ownerEmail}</p>
                          <p className="text-[11px] text-slate-500 mt-0.5 tabular-nums">
                            {clinic.authorizedUids && clinic.authorizedUids.length > 0 ? (
                              <>
                                {clinic.accessEmails.length}{' '}
                                {t('password login(s) · UID locked', 'টি পাসওয়ার্ড লগইন · UID লক সক্রিয়')}
                              </>
                            ) : (
                              <span className="text-amber-700 font-medium">
                                {t('Needs password / UID setup', 'পাসওয়ার্ড ও UID সেটআপ প্রয়োজন')}
                              </span>
                            )}
                          </p>
                        </td>

                        <td className="py-3.5 px-4 align-top whitespace-nowrap">
                          {presence.isOnline ? (
                            <div className="space-y-0.5">
                              <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-700">
                                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse shrink-0" />
                                {t('Active Now', 'এখন সক্রিয়')}
                              </span>
                              {presence.activeEmail && (
                                <p className="text-[11px] font-mono text-slate-600 truncate max-w-[180px]">
                                  {presence.activeEmail}
                                </p>
                              )}
                              {presence.exactLabel && (
                                <p className="text-[11px] text-slate-400 tabular-nums">
                                  {presence.relativeLabel} · {presence.exactLabel}
                                </p>
                              )}
                            </div>
                          ) : presence.hasSeenBefore ? (
                            <div className="space-y-0.5">
                              <span className="inline-flex items-center gap-1.5 font-medium text-slate-700">
                                <span className="w-2 h-2 rounded-full bg-slate-300 shrink-0" />
                                {t('Last active:', 'সর্বশেষ:')} {presence.relativeLabel}
                              </span>
                              {presence.exactLabel && (
                                <p className="text-[11px] text-slate-500 tabular-nums">
                                  {presence.exactLabel}
                                </p>
                              )}
                              {presence.activeEmail && (
                                <p className="text-[11px] font-mono text-slate-400 truncate max-w-[180px]">
                                  {presence.activeEmail}
                                </p>
                              )}
                            </div>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-400">
                              <span className="w-2 h-2 rounded-full bg-slate-200 shrink-0" />
                              {presence.relativeLabel}
                            </span>
                          )}
                        </td>

                        <td className="py-3.5 px-4 align-top tabular-nums">
                          <p className="font-medium text-slate-900">
                            {planLabels[clinic.planTier].name}
                          </p>
                          <p className="text-[11px] text-slate-500 mt-0.5 font-mono">
                            {diskStats ? formatBytes(diskStats.totalBytes) : '0 B'} /{' '}
                            {clinic.storageLimitMb} MB · {clinic.patientLimit}{' '}
                            {t('pts', 'রোগী')}
                          </p>
                        </td>

                        <td className="py-3.5 px-4 align-top whitespace-nowrap">
                          <span
                            className={`font-medium ${
                              clinic.subscriptionStatus === 'active'
                                ? 'text-emerald-700'
                                : clinic.subscriptionStatus === 'trial'
                                  ? 'text-amber-700'
                                  : 'text-red-700'
                            }`}
                          >
                            {subStatusLabels[clinic.subscriptionStatus]}
                          </span>
                          {clinic.monthlyFeeAmount > 0 && (
                            <p className="text-[11px] font-mono text-slate-500 mt-0.5 tabular-nums">
                              {clinic.currencySymbol}
                              {clinic.monthlyFeeAmount} · {billingLabels[clinic.billingCycle]}
                            </p>
                          )}
                        </td>

                        <td className="py-3.5 px-4 align-top text-right whitespace-nowrap">
                          {isConfirmingDelete ? (
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                type="button"
                                disabled={deletingClinicId === clinic.id}
                                onClick={() => handleDeleteClinic(clinic)}
                                className="px-2.5 py-1 text-[11px] font-medium text-white bg-red-700 rounded hover:bg-red-800 cursor-pointer disabled:opacity-60"
                              >
                                {deletingClinicId === clinic.id
                                  ? t('Deleting...', 'মুছছে...')
                                  : t('Confirm Delete', 'নিশ্চিত মুছুন')}
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteClinicId(null)}
                                className="px-2 py-1 text-[11px] font-medium text-slate-600 bg-white border border-slate-300 rounded hover:bg-slate-50 cursor-pointer"
                              >
                                {t('Cancel', 'বাতিল')}
                              </button>
                            </div>
                          ) : (
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => onOpenClinicWorkspace(clinic.id)}
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium text-teal-800 bg-teal-50 border border-teal-200 rounded-md hover:bg-teal-100 cursor-pointer whitespace-nowrap"
                              >
                                <span>{t('Open', 'খুলুন')}</span>
                                <ArrowRight className="w-3 h-3" />
                              </button>
                              <button
                                type="button"
                                onClick={() => onEditClinic(clinic)}
                                title={t('Customize clinic', 'ক্লিনিক কাস্টমাইজ করুন')}
                                className="p-1.5 text-slate-600 hover:text-slate-900 border border-slate-200 rounded-md hover:bg-slate-100 cursor-pointer"
                              >
                                <Edit3 className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                disabled={togglingClinicId === clinic.id}
                                onClick={() => handleToggleSuspend(clinic)}
                                title={
                                  isSuspended
                                    ? t('Activate clinic', 'সক্রিয় করুন')
                                    : t('Suspend clinic', 'সাময়িক স্থগিত করুন')
                                }
                                className="p-1.5 text-slate-600 hover:text-slate-900 border border-slate-200 rounded-md hover:bg-slate-100 cursor-pointer disabled:opacity-50"
                              >
                                {isSuspended ? (
                                  <PlayCircle className="w-3.5 h-3.5 text-emerald-700" />
                                ) : (
                                  <PauseCircle className="w-3.5 h-3.5 text-amber-700" />
                                )}
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteClinicId(clinic.id)}
                                title={t('Delete clinic', 'ক্লিনিক মুছুন')}
                                className="p-1.5 text-slate-500 hover:text-red-700 border border-slate-200 rounded-md hover:bg-red-50 cursor-pointer"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* TAB 2: DATABASE & SUBSCRIPTIONS */}
      {activeTab === 'subscriptions' && (
        <div className="space-y-6">
          <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h2 className="font-display text-sm font-semibold text-slate-900">
                  {t('Client Database Quotas & Billing Ledger', 'ক্লায়েন্ট ডেটাবেস কোটা ও বিলিং খাতা')}
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  {t(
                    'Enforced across Firestore security rules and Express photo server quotas.',
                    'ফায়ারস্টোর সিকিউরিটি রুলস এবং ফটো সার্ভারে স্বয়ংক্রিয়ভাবে সীমা কার্যকর থাকে।'
                  )}
                </p>
              </div>
              <button
                type="button"
                onClick={onCreateClinic}
                className="px-3 py-1.5 text-xs font-medium text-teal-800 bg-teal-50 border border-teal-200 rounded-lg hover:bg-teal-100 cursor-pointer whitespace-nowrap"
              >
                + {t('Add Clinic Plan', 'নতুন ক্লিনিক যোগ')}
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold text-slate-500">
                    <th className="py-3 px-4 whitespace-nowrap">{t('Clinic', 'ক্লিনিক')}</th>
                    <th className="py-3 px-4 whitespace-nowrap">{t('Plan Tier', 'প্ল্যান')}</th>
                    <th className="py-3 px-4 whitespace-nowrap">{t('Patient Quota', 'রোগী সীমা')}</th>
                    <th className="py-3 px-4 whitespace-nowrap">{t('Photo Disk Quota', 'ফটো ডিস্ক কোটা')}</th>
                    <th className="py-3 px-4 whitespace-nowrap">{t('Billing', 'বিলিং')}</th>
                    <th className="py-3 px-4 whitespace-nowrap">{t('Status', 'অবস্থা')}</th>
                    <th className="py-3 px-4 whitespace-nowrap">{t('Notes', 'নোট')}</th>
                    <th className="py-3 px-4 whitespace-nowrap text-right">{t('Edit', 'সম্পাদনা')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 text-xs">
                  {clinics.map((clinic) => {
                    const diskUsed = saasHealth?.storage.byClinic[clinic.id]?.totalBytes || 0;
                    return (
                      <tr key={clinic.id} className="hover:bg-slate-50/70">
                        <td className="py-3 px-4 font-medium text-slate-900 whitespace-nowrap">
                          {clinic.clinicName}
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap">
                          {planLabels[clinic.planTier].name}
                        </td>
                        <td className="py-3 px-4 font-mono tabular-nums whitespace-nowrap">
                          {clinic.patientLimit.toLocaleString()} {t('patients', 'জন')}
                        </td>
                        <td className="py-3 px-4 font-mono tabular-nums whitespace-nowrap">
                          {formatBytes(diskUsed)} / {clinic.storageLimitMb} MB
                        </td>
                        <td className="py-3 px-4 font-mono tabular-nums whitespace-nowrap">
                          {clinic.monthlyFeeAmount > 0
                            ? `${clinic.currencySymbol}${clinic.monthlyFeeAmount} (${billingLabels[clinic.billingCycle]})`
                            : billingLabels[clinic.billingCycle]}
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap">
                          <span
                            className={`font-medium ${
                              clinic.subscriptionStatus === 'active'
                                ? 'text-emerald-700'
                                : clinic.subscriptionStatus === 'trial'
                                  ? 'text-amber-700'
                                  : 'text-red-700'
                            }`}
                          >
                            {subStatusLabels[clinic.subscriptionStatus]}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-slate-500 max-w-[200px] truncate">
                          {clinic.subscriptionNotes || '—'}
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => onEditClinic(clinic)}
                            className="px-2.5 py-1 text-[11px] font-medium text-slate-700 bg-white border border-slate-300 rounded hover:bg-slate-50 cursor-pointer"
                          >
                            {t('Adjust Plan', 'পরিবর্তন')}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* Platform Tier Catalog Reference */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {(['free', 'growth', 'clinic_pro'] as PlanTier[]).map((tierKey) => {
              const plan = PLAN_CATALOG[tierKey];
              const localized = planLabels[tierKey];
              return (
                <div key={tierKey} className="bg-white border border-slate-200 rounded-xl p-5">
                  <div className="flex items-baseline justify-between gap-2">
                    <h3 className="font-display text-sm font-semibold text-slate-900">
                      {localized.name}
                    </h3>
                    <span className="font-mono text-xs font-semibold text-teal-800 tabular-nums">
                      {localized.monthlyPriceLabel}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 mt-1">{localized.audience}</p>
                  <dl className="mt-4 pt-3 border-t border-slate-100 space-y-1.5 text-xs">
                    <div className="flex justify-between">
                      <dt className="text-slate-500">{t('Default Patients:', 'ডিফল্ট রোগী সীমা:')}</dt>
                      <dd className="font-mono text-slate-900 tabular-nums">{plan.patientLimit}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-slate-500">{t('Default Storage:', 'ডিফল্ট স্টোরেজ:')}</dt>
                      <dd className="font-mono text-slate-900 tabular-nums">
                        {plan.storageLimitMb >= 1024
                          ? `${plan.storageLimitMb / 1024} GB`
                          : `${plan.storageLimitMb} MB`}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-slate-500">{t('Database:', 'ডেটাবেস:')}</dt>
                      <dd className="text-slate-700 text-right">{localized.databaseTier}</dd>
                    </div>
                  </dl>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* TAB 3: HOSTING, HEALTH & LEGACY MIGRATION */}
      {activeTab === 'hosting' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Global Hosting Configuration Form */}
            <form
              onSubmit={handleSaveHostingConfig}
              className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6 space-y-4"
            >
              <div className="flex items-center justify-between border-b border-slate-200 pb-3">
                <div className="flex items-center gap-2">
                  <Server className="w-4 h-4 text-teal-700" />
                  <h2 className="font-display text-base font-semibold text-slate-900">
                    {t('Global Hosting & Platform Settings', 'গ্লোবাল হোস্টিং ও প্ল্যাটফর্ম সেটিংস')}
                  </h2>
                </div>
                {hostingSavedNotice && (
                  <span className="text-xs font-medium text-emerald-700">
                    {t('Saved to Firestore', 'সংরক্ষিত হয়েছে')}
                  </span>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {t('Platform Brand Name *', 'প্ল্যাটফর্ম ব্র্যান্ড নাম *')}
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={FIELD_LIMITS.platformNameMax}
                    value={platformName}
                    onChange={(e) => setPlatformName(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {t('Platform Support Email *', 'সাপোর্ট ইমেইল *')}
                  </label>
                  <input
                    type="email"
                    required
                    maxLength={FIELD_LIMITS.emailMax}
                    value={supportEmail}
                    onChange={(e) => setSupportEmail(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {t('Free Hosting Provider *', 'ফ্রি হোস্টিং প্রোভাইডার *')}
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={FIELD_LIMITS.hostingProviderMax}
                    value={defaultHostingProvider}
                    onChange={(e) => setDefaultHostingProvider(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {t('Cloud Region *', 'ক্লাউড রিজিওন *')}
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={80}
                    value={defaultRegion}
                    onChange={(e) => setDefaultRegion(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t(
                    'Public Hosted App URL (Used to generate client links)',
                    'পাবলিক হোস্টেড অ্যাপ URL (ক্লায়েন্ট লিংক তৈরিতে ব্যবহৃত)'
                  )}
                </label>
                <input
                  type="url"
                  maxLength={300}
                  value={publicBaseUrl}
                  onChange={(e) => setPublicBaseUrl(e.target.value)}
                  placeholder="https://your-clinic-saas.onrender.com"
                  className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                />
                {(isPrivateDevPreviewUrl(publicBaseUrl) ||
                  (!publicBaseUrl &&
                    typeof window !== 'undefined' &&
                    /^https?:\/\/ais-(dev|pre)-/i.test(window.location.origin))) && (
                  <p className="text-[11px] text-amber-800 mt-1.5 leading-relaxed">
                    {t(
                      'Note: ais-dev-* links are private (403 in Firefox/other browsers), and ais-pre-* returns "Page not found" until you click Share/Publish in AI Studio. To get a clean public URL with no 403/404 and no AI Studio loading logo, deploy the app (Cloud Run / Render) and paste your live domain here.',
                      'নোট: ais-dev-* লিংক প্রাইভেট (Firefox-এ 403 দেখায়) এবং AI Studio থেকে Share/Publish না করলে ais-pre-* লিংকে "Page not found" দেখায়। 403/404 ও স্টুডিও লোগো ছাড়া সরাসরি পাবলিক লিংকের জন্য অ্যাপটি Cloud Run বা Render-এ ডিপ্লয় করে সেই URL এখানে সেভ করুন।'
                    )}
                  </p>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t('Free-Tier Summary Note', 'ফ্রি-টিয়ার সারসংক্ষেপ')}
                </label>
                <textarea
                  rows={2}
                  maxLength={500}
                  value={freeTierSummary}
                  onChange={(e) => setFreeTierSummary(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t('Maintenance Banner Notice (Optional)', 'মেইনটেন্যান্স নোটিশ (ঐচ্ছিক)')}
                </label>
                <input
                  type="text"
                  maxLength={400}
                  value={maintenanceNotice}
                  onChange={(e) => setMaintenanceNotice(e.target.value)}
                  placeholder={t(
                    'Leave empty unless announcing scheduled maintenance to clinics',
                    'রক্ষণাবেক্ষণ বার্তা না থাকলে খালি রাখুন'
                  )}
                  className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                />
              </div>

              <div className="pt-2 flex justify-end">
                <button
                  type="submit"
                  disabled={savingHosting}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-lg hover:bg-teal-800 disabled:opacity-60 cursor-pointer"
                >
                  {savingHosting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {t('Save Hosting Configuration', 'হোস্টিং কনফিগারেশন সংরক্ষণ')}
                </button>
              </div>
            </form>

            {/* Live Server Health & Environment Diagnostics */}
            <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 space-y-5">
              <div className="flex items-center justify-between border-b border-slate-200 pb-3">
                <div className="flex items-center gap-2">
                  <HardDrive className="w-4 h-4 text-teal-700" />
                  <h2 className="font-display text-base font-semibold text-slate-900">
                    {t('Live Server & Storage Diagnostics', 'লাইভ সার্ভার ও স্টোরেজ ডায়াগনস্টিক')}
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={onRefreshHealth}
                  disabled={loadingHealth}
                  className="p-1.5 text-slate-500 hover:text-slate-900 rounded border border-slate-200 cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${loadingHealth ? 'animate-spin' : ''}`} />
                </button>
              </div>

              {saasHealth ? (
                <dl className="space-y-2.5 text-xs">
                  <div className="flex justify-between">
                    <dt className="text-slate-500">{t('Runtime / Port', 'রানটাইম / পোর্ট')}</dt>
                    <dd className="font-mono text-slate-900 tabular-nums">
                      {saasHealth.nodeVersion} · :{saasHealth.port} ({saasHealth.environment})
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-500">{t('Server Uptime', 'সার্ভার আপটাইম')}</dt>
                    <dd className="font-mono text-slate-900 tabular-nums">
                      {Math.floor(saasHealth.uptimeSeconds / 60)}m {saasHealth.uptimeSeconds % 60}s
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-500">{t('Gemini API Key', 'Gemini API কী')}</dt>
                    <dd
                      className={`font-medium ${
                        saasHealth.geminiConfigured ? 'text-emerald-700' : 'text-red-700'
                      }`}
                    >
                      {saasHealth.geminiConfigured ? t('Configured', 'যুক্ত আছে') : t('Missing', 'নেই')}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-500">{t('Firebase Project', 'ফায়ারবেস প্রজেক্ট')}</dt>
                    <dd className="font-mono text-slate-900 truncate max-w-[190px]">
                      {saasHealth.firebaseProjectId || '—'}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-500">{t('Firestore Database', 'ফায়ারস্টোর ডেটাবেস')}</dt>
                    <dd className="font-mono text-slate-900 truncate max-w-[190px]">
                      {saasHealth.firestoreDatabaseId || '(default)'}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-500">{t('Media Storage Backend', 'মিডিয়া স্টোরেজ মাধ্যম')}</dt>
                    <dd
                      className={`font-medium text-right ${
                        saasHealth.b2Configured ? 'text-emerald-700' : 'text-amber-700'
                      }`}
                    >
                      {saasHealth.b2Configured
                        ? `Backblaze B2 (${saasHealth.b2BucketName || 'Bucket'})`
                        : t('Local Disk Fallback', 'লোকাল ডিস্ক (সাময়িক)')}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-500">{t('Photo Disk Root', 'ফটো ডিস্ক রুট')}</dt>
                    <dd
                      className={`font-medium ${
                        saasHealth.uploadRootWritable ? 'text-emerald-700' : 'text-red-700'
                      }`}
                    >
                      {saasHealth.uploadRootWritable ? t('Writable', 'লেখাযোগ্য') : t('Read-Only', 'সীমিত')}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-500">{t('Legacy Root Photos', 'লিগ্যাসি ফটো')}</dt>
                    <dd className="font-mono text-slate-700 tabular-nums">
                      {saasHealth.storage.legacyStats.totalFiles} files ·{' '}
                      {formatBytes(saasHealth.storage.legacyStats.totalBytes)}
                    </dd>
                  </div>
                </dl>
              ) : (
                <p className="text-xs text-slate-500">
                  {t('Fetching live Express server telemetry...', 'সার্ভার তথ্য আনা হচ্ছে...')}
                </p>
              )}

              <div className="pt-4 border-t border-slate-200 space-y-2 text-xs text-slate-600 leading-relaxed">
                <p className="font-semibold text-slate-900">
                  {t('Free Hosting Checklist (Share With Clients):', 'ফ্রি হোস্টিং চেকলিস্ট:')}
                </p>
                <ol className="list-decimal list-inside space-y-1">
                  <li>
                    {t(
                      'Deploy Node server (npm run build && npm start) on Render Free Web Service with GEMINI_API_KEY plus Backblaze B2 vars (B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET_NAME) for persistent 10 GB private photo storage.',
                      'Render ফ্রি ওয়েব সার্ভিসে Node সার্ভার (npm run build && npm start) ডিপ্লয় করুন এবং GEMINI_API_KEY ও Backblaze B2-এর জন্য B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET_NAME যুক্ত করুন।'
                    )}
                  </li>
                  <li>
                    {t(
                      'Host the static frontend on Firebase Hosting Spark (firebase deploy --only hosting) with VITE_API_BASE_URL pointing to your Render URL.',
                      'VITE_API_BASE_URL-এ Render লিংক দিয়ে Firebase Hosting Spark-এ (firebase deploy --only hosting) ফ্রন্টএন্ড হোস্ট করুন।'
                    )}
                  </li>
                  <li>
                    {t(
                      'In Firebase Console → Authentication → Sign-in method, enable Email/Password (for client clinic logins) and add your live domain under Authorized Domains.',
                      'ক্লায়েন্ট লগইন চালু করতে Firebase Console → Authentication → Sign-in method-এ Email/Password সক্রিয় করুন এবং Authorized Domains-এ ডোমেইন যোগ করুন।'
                    )}
                  </li>
                  <li>
                    {t(
                      'Set Public Hosted App URL on the left, assign each client’s Email & Password, and share their clean /clinic-name link.',
                      'বাম পাশে পাবলিক হোস্টেড URL সংরক্ষণ করে প্রতিটি ক্লায়েন্টকে নির্ধারিত ইমেইল, পাসওয়ার্ড এবং সংক্ষিপ্ত /clinic-name লিংক দিন।'
                    )}
                  </li>
                </ol>
              </div>
            </div>
          </div>

          {/* Legacy Root Data Migration Tool */}
          <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 pb-4">
              <div className="flex items-center gap-2">
                <Database className="w-4 h-4 text-teal-700" />
                <div>
                  <h2 className="font-display text-base font-semibold text-slate-900">
                    {t('Legacy Single-Clinic Data Migration', 'পুরনো একক-ক্লিনিক ডেটা মাইগ্রেশন')}
                  </h2>
                  <p className="text-xs text-slate-500">
                    {t(
                      'Scan root collections (/patients, /fee_records, /repertory_entries) and copy them into any multi-tenant clinic.',
                      'পুরনো রুট ডেটাবেস স্ক্যান করে যেকোনো মাল্টি-টেন্যান্ট ক্লিনিকে স্থানান্তর করুন।'
                    )}
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={handleScanLegacy}
                disabled={scanningLegacy}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
              >
                {scanningLegacy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {t('Scan Legacy Collections', 'পুরনো ডেটা স্ক্যান করুন')}
              </button>
            </div>

            {legacySummary && (
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 bg-slate-50 border border-slate-200 rounded-lg p-4">
                <div className="text-xs text-slate-700 space-y-1 tabular-nums">
                  <p className="font-semibold text-slate-900">
                    {t('Legacy Collections Found', 'পাওয়া লিগ্যাসি রেকর্ড')} ({legacySummary.scannedAt})
                  </p>
                  <p>
                    {legacySummary.patients} {t('patients', 'জন রোগী')} · {legacySummary.fees}{' '}
                    {t('fee records', 'টি ফি রেকর্ড')} · {legacySummary.repertory}{' '}
                    {t('repertory entries', 'টি রেপার্টরি')}
                  </p>
                </div>

                {clinics.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2.5">
                    <select
                      value={migrationTargetClinicId}
                      onChange={(e) => setMigrationTargetClinicId(e.target.value)}
                      className="px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg"
                    >
                      {clinics.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.clinicName} (/{c.slug})
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={
                        migratingLegacy ||
                        (legacySummary.patients === 0 &&
                          legacySummary.fees === 0 &&
                          legacySummary.repertory === 0)
                      }
                      onClick={handleMigrateLegacyData}
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-lg hover:bg-teal-800 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                    >
                      {migratingLegacy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                      {t('Copy Legacy Data to Selected Clinic', 'নির্বাচিত ক্লিনিকে কপি করুন')}
                    </button>
                  </div>
                )}
              </div>
            )}

            {migrationNotice && (
              <div className="border border-emerald-200 bg-emerald-50 rounded-lg p-3 text-xs text-emerald-900">
                {migrationNotice}
              </div>
            )}
          </section>
        </div>
      )}

      {/* TAB 4: DELETED BACKUP & RESTORE (ZERO HARD DELETE RECOVERY) */}
      {activeTab === 'backup' && (
        <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-200 pb-4">
            <div>
              <h2 className="font-display text-base font-semibold text-slate-900 flex items-center gap-2">
                <ArchiveRestore className="w-4 h-4 text-teal-700" />
                <span>
                  {t(
                    'Soft-Deleted Records Backup & Recovery',
                    'মুছে ফেলা তথ্যের ব্যাকআপ ও পুনরুদ্ধার'
                  )}
                </span>
              </h2>
              <p className="text-xs text-slate-500 mt-1">
                {t(
                  'Clinics delete their own active records directly. Any previously archived or soft-deleted patients, visits, fees, notes, photos, and disease guides can still be scanned, restored, or purged here.',
                  'ক্লিনিকগুলো এখন সরাসরি নিজেদের তথ্য মুছে ফেলতে পারে। আগে মুছে ব্যাকআপে রাখা কোনো রোগী, ভিজিট, ফি, নোট, ছবি বা রোগের তালিকা এখান থেকে স্ক্যান করে পুনরুদ্ধার বা স্থায়ীভাবে মুছতে পারবেন।'
                )}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2.5 shrink-0">
              <select
                value={backupClinicFilter}
                onChange={(e) => setBackupClinicFilter(e.target.value)}
                aria-label={t('Filter by clinic', 'ক্লিনিক নির্বাচন')}
                className="px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg"
              >
                <option value="all">{t('All Clinics', 'সব ক্লিনিক')}</option>
                {clinics.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.clinicName}
                  </option>
                ))}
              </select>

              <button
                type="button"
                disabled={scanningBackup || clinics.length === 0}
                onClick={handleScanDeletedBackup}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-lg hover:bg-teal-800 disabled:opacity-60 transition-colors cursor-pointer whitespace-nowrap"
              >
                {scanningBackup ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5" />
                )}
                {scanningBackup
                  ? t('Scanning Backup...', 'ব্যাকআপ স্ক্যান হচ্ছে...')
                  : t('Scan Deleted Backup', 'ডিলিট ব্যাকআপ স্ক্যান করুন')}
              </button>
            </div>
          </div>

          {backupNotice && (
            <div className="border border-emerald-200 bg-emerald-50 rounded-lg p-3 text-xs text-emerald-900">
              {backupNotice}
            </div>
          )}

          {backupScannedOnce && backupItems.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg w-fit">
                {(
                  [
                    'all',
                    'patient',
                    'consultation',
                    'fee',
                    'note',
                    'photo',
                    'disease',
                    'repertory',
                  ] as const
                ).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => setBackupKindFilter(kind)}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                      backupKindFilter === kind
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {kind === 'all' ? t('All Types', 'সব ধরন') : backupKindLabel(kind)}
                  </button>
                ))}
              </div>

              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="search"
                  value={backupSearchQuery}
                  onChange={(e) => setBackupSearchQuery(e.target.value)}
                  placeholder={t(
                    'Search patient, case #, phone, address...',
                    'রোগী, কেস নং, ফোন বা ঠিকানা...'
                  )}
                  className="pl-8 pr-3 py-1.5 text-xs w-60 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                />
              </div>
            </div>
          )}

          {!backupScannedOnce ? (
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-10 text-center">
              <ArchiveRestore className="w-7 h-7 text-slate-400 mx-auto mb-2.5" />
              <h3 className="font-display text-sm font-semibold text-slate-900">
                {t('Ready to inspect clinic backups', 'ক্লিনিক ব্যাকআপ যাচাই করতে প্রস্তুত')}
              </h3>
              <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
                {t(
                  'Click "Scan Deleted Backup" above to fetch all soft-deleted items preserved across your hosted clinics.',
                  'ক্লিনিকগুলোতে মুছে ফেলা সব সংরক্ষিত তথ্য দেখতে উপরে "ডিলিট ব্যাকআপ স্ক্যান করুন" বাটনে ক্লিক করুন।'
                )}
              </p>
            </div>
          ) : filteredBackupItems.length === 0 ? (
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-10 text-center">
              <p className="text-sm font-medium text-slate-800">
                {t('No deleted backup records found', 'মুছে ফেলা কোনো রেকর্ড পাওয়া যায়নি')}
              </p>
              <p className="text-xs text-slate-500 mt-1">
                {t(
                  'All scanned records are currently active, or none match the selected filter.',
                  'স্ক্যান করা সব তথ্য সক্রিয় রয়েছে অথবা বর্তমান ফিল্টারে কোনো মুছে ফেলা রেকর্ড নেই।'
                )}
              </p>
            </div>
          ) : (
            <div className="border border-slate-200 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold text-slate-500">
                      <th className="py-3 px-4 whitespace-nowrap">{t('Type', 'ধরন')}</th>
                      <th className="py-3 px-4 whitespace-nowrap">{t('Clinic', 'ক্লিনিক')}</th>
                      <th className="py-3 px-4 whitespace-nowrap">{t('Record Details', 'তথ্যের বিবরণ')}</th>
                      <th className="py-3 px-4 whitespace-nowrap">{t('Deleted At', 'ডিলিটের সময়')}</th>
                      <th className="py-3 px-4 whitespace-nowrap text-right">{t('Restore', 'পুনরুদ্ধার')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {filteredBackupItems.map((item) => (
                      <tr key={item.key} className="hover:bg-slate-50/70 align-top">
                        <td className="py-3 px-4 whitespace-nowrap">
                          <span className="px-2 py-0.5 text-[11px] font-medium bg-slate-100 text-slate-800 border border-slate-200 rounded">
                            {backupKindLabel(item.kind)}
                          </span>
                        </td>
                        <td className="py-3 px-4 font-medium text-slate-800 whitespace-nowrap">
                          {item.clinicName}
                        </td>
                        <td className="py-3 px-4 max-w-md">
                          <p className="font-semibold text-slate-900">{item.title}</p>
                          {item.subtitle && (
                            <p className="text-[11px] text-slate-500 mt-0.5 truncate">
                              {item.subtitle}
                            </p>
                          )}
                        </td>
                        <td className="py-3 px-4 font-mono text-[11px] text-slate-500 whitespace-nowrap tabular-nums">
                          {item.deletedAt ? item.deletedAt.replace('T', ' ').slice(0, 19) : '—'}
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          <button
                            type="button"
                            disabled={restoringKey === item.key}
                            onClick={() => handleRestoreBackupItem(item)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium text-teal-800 bg-teal-50 border border-teal-200 rounded-lg hover:bg-teal-100 disabled:opacity-50 transition-colors cursor-pointer"
                          >
                            {restoringKey === item.key ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <RotateCcw className="w-3 h-3" />
                            )}
                            {t('Restore', 'পুনরুদ্ধার করুন')}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
