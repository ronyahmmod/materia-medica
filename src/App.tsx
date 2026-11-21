import { useCallback, useEffect, useMemo, useState } from 'react';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
} from 'firebase/firestore';
import {
  BookOpen,
  CalendarClock,
  CreditCard,
  LayoutDashboard,
  LogOut,
  Menu,
  Plus,
  Search,
  Users,
  X,
} from 'lucide-react';
import { AdminSignInView } from './components/AdminSignInView';
import { PatientAgeChart } from './components/PatientAgeChart';
import { PatientDetailView } from './components/PatientDetailView';
import { PatientFormModal } from './components/PatientFormModal';
import { PlanAndHostingView } from './components/PlanAndHostingView';
import { RepertoryView } from './components/RepertoryView';
import { SecureClinicalImage } from './components/SecureClinicalImage';
import { auth, db, handleFirestoreError, OperationType } from './firebase';
import { LanguageSwitcher, useLanguage } from './i18n/LanguageContext';
import {
  GENDER_LABELS_I18N,
  PLAN_LABELS_I18N,
  STATUS_LABELS_I18N,
} from './i18n/translations';
import { formatBytes } from './lib/imageCompressor';
import { fetchStorageStats, type StorageStatsResponse } from './lib/photoApi';
import {
  PLAN_CATALOG,
  type ClinicSettings,
  type Patient,
  type PatientStatus,
} from './types/clinic';

type NavSection = 'overview' | 'patients' | 'follow-ups' | 'repertory' | 'plan';

const PRIMARY_ADMIN_EMAIL = 'rony.jib@gmail.com';

const DEFAULT_SETTINGS: ClinicSettings = {
  id: 'subscription',
  clinicName: 'Materia Medica Clinic',
  practitionerName: 'Clinic Admin',
  planTier: 'free',
  patientLimit: PLAN_CATALOG.free.patientLimit,
  storageLimitMb: PLAN_CATALOG.free.storageLimitMb,
  hostingProvider: 'Cloud Run / Render Free Tier',
  updatedBy: '',
  updatedAt: Timestamp.now(),
};

const STATUS_CLASSES: Record<PatientStatus, string> = {
  active: 'text-emerald-700',
  'follow-up': 'text-amber-700',
  archived: 'text-slate-500',
};

