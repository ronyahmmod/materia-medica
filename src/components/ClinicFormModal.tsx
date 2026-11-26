import { useState, type FormEvent } from 'react';
import { doc, serverTimestamp, writeBatch } from 'firebase/firestore';
import {
  Building2,
  Check,
  Copy,
  Eye,
  EyeOff,
  Globe,
  KeyRound,
  Loader2,
  Mail,
  Plus,
  RefreshCw,
  Shield,
  Trash2,
  X,
} from 'lucide-react';
import { auth, db, OperationType, reportFirestoreError } from '../firebase';
import { useLanguage } from '../i18n/LanguageContext';
import {
  ACCENT_THEME_LABELS_I18N,
  BILLING_CYCLE_LABELS_I18N,
  PLAN_LABELS_I18N,
  SUBSCRIPTION_STATUS_LABELS_I18N,
} from '../i18n/translations';
import {
  generateStrongClientPassword,
  provisionClientEmailPasswordAccount,
  sendClientPasswordReset,
} from '../lib/clientAuthProvisioner';
import {
  ACCENT_THEME_PALETTES,
  buildClinicAccessEmails,
  buildClinicShareUrl,
  buildPublicProfilePayload,
  buildUniqueIdList,
  formatReadableClinicUrl,
  isSameStringList,
  isValidClinicSlug,
  RESERVED_CLINIC_SLUGS,
  sanitizeClinicSlug,
  suggestShortClinicSlug,
  SUPER_ADMIN_EMAIL,
  syncTenantAccessListsAcrossDocs,
} from '../lib/tenantPaths';
import {
  ACCENT_THEME_OPTIONS,
  BILLING_CYCLE_OPTIONS,
  CURRENCY_OPTIONS,
  FIELD_LIMITS,
  PLAN_CATALOG,
  SUBSCRIPTION_STATUS_OPTIONS,
  type BillingCycle,
  type ClinicAccentTheme,
  type ClinicTenant,
  type CurrencySymbol,
  type PlanTier,
  type SubscriptionStatus,
} from '../types/clinic';

interface ClinicFormModalProps {
  existingClinic?: ClinicTenant | null;
  existingSlugs: string[];
  defaultHostingProvider?: string;
  publicBaseUrl?: string;
  onClose: () => void;
  onSaved: (clinicId: string) => void;
}

interface StaffCredentialDraft {
  id: string;
  email: string;
  password: string;
}

