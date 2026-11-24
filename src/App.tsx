import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  Banknote,
  BookOpen,
  Building2,
  CalendarClock,
  Check,
  Copy,
  CreditCard,
  LayoutDashboard,
  LogOut,
  Menu,
  PauseCircle,
  Plus,
  Search,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react';
import { AdminSignInView } from './components/AdminSignInView';
import { ClinicFormModal } from './components/ClinicFormModal';
import { FeesLedgerView } from './components/FeesLedgerView';
import { PatientAgeChart } from './components/PatientAgeChart';
import { PatientDetailView } from './components/PatientDetailView';
import { PatientFormModal } from './components/PatientFormModal';
import { PlanAndHostingView } from './components/PlanAndHostingView';
import { RepertoryView } from './components/RepertoryView';
import { SecureClinicalImage } from './components/SecureClinicalImage';
import { SuperAdminConsole } from './components/SuperAdminConsole';
import { auth, db, handleFirestoreError, OperationType } from './firebase';
import { LanguageSwitcher, useLanguage } from './i18n/LanguageContext';
import {
  GENDER_LABELS_I18N,
  PLAN_LABELS_I18N,
  STATUS_LABELS_I18N,
} from './i18n/translations';
import {
  formatCashAmount,
  setActiveCurrencySymbol,
  summarizeFees,
} from './lib/feeCalculations';
import { formatBytes } from './lib/imageCompressor';
import {
  fetchSaasPlatformHealth,
  fetchStorageStats,
  type SaasPlatformHealthResponse,
  type StorageStatsResponse,
} from './lib/photoApi';
import {
  ACCENT_THEME_PALETTES,
  buildClinicShareUrl,
  buildDefaultPlatformConfig,
  buildPublicProfilePayload,
  DEFAULT_PLATFORM_CONFIG_ID,
  extractClinicSlugFromLocation,
  setActiveClinicHeaderId,
  SUPER_ADMIN_EMAIL,
  tenantFeesCol,
  tenantPatientsCol,
} from './lib/tenantPaths';
import {
  PLAN_CATALOG,
  type ClinicPublicProfile,
  type ClinicTenant,
  type FeeRecord,
  type Patient,
  type PatientStatus,
  type PlatformHostingConfig,
} from './types/clinic';

type NavSection = 'overview' | 'patients' | 'follow-ups' | 'fees' | 'repertory' | 'plan';

const FALLBACK_PLATFORM_CONFIG: PlatformHostingConfig = {
  id: DEFAULT_PLATFORM_CONFIG_ID,
  platformName: 'Materia Medica SaaS',
  supportEmail: SUPER_ADMIN_EMAIL,
  defaultHostingProvider: 'Cloud Run / Render Free Tier',
  defaultRegion: 'asia-southeast1',
  publicBaseUrl: '',
  freeTierSummary: '',
  maintenanceNotice: '',
  updatedBy: '',
  updatedAt: Timestamp.now(),
};

const STATUS_CLASSES: Record<PatientStatus, string> = {
  active: 'text-emerald-700',
  'follow-up': 'text-amber-700',
  archived: 'text-slate-500',
};

function timestampMillis(ts?: Timestamp | null): number {
  if (!ts) return 0;
  try {
    return ts.toMillis();
  } catch {
    return 0;
  }
}

