import { useState, type FormEvent } from 'react';
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { Check, Database, HardDrive, Server } from 'lucide-react';
import { auth, db, handleFirestoreError, OperationType } from '../firebase';
import { formatBytes } from '../lib/imageCompressor';
import { type StorageStatsResponse } from '../lib/photoApi';
import { useLanguage } from '../i18n/LanguageContext';
import { PLAN_LABELS_I18N } from '../i18n/translations';
import {
  PLAN_CATALOG,
  type ClinicSettings,
  type PlanTier,
} from '../types/clinic';

interface PlanAndHostingViewProps {
  settings: ClinicSettings;
  patientCount: number;
  storageStats: StorageStatsResponse;
}

export function PlanAndHostingView({
  settings,
  patientCount,
  storageStats,
}: PlanAndHostingViewProps) {
  const { language, t } = useLanguage();
  const planLabels = PLAN_LABELS_I18N[language];

  const [clinicName, setClinicName] = useState(settings.clinicName);
  const [practitionerName, setPractitionerName] = useState(settings.practitionerName);
  const [hostingProvider, setHostingProvider] = useState(
    settings.hostingProvider || 'Cloud Run / Render Free Tier'
  );
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingTier, setSavingTier] = useState<PlanTier | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  const storageLimitBytes = settings.storageLimitMb * 1024 * 1024;
  const patientRatio = Math.min(100, Math.round((patientCount / settings.patientLimit) * 100));
  const storageRatio = Math.min(
    100,
    Math.round((storageStats.totalBytes / Math.max(1, storageLimitBytes)) * 100)
  );

  const persistSettings = async (next: {
    clinicName: string;
    practitionerName: string;
    planTier: PlanTier;
    patientLimit: number;
    storageLimitMb: number;
    hostingProvider: string;
  }) => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    try {
      await setDoc(doc(db, 'clinic_settings', 'subscription'), {
        clinicName: next.clinicName.trim().slice(0, 160) || 'Materia Medica Clinic',
        practitionerName: next.practitionerName.trim().slice(0, 120) || 'Admin Practitioner',
        planTier: next.planTier,
        patientLimit: next.patientLimit,
        storageLimitMb: next.storageLimitMb,
        hostingProvider: next.hostingProvider.trim().slice(0, 120),
        updatedBy: uid,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'clinic_settings/subscription');
    }
  };

  const handleSaveProfile = async (e: FormEvent) => {
    e.preventDefault();
    setSavingProfile(true);
    setSavedNotice(null);
    await persistSettings({
      clinicName,
      practitionerName,
      planTier: settings.planTier,
      patientLimit: settings.patientLimit,
      storageLimitMb: settings.storageLimitMb,
      hostingProvider,
    });
    setSavingProfile(false);
    setSavedNotice(t('Clinic profile saved.', 'ক্লিনিক প্রোফাইল সংরক্ষিত হয়েছে।'));
  };

  const handleSelectPlan = async (tier: PlanTier) => {
    const plan = PLAN_CATALOG[tier];
    const localizedPlan = planLabels[tier];
    setSavingTier(tier);
    setSavedNotice(null);
    await persistSettings({
      clinicName,
      practitionerName,
      planTier: plan.tier,
      patientLimit: plan.patientLimit,
      storageLimitMb: plan.storageLimitMb,
      hostingProvider,
    });
    setSavingTier(null);
    setSavedNotice(
      t(
        `Active clinic plan updated to ${localizedPlan.name}.`,
        `সক্রিয় ক্লিনিক প্ল্যান ${localizedPlan.name}-এ হালনাগাদ করা হয়েছে।`
      )
    );
  };

  const tiers: PlanTier[] = ['free', 'growth', 'clinic_pro'];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
          {t('Clinic Plan & Free-Tier Hosting', 'ক্লিনিক প্ল্যান ও ফ্রি-টিয়ার হোস্টিং')}
        </h1>
        <p className="text-sm text-slate-600 mt-1 max-w-2xl">
          {t(
            'Operate your practice at $0/month on the Starter Free Tier. Monitor patient count and compressed photo server storage, and subscribe to a higher tier when patient volume grows.',
            'স্টার্টার ফ্রি টিয়ারে প্রতি মাসে $০ খরচে আপনার চেম্বার পরিচালনা করুন। রোগীর সংখ্যা ও কম্প্রেসড ফটো সার্ভার স্টোরেজ পর্যবেক্ষণ করুন এবং রোগীর সংখ্যা বাড়লে উচ্চতর প্ল্যানে সাবস্ক্রাইব করুন।'
          )}
        </p>
      </div>

      {/* Live Capacity Telemetry */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <div className="bg-white border border-slate-200 rounded-xl p-6">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 text-xs font-medium text-slate-600">
              <Database className="w-4 h-4 text-teal-700" />
              <span>{t('Patient Database Quota', 'রোগী ডেটাবেস কোটা')}</span>
            </div>
            <span className="font-mono text-xs font-semibold text-slate-900 tabular-nums">
              {patientCount} / {settings.patientLimit} {t('patients', 'জন রোগী')}
            </span>
          </div>
          <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all ${
                patientRatio >= 90 ? 'bg-red-600' : patientRatio >= 75 ? 'bg-amber-600' : 'bg-teal-700'
              }`}
              style={{ width: `${patientRatio}%` }}
            />
          </div>
          <p className="text-xs text-slate-500 mt-3 tabular-nums">
            {t(
              `${patientRatio}% utilized on ${planLabels[settings.planTier].name}. ${Math.max(0, settings.patientLimit - patientCount)} patient slots remaining.`,
              `${planLabels[settings.planTier].name}-এ ${patientRatio}% ব্যবহৃত হয়েছে। আরও ${Math.max(0, settings.patientLimit - patientCount)} জন রোগীর জায়গা বাকি আছে।`
            )}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-6">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 text-xs font-medium text-slate-600">
              <HardDrive className="w-4 h-4 text-teal-700" />
              <span>{t('Photo Upload Server Storage', 'ফটো আপলোড সার্ভার স্টোরেজ')}</span>
            </div>
            <span className="font-mono text-xs font-semibold text-slate-900 tabular-nums">
              {formatBytes(storageStats.totalBytes)} / {settings.storageLimitMb} MB
            </span>
          </div>
          <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all ${
                storageRatio >= 90 ? 'bg-red-600' : storageRatio >= 75 ? 'bg-amber-600' : 'bg-teal-700'
              }`}
              style={{ width: `${Math.max(storageStats.totalBytes > 0 ? 2 : 0, storageRatio)}%` }}
            />
          </div>
          <p className="text-xs text-slate-500 mt-3 tabular-nums">
            {t(
              `${storageStats.totalFiles} clinical images stored · Client-side WebP compression active.`,
              `${storageStats.totalFiles}টি ক্লিনিক্যাল ছবি সংরক্ষিত · ব্রাউজার-সাইড WebP কম্প্রেশন সক্রিয়।`
            )}
          </p>
        </div>
      </div>

      {/* Subscription Tier Comparison */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-lg font-semibold text-slate-900">
            {t('Practice Scaling Plans', 'প্র্যাকটিস স্কেলিং প্ল্যানসমূহ')}
          </h2>
          {savedNotice && (
            <span className="text-xs font-medium text-teal-800">{savedNotice}</span>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {tiers.map((tierKey) => {
            const plan = PLAN_CATALOG[tierKey];
            const localized = planLabels[tierKey];
            const isCurrent = settings.planTier === tierKey;

            return (
              <div
                key={tierKey}
                className={`bg-white rounded-xl p-6 flex flex-col justify-between border ${
                  isCurrent ? 'border-teal-700 ring-1 ring-teal-700/20' : 'border-slate-200'
                }`}
              >
                <div>
                  <p className="text-xs font-medium text-teal-800">{localized.audience}</p>
                  <div className="flex items-baseline justify-between gap-2 mt-1.5">
                    <h3 className="font-display text-lg font-semibold text-slate-900">
                      {localized.name}
                    </h3>
                    <span className="font-mono text-sm font-semibold text-slate-900 tabular-nums">
                      {localized.monthlyPriceLabel}
                    </span>
                  </div>

                  <dl className="mt-5 pt-4 border-t border-slate-200 space-y-2.5 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-slate-500">{t('Patient Capacity', 'রোগী ধারণক্ষমতা')}</dt>
                      <dd className="font-mono font-medium text-slate-900 tabular-nums">
                        {t('Up to', 'সর্বোচ্চ')} {plan.patientLimit.toLocaleString()}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-slate-500">{t('Photo Storage', 'ফটো স্টোরেজ')}</dt>
                      <dd className="font-mono font-medium text-slate-900 tabular-nums">
                        {plan.storageLimitMb >= 1024
                          ? `${plan.storageLimitMb / 1024} GB`
                          : `${plan.storageLimitMb} MB`}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-slate-500">{t('Database Tier', 'ডেটাবেস টিয়ার')}</dt>
                      <dd className="text-slate-800 text-right">{localized.databaseTier}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-slate-500">{t('Photo Server', 'ফটো সার্ভার')}</dt>
                      <dd className="text-slate-800 text-right">{localized.photoStorageTier}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-slate-500">{t('Backups', 'ব্যাকআপ')}</dt>
                      <dd className="text-slate-800 text-right">{localized.backupPolicy}</dd>
                    </div>
                  </dl>
                </div>

                <div className="mt-6 pt-4 border-t border-slate-100">
                  {isCurrent ? (
                    <div className="w-full py-2 px-4 text-xs font-medium text-teal-800 bg-teal-50 border border-teal-200 rounded-lg flex items-center justify-center gap-1.5">
                      <Check className="w-3.5 h-3.5" />
                      {t('Active Practice Plan', 'সক্রিয় প্র্যাকটিস প্ল্যান')}
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={savingTier !== null}
                      onClick={() => handleSelectPlan(tierKey)}
                      className="w-full py-2 px-4 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
                    >
                      {savingTier === tierKey
                        ? t('Updating Plan...', 'প্ল্যান হালনাগাদ হচ্ছে...')
                        : tierKey === 'free'
                          ? t('Switch to Free Tier', 'ফ্রি টিয়ারে ফিরুন')
                          : t(`Subscribe to ${localized.name}`, `${localized.name}-এ সাবস্ক্রাইব করুন`)}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Clinic Profile & Free-Tier Hosting Blueprint */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <form
          onSubmit={handleSaveProfile}
          className="lg:col-span-6 bg-white border border-slate-200 rounded-xl p-6 space-y-4"
        >
          <h2 className="font-display text-base font-semibold text-slate-900">
            {t('Clinic Identity & Host Configuration', 'ক্লিনিক পরিচিতি ও হোস্ট কনফিগারেশন')}
          </h2>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              {t('Clinic Name', 'ক্লিনিকের নাম')}
            </label>
            <input
              type="text"
              required
              maxLength={160}
              value={clinicName}
              onChange={(e) => setClinicName(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              {t('Primary Homeopath / Admin Name', 'প্রধান হোমিওপ্যাথ / অ্যাডমিনের নাম')}
            </label>
            <input
              type="text"
              required
              maxLength={120}
              value={practitionerName}
              onChange={(e) => setPractitionerName(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              {t('Free-Tier Host Target', 'ফ্রি-টিয়ার হোস্ট প্ল্যাটফর্ম')}
            </label>
            <input
              type="text"
              maxLength={120}
              value={hostingProvider}
              onChange={(e) => setHostingProvider(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
            />
          </div>
          <div className="pt-2">
            <button
              type="submit"
              disabled={savingProfile}
              className="px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-lg hover:bg-teal-800 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
            >
              {savingProfile
                ? t('Saving...', 'সংরক্ষণ হচ্ছে...')
                : t('Save Clinic Settings', 'ক্লিনিক সেটিংস সংরক্ষণ করুন')}
            </button>
          </div>
        </form>

        <div className="lg:col-span-6 bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div className="flex items-center gap-2">
            <Server className="w-4 h-4 text-teal-700" />
            <h2 className="font-display text-base font-semibold text-slate-900">
              {t('Free-Tier Stack Breakdown', 'ফ্রি-টিয়ার প্রযুক্তি কাঠামো')}
            </h2>
          </div>
          <div className="space-y-3 text-xs text-slate-600 leading-relaxed">
            <p>
              <span className="font-semibold text-slate-900">
                {t('1. Admin-Only Authentication:', '১. শুধু অ্যাডমিন প্রমাণীকরণ:')}
              </span>{' '}
              {t(
                'Firebase Google Sign-In (free tier) restricts all data reads and writes to verified practitioner emails. Patients never log in.',
                'ফায়ারবেজ গুগল সাইন-ইন (ফ্রি টিয়ার) কেবল অনুমোদিত চিকিৎসকের ইমেইল থেকেই ডেটা দেখা ও সম্পাদনার অনুমতি দেয়। রোগীরা লগইন করে না।'
              )}
            </p>
            <p>
              <span className="font-semibold text-slate-900">
                {t('2. Clinical Database:', '২. ক্লিনিক্যাল ডেটাবেস:')}
              </span>{' '}
              {t(
                'Cloud Firestore Spark plan stores patient records, constitutional histories, and consultation prescriptions with zero monthly base cost.',
                'ক্লাউড ফায়ারস্টোর স্পার্ক প্ল্যানে মাসিক কোনো ফিক্সড খরচ ছাড়াই রোগীর রেকর্ড, ধাতুগত ইতিহাস ও কনসাল্টেশন প্রেসক্রিপশন সংরক্ষিত থাকে।'
              )}
            </p>
            <p>
              <span className="font-semibold text-slate-900">
                {t('3. Photo Upload Server:', '৩. ফটো আপলোড সার্ভার:')}
              </span>{' '}
              {t(
                'Your Express backend verifies your Firebase ID token, validates JPEG/PNG/WebP image headers, and saves client-compressed WebP photos to disk—avoiding paid cloud bucket fees on the free tier.',
                'আপনার এক্সপ্রেস ব্যাকএন্ড ফায়ারবেজ আইডি টোকেন যাচাই করে, ছবির ফরম্যাট নিশ্চিত করে এবং ক্লায়েন্ট-কম্প্রেসড WebP ছবি ডিস্কে সংরক্ষণ করে—ফ্রি টিয়ারে বাড়তি ক্লাউড স্টোরেজ খরচ এড়িয়ে।'
              )}
            </p>
            <p>
              <span className="font-semibold text-slate-900">
                {t('4. Free-Tier Hosting & Scaling:', '৪. ফ্রি-টিয়ার হোস্টিং ও স্কেলিং:')}
              </span>{' '}
              {t(
                'Build with npm run build and deploy with npm start on Cloud Run, Render, or Railway free tier. When your clinic passes 50 patients, upgrade above to unlock higher limits and automated object storage.',
                'npm run build দিয়ে বিল্ড করে Cloud Run, Render বা Railway ফ্রি টিয়ারে npm start-এ ডিপ্লয় করুন। আপনার ক্লিনিকে ৫০ জন রোগী অতিক্রম করলে উপরের প্ল্যান থেকে সহজেই আপগ্রেড করতে পারবেন।'
              )}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