function generateClinicId(): string {
  return `cln_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
}

export function ClinicFormModal({
  existingClinic,
  existingSlugs,
  defaultHostingProvider = 'Cloud Run / Render Free Tier',
  publicBaseUrl,
  onClose,
  onSaved,
}: ClinicFormModalProps) {
  const { language, t } = useLanguage();
  const planLabels = PLAN_LABELS_I18N[language];
  const statusLabels = SUBSCRIPTION_STATUS_LABELS_I18N[language];
  const billingLabels = BILLING_CYCLE_LABELS_I18N[language];
  const themeLabels = ACCENT_THEME_LABELS_I18N[language];

  const isEditing = Boolean(existingClinic);
  const hasExistingUids = Boolean(existingClinic?.authorizedUids?.length);

  const [clinicName, setClinicName] = useState(existingClinic?.clinicName || '');
  const [practitionerName, setPractitionerName] = useState(
    existingClinic?.practitionerName || ''
  );
  const [slug, setSlug] = useState(existingClinic?.slug || '');
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(Boolean(existingClinic));

  const [tagline, setTagline] = useState(existingClinic?.tagline || '');
  const [phone, setPhone] = useState(existingClinic?.phone || '');
  const [address, setAddress] = useState(existingClinic?.address || '');
  const [currencySymbol, setCurrencySymbol] = useState<CurrencySymbol>(
    existingClinic?.currencySymbol || '৳'
  );
  const [accentColor, setAccentColor] = useState<ClinicAccentTheme>(
    existingClinic?.accentColor || 'teal'
  );

  // Client Admin Email & Password Credentials
  const [ownerEmail, setOwnerEmail] = useState(existingClinic?.ownerEmail || '');
  const [ownerPassword, setOwnerPassword] = useState(() =>
    existingClinic ? '' : generateStrongClientPassword(12)
  );
  const [showOwnerPassword, setShowOwnerPassword] = useState(!existingClinic);
  const [copiedCredentials, setCopiedCredentials] = useState(false);
  const [sendingReset, setSendingReset] = useState(false);
  const [resetSentMessage, setResetSentMessage] = useState<string | null>(null);

  // Existing retained staff emails (when editing) & new staff credential drafts
  const [retainedStaffEmails, setRetainedStaffEmails] = useState<string[]>(() => {
    if (!existingClinic) return [];
    const ownerLower = existingClinic.ownerEmail.trim().toLowerCase();
    return existingClinic.accessEmails.filter((e) => e.toLowerCase() !== ownerLower);
  });
  const [staffDrafts, setStaffDrafts] = useState<StaffCredentialDraft[]>([]);

  const [planTier, setPlanTier] = useState<PlanTier>(existingClinic?.planTier || 'free');
  const [subscriptionStatus, setSubscriptionStatus] = useState<SubscriptionStatus>(
    existingClinic?.subscriptionStatus || 'active'
  );
  const [patientLimit, setPatientLimit] = useState(
    String(existingClinic?.patientLimit ?? PLAN_CATALOG.free.patientLimit)
  );
  const [storageLimitMb, setStorageLimitMb] = useState(
    String(existingClinic?.storageLimitMb ?? PLAN_CATALOG.free.storageLimitMb)
  );
  const [billingCycle, setBillingCycle] = useState<BillingCycle>(
    existingClinic?.billingCycle || 'free'
  );
  const [monthlyFeeAmount, setMonthlyFeeAmount] = useState(
    String(existingClinic?.monthlyFeeAmount ?? 0)
  );
  const [hostingProvider, setHostingProvider] = useState(
    existingClinic?.hostingProvider || defaultHostingProvider
  );
  const [subscriptionNotes, setSubscriptionNotes] = useState(
    existingClinic?.subscriptionNotes || ''
  );

  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleClinicNameChange = (val: string) => {
    setClinicName(val);
    if (!slugManuallyEdited) {
      setSlug(suggestShortClinicSlug(val));
    }
  };

  const handlePlanTierChange = (nextTier: PlanTier) => {
    setPlanTier(nextTier);
    const catalog = PLAN_CATALOG[nextTier];
    setPatientLimit(String(catalog.patientLimit));
    setStorageLimitMb(String(catalog.storageLimitMb));
    if (nextTier === 'free') {
      setBillingCycle('free');
      setMonthlyFeeAmount('0');
    } else {
      if (billingCycle === 'free') setBillingCycle('monthly');
      setMonthlyFeeAmount(String(catalog.monthlyPriceUsd));
    }
  };

  const previewSlug = sanitizeClinicSlug(slug) || 'your-clinic';
  const previewShareUrl = buildClinicShareUrl(previewSlug, publicBaseUrl);
  const previewReadableUrl = formatReadableClinicUrl(previewSlug, publicBaseUrl);

  const handleCopyCredentials = async () => {
    const cleanEmail = ownerEmail.trim().toLowerCase();
    const lines = [
      `Clinic: ${clinicName.trim() || previewSlug}`,
      `Portal URL: ${previewShareUrl}`,
      `Client Admin Email: ${cleanEmail}`,
      ownerPassword
        ? `Assigned Password: ${ownerPassword}`
        : '(Use previously assigned password or password reset email)',
    ].join('\n');

    try {
      await navigator.clipboard.writeText(lines);
      setCopiedCredentials(true);
      window.setTimeout(() => setCopiedCredentials(false), 2200);
    } catch {
      // Clipboard fallback ignored cleanly
    }
  };

  const handleSendResetEmail = async () => {
    const cleanEmail = ownerEmail.trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) {
      setErrorMessage(
        t('Enter a valid Client Admin Email first.', 'প্রথমে একটি বৈধ ক্লায়েন্ট ইমেইল লিখুন।')
      );
      return;
    }
    setSendingReset(true);
    setErrorMessage(null);
    setResetSentMessage(null);
    try {
      await sendClientPasswordReset(cleanEmail);
      setResetSentMessage(
        t(
          `Password reset link sent to ${cleanEmail}.`,
          `${cleanEmail} ঠিকানায় পাসওয়ার্ড রিসেট লিংক পাঠানো হয়েছে।`
        )
      );
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSendingReset(false);
    }
  };

  const handleAddStaffDraft = () => {
    const totalCount =
      1 + retainedStaffEmails.length + staffDrafts.length;
    if (totalCount >= 10) return;
    setStaffDrafts((prev) => [
      ...prev,
      {
        id: `stf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        email: '',
        password: generateStrongClientPassword(12),
      },
    ]);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setResetSentMessage(null);

    const superAdminUid = auth.currentUser?.uid;
    if (!superAdminUid) {
      setErrorMessage(t('Super Admin authentication required.', 'সুপার অ্যাডমিন সাইন ইন প্রয়োজন।'));
      return;
    }

    const cleanClinicName = clinicName.trim();
    const cleanPractitioner = practitionerName.trim();
    const cleanSlug = sanitizeClinicSlug(slug);
    const cleanOwnerEmail = ownerEmail.trim().toLowerCase();
    const cleanPhone = phone.trim();
    const cleanTagline = tagline.trim();
    const cleanAddress = address.trim();
    const cleanHosting = hostingProvider.trim();
    const cleanNotes = subscriptionNotes.trim();

    if (!cleanClinicName || !cleanPractitioner) {
      setErrorMessage(
        t(
          'Clinic name and practitioner name are required.',
          'ক্লিনিকের নাম এবং চিকিৎসকের নাম আবশ্যক।'
        )
      );
      return;
    }

    if (!isValidClinicSlug(cleanSlug)) {
      if (RESERVED_CLINIC_SLUGS.has(cleanSlug)) {
        setErrorMessage(
          t(
            `"${cleanSlug}" is a reserved system path. Please choose another short clinic slug (e.g., ${cleanSlug}-clinic).`,
            `"${cleanSlug}" একটি সংরক্ষিত সিস্টেম পাথ। অনুগ্রহ করে অন্য একটি সংক্ষিপ্ত স্লাগ দিন (যেমন: ${cleanSlug}-clinic)।`
          )
        );
      } else {
        setErrorMessage(
          t(
            'URL slug must be 2–64 lowercase letters, numbers, or hyphens.',
            'URL স্লাগ ২–৬৪ অক্ষরের ছোট ইংরেজি বর্ণ, সংখ্যা বা হাইফেন হতে হবে।'
          )
        );
      }
      return;
    }

    const conflictSlugs = existingSlugs.filter(
      (s) => s.toLowerCase() !== (existingClinic?.slug || '').toLowerCase()
    );
    if (conflictSlugs.includes(cleanSlug)) {
      setErrorMessage(
        t(
          `The clinic URL slug "${cleanSlug}" is already assigned to another client.`,
          `"${cleanSlug}" স্লাগটি ইতিমধ্যে অন্য একটি ক্লিনিকে ব্যবহৃত হয়েছে।`
        )
      );
      return;
    }

    if (!cleanOwnerEmail.includes('@') || cleanOwnerEmail.length < 3) {
      setErrorMessage(
        t(
          'A valid Client Admin Email is required for password sign-in.',
          'পাসওয়ার্ড লগইনের জন্য একটি বৈধ ক্লায়েন্ট অ্যাডমিন ইমেইল প্রয়োজন।'
        )
      );
      return;
    }

    const ownerEmailChanged =
      isEditing && existingClinic?.ownerEmail.trim().toLowerCase() !== cleanOwnerEmail;
    const isSuperAdminOwnedClinic = cleanOwnerEmail === SUPER_ADMIN_EMAIL.toLowerCase();
    const mustProvisionOwner =
      (!isEditing && !isSuperAdminOwnedClinic) ||
      ownerEmailChanged ||
      (!hasExistingUids && !isSuperAdminOwnedClinic) ||
      ownerPassword.length > 0;

    if (mustProvisionOwner && ownerPassword.length < 8) {
      setErrorMessage(
        t(
          'Assign a client password of at least 8 characters to provision their login account.',
          'ক্লায়েন্ট লগইন অ্যাকাউন্ট তৈরি করতে কমপক্ষে ৮ অক্ষরের একটি পাসওয়ার্ড দিন।'
        )
      );
      return;
    }

    // Validate any additional staff login drafts
    const validStaffDrafts: Array<{ email: string; password: string }> = [];
    for (const draft of staffDrafts) {
      const sEmail = draft.email.trim().toLowerCase();
      if (!sEmail && !draft.password) continue;
      if (!sEmail.includes('@') || sEmail.length < 3) {
        setErrorMessage(
          t('Each additional staff login needs a valid email.', 'প্রতিটি অতিরিক্ত স্টাফ লগইনের জন্য বৈধ ইমেইল দিন।')
        );
        return;
      }
      if (draft.password.length < 8) {
        setErrorMessage(
          t(
            `Assigned password for staff "${sEmail}" must be at least 8 characters.`,
            `"${sEmail}" স্টাফের পাসওয়ার্ড কমপক্ষে ৮ অক্ষরের হতে হবে।`
          )
        );
        return;
      }
      validStaffDrafts.push({ email: sEmail, password: draft.password });
    }

    if (cleanPhone.length > 40) {
      setErrorMessage(
        t('Contact phone must be 40 characters or fewer.', 'ফোন নম্বর ৪০ অক্ষরের কম হতে হবে।')
      );
      return;
    }

    const accessEmails = buildClinicAccessEmails(
      cleanOwnerEmail,
      [...retainedStaffEmails, ...validStaffDrafts.map((s) => s.email)].join(',')
    );
    if (accessEmails.length === 0) {
      setErrorMessage(
        t('At least one valid authorized email is required.', 'কমপক্ষে একটি অনুমোদিত ইমেইল প্রয়োজন।')
      );
      return;
    }

    const parsedPatientLimit = Number.parseInt(patientLimit, 10);
    const parsedStorageLimitMb = Number.parseInt(storageLimitMb, 10);
    const parsedFeeAmount = Number.parseFloat(monthlyFeeAmount || '0');

    if (
      !Number.isFinite(parsedPatientLimit) ||
      parsedPatientLimit < 1 ||
      parsedPatientLimit > 100000
    ) {
      setErrorMessage(
        t('Patient limit must be between 1 and 100,000.', 'রোগীর সীমা ১ থেকে ১,০০,০০০ হতে হবে।')
      );
      return;
    }

    if (
      !Number.isFinite(parsedStorageLimitMb) ||
      parsedStorageLimitMb < 1 ||
      parsedStorageLimitMb > 100000
    ) {
      setErrorMessage(
        t(
          'Storage limit must be between 1 MB and 100,000 MB.',
          'স্টোরেজ সীমা ১ MB থেকে ১,০০,০০০ MB হতে হবে।'
        )
      );
      return;
    }

    if (!Number.isFinite(parsedFeeAmount) || parsedFeeAmount < 0 || parsedFeeAmount > 100000) {
      setErrorMessage(
        t('Subscription fee must be 0 or greater.', 'সাবস্ক্রিপশন ফি ০ বা তার বেশি হতে হবে।')
      );
      return;
    }

    setSaving(true);
    const clinicId = existingClinic ? existingClinic.id : generateClinicId();

    try {
      const collectedUids: string[] = [...(existingClinic?.authorizedUids || [])];

      if (isSuperAdminOwnedClinic) {
        collectedUids.push(superAdminUid);
      }

      if (mustProvisionOwner) {
        const ownerAccount = await provisionClientEmailPasswordAccount(
          cleanOwnerEmail,
          ownerPassword
        );
        collectedUids.push(ownerAccount.uid);
      }

      for (const staff of validStaffDrafts) {
        const staffAccount = await provisionClientEmailPasswordAccount(
          staff.email,
          staff.password
        );
        collectedUids.push(staffAccount.uid);
      }

      const authorizedUids = buildUniqueIdList(collectedUids);
      if (authorizedUids.length === 0) {
        throw new Error(
          t(
            'Unable to bind an authorized user ID for this clinic. Please enter a valid email and password.',
            'এই ক্লিনিকের জন্য অনুমোদিত ইউজার আইডি যুক্ত করা যায়নি। অনুগ্রহ করে বৈধ ইমেইল ও পাসওয়ার্ড দিন।'
          )
        );
      }

      const tenantPayload: Record<string, unknown> = {
        slug: cleanSlug,
        clinicName: cleanClinicName,
        practitionerName: cleanPractitioner,
        ownerEmail: cleanOwnerEmail,
        accessEmails,
        authorizedUids,
        currencySymbol,
        accentColor,
        planTier,
        subscriptionStatus,
        patientLimit: parsedPatientLimit,
        storageLimitMb: parsedStorageLimitMb,
        monthlyFeeAmount: Math.round(parsedFeeAmount * 100) / 100,
        billingCycle,
        createdBy: existingClinic ? existingClinic.createdBy : superAdminUid,
        createdAt: existingClinic ? existingClinic.createdAt : serverTimestamp(),
        updatedAt: serverTimestamp(),
      };

      if (cleanTagline) tenantPayload.tagline = cleanTagline;
      if (cleanPhone) tenantPayload.phone = cleanPhone;
      if (cleanAddress) tenantPayload.address = cleanAddress;
      if (cleanHosting) tenantPayload.hostingProvider = cleanHosting;
      if (cleanNotes) tenantPayload.subscriptionNotes = cleanNotes;
      if (existingClinic?.lastActiveAt) tenantPayload.lastActiveAt = existingClinic.lastActiveAt;
      if (existingClinic?.lastActiveEmail) tenantPayload.lastActiveEmail = existingClinic.lastActiveEmail;

      const publicPayload = buildPublicProfilePayload(clinicId, {
        slug: cleanSlug,
        clinicName: cleanClinicName,
        practitionerName: cleanPractitioner,
        tagline: cleanTagline || undefined,
        accentColor,
        planTier,
        subscriptionStatus,
      });

      const batch = writeBatch(db);
      batch.set(doc(db, 'clinics', clinicId), tenantPayload);
      batch.set(doc(db, 'clinic_public', cleanSlug), publicPayload);

      if (existingClinic && existingClinic.slug !== cleanSlug) {
        batch.delete(doc(db, 'clinic_public', existingClinic.slug));
      }

      await batch.commit();

      if (
        existingClinic &&
        (!isSameStringList(existingClinic.accessEmails || [], accessEmails) ||
          !isSameStringList(existingClinic.authorizedUids || [], authorizedUids))
      ) {
        await syncTenantAccessListsAcrossDocs(clinicId, accessEmails, authorizedUids);
      }

      onSaved(clinicId);
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      if (rawMsg.includes('EMAIL_PASSWORD_DISABLED')) {
        setErrorMessage(
          t(
            'Email/Password sign-in is disabled in your Firebase project. Open Firebase Console -> Authentication -> Sign-in method -> Email/Password -> Enable, then save again.',
            'আপনার Firebase প্রজেক্টে Email/Password সাইন-ইন বন্ধ আছে। Firebase Console -> Authentication -> Sign-in method -> Email/Password চালু করে আবার চেষ্টা করুন।'
          )
        );
      } else {
        setErrorMessage(rawMsg);
      }
      reportFirestoreError(err, OperationType.WRITE, `clinics/${clinicId}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-3xl my-8 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Building2 className="w-4 h-4 text-teal-700 shrink-0" />
            <div>
              <h2 className="font-display text-base font-semibold text-slate-900">
                {isEditing
                  ? t('Customize Client Clinic & Credentials', 'ক্লায়েন্ট ক্লিনিক ও লগইন কাস্টমাইজ করুন')
                  : t('Provision New Client Clinic', 'নতুন ক্লায়েন্ট ক্লিনিক তৈরি করুন')}
              </h2>
              <p className="text-xs text-slate-500">
                {t(
                  'Configure white-label branding, custom URL, assigned Email/Password credentials, and database quotas.',
                  'হোয়াইট-লেবেল ব্র্যান্ডিং, কাস্টম URL, নির্ধারিত ইমেইল/পাসওয়ার্ড এবং ডেটাবেস কোটা নির্ধারণ করুন।'
                )}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-6 max-h-[82vh] overflow-y-auto">
          {errorMessage && (
            <div className="border border-red-200 bg-red-50 rounded-lg p-3 text-xs text-red-800" role="alert">
              {errorMessage}
            </div>
          )}

          {resetSentMessage && (
            <div className="border border-emerald-200 bg-emerald-50 rounded-lg p-3 text-xs text-emerald-900">
              {resetSentMessage}
            </div>
          )}

          {/* Section 1: Clinic Branding & Shareable URL */}
          <section className="space-y-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-900 border-b border-slate-200 pb-2">
              <Globe className="w-3.5 h-3.5 text-slate-500" />
              <span>{t('1. Clinic Branding & Shareable URL', '১. ক্লিনিক ব্র্যান্ডিং ও শেয়ারযোগ্য URL')}</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t('Clinic / Chamber Name *', 'ক্লিনিক / চেম্বারের নাম *')}
                </label>
                <input
                  type="text"
                  required
                  maxLength={FIELD_LIMITS.clinicNameMax}
                  value={clinicName}
                  onChange={(e) => handleClinicNameChange(e.target.value)}
                  placeholder={t('e.g., Shifa Classical Homeopathy', 'যেমন: শিফা ক্লাসিক্যাল হোমিওপ্যাথি')}
                  className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t('Lead Practitioner Name *', 'প্রধান চিকিৎসকের নাম *')}
                </label>
                <input
                  type="text"
                  required
                  maxLength={FIELD_LIMITS.practitionerNameMax}
                  value={practitionerName}
                  onChange={(e) => setPractitionerName(e.target.value)}
                  placeholder={t('e.g., Dr. Rahman', 'যেমন: ডা. রহমান')}
                  className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t('Short Client URL Slug *', 'সংক্ষিপ্ত ক্লায়েন্ট URL স্লাগ *')}
                </label>
                <div className="flex items-center bg-white border border-slate-300 rounded-lg focus-within:ring-2 focus-within:ring-teal-700/20 focus-within:border-teal-700 overflow-hidden">
                  <span className="pl-3 pr-1 py-2 text-xs font-mono text-slate-400 select-none bg-slate-50 border-r border-slate-200">
                    /
                  </span>
                  <input
                    type="text"
                    required
                    maxLength={FIELD_LIMITS.slugMax}
                    value={slug}
                    onChange={(e) => {
                      setSlugManuallyEdited(true);
                      setSlug(sanitizeClinicSlug(e.target.value));
                    }}
                    placeholder="shifa-clinic"
                    className="w-full px-2.5 py-2 text-xs font-mono bg-white focus:outline-none"
                  />
                </div>
                <p
                  title={previewShareUrl}
                  className="text-[11px] text-teal-800 mt-1 break-all font-mono"
                >
                  {previewReadableUrl}
                </p>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t('Portal Tagline', 'পোর্টাল ট্যাগলাইন')}
                </label>
                <input
                  type="text"
                  maxLength={FIELD_LIMITS.taglineMax}
                  value={tagline}
                  onChange={(e) => setTagline(e.target.value)}
                  placeholder={t(
                    'Classical Constitutional Remedies & Care',
                    'ক্লাসিক্যাল ধাতুগত চিকিৎসা ও রোগী ব্যবস্থাপনা'
                  )}
                  className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t('Clinic Phone', 'ক্লিনিক ফোন')}
                </label>
                <input
                  type="text"
                  maxLength={40}
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+880 17..."
                  className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t('Currency Symbol', 'মুদ্রা চিহ্ন')}
                </label>
                <select
                  value={currencySymbol}
                  onChange={(e) => setCurrencySymbol(e.target.value as CurrencySymbol)}
                  className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                >
                  {CURRENCY_OPTIONS.map((cur) => (
                    <option key={cur} value={cur}>
                      {cur}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t('Workspace Accent Theme', 'ওয়ার্কস্পেস থিম রঙ')}
                </label>
                <div className="grid grid-cols-4 gap-2 pt-0.5">
                  {ACCENT_THEME_OPTIONS.map((themeKey) => {
                    const p = ACCENT_THEME_PALETTES[themeKey];
                    const selected = accentColor === themeKey;
                    return (
                      <button
                        key={themeKey}
                        type="button"
                        title={themeLabels[themeKey]}
                        onClick={() => setAccentColor(themeKey)}
                        className={`h-8 rounded-lg border flex items-center justify-center cursor-pointer transition-colors ${
                          selected ? 'border-slate-900 ring-2 ring-slate-900/20' : 'border-slate-200'
                        }`}
                      >
                        <span className={`w-4 h-4 rounded-sm flex items-center justify-center ${p.swatchHex}`}>
                          {selected && <Check className="w-3 h-3 text-white" />}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {t('Clinic Address (Shown on Print Case Sheets)', 'ক্লিনিকের ঠিকানা (প্রিন্ট কেস শিটে দেখাবে)')}
              </label>
              <input
                type="text"
                maxLength={FIELD_LIMITS.addressMax}
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder={t('Chamber address, street, city', 'চেম্বারের ঠিকানা ও শহর')}
                className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
              />
            </div>
          </section>

          {/* Section 2: Assigned Client Credentials (Email & Password Only) */}
          <section className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-semibold text-slate-900 border-b border-slate-200 pb-2">
              <div className="flex items-center gap-2">
                <Shield className="w-3.5 h-3.5 text-teal-700" />
                <span>
                  {t(
                    '2. Client Admin Credentials (Email & Password Only)',
                    '২. ক্লায়েন্ট অ্যাডমিন লগইন (শুধুমাত্র ইমেইল ও পাসওয়ার্ড)'
                  )}
                </span>
              </div>
              <button
                type="button"
                onClick={handleCopyCredentials}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-slate-700 bg-slate-50 border border-slate-200 rounded-md hover:bg-slate-100 cursor-pointer"
              >
                {copiedCredentials ? (
                  <>
                    <Check className="w-3 h-3 text-emerald-700" />
                    {t('Credentials Copied', 'লগইন তথ্য কপি হয়েছে')}
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3" />
                    {t('Copy Login Details', 'লগইন তথ্য কপি করুন')}
                  </>
                )}
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t('Client Admin Email *', 'ক্লায়েন্ট অ্যাডমিন ইমেইল *')}
                </label>
                <div className="relative">
                  <Mail className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="email"
                    required
                    maxLength={FIELD_LIMITS.emailMax}
                    value={ownerEmail}
                    onChange={(e) => setOwnerEmail(e.target.value)}
                    placeholder="doctor@clinic-domain.com"
                    className="w-full pl-8 pr-3 py-2 text-xs font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-medium text-slate-700">
                    {isEditing && hasExistingUids
                      ? t('New / Link Password (Optional)', 'নতুন / লিংক পাসওয়ার্ড (ঐচ্ছিক)')
                      : t('Assigned Password * (min 8 chars)', 'নির্ধারিত পাসওয়ার্ড * (কমপক্ষে ৮ অক্ষর)')}
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setOwnerPassword(generateStrongClientPassword(12));
                      setShowOwnerPassword(true);
                    }}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-teal-800 hover:underline cursor-pointer"
                  >
                    <RefreshCw className="w-3 h-3" />
                    {t('Generate', 'তৈরি করুন')}
                  </button>
                </div>
                <div className="relative">
                  <KeyRound className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type={showOwnerPassword ? 'text' : 'password'}
                    required={!isEditing || !hasExistingUids}
                    minLength={ownerPassword.length > 0 ? 8 : undefined}
                    value={ownerPassword}
                    onChange={(e) => setOwnerPassword(e.target.value)}
                    placeholder={
                      isEditing && hasExistingUids
                        ? t('Leave blank to keep existing login', 'আগের পাসওয়ার্ড রাখতে খালি রাখুন')
                        : t('Assign strong password', 'শক্তিশালী পাসওয়ার্ড লিখুন')
                    }
                    className="w-full pl-8 pr-9 py-2 text-xs font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                  />
                  <button
                    type="button"
                    onClick={() => setShowOwnerPassword((prev) => !prev)}
                    aria-label="Toggle password visibility"
                    className="p-1 text-slate-400 hover:text-slate-700 absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer"
                  >
                    {showOwnerPassword ? (
                      <EyeOff className="w-3.5 h-3.5" />
                    ) : (
                      <Eye className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>
              </div>
            </div>

            {isEditing && existingClinic && (
              <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-50 border border-slate-200 rounded-lg px-3.5 py-2.5 text-xs">
                <div className="text-slate-600 tabular-nums">
                  {hasExistingUids ? (
                    <span className="text-emerald-800 font-medium">
                      {t(
                        `Active UID Lock: ${existingClinic.authorizedUids.length} bound account(s)`,
                        `সক্রিয় UID লক: ${existingClinic.authorizedUids.length}টি অনুমোদিত অ্যাকাউন্ট`
                      )}
                    </span>
                  ) : (
                    <span className="text-amber-800 font-medium">
                      {t(
                        'Legacy clinic needs a password assigned above to bind its strict UID lock.',
                        'পুরনো এই ক্লিনিকটিতে UID লক সক্রিয় করতে উপরে একটি পাসওয়ার্ড দিন।'
                      )}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  disabled={sendingReset}
                  onClick={handleSendResetEmail}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-100 cursor-pointer disabled:opacity-50"
                >
                  {sendingReset && <Loader2 className="w-3 h-3 animate-spin" />}
                  {t('Send Password Reset Email', 'পাসওয়ার্ড রিসেট ইমেইল পাঠান')}
                </button>
              </div>
            )}

            {/* Additional Staff Logins */}
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-700">
                  {t('Additional Staff Logins (Optional, up to 10 total)', 'অতিরিক্ত স্টাফ লগইন (ঐচ্ছিক)')}
                </span>
                <button
                  type="button"
                  onClick={handleAddStaffDraft}
                  disabled={1 + retainedStaffEmails.length + staffDrafts.length >= 10}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-teal-800 hover:underline disabled:opacity-40 cursor-pointer"
                >
                  <Plus className="w-3 h-3" />
                  {t('Add Staff Login', 'স্টাফ লগইন যোগ করুন')}
                </button>
              </div>

              {retainedStaffEmails.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {retainedStaffEmails.map((stEmail) => (
                    <span
                      key={stEmail}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-mono bg-slate-100 border border-slate-200 text-slate-700 rounded-md"
                    >
                      {stEmail}
                      <button
                        type="button"
                        onClick={() =>
                          setRetainedStaffEmails((prev) => prev.filter((item) => item !== stEmail))
                        }
                        title={t('Revoke access', 'অ্যাক্সেস বাতিল')}
                        className="text-slate-400 hover:text-red-700 cursor-pointer"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {staffDrafts.map((draft) => (
                <div key={draft.id} className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center">
                  <input
                    type="email"
                    value={draft.email}
                    onChange={(e) =>
                      setStaffDrafts((prev) =>
                        prev.map((d) => (d.id === draft.id ? { ...d, email: e.target.value } : d))
                      )
                    }
                    placeholder="assistant@clinic-domain.com"
                    className="sm:col-span-6 px-3 py-1.5 text-xs font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-teal-700"
                  />
                  <input
                    type="text"
                    value={draft.password}
                    onChange={(e) =>
                      setStaffDrafts((prev) =>
                        prev.map((d) =>
                          d.id === draft.id ? { ...d, password: e.target.value } : d
                        )
                      )
                    }
                    placeholder={t('Staff password (min 8 chars)', 'স্টাফ পাসওয়ার্ড (কমপক্ষে ৮ অক্ষর)')}
                    className="sm:col-span-5 px-3 py-1.5 text-xs font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-teal-700"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setStaffDrafts((prev) => prev.filter((d) => d.id !== draft.id))
                    }
                    className="sm:col-span-1 p-1.5 text-slate-400 hover:text-red-700 justify-self-end cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>

            <p className="text-[11px] text-slate-500">
              {t(
                'Google login is disabled on client portals. Clients sign in strictly with the Email & Password assigned here, bound to their Firebase User ID.',
                'ক্লায়েন্ট পোর্টালে Google লগইন বন্ধ। ক্লায়েন্টরা শুধুমাত্র এখানে নির্ধারিত ইমেইল ও পাসওয়ার্ড দিয়েই লগইন করতে পারবেন।'
              )}
            </p>
          </section>

          {/* Section 3: Database Quotas & Subscription */}
          <section className="space-y-4">
            <div className="flex items-center justify-between text-xs font-semibold text-slate-900 border-b border-slate-200 pb-2">
              <span>{t('3. Database Quotas & Subscription Plan', '৩. ডেটাবেস কোটা ও সাবস্ক্রিপশন প্ল্যান')}</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t('Subscription Tier', 'সাবস্ক্রিপশন টিয়ার')}
                </label>
                <select
                  value={planTier}
                  onChange={(e) => handlePlanTierChange(e.target.value as PlanTier)}
                  className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                >
                  {(['free', 'growth', 'clinic_pro'] as const).map((tierKey) => (
                    <option key={tierKey} value={tierKey}>
                      {planLabels[tierKey].name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t('Subscription Status', 'সাবস্ক্রিপশন অবস্থা')}
                </label>
                <select
                  value={subscriptionStatus}
                  onChange={(e) => setSubscriptionStatus(e.target.value as SubscriptionStatus)}
                  className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                >
                  {SUBSCRIPTION_STATUS_OPTIONS.map((st) => (
                    <option key={st} value={st}>
                      {statusLabels[st]}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t('Billing Cycle', 'বিলিং চক্র')}
                </label>
                <select
                  value={billingCycle}
                  onChange={(e) => setBillingCycle(e.target.value as BillingCycle)}
                  className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                >
                  {BILLING_CYCLE_OPTIONS.map((bc) => (
                    <option key={bc} value={bc}>
                      {billingLabels[bc]}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t('Patient Limit', 'রোগী সীমা')}
                </label>
                <input
                  type="number"
                  min={1}
                  max={100000}
                  required
                  value={patientLimit}
                  onChange={(e) => setPatientLimit(e.target.value)}
                  className="w-full px-3 py-2 text-xs font-mono tabular-nums bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t('Storage Limit (MB)', 'স্টোরেজ সীমা (MB)')}
                </label>
                <input
                  type="number"
                  min={1}
                  max={100000}
                  required
                  value={storageLimitMb}
                  onChange={(e) => setStorageLimitMb(e.target.value)}
                  className="w-full px-3 py-2 text-xs font-mono tabular-nums bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t(`Fee (${currencySymbol})`, `ফি (${currencySymbol})`)}
                </label>
                <input
                  type="number"
                  min={0}
                  max={100000}
                  step="any"
                  required
                  value={monthlyFeeAmount}
                  onChange={(e) => setMonthlyFeeAmount(e.target.value)}
                  className="w-full px-3 py-2 text-xs font-mono tabular-nums bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t('Hosting Target', 'হোস্টিং সার্ভার')}
                </label>
                <input
                  type="text"
                  maxLength={FIELD_LIMITS.hostingProviderMax}
                  value={hostingProvider}
                  onChange={(e) => setHostingProvider(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {t('Subscription & Client Notes', 'সাবস্ক্রিপশন ও ক্লায়েন্ট নোট')}
              </label>
              <input
                type="text"
                maxLength={FIELD_LIMITS.subscriptionNotesMax}
                value={subscriptionNotes}
                onChange={(e) => setSubscriptionNotes(e.target.value)}
                placeholder={t(
                  'e.g., Free trial until Dec 31, custom domain pending',
                  'যেমন: ডিসেম্বর পর্যন্ত ফ্রি ট্রায়াল, কাস্টম ডোমেইন যুক্ত হবে'
                )}
                className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
              />
            </div>
          </section>

          <div className="pt-4 border-t border-slate-200 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
            >
              {t('Cancel', 'বাতিল')}
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 px-5 py-2 text-xs font-medium text-white bg-teal-700 rounded-lg hover:bg-teal-800 disabled:opacity-60 cursor-pointer"
            >
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {saving
                ? t('Provisioning & Saving...', 'সংরক্ষণ ও সক্রিয় হচ্ছে...')
                : isEditing
                  ? t('Save Clinic Settings', 'ক্লিনিক সেটিংস সংরক্ষণ')
                  : t('Create & Provision Clinic', 'ক্লিনিক তৈরি ও চালু করুন')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