export default function App() {
  const { language, t } = useLanguage();
  const requestedSlug = useMemo(() => extractClinicSlugFromLocation(), []);

  // Public URL Storefront State (before sign-in)
  const [publicClinic, setPublicClinic] = useState<ClinicPublicProfile | null>(null);
  const [loadingSlug, setLoadingSlug] = useState(Boolean(requestedSlug));
  const [slugNotFound, setSlugNotFound] = useState(false);

  // Auth State
  const [authReady, setAuthReady] = useState(false);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [authProvider, setAuthProvider] = useState<string | null>(null);
  const [authProviderResolved, setAuthProviderResolved] = useState(false);

  const isClientPortalRoute = Boolean(requestedSlug);
  const isSuperAdmin = Boolean(
    authProviderResolved &&
      authProvider === 'google.com' &&
      currentUser?.emailVerified &&
      currentUser.email?.toLowerCase() === SUPER_ADMIN_EMAIL
  );
  const effectiveIsSuperAdmin = !isClientPortalRoute && isSuperAdmin;
  const isPasswordClient = Boolean(
    authProviderResolved &&
      authProvider === 'password' &&
      currentUser?.uid &&
      currentUser.email
  );
  const isRejectedNonPassword = Boolean(
    authProviderResolved && currentUser && !isSuperAdmin && !isPasswordClient
  );

  // Platform & Multi-Tenant Clinics State
  const [platformConfig, setPlatformConfig] = useState<PlatformHostingConfig>(
    FALLBACK_PLATFORM_CONFIG
  );
  const [clinics, setClinics] = useState<ClinicTenant[]>([]);
  const [clinicsLoaded, setClinicsLoaded] = useState(false);
  const [appMode, setAppMode] = useState<'saas' | 'clinic'>(requestedSlug ? 'clinic' : 'saas');
  const [selectedClinicId, setSelectedClinicId] = useState<string | null>(null);
  const initialModeResolvedRef = useRef(false);
  const bootstrappedDefaultClinicRef = useRef(false);
  const prevAuthUidRef = useRef<string | null>(null);

  // Super Admin Hosting Health & Modal State
  const [saasHealth, setSaasHealth] = useState<SaasPlatformHealthResponse | null>(null);
  const [loadingHealth, setLoadingHealth] = useState(false);
  const [showClinicModal, setShowClinicModal] = useState(false);
  const [editingClinic, setEditingClinic] = useState<ClinicTenant | null>(null);
  const [copiedActiveUrl, setCopiedActiveUrl] = useState(false);

  // Active Clinic Clinical State
  const [patients, setPatients] = useState<Patient[]>([]);
  const [loadingPatients, setLoadingPatients] = useState(true);
  const [feeRecords, setFeeRecords] = useState<FeeRecord[]>([]);
  const [loadingFees, setLoadingFees] = useState(true);
  const [storageStats, setStorageStats] = useState<StorageStatsResponse>({
    totalFiles: 0,
    totalBytes: 0,
  });

  const [activeNav, setActiveNav] = useState<NavSection>('overview');
  const [selectedPatientId, setSelectedPatientId] = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | PatientStatus>('all');

  const [showPatientModal, setShowPatientModal] = useState(false);
  const [editingPatient, setEditingPatient] = useState<Patient | null>(null);

  // Load non-PII public clinic profile if ?clinic=<slug> or /c/<slug> is present
  useEffect(() => {
    if (!requestedSlug) {
      setLoadingSlug(false);
      return;
    }

    let cancelled = false;
    setLoadingSlug(true);
    getDoc(doc(db, 'clinic_public', requestedSlug))
      .then((snap) => {
        if (cancelled) return;
        if (snap.exists()) {
          setPublicClinic(snap.data() as ClinicPublicProfile);
          setSlugNotFound(false);
        } else {
          setPublicClinic(null);
          setSlugNotFound(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPublicClinic(null);
          setSlugNotFound(true);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingSlug(false);
      });

    return () => {
      cancelled = true;
    };
  }, [requestedSlug]);

  // Firebase Auth state listener
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      const nextUid = user?.uid ?? null;
      if (nextUid !== prevAuthUidRef.current) {
        prevAuthUidRef.current = nextUid;
        setClinics([]);
        setClinicsLoaded(false);
        setSelectedClinicId(null);
        setPatients([]);
        setFeeRecords([]);
        setSelectedPatientId(null);
        setActiveClinicHeaderId(null);
        setActiveCurrencySymbol('৳');
        initialModeResolvedRef.current = false;
      }
      setCurrentUser(user);
      setAuthReady(true);
    });
    return () => unsub();
  }, []);

  // Resolve Firebase ID token sign-in provider for strict role/auth isolation
  useEffect(() => {
    if (!authReady) return;
    if (!currentUser) {
      setAuthProvider(null);
      setAuthProviderResolved(true);
      return;
    }

    let cancelled = false;
    setAuthProviderResolved(false);
    currentUser
      .getIdTokenResult()
      .then((res) => {
        if (!cancelled) {
          setAuthProvider(res.signInProvider || null);
          setAuthProviderResolved(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAuthProvider(currentUser.providerData[0]?.providerId || null);
          setAuthProviderResolved(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [authReady, currentUser]);

  // Platform hosting configuration subscription
  useEffect(() => {
    if (
      !authReady ||
      !authProviderResolved ||
      (!effectiveIsSuperAdmin && !isPasswordClient) ||
      !currentUser
    ) {
      return;
    }

    const configRef = doc(db, 'platform_config', DEFAULT_PLATFORM_CONFIG_ID);
    const unsub = onSnapshot(
      configRef,
      (snap) => {
        if (snap.exists()) {
          setPlatformConfig({
            id: snap.id,
            ...(snap.data() as Omit<PlatformHostingConfig, 'id'>),
          });
        } else if (effectiveIsSuperAdmin) {
          void setDoc(configRef, buildDefaultPlatformConfig(currentUser.uid)).catch((err) => {
            handleFirestoreError(err, OperationType.WRITE, 'platform_config/hosting');
          });
        }
      },
      (err) => {
        handleFirestoreError(err, OperationType.GET, 'platform_config/hosting');
      }
    );

    return () => unsub();
  }, [authReady, authProviderResolved, currentUser, effectiveIsSuperAdmin, isPasswordClient]);

  // Clinics collection subscription (All clinics for Super Admin on root; UID-bound clinics for password clients)
  useEffect(() => {
    if (
      !authReady ||
      !authProviderResolved ||
      (!effectiveIsSuperAdmin && !isPasswordClient) ||
      !currentUser
    ) {
      return;
    }

    setClinicsLoaded(false);

    const clinicsQuery = effectiveIsSuperAdmin
      ? collection(db, 'clinics')
      : query(collection(db, 'clinics'), where('authorizedUids', 'array-contains', currentUser.uid));

    const unsub = onSnapshot(
      clinicsQuery,
      (snapshot) => {
        if (effectiveIsSuperAdmin && snapshot.empty && !bootstrappedDefaultClinicRef.current) {
          bootstrappedDefaultClinicRef.current = true;
          const defaultId = 'cln_materia_medica';
          const defaultSlug = 'materia-medica';
          const defaultTenant = {
            slug: defaultSlug,
            clinicName: 'Materia Medica Clinic',
            practitionerName: currentUser.displayName || 'Dr. Rony',
            ownerEmail: SUPER_ADMIN_EMAIL,
            accessEmails: [SUPER_ADMIN_EMAIL],
            authorizedUids: [currentUser.uid],
            tagline: 'Classical Constitutional Homeopathy & Case Management',
            currencySymbol: '৳' as const,
            accentColor: 'teal' as const,
            planTier: 'free' as const,
            subscriptionStatus: 'active' as const,
            patientLimit: PLAN_CATALOG.free.patientLimit,
            storageLimitMb: PLAN_CATALOG.free.storageLimitMb,
            hostingProvider: 'Cloud Run / Render Free Tier',
            monthlyFeeAmount: 0,
            billingCycle: 'free' as const,
            createdBy: currentUser.uid,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          };
          const batch = writeBatch(db);
          batch.set(doc(db, 'clinics', defaultId), defaultTenant);
          batch.set(
            doc(db, 'clinic_public', defaultSlug),
            buildPublicProfilePayload(defaultId, defaultTenant)
          );
          void batch.commit().catch((err) => {
            handleFirestoreError(err, OperationType.WRITE, `clinics/${defaultId}`);
          });
          return;
        }

        const list = snapshot.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<ClinicTenant, 'id'>) }))
          .sort((a, b) => timestampMillis(b.updatedAt) - timestampMillis(a.updatedAt));

        setClinics(list);
        setClinicsLoaded(true);

        if (!initialModeResolvedRef.current) {
          initialModeResolvedRef.current = true;
          if (requestedSlug) {
            const matched = list.find((c) => c.slug === requestedSlug);
            if (matched) {
              setSelectedClinicId(matched.id);
              setAppMode('clinic');
            }
          } else if (effectiveIsSuperAdmin) {
            setSelectedClinicId(list[0]?.id || null);
            setAppMode('saas');
          } else if (list.length > 0) {
            setSelectedClinicId(list[0].id);
            setAppMode('clinic');
          }
        }
      },
      (err) => {
        setClinicsLoaded(true);
        handleFirestoreError(err, OperationType.LIST, 'clinics');
      }
    );

    return () => unsub();
  }, [
    authReady,
    authProviderResolved,
    currentUser,
    effectiveIsSuperAdmin,
    isPasswordClient,
    requestedSlug,
  ]);

  // Derive activeClinic & strict client UID + email verification
  const { activeClinic, accessDeniedReason } = useMemo(() => {
    if (!currentUser || !authProviderResolved) {
      return { activeClinic: null as ClinicTenant | null, accessDeniedReason: null as string | null };
    }

    if (isRejectedNonPassword) {
      return {
        activeClinic: null,
        accessDeniedReason: t(
          'Google sign-in is disabled for client clinics. Please sign out and log in with the Email & Password assigned by your Super Admin.',
          'ক্লায়েন্ট ক্লিনিকের জন্য Google সাইন-ইন বন্ধ। অনুগ্রহ করে সাইন আউট করে সুপার অ্যাডমিনের দেওয়া ইমেইল ও পাসওয়ার্ড দিয়ে লগইন করুন।'
        ),
      };
    }

    if (!clinicsLoaded) {
      return { activeClinic: null as ClinicTenant | null, accessDeniedReason: null as string | null };
    }

    if (!effectiveIsSuperAdmin) {
      const emailLower = (currentUser.email || '').trim().toLowerCase();
      const verifiedClinics = clinics.filter(
        (c) =>
          c.authorizedUids?.includes(currentUser.uid) &&
          c.accessEmails?.some((e) => e.toLowerCase() === emailLower)
      );

      if (requestedSlug) {
        const matched = verifiedClinics.find((c) => c.slug === requestedSlug);
        if (!matched) {
          return {
            activeClinic: null,
            accessDeniedReason: t(
              `Your assigned credentials do not grant access to clinic "${requestedSlug}".`,
              `আপনার নির্ধারিত লগইন তথ্যে "${requestedSlug}" ক্লিনিকে প্রবেশের অনুমতি নেই।`
            ),
          };
        }
        return { activeClinic: matched, accessDeniedReason: null };
      }

      if (verifiedClinics.length === 0) {
        return {
          activeClinic: null,
          accessDeniedReason: t(
            'No active clinic workspace is assigned to your login credentials. Ask the Super Admin to provision your clinic access.',
            'আপনার লগইন অ্যাকাউন্টে এখনো কোনো ক্লিনিক নির্ধারিত হয়নি। অনুগ্রহ করে সুপার অ্যাডমিনের সাথে যোগাযোগ করুন।'
          ),
        };
      }

      const chosen = verifiedClinics.find((c) => c.id === selectedClinicId) || verifiedClinics[0];
      return { activeClinic: chosen, accessDeniedReason: null };
    }

    const chosen = clinics.find((c) => c.id === selectedClinicId) || clinics[0] || null;
    return { activeClinic: chosen, accessDeniedReason: null };
  }, [
    authProviderResolved,
    clinics,
    clinicsLoaded,
    currentUser,
    effectiveIsSuperAdmin,
    isRejectedNonPassword,
    requestedSlug,
    selectedClinicId,
    t,
  ]);

  // Keep global active clinic ID & currency synchronized for API clients and formatters
  useEffect(() => {
    setActiveClinicHeaderId(activeClinic?.id || null);
    setActiveCurrencySymbol(activeClinic?.currencySymbol || '৳');
    setSelectedPatientId(null);
  }, [activeClinic?.id, activeClinic?.currencySymbol]);

  const refreshStorageStats = useCallback(async () => {
    if (!auth.currentUser || !activeClinic?.id) return;
    try {
      const stats = await fetchStorageStats(activeClinic.id);
      setStorageStats(stats);
    } catch {
      // Retain last known metrics on transient failures
    }
  }, [activeClinic?.id]);

  const refreshSaasHealth = useCallback(async () => {
    if (!auth.currentUser || !effectiveIsSuperAdmin) return;
    setLoadingHealth(true);
    try {
      const health = await fetchSaasPlatformHealth();
      setSaasHealth(health);
    } catch {
      // Ignore transient errors
    } finally {
      setLoadingHealth(false);
    }
  }, [effectiveIsSuperAdmin]);

  useEffect(() => {
    if (effectiveIsSuperAdmin && authReady && appMode === 'saas') {
      void refreshSaasHealth();
    }
  }, [effectiveIsSuperAdmin, authReady, appMode, refreshSaasHealth]);

  // Tenant clinical data subscriptions (patients & fees)
  useEffect(() => {
    if (
      !authReady ||
      !authProviderResolved ||
      (!effectiveIsSuperAdmin && !isPasswordClient) ||
      !currentUser ||
      !activeClinic ||
      (!effectiveIsSuperAdmin && activeClinic.subscriptionStatus === 'suspended')
    ) {
      setPatients([]);
      setFeeRecords([]);
      return;
    }

    const userUid = currentUser.uid;
    const patientsQuery = effectiveIsSuperAdmin
      ? tenantPatientsCol(activeClinic.id)
      : query(
          tenantPatientsCol(activeClinic.id),
          where('clinicAccessUids', 'array-contains', userUid)
        );

    const feesQuery = effectiveIsSuperAdmin
      ? tenantFeesCol(activeClinic.id)
      : query(
          tenantFeesCol(activeClinic.id),
          where('clinicAccessUids', 'array-contains', userUid)
        );

    setLoadingPatients(true);
    const unsubPatients = onSnapshot(
      patientsQuery,
      (snapshot) => {
        const list = snapshot.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<Patient, 'id'>) }))
          .sort((a, b) => timestampMillis(b.updatedAt) - timestampMillis(a.updatedAt));
        setPatients(list);
        setLoadingPatients(false);
      },
      (error) => {
        setLoadingPatients(false);
        handleFirestoreError(error, OperationType.LIST, `clinics/${activeClinic.id}/patients`);
      }
    );

    setLoadingFees(true);
    const unsubFees = onSnapshot(
      feesQuery,
      (snapshot) => {
        const list = snapshot.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<FeeRecord, 'id'>) }))
          .sort((a, b) => (b.collectedDate || '').localeCompare(a.collectedDate || ''));
        setFeeRecords(list);
        setLoadingFees(false);
      },
      (error) => {
        setLoadingFees(false);
        handleFirestoreError(error, OperationType.LIST, `clinics/${activeClinic.id}/fee_records`);
      }
    );

    void refreshStorageStats();

    return () => {
      unsubPatients();
      unsubFees();
    };
  }, [
    activeClinic,
    authProviderResolved,
    authReady,
    currentUser,
    effectiveIsSuperAdmin,
    isPasswordClient,
    refreshStorageStats,
  ]);

  const selectedPatient = useMemo(
    () => patients.find((p) => p.id === selectedPatientId) || null,
    [patients, selectedPatientId]
  );

  const selectedPatientFees = useMemo(
    () => (selectedPatientId ? feeRecords.filter((f) => f.patientId === selectedPatientId) : []),
    [feeRecords, selectedPatientId]
  );

  const filteredPatients = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return patients.filter((p) => {
      if (statusFilter !== 'all' && p.status !== statusFilter) return false;
      if (!q) return true;
      return (
        p.fullName.toLowerCase().includes(q) ||
        p.caseNumber.toLowerCase().includes(q) ||
        p.phone.toLowerCase().includes(q) ||
        p.chiefComplaint.toLowerCase().includes(q) ||
        (p.lastRemedy || '').toLowerCase().includes(q)
      );
    });
  }, [patients, searchQuery, statusFilter]);

  const followUpPatients = useMemo(() => {
    return patients
      .filter((p) => p.status !== 'archived' && Boolean(p.nextFollowUpDate))
      .sort((a, b) => (a.nextFollowUpDate || '').localeCompare(b.nextFollowUpDate || ''));
  }, [patients]);

  const nextSuggestedCaseNumber = useMemo(() => {
    const nextNum = 1001 + patients.length;
    return `HM-${nextNum}`;
  }, [patients.length]);

  const todayIso = new Date().toISOString().slice(0, 10);
  const feeSummary = useMemo(() => summarizeFees(feeRecords, todayIso), [feeRecords, todayIso]);
  const dueOrOverdueCount = useMemo(
    () =>
      followUpPatients.filter((p) => (p.nextFollowUpDate || '') <= todayIso).length +
      patients.filter((p) => p.status === 'follow-up' && !p.nextFollowUpDate).length,
    [followUpPatients, patients, todayIso]
  );

  // Loading & Sign-In Gate
  if (!authReady || loadingSlug || (currentUser && !authProviderResolved)) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center gap-3 p-6">
        <img src="/clinic-icon.svg" alt="" width={44} height={44} className="w-11 h-11 rounded-xl" />
        <p className="text-sm text-slate-600">
          {t('Loading clinical workspace...', 'ক্লিনিক্যাল ওয়ার্কস্পেস চালু হচ্ছে...')}
        </p>
      </div>
    );
  }

  if (!currentUser || isRejectedNonPassword || (isClientPortalRoute && !isPasswordClient)) {
    return (
      <AdminSignInView
        unauthorizedUser={isRejectedNonPassword ? currentUser : null}
        superAdminSessionEmail={isClientPortalRoute && isSuperAdmin ? currentUser?.email || null : null}
        publicClinic={publicClinic}
        loadingSlug={loadingSlug}
        slugNotFound={slugNotFound}
        requestedSlug={requestedSlug}
        isRootPortal={!publicClinic && !requestedSlug}
        accessDeniedReason={accessDeniedReason}
      />
    );
  }

  if (!clinicsLoaded) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center gap-3 p-6">
        <img src="/clinic-icon.svg" alt="" width={44} height={44} className="w-11 h-11 rounded-xl" />
        <p className="text-sm text-slate-600">
          {t('Loading clinic directory and permissions...', 'ক্লিনিক তালিকা ও অনুমতি লোড হচ্ছে...')}
        </p>
      </div>
    );
  }

  if (!effectiveIsSuperAdmin && (!activeClinic || accessDeniedReason)) {
    return (
      <AdminSignInView
        unauthorizedUser={currentUser}
        publicClinic={publicClinic}
        slugNotFound={slugNotFound}
        requestedSlug={requestedSlug}
        isRootPortal={!publicClinic && !requestedSlug}
        accessDeniedReason={accessDeniedReason}
      />
    );
  }

  // Client access paused screen if clinic subscription is suspended
  if (!effectiveIsSuperAdmin && activeClinic && activeClinic.subscriptionStatus === 'suspended') {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="max-w-lg w-full bg-white border border-slate-200 rounded-xl p-8 space-y-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5 text-amber-800">
              <PauseCircle className="w-5 h-5 shrink-0" />
              <h1 className="font-display text-lg font-semibold text-slate-900">
                {activeClinic.clinicName}
              </h1>
            </div>
            <LanguageSwitcher />
          </div>
          <p className="text-sm text-slate-600 leading-relaxed">
            {t(
              'This clinic subscription is currently paused. Patient records are safely preserved, and access will resume immediately once reactivated by the platform administrator.',
              'এই ক্লিনিকের সাবস্ক্রিপশন সাময়িকভাবে স্থগিত করা হয়েছে। আপনার রোগীর সব তথ্য নিরাপদ আছে এবং প্ল্যাটফর্ম অ্যাডমিন সক্রিয় করলেই আবার ব্যবহার করতে পারবেন।'
            )}
          </p>
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 text-xs text-slate-700 space-y-1">
            <p>
              <span className="font-medium">{t('Practitioner:', 'চিকিৎসক:')}</span>{' '}
              {activeClinic.practitionerName}
            </p>
            <p>
              <span className="font-medium">{t('Support Contact:', 'সাপোর্ট যোগাযোগ:')}</span>{' '}
              <span className="font-mono">{platformConfig.supportEmail}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={() => signOut(auth)}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            {t('Sign out', 'সাইন আউট')}
          </button>
        </div>
      </div>
    );
  }

  const showingSaasConsole = effectiveIsSuperAdmin && appMode === 'saas';
  const palette = activeClinic
    ? ACCENT_THEME_PALETTES[activeClinic.accentColor] || ACCENT_THEME_PALETTES.teal
    : ACCENT_THEME_PALETTES.teal;

  const patientCapacityPercent = activeClinic
    ? Math.min(100, Math.round((patients.length / Math.max(1, activeClinic.patientLimit)) * 100))
    : 0;
  const approachingCapacity = activeClinic
    ? patients.length >= Math.floor(activeClinic.patientLimit * 0.8)
    : false;

  const statusLabels = STATUS_LABELS_I18N[language];
  const genderLabels = GENDER_LABELS_I18N[language];
  const currentPlanLabel = activeClinic
    ? PLAN_LABELS_I18N[language][activeClinic.planTier].name
    : '';

  const openNewPatientModal = () => {
    setEditingPatient(null);
    setShowPatientModal(true);
  };

  const navigateTo = (section: NavSection) => {
    setSelectedPatientId(null);
    setActiveNav(section);
    setAppMode('clinic');
    setMobileMenuOpen(false);
  };

  const handleCopyActiveClinicUrl = async () => {
    if (!activeClinic) return;
    const url = buildClinicShareUrl(activeClinic.slug, platformConfig.publicBaseUrl);
    try {
      await navigator.clipboard.writeText(url);
      setCopiedActiveUrl(true);
      window.setTimeout(() => setCopiedActiveUrl(false), 2000);
    } catch {
      // Ignore clipboard permission errors
    }
  };

  const breadcrumbLabel = showingSaasConsole
    ? t('Super Admin Control Plane', 'সুপার অ্যাডমিন কন্ট্রোল প্যানেল')
    : selectedPatient
      ? `${t('Patients', 'রোগী')} / ${selectedPatient.fullName}`
      : activeNav === 'overview'
        ? t('Overview', 'সারসংক্ষেপ')
        : activeNav === 'patients'
          ? t('Patient Registry', 'রোগী তালিকা')
          : activeNav === 'follow-ups'
            ? t('Follow-up Schedule', 'ফলো-আপ সূচি')
            : activeNav === 'fees'
              ? t('Cash Fees & Ledger', 'নগদ ফি ও হিসাব')
              : activeNav === 'repertory'
                ? t('Clinical Repertory', 'ক্লিনিক্যাল রেপার্টরি')
                : t('Subscription & Clinic URL', 'সাবস্ক্রিপশন ও ক্লিনিক URL');

  const navItems: { id: NavSection; label: string; icon: typeof LayoutDashboard }[] = [
    { id: 'overview', label: t('Overview', 'সারসংক্ষেপ'), icon: LayoutDashboard },
    { id: 'patients', label: t('Patients', 'রোগী'), icon: Users },
    { id: 'follow-ups', label: t('Follow-ups', 'ফলো-আপ'), icon: CalendarClock },
    { id: 'fees', label: t('Cash Fees', 'নগদ ফি'), icon: Banknote },
    { id: 'repertory', label: t('Repertory', 'রেপার্টরি'), icon: BookOpen },
    { id: 'plan', label: t('Subscription & URL', 'প্ল্যান ও URL'), icon: CreditCard },
  ];

  return (
    <div className="min-h-screen bg-slate-50 flex text-slate-900">
      {/* Mobile Sidebar Backdrop */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 z-40 bg-slate-900/40 lg:hidden"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 bg-white border-r border-slate-200 flex flex-col justify-between transition-transform duration-150 lg:static lg:translate-x-0 print:hidden ${
          mobileMenuOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="overflow-y-auto">
          <div className="h-16 px-5 border-b border-slate-200 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => {
                if (effectiveIsSuperAdmin && showingSaasConsole) {
                  setMobileMenuOpen(false);
                } else {
                  navigateTo('overview');
                }
              }}
              className="flex items-center gap-2.5 min-w-0 font-display text-sm font-bold tracking-tight text-slate-900 cursor-pointer text-left"
            >
              <img src="/clinic-icon.svg" alt="" width={24} height={24} className="w-6 h-6 rounded-md shrink-0" />
              <span className="truncate">
                {showingSaasConsole
                  ? platformConfig.platformName
                  : activeClinic?.clinicName || platformConfig.platformName}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setMobileMenuOpen(false)}
              aria-label="Close navigation"
              className="p-1.5 text-slate-500 hover:text-slate-900 lg:hidden cursor-pointer shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="p-4 space-y-4">
            {/* Super Admin Mode Switcher — Never rendered on client clinic URLs */}
            {effectiveIsSuperAdmin && (
              <div className="space-y-1.5 pb-3 border-b border-slate-200">
                <button
                  type="button"
                  onClick={() => {
                    setAppMode('saas');
                    setSelectedPatientId(null);
                    setMobileMenuOpen(false);
                  }}
                  className={`w-full flex items-center justify-between px-3 py-2 text-xs font-medium rounded-lg transition-colors cursor-pointer whitespace-nowrap ${
                    showingSaasConsole
                      ? 'bg-teal-50 text-teal-900'
                      : 'text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <ShieldCheck
                      className={`w-4 h-4 ${
                        showingSaasConsole ? 'text-teal-700' : 'text-slate-400'
                      }`}
                    />
                    <span>{t('Super Admin Console', 'সুপার অ্যাডমিন কনসোল')}</span>
                  </span>
                  <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                    {clinics.length}
                  </span>
                </button>

                {clinics.length > 0 && (
                  <div className="pt-1">
                    <label className="block text-[11px] font-medium text-slate-500 px-1 mb-1">
                      {t('Active Clinic Workspace', 'সক্রিয় ক্লিনিক ওয়ার্কস্পেস')}
                    </label>
                    <select
                      value={activeClinic?.id || ''}
                      onChange={(e) => {
                        setSelectedClinicId(e.target.value);
                        setSelectedPatientId(null);
                        setAppMode('clinic');
                        setMobileMenuOpen(false);
                      }}
                      className="w-full px-2.5 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:border-teal-700"
                    >
                      {clinics.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.clinicName}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            )}

            {/* Multi-Clinic Selector for Client Users assigned to >1 clinic */}
            {!effectiveIsSuperAdmin && clinics.length > 1 && (
              <div className="pb-3 border-b border-slate-200">
                <label className="block text-[11px] font-medium text-slate-500 px-1 mb-1">
                  {t('Switch Assigned Clinic', 'ক্লিনিক পরিবর্তন')}
                </label>
                <select
                  value={activeClinic?.id || ''}
                  onChange={(e) => {
                    setSelectedClinicId(e.target.value);
                    setSelectedPatientId(null);
                    setMobileMenuOpen(false);
                  }}
                  className="w-full px-2.5 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-800"
                >
                  {clinics.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.clinicName}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Clinic Workspace Navigation */}
            {activeClinic && !showingSaasConsole && (
              <nav className="space-y-1">
                {navItems.map((item) => {
                  const Icon = item.icon;
                  const isActive = !selectedPatient && activeNav === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => navigateTo(item.id)}
                      className={`w-full flex items-center justify-between px-3 py-2.5 text-sm font-medium rounded-lg transition-colors cursor-pointer whitespace-nowrap ${
                        isActive
                          ? palette.navActive
                          : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                      }`}
                    >
                      <span className="flex items-center gap-2.5">
                        <Icon
                          className={`w-4 h-4 ${
                            isActive ? palette.navIconActive : 'text-slate-400'
                          }`}
                        />
                        <span>{item.label}</span>
                      </span>
                      {item.id === 'patients' && (
                        <span className="text-xs font-mono text-slate-500 tabular-nums">
                          {patients.length}
                        </span>
                      )}
                      {item.id === 'follow-ups' && dueOrOverdueCount > 0 && (
                        <span className="text-xs font-mono text-amber-700 tabular-nums">
                          {dueOrOverdueCount}
                        </span>
                      )}
                      {item.id === 'fees' && feeSummary.totalDue > 0 && (
                        <span className="text-[11px] font-mono text-amber-700 tabular-nums">
                          {formatCashAmount(feeSummary.totalDue)}
                        </span>
                      )}
                    </button>
                  );
                })}
              </nav>
            )}

            {showingSaasConsole && activeClinic && (
              <button
                type="button"
                onClick={() => {
                  setAppMode('clinic');
                  setMobileMenuOpen(false);
                }}
                className="w-full flex items-center gap-2 px-3 py-2.5 text-xs font-medium text-slate-700 bg-slate-50 border border-slate-200 rounded-lg hover:bg-slate-100 cursor-pointer whitespace-nowrap"
              >
                <Building2 className="w-4 h-4 text-slate-500 shrink-0" />
                <span className="truncate">
                  {t('Open', 'খুলুন')}: {activeClinic.clinicName}
                </span>
              </button>
            )}
          </div>
        </div>

        <div className="p-4 space-y-4 border-t border-slate-200">
          {activeClinic && !showingSaasConsole && (
            <button
              type="button"
              onClick={() => navigateTo('plan')}
              className="w-full text-left p-3 rounded-lg border border-slate-200 bg-slate-50/70 hover:bg-slate-100/80 transition-colors cursor-pointer"
            >
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span className="font-medium text-slate-700">{currentPlanLabel}</span>
                <span className="font-mono text-slate-600 tabular-nums">
                  {patients.length}/{activeClinic.patientLimit}
                </span>
              </div>
              <div className="w-full h-1.5 bg-slate-200 rounded-full overflow-hidden">
                <div
                  className={`h-full ${
                    patientCapacityPercent >= 85 ? 'bg-amber-600' : palette.barFill
                  }`}
                  style={{ width: `${patientCapacityPercent}%` }}
                />
              </div>
              <p className="text-[11px] text-slate-500 mt-1.5 tabular-nums">
                {formatBytes(storageStats.totalBytes)} / {activeClinic.storageLimitMb} MB{' '}
                {t('photos', 'ছবি')}
              </p>
            </button>
          )}

          {/* Account Row */}
          <div className="flex items-center justify-between gap-2 pt-1">
            <div className="flex items-center gap-2.5 min-w-0">
              <img
                src="/src/assets/images/avatar_practitioner_1795222750583.jpg"
                alt="Practitioner avatar"
                referrerPolicy="no-referrer"
                className="w-8 h-8 rounded-lg object-cover border border-slate-200 shrink-0"
              />
              <div className="min-w-0">
                <p className="text-xs font-medium text-slate-900 truncate">
                  {showingSaasConsole
                    ? t('Super Admin', 'সুপার অ্যাডমিন')
                    : activeClinic?.practitionerName || currentUser.displayName || 'Practitioner'}
                </p>
                <p className="text-[11px] text-slate-500 truncate">{currentUser.email}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => signOut(auth)}
              title="Sign out"
              aria-label="Sign out"
              className="p-2 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer shrink-0"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top Bar Contract */}
        <header className="h-16 bg-white border-b border-slate-200 px-6 flex items-center justify-between gap-6 shrink-0 print:hidden">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open navigation"
              className="p-2 -ml-2 text-slate-600 hover:text-slate-900 lg:hidden cursor-pointer"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-sm min-w-0">
              <span className="text-slate-500 hidden sm:inline truncate">
                {showingSaasConsole
                  ? platformConfig.platformName
                  : activeClinic?.clinicName || platformConfig.platformName}
              </span>
              <span className="text-slate-300 hidden sm:inline" aria-hidden="true">
                /
              </span>
              <span className="font-medium text-slate-900 truncate">{breadcrumbLabel}</span>
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            {!showingSaasConsole && activeClinic && (
              <button
                type="button"
                onClick={handleCopyActiveClinicUrl}
                className="hidden md:inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer whitespace-nowrap"
              >
                {copiedActiveUrl ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-700" />
                    {t('URL Copied', 'URL কপি হয়েছে')}
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    {t('Copy Clinic URL', 'ক্লিনিক URL কপি')}
                  </>
                )}
              </button>
            )}

            <LanguageSwitcher />

            {showingSaasConsole ? (
              <button
                type="button"
                onClick={() => {
                  setEditingClinic(null);
                  setShowClinicModal(true);
                }}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-lg hover:bg-teal-800 transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                {t('New Client', 'নতুন ক্লায়েন্ট')}
              </button>
            ) : activeClinic ? (
              <button
                type="button"
                onClick={openNewPatientModal}
                className={`inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg transition-colors cursor-pointer whitespace-nowrap shrink-0 ${palette.primaryBtn}`}
              >
                <Plus className="w-3.5 h-3.5" />
                {t('New Patient', 'নতুন রোগী')}
              </button>
            ) : null}
          </div>
        </header>

        {/* Optional Platform Maintenance Notice Banner */}
        {platformConfig.maintenanceNotice && (
          <div className="bg-amber-50 border-b border-amber-200 px-6 py-2.5 text-xs text-amber-900 print:hidden">
            {platformConfig.maintenanceNotice}
          </div>
        )}

        {/* Main Viewport */}
        <main className="flex-1 p-6 lg:p-8 max-w-[1280px] w-full mx-auto print:p-0 print:max-w-none">
          {showingSaasConsole ? (
            <SuperAdminConsole
              clinics={clinics}
              platformConfig={platformConfig}
              saasHealth={saasHealth}
              loadingHealth={loadingHealth}
              onRefreshHealth={refreshSaasHealth}
              onOpenClinicWorkspace={(clinicId) => {
                setSelectedClinicId(clinicId);
                setSelectedPatientId(null);
                setActiveNav('overview');
                setAppMode('clinic');
              }}
              onCreateClinic={() => {
                setEditingClinic(null);
                setShowClinicModal(true);
              }}
              onEditClinic={(clinic) => {
                setEditingClinic(clinic);
                setShowClinicModal(true);
              }}
            />
          ) : !activeClinic ? (
            <div className="bg-white border border-slate-200 rounded-xl p-12 text-center">
              <Building2 className="w-7 h-7 text-slate-400 mx-auto mb-3" />
              <h2 className="font-display text-base font-semibold text-slate-900">
                {t('No clinic workspace selected', 'কোনো ক্লিনিক ওয়ার্কস্পেস নির্বাচিত নেই')}
              </h2>
            </div>
          ) : selectedPatient ? (
            <PatientDetailView
              clinic={activeClinic}
              isSuperAdmin={effectiveIsSuperAdmin}
              patient={selectedPatient}
              feeRecords={selectedPatientFees}
              onBack={() => setSelectedPatientId(null)}
              onEditPatient={(pat) => {
                setEditingPatient(pat);
                setShowPatientModal(true);
              }}
              onDeletedPatient={() => {
                setSelectedPatientId(null);
              }}
              onPhotoStorageChanged={refreshStorageStats}
            />
          ) : activeNav === 'fees' ? (
            <FeesLedgerView
              clinic={activeClinic}
              patients={patients}
              feeRecords={feeRecords}
              loading={loadingFees}
              onSelectPatient={(patientId) => setSelectedPatientId(patientId)}
            />
          ) : activeNav === 'repertory' ? (
            <RepertoryView clinic={activeClinic} isSuperAdmin={effectiveIsSuperAdmin} />
          ) : activeNav === 'plan' ? (
            <PlanAndHostingView
              clinic={activeClinic}
              isSuperAdmin={effectiveIsSuperAdmin}
              patientCount={patients.length}
              storageStats={storageStats}
              publicBaseUrl={platformConfig.publicBaseUrl}
              onOpenSuperAdminConsole={
                effectiveIsSuperAdmin ? () => setAppMode('saas') : undefined
              }
            />
          ) : activeNav === 'patients' ? (
            <div className="space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
                    {t('Patient Registry', 'রোগী তালিকা')}
                  </h1>
                  <p className="text-sm text-slate-500 mt-0.5 tabular-nums">
                    {patients.length} {t('total cases', 'টি মোট কেস')} · {activeClinic.clinicName}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <div className="relative">
                    <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="search"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder={t(
                        'Search name, case #, remedy...',
                        'নাম, কেস নম্বর বা রেমেডি খুঁজুন...'
                      )}
                      className="pl-9 pr-3 py-2 text-xs w-64 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                    />
                  </div>

                  <div className="inline-flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
                    {(['all', 'active', 'follow-up', 'archived'] as const).map((tab) => (
                      <button
                        key={tab}
                        type="button"
                        onClick={() => setStatusFilter(tab)}
                        className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                          statusFilter === tab
                            ? 'bg-white text-slate-900 shadow-xs'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {tab === 'all'
                          ? t('All', 'সব')
                          : tab === 'active'
                            ? statusLabels.active
                            : tab === 'follow-up'
                              ? t('Follow-up', 'ফলো-আপ')
                              : statusLabels.archived}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {loadingPatients ? (
                <div className="bg-white border border-slate-200 rounded-xl p-8 space-y-3">
                  <div className="h-5 bg-slate-100 rounded w-1/3" />
                  <div className="h-10 bg-slate-100 rounded" />
                  <div className="h-10 bg-slate-100 rounded" />
                </div>
              ) : filteredPatients.length === 0 ? (
                <div className="bg-white border border-slate-200 rounded-xl p-12 text-center">
                  <Users className="w-7 h-7 text-slate-400 mx-auto mb-3" />
                  <h2 className="font-display text-base font-semibold text-slate-900">
                    {patients.length === 0
                      ? t('No patients registered yet', 'এখনো কোনো রোগী নিবন্ধিত হয়নি')
                      : t('No matching patients found', 'কোনো মিল থাকা রোগী পাওয়া যায়নি')}
                  </h2>
                  <p className="text-xs text-slate-500 mt-1 mb-5 max-w-sm mx-auto">
                    {patients.length === 0
                      ? t(
                          'Create your first homeopathic patient case file with constitutional notes and clinical portrait.',
                          'ধাতুগত নোট এবং ক্লিনিক্যাল ছবিসহ আপনার প্রথম রোগীর কেস ফাইল তৈরি করুন।'
                        )
                      : t(
                          'Try clearing the search query or switching status filter tabs.',
                          'অনুসন্ধান লেখা মুছে দেখুন অথবা স্ট্যাটাস ফিল্টার পরিবর্তন করুন।'
                        )}
                  </p>
                  {patients.length === 0 && (
                    <button
                      type="button"
                      onClick={openNewPatientModal}
                      className={`inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg transition-colors cursor-pointer ${palette.primaryBtn}`}
                    >
                      <Plus className="w-3.5 h-3.5" />
                      {t('Register First Patient', 'প্রথম রোগী নিবন্ধন করুন')}
                    </button>
                  )}
                </div>
              ) : (
                <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold text-slate-500">
                          <th className="py-3 px-4 whitespace-nowrap">{t('Case #', 'কেস নং')}</th>
                          <th className="py-3 px-4 whitespace-nowrap">{t('Patient', 'রোগী')}</th>
                          <th className="py-3 px-4 whitespace-nowrap">{t('Age / Sex', 'বয়স / লিঙ্গ')}</th>
                          <th className="py-3 px-4 whitespace-nowrap">{t('Chief Complaint', 'মূল সমস্যা')}</th>
                          <th className="py-3 px-4 whitespace-nowrap">{t('Last Remedy', 'সর্বশেষ রেমেডি')}</th>
                          <th className="py-3 px-4 whitespace-nowrap">{t('Follow-up', 'ফলো-আপ')}</th>
                          <th className="py-3 px-4 whitespace-nowrap text-right">{t('Status', 'অবস্থা')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 text-xs">
                        {filteredPatients.map((patient) => {
                          const statusTextClass = STATUS_CLASSES[patient.status];
                          const statusLabel = statusLabels[patient.status];
                          const initials = patient.fullName
                            .split(' ')
                            .map((s) => s[0])
                            .join('')
                            .slice(0, 2)
                            .toUpperCase();

                          return (
                            <tr
                              key={patient.id}
                              onClick={() => setSelectedPatientId(patient.id)}
                              className="hover:bg-slate-50 transition-colors cursor-pointer"
                            >
                              <td className="py-3 px-4 font-mono text-slate-700 tabular-nums whitespace-nowrap">
                                {patient.caseNumber}
                              </td>
                              <td className="py-3 px-4 whitespace-nowrap">
                                <div className="flex items-center gap-2.5">
                                  <div className="w-7 h-7 rounded-md overflow-hidden border border-slate-200 bg-slate-100 shrink-0">
                                    <SecureClinicalImage
                                      src={patient.portraitUrl}
                                      alt={patient.fullName}
                                      fallbackLabel={initials}
                                    />
                                  </div>
                                  <div>
                                    <p className="font-medium text-slate-900">{patient.fullName}</p>
                                    <p className="text-[11px] text-slate-500 tabular-nums">
                                      {patient.phone}
                                    </p>
                                  </div>
                                </div>
                              </td>
                              <td className="py-3 px-4 text-slate-600 tabular-nums whitespace-nowrap">
                                {patient.age} · {genderLabels[patient.gender]}
                              </td>
                              <td className="py-3 px-4 text-slate-700 max-w-xs truncate">
                                {patient.chiefComplaint}
                              </td>
                              <td className="py-3 px-4 text-slate-700 whitespace-nowrap">
                                {patient.lastRemedy || '—'}
                              </td>
                              <td className="py-3 px-4 font-mono text-slate-600 tabular-nums whitespace-nowrap">
                                {patient.nextFollowUpDate || '—'}
                              </td>
                              <td className="py-3 px-4 text-right whitespace-nowrap">
                                <span className={`font-medium ${statusTextClass}`}>
                                  {statusLabel}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          ) : activeNav === 'follow-ups' ? (
            <div className="space-y-6">
              <div>
                <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
                  {t('Follow-up Schedule', 'ফলো-আপ সূচি')}
                </h1>
                <p className="text-sm text-slate-500 mt-0.5 tabular-nums">
                  {followUpPatients.length} {t('scheduled follow-ups', 'টি নির্ধারিত ফলো-আপ')} ·{' '}
                  {t('Sorted chronologically', 'তারিখ অনুযায়ী সাজানো')}
                </p>
              </div>

              {followUpPatients.length === 0 ? (
                <div className="bg-white border border-slate-200 rounded-xl p-12 text-center">
                  <CalendarClock className="w-7 h-7 text-slate-400 mx-auto mb-3" />
                  <h2 className="font-display text-base font-semibold text-slate-900">
                    {t('No follow-up dates scheduled', 'কোনো ফলো-আপ তারিখ নির্ধারিত নেই')}
                  </h2>
                  <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
                    {t(
                      'Set a next follow-up date when registering a patient or logging a consultation.',
                      'রোগী নিবন্ধন বা পরামর্শ নথিভুক্ত করার সময় পরবর্তী ফলো-আপ তারিখ যোগ করুন।'
                    )}
                  </p>
                </div>
              ) : (
                <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-200">
                  {followUpPatients.map((patient) => {
                    const isOverdue = (patient.nextFollowUpDate || '') < todayIso;
                    const isToday = patient.nextFollowUpDate === todayIso;
                    return (
                      <div
                        key={patient.id}
                        onClick={() => setSelectedPatientId(patient.id)}
                        className="p-4 sm:px-6 flex flex-wrap items-center justify-between gap-4 hover:bg-slate-50 transition-colors cursor-pointer"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 text-xs text-slate-500 mb-0.5 tabular-nums">
                            <span className="font-mono text-slate-700">{patient.caseNumber}</span>
                            <span aria-hidden="true">·</span>
                            <span>{patient.phone}</span>
                          </div>
                          <p className="text-sm font-semibold text-slate-900">{patient.fullName}</p>
                          <p className="text-xs text-slate-600 mt-0.5">
                            {patient.lastRemedy
                              ? `${t('Last remedy:', 'সর্বশেষ রেমেডি:')} ${patient.lastRemedy}`
                              : patient.chiefComplaint}
                          </p>
                        </div>

                        <div className="text-right shrink-0">
                          <p className="font-mono text-xs font-semibold text-slate-900 tabular-nums">
                            {patient.nextFollowUpDate}
                          </p>
                          <p
                            className={`text-xs mt-0.5 font-medium ${
                              isOverdue
                                ? 'text-red-700'
                                : isToday
                                  ? 'text-amber-700'
                                  : 'text-slate-500'
                            }`}
                          >
                            {isOverdue
                              ? t('Overdue', 'মেয়াদোত্তীর্ণ')
                              : isToday
                                ? t('Due Today', 'আজ নির্ধারিত')
                                : t('Upcoming', 'আসন্ন')}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            /* Clinic Practice Overview Dashboard */
            <div className="space-y-8">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
                    {activeClinic.clinicName}
                  </h1>
                  <p className="text-sm text-slate-500 mt-0.5">
                    {activeClinic.practitionerName}
                    {activeClinic.tagline ? ` · ${activeClinic.tagline}` : ''}
                  </p>
                </div>

                {effectiveIsSuperAdmin && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingClinic(activeClinic);
                      setShowClinicModal(true);
                    }}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap self-start"
                  >
                    {t('Customize This Clinic', 'এই ক্লিনিক কাস্টমাইজ করুন')}
                  </button>
                )}
              </div>

              {approachingCapacity && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
                  <div className="text-xs text-amber-900">
                    <p className="font-semibold">
                      {t(
                        `Patient registry at ${patientCapacityPercent}% of ${currentPlanLabel} capacity`,
                        `রোগী তালিকা ${currentPlanLabel} ধারণক্ষমতার ${patientCapacityPercent}% পূর্ণ হয়েছে`
                      )}
                    </p>
                    <p className="mt-0.5 text-amber-800 tabular-nums">
                      {t(
                        `${patients.length} of ${activeClinic.patientLimit} patient slots used.`,
                        `${activeClinic.patientLimit}টির মধ্যে ${patients.length}টি রোগীর স্লট ব্যবহৃত হয়েছে।`
                      )}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => navigateTo('plan')}
                    className={`px-3.5 py-2 text-xs font-medium rounded-lg transition-colors cursor-pointer whitespace-nowrap ${palette.primaryBtn}`}
                  >
                    {t('View Quota & Plan', 'কোটা ও প্ল্যান দেখুন')}
                  </button>
                </div>
              )}

              {/* 4-Column KPI Strip */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="bg-white border border-slate-200 rounded-xl p-5">
                  <p className="text-xs font-medium text-slate-500">
                    {t('Total Patients', 'মোট রোগী')}
                  </p>
                  <p className="font-display text-2xl font-semibold text-slate-900 mt-1 tabular-nums">
                    {patients.length}
                  </p>
                  <p className="text-xs text-slate-500 mt-1 tabular-nums">
                    {patients.filter((p) => p.status === 'active').length}{' '}
                    {t('active cases', 'টি সক্রিয় কেস')}
                  </p>
                </div>

                <div className="bg-white border border-slate-200 rounded-xl p-5">
                  <p className="text-xs font-medium text-slate-500">
                    {t('Follow-ups Due', 'বাকি ফলো-আপ')}
                  </p>
                  <p className="font-display text-2xl font-semibold text-slate-900 mt-1 tabular-nums">
                    {dueOrOverdueCount}
                  </p>
                  <p className="text-xs text-slate-500 mt-1 tabular-nums">
                    {followUpPatients.length} {t('scheduled total', 'টি মোট নির্ধারিত')}
                  </p>
                </div>

                <div className="bg-white border border-slate-200 rounded-xl p-5">
                  <p className="text-xs font-medium text-slate-500">
                    {t('Photo Server Storage', 'ফটো সার্ভার স্টোরেজ')}
                  </p>
                  <p className="font-display text-2xl font-semibold text-slate-900 mt-1 tabular-nums">
                    {formatBytes(storageStats.totalBytes)}
                  </p>
                  <p className="text-xs text-slate-500 mt-1 tabular-nums">
                    {storageStats.totalFiles} {t('compressed photos', 'টি কম্প্রেসড ছবি')}
                  </p>
                </div>

                <div className="bg-white border border-slate-200 rounded-xl p-5">
                  <p className="text-xs font-medium text-slate-500">
                    {t('Plan Capacity', 'প্ল্যান ধারণক্ষমতা')}
                  </p>
                  <p className="font-display text-2xl font-semibold text-slate-900 mt-1 tabular-nums">
                    {patientCapacityPercent}%
                  </p>
                  <p className="text-xs text-slate-500 mt-1 tabular-nums">
                    {currentPlanLabel} ({patients.length}/{activeClinic.patientLimit})
                  </p>
                </div>
              </div>

              {/* Cash-Only Fee Collection Summary Strip */}
              <section className="bg-white border border-slate-200 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
                <div className="flex flex-wrap items-center gap-6 sm:gap-10 tabular-nums">
                  <div>
                    <p className="text-xs text-slate-500 flex items-center gap-1.5">
                      <Banknote className={`w-3.5 h-3.5 ${palette.navIconActive}`} />
                      <span>{t("Today's Cash", 'আজকের নগদ')}</span>
                    </p>
                    <p className="font-mono text-lg font-semibold text-emerald-700 mt-0.5">
                      {formatCashAmount(feeSummary.todayCash)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">
                      {t("This Month's Cash", 'এই মাসের নগদ')}
                    </p>
                    <p className="font-mono text-lg font-semibold text-slate-900 mt-0.5">
                      {formatCashAmount(feeSummary.monthCash)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">
                      {t('Pending Cash Dues', 'বকেয়া ফি')}
                    </p>
                    <p
                      className={`font-mono text-lg font-semibold mt-0.5 ${
                        feeSummary.totalDue > 0 ? 'text-amber-700' : 'text-slate-700'
                      }`}
                    >
                      {formatCashAmount(feeSummary.totalDue)}
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => navigateTo('fees')}
                  className={`px-3.5 py-2 text-xs font-medium border rounded-lg transition-colors cursor-pointer whitespace-nowrap ${palette.softPanel}`}
                >
                  {t('Open Cash Ledger', 'নগদ ফি খাতা দেখুন')}
                </button>
              </section>

              {patients.length === 0 && !loadingPatients ? (
                <div className="bg-white border border-slate-200 rounded-xl p-12 text-center">
                  <Users className="w-7 h-7 text-slate-400 mx-auto mb-3" />
                  <h2 className="font-display text-lg font-semibold text-slate-900">
                    {t(
                      'Start Your Homeopathic Practice Ledger',
                      'আপনার হোমিওপ্যাথিক প্র্যাকটিস লেজার শুরু করুন'
                    )}
                  </h2>
                  <p className="text-sm text-slate-500 mt-1 mb-6 max-w-md mx-auto">
                    {t(
                      'Register your first patient to track constitutional traits, remedy potencies, follow-up dates, and compressed clinical photography.',
                      'ধাতুগত বৈশিষ্ট্য, রেমেডি পোটেন্সি, ফলো-আপ তারিখ এবং কম্প্রেসড ক্লিনিক্যাল ছবি সংরক্ষণে আপনার প্রথম রোগী নিবন্ধন করুন।'
                    )}
                  </p>
                  <button
                    type="button"
                    onClick={openNewPatientModal}
                    className={`inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium rounded-lg transition-colors cursor-pointer ${palette.primaryBtn}`}
                  >
                    <Plus className="w-4 h-4" />
                    {t('Register First Patient', 'প্রথম রোগী নিবন্ধন করুন')}
                  </button>
                </div>
              ) : (
                <>
                  <PatientAgeChart patients={patients} />

                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                    {/* Recent Patients */}
                    <section className="lg:col-span-7 bg-white border border-slate-200 rounded-xl overflow-hidden">
                      <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
                        <h2 className="font-display text-sm font-semibold text-slate-900">
                          {t('Recent Patient Cases', 'সাম্প্রতিক রোগীর কেস')}
                        </h2>
                        <button
                          type="button"
                          onClick={() => navigateTo('patients')}
                          className={`text-xs font-medium hover:underline cursor-pointer ${palette.accentText}`}
                        >
                          {t('View All', 'সব দেখুন')}
                        </button>
                      </div>
                      <div className="divide-y divide-slate-200">
                        {patients.slice(0, 6).map((patient) => (
                          <button
                            key={patient.id}
                            type="button"
                            onClick={() => setSelectedPatientId(patient.id)}
                            className="w-full text-left px-6 py-3.5 hover:bg-slate-50 transition-colors flex items-center justify-between gap-4 cursor-pointer"
                          >
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-slate-900 truncate">
                                {patient.fullName}
                              </p>
                              <p className="text-xs text-slate-500 truncate mt-0.5">
                                <span className="font-mono">{patient.caseNumber}</span> ·{' '}
                                {patient.chiefComplaint}
                              </p>
                            </div>
                            <span className="text-xs text-slate-600 shrink-0 tabular-nums">
                              {patient.lastRemedy || statusLabels[patient.status]}
                            </span>
                          </button>
                        ))}
                      </div>
                    </section>

                    {/* Upcoming Follow-ups */}
                    <section className="lg:col-span-5 bg-white border border-slate-200 rounded-xl overflow-hidden">
                      <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
                        <h2 className="font-display text-sm font-semibold text-slate-900">
                          {t('Upcoming Follow-ups', 'আসন্ন ফলো-আপ')}
                        </h2>
                        <button
                          type="button"
                          onClick={() => navigateTo('follow-ups')}
                          className={`text-xs font-medium hover:underline cursor-pointer ${palette.accentText}`}
                        >
                          {t('Schedule', 'সূচি')}
                        </button>
                      </div>
                      {followUpPatients.length === 0 ? (
                        <div className="p-6 text-xs text-slate-500">
                          {t('No follow-up dates queued yet.', 'এখনো কোনো ফলো-আপ তারিখ নির্ধারিত নেই।')}
                        </div>
                      ) : (
                        <div className="divide-y divide-slate-200">
                          {followUpPatients.slice(0, 6).map((patient) => (
                            <button
                              key={patient.id}
                              type="button"
                              onClick={() => setSelectedPatientId(patient.id)}
                              className="w-full text-left px-6 py-3.5 hover:bg-slate-50 transition-colors flex items-center justify-between gap-4 cursor-pointer"
                            >
                              <div className="min-w-0">
                                <p className="text-sm font-medium text-slate-900 truncate">
                                  {patient.fullName}
                                </p>
                                <p className="text-xs text-slate-500 truncate mt-0.5">
                                  {patient.lastRemedy || t('Consultation due', 'পরামর্শ বাকি')}
                                </p>
                              </div>
                              <span
                                className={`font-mono text-xs tabular-nums shrink-0 ${
                                  (patient.nextFollowUpDate || '') <= todayIso
                                    ? 'text-amber-700 font-semibold'
                                    : 'text-slate-600'
                                }`}
                              >
                                {patient.nextFollowUpDate}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </section>
                  </div>
                </>
              )}
            </div>
          )}
        </main>
      </div>

      {/* Patient Create/Edit Modal */}
      {showPatientModal && activeClinic && (
        <PatientFormModal
          clinic={activeClinic}
          existingPatient={editingPatient}
          nextSuggestedCaseNumber={nextSuggestedCaseNumber}
          currentPatientCount={patients.length}
          patientLimit={activeClinic.patientLimit}
          onClose={() => {
            setShowPatientModal(false);
            setEditingPatient(null);
          }}
          onSaved={(patientId) => {
            setShowPatientModal(false);
            setEditingPatient(null);
            setSelectedPatientId(patientId);
            void refreshStorageStats();
          }}
          onOpenPlans={() => {
            setShowPatientModal(false);
            setEditingPatient(null);
            navigateTo('plan');
          }}
        />
      )}

      {/* Super Admin Clinic Provisioning / Customization Modal */}
      {showClinicModal && effectiveIsSuperAdmin && (
        <ClinicFormModal
          existingClinic={editingClinic}
          existingSlugs={clinics.map((c) => c.slug)}
          defaultHostingProvider={platformConfig.defaultHostingProvider}
          publicBaseUrl={platformConfig.publicBaseUrl}
          onClose={() => {
            setShowClinicModal(false);
            setEditingClinic(null);
          }}
          onSaved={(savedClinicId) => {
            setShowClinicModal(false);
            setEditingClinic(null);
            setSelectedClinicId(savedClinicId);
          }}
        />
      )}
    </div>
  );
}