export default function App() {
  const { language, t } = useLanguage();
  const [authReady, setAuthReady] = useState(false);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [isAuthorizedAdmin, setIsAuthorizedAdmin] = useState(false);

  const [patients, setPatients] = useState<Patient[]>([]);
  const [loadingPatients, setLoadingPatients] = useState(true);
  const [settings, setSettings] = useState<ClinicSettings>(DEFAULT_SETTINGS);
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

  const refreshStorageStats = useCallback(async () => {
    if (!auth.currentUser) return;
    try {
      const stats = await fetchStorageStats();
      setStorageStats(stats);
    } catch {
      // Storage stats stay at last known value if network temporarily unavailable
    }
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      setCurrentUser(user);
      if (!user) {
        setIsAuthorizedAdmin(false);
        setAuthReady(true);
        return;
      }

      const emailMatch =
        user.emailVerified && user.email?.toLowerCase() === PRIMARY_ADMIN_EMAIL;
      if (emailMatch) {
        setIsAuthorizedAdmin(true);
        setAuthReady(true);
        return;
      }

      try {
        const adminDoc = await getDoc(doc(db, 'admins', user.uid));
        setIsAuthorizedAdmin(user.emailVerified && adminDoc.exists());
      } catch {
        setIsAuthorizedAdmin(false);
      } finally {
        setAuthReady(true);
      }
    });

    return () => unsub();
  }, []);

  useEffect(() => {
    if (!authReady || !currentUser || !isAuthorizedAdmin) return;

    setLoadingPatients(true);
    const unsubPatients = onSnapshot(
      query(collection(db, 'patients'), orderBy('updatedAt', 'desc')),
      (snapshot) => {
        setPatients(
          snapshot.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Patient, 'id'>) }))
        );
        setLoadingPatients(false);
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, 'patients');
      }
    );

    const settingsRef = doc(db, 'clinic_settings', 'subscription');
    const unsubSettings = onSnapshot(
      settingsRef,
      (snapshot) => {
        if (snapshot.exists()) {
          setSettings({
            id: snapshot.id,
            ...(snapshot.data() as Omit<ClinicSettings, 'id'>),
          });
        } else {
          void setDoc(settingsRef, {
            clinicName: 'Materia Medica Clinic',
            practitionerName: currentUser.displayName || 'Clinic Admin',
            planTier: 'free',
            patientLimit: PLAN_CATALOG.free.patientLimit,
            storageLimitMb: PLAN_CATALOG.free.storageLimitMb,
            hostingProvider: 'Cloud Run / Render Free Tier',
            updatedBy: currentUser.uid,
            updatedAt: serverTimestamp(),
          }).catch((err) => {
            handleFirestoreError(err, OperationType.WRITE, 'clinic_settings/subscription');
          });
        }
      },
      (error) => {
        handleFirestoreError(error, OperationType.GET, 'clinic_settings/subscription');
      }
    );

    void refreshStorageStats();

    return () => {
      unsubPatients();
      unsubSettings();
    };
  }, [authReady, currentUser, isAuthorizedAdmin, refreshStorageStats]);

  const selectedPatient = useMemo(
    () => patients.find((p) => p.id === selectedPatientId) || null,
    [patients, selectedPatientId]
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
  const dueOrOverdueCount = useMemo(
    () =>
      followUpPatients.filter((p) => (p.nextFollowUpDate || '') <= todayIso).length +
      patients.filter((p) => p.status === 'follow-up' && !p.nextFollowUpDate).length,
    [followUpPatients, patients, todayIso]
  );

  const patientCapacityPercent = Math.min(
    100,
    Math.round((patients.length / Math.max(1, settings.patientLimit)) * 100)
  );
  const approachingCapacity = patients.length >= Math.floor(settings.patientLimit * 0.8);

  if (!authReady) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <p className="text-sm text-slate-600">
          {t('Initializing clinic workspace...', 'ক্লিনিক ওয়ার্কস্পেস চালু হচ্ছে...')}
        </p>
      </div>
    );
  }

  if (!currentUser || !isAuthorizedAdmin) {
    return <AdminSignInView unauthorizedUser={currentUser} />;
  }

  const openNewPatientModal = () => {
    setEditingPatient(null);
    setShowPatientModal(true);
  };

  const navigateTo = (section: NavSection) => {
    setSelectedPatientId(null);
    setActiveNav(section);
    setMobileMenuOpen(false);
  };

  const statusLabels = STATUS_LABELS_I18N[language];
  const genderLabels = GENDER_LABELS_I18N[language];
  const currentPlanLabel = PLAN_LABELS_I18N[language][settings.planTier].name;

  const breadcrumbLabel = selectedPatient
    ? `${t('Patients', 'রোগী')} / ${selectedPatient.fullName}`
    : activeNav === 'overview'
      ? t('Overview', 'সারসংক্ষেপ')
      : activeNav === 'patients'
        ? t('Patient Registry', 'রোগী তালিকা')
        : activeNav === 'follow-ups'
          ? t('Follow-up Schedule', 'ফলো-আপ সূচি')
          : activeNav === 'repertory'
            ? t('Clinical Repertory', 'ক্লিনিক্যাল রেপার্টরি')
            : t('Plan & Free-Tier Hosting', 'প্ল্যান ও ফ্রি-টিয়ার হোস্টিং');

  const navItems: { id: NavSection; label: string; icon: typeof LayoutDashboard }[] = [
    { id: 'overview', label: t('Overview', 'সারসংক্ষেপ'), icon: LayoutDashboard },
    { id: 'patients', label: t('Patients', 'রোগী'), icon: Users },
    { id: 'follow-ups', label: t('Follow-ups', 'ফলো-আপ'), icon: CalendarClock },
    { id: 'repertory', label: t('Repertory', 'রেপার্টরি'), icon: BookOpen },
    { id: 'plan', label: t('Plan & Hosting', 'প্ল্যান ও হোস্টিং'), icon: CreditCard },
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
        <div>
          <div className="h-16 px-6 border-b border-slate-200 flex items-center justify-between">
            <button
              type="button"
              onClick={() => navigateTo('overview')}
              className="font-display text-base font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 cursor-pointer"
            >
              {t('Materia Medica', 'মেটেরিয়া মেডিকা')}
            </button>
            <button
              type="button"
              onClick={() => setMobileMenuOpen(false)}
              aria-label="Close navigation"
              className="p-1.5 text-slate-500 hover:text-slate-900 lg:hidden cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <nav className="p-4 space-y-1">
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
                      ? 'bg-teal-50 text-teal-900'
                      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                  }`}
                >
                  <span className="flex items-center gap-2.5">
                    <Icon className={`w-4 h-4 ${isActive ? 'text-teal-700' : 'text-slate-400'}`} />
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
                </button>
              );
            })}
          </nav>
        </div>

        <div className="p-4 space-y-4 border-t border-slate-200">
          {/* Compact Free-Tier Quota Summary */}
          <button
            type="button"
            onClick={() => navigateTo('plan')}
            className="w-full text-left p-3 rounded-lg border border-slate-200 bg-slate-50/70 hover:bg-slate-100/80 transition-colors cursor-pointer"
          >
            <div className="flex items-center justify-between text-xs mb-1.5">
              <span className="font-medium text-slate-700">{currentPlanLabel}</span>
              <span className="font-mono text-slate-600 tabular-nums">
                {patients.length}/{settings.patientLimit}
              </span>
            </div>
            <div className="w-full h-1.5 bg-slate-200 rounded-full overflow-hidden">
              <div
                className={`h-full ${
                  patientCapacityPercent >= 85 ? 'bg-amber-600' : 'bg-teal-700'
                }`}
                style={{ width: `${patientCapacityPercent}%` }}
              />
            </div>
            <p className="text-[11px] text-slate-500 mt-1.5 tabular-nums">
              {formatBytes(storageStats.totalBytes)} / {settings.storageLimitMb} MB{' '}
              {t('photos', 'ছবি')}
            </p>
          </button>

          {/* Admin Account Row */}
          <div className="flex items-center justify-between gap-2 pt-1">
            <div className="flex items-center gap-2.5 min-w-0">
              <img
                src="/src/assets/images/avatar_practitioner_1795222750583.jpg"
                alt="Clinic practitioner avatar"
                referrerPolicy="no-referrer"
                className="w-8 h-8 rounded-lg object-cover border border-slate-200 shrink-0"
              />
              <div className="min-w-0">
                <p className="text-xs font-medium text-slate-900 truncate">
                  {settings.practitionerName}
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
        <header className="h-16 bg-white border-b border-slate-200 px-6 flex items-center justify-between gap-8 shrink-0 print:hidden">
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
                {settings.clinicName}
              </span>
              <span className="text-slate-300 hidden sm:inline" aria-hidden="true">
                /
              </span>
              <span className="font-medium text-slate-900 truncate">{breadcrumbLabel}</span>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <LanguageSwitcher />
            <button
              type="button"
              onClick={openNewPatientModal}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-lg hover:bg-teal-800 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              {t('New Patient', 'নতুন রোগী')}
            </button>
          </div>
        </header>

        {/* Main Viewport */}
        <main className="flex-1 p-6 lg:p-8 max-w-[1280px] w-full mx-auto print:p-0 print:max-w-none">
          {selectedPatient ? (
            <PatientDetailView
              patient={selectedPatient}
              clinicName={settings.clinicName}
              practitionerName={settings.practitionerName}
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
          ) : activeNav === 'repertory' ? (
            <RepertoryView />
          ) : activeNav === 'plan' ? (
            <PlanAndHostingView
              settings={settings}
              patientCount={patients.length}
              storageStats={storageStats}
            />
          ) : activeNav === 'patients' ? (
            <div className="space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
                    {t('Patient Registry', 'রোগী তালিকা')}
                  </h1>
                  <p className="text-sm text-slate-500 mt-0.5 tabular-nums">
                    {patients.length} {t('total cases', 'টি মোট কেস')} ·{' '}
                    {t('Admin-managed records', 'অ্যাডমিন-পরিচালিত রেকর্ড')}
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
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-lg hover:bg-teal-800 transition-colors cursor-pointer"
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
            /* Overview Dashboard */
            <div className="space-y-8">
              <div>
                <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
                  {t('Practice Overview', 'প্র্যাকটিস সারসংক্ষেপ')}
                </h1>
                <p className="text-sm text-slate-500 mt-0.5">
                  {t(
                    'Admin-only homeopathic patient records, remedy follow-ups, and free-tier capacity.',
                    'শুধুমাত্র অ্যাডমিন-পরিচালিত হোমিওপ্যাথিক রোগীর নথি, রেমেডি ফলো-আপ ও ফ্রি-টিয়ার ধারণক্ষমতা।'
                  )}
                </p>
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
                        `${patients.length} of ${settings.patientLimit} patient slots used. Upgrade your subscription tier as your clinic grows.`,
                        `${settings.patientLimit}টির মধ্যে ${patients.length}টি রোগীর স্লট ব্যবহৃত হয়েছে। রোগী বাড়লে প্ল্যান আপগ্রেড করুন।`
                      )}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => navigateTo('plan')}
                    className="px-3.5 py-2 text-xs font-medium text-white bg-teal-700 rounded-lg hover:bg-teal-800 transition-colors cursor-pointer whitespace-nowrap"
                  >
                    {t('Manage Subscription', 'সাবস্ক্রিপশন পরিচালনা')}
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
                    {currentPlanLabel} ({patients.length}/{settings.patientLimit})
                  </p>
                </div>
              </div>

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
                      'Register your first patient to track constitutional traits, remedy potencies, follow-up dates, and compressed clinical photography on the free tier.',
                      'ধাতুগত বৈশিষ্ট্য, রেমেডি পোটেন্সি, ফলো-আপ তারিখ এবং কম্প্রেসড ক্লিনিক্যাল ছবি সংরক্ষণে আপনার প্রথম রোগী নিবন্ধন করুন।'
                    )}
                  </p>
                  <button
                    type="button"
                    onClick={openNewPatientModal}
                    className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-teal-700 rounded-lg hover:bg-teal-800 transition-colors cursor-pointer"
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
                        className="text-xs font-medium text-teal-800 hover:underline cursor-pointer"
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
                        className="text-xs font-medium text-teal-800 hover:underline cursor-pointer"
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

      {showPatientModal && (
        <PatientFormModal
          existingPatient={editingPatient}
          nextSuggestedCaseNumber={nextSuggestedCaseNumber}
          currentPatientCount={patients.length}
          patientLimit={settings.patientLimit}
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
    </div>
  );
}
