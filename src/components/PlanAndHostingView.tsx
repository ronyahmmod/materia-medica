import { useState } from 'react';
import {
  Check,
  Copy,
  Database,
  ExternalLink,
  HardDrive,
  Server,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { formatBytes } from '../lib/imageCompressor';
import { type StorageStatsResponse } from '../lib/photoApi';
import {
  ACCENT_THEME_PALETTES,
  buildClinicShareUrl,
  formatReadableClinicUrl,
  SUPER_ADMIN_EMAIL,
} from '../lib/tenantPaths';
import { useLanguage } from '../i18n/LanguageContext';
import {
  BILLING_CYCLE_LABELS_I18N,
  PLAN_LABELS_I18N,
  SUBSCRIPTION_STATUS_LABELS_I18N,
} from '../i18n/translations';
import { PLAN_CATALOG, type ClinicTenant, type PlanTier } from '../types/clinic';

interface PlanAndHostingViewProps {
  clinic: ClinicTenant;
  isSuperAdmin: boolean;
  patientCount: number;
  storageStats: StorageStatsResponse;
  publicBaseUrl?: string;
  onOpenSuperAdminConsole?: () => void;
}

export function PlanAndHostingView({
  clinic,
  isSuperAdmin,
  patientCount,
  storageStats,
  publicBaseUrl,
  onOpenSuperAdminConsole,
}: PlanAndHostingViewProps) {
  const { language, t } = useLanguage();
  const planLabels = PLAN_LABELS_I18N[language];
  const subStatusLabels = SUBSCRIPTION_STATUS_LABELS_I18N[language];
  const billingCycleLabels = BILLING_CYCLE_LABELS_I18N[language];
  const palette = ACCENT_THEME_PALETTES[clinic.accentColor] || ACCENT_THEME_PALETTES.teal;

  const [copiedUrl, setCopiedUrl] = useState(false);

  const shareUrl = buildClinicShareUrl(clinic.slug, publicBaseUrl);
  const readableUrl = formatReadableClinicUrl(clinic.slug, publicBaseUrl);
  const storageLimitBytes = clinic.storageLimitMb * 1024 * 1024;
  const patientRatio = Math.min(100, Math.round((patientCount / Math.max(1, clinic.patientLimit)) * 100));
  const storageRatio = Math.min(
    100,
    Math.round((storageStats.totalBytes / Math.max(1, storageLimitBytes)) * 100)
  );

  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopiedUrl(true);
      window.setTimeout(() => setCopiedUrl(false), 2000);
    } catch {
      // Clipboard fallback ignored cleanly
    }
  };

  const tiers: PlanTier[] = ['free', 'growth', 'clinic_pro'];

  const statusTone =
    clinic.subscriptionStatus === 'active'
      ? 'text-emerald-700'
      : clinic.subscriptionStatus === 'trial'
        ? 'text-amber-700'
        : 'text-red-700';

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
            {t('Subscription, Quotas & Clinic URL', 'সাবস্ক্রিপশন, কোটা ও ক্লিনিক URL')}
          </h1>
          <p className="text-sm text-slate-600 mt-1 max-w-2xl">
            {t(
              'Monitor your clinic patient database quota, compressed photo storage, and dedicated shareable portal link.',
              'আপনার ক্লিনিকের রোগীর ডেটাবেস কোটা, কম্প্রেসড ফটো স্টোরেজ এবং নির্ধারিত শেয়ারযোগ্য পোর্টাল লিংক পর্যবেক্ষণ করুন।'
            )}
          </p>
        </div>

        {isSuperAdmin && onOpenSuperAdminConsole && (
          <button
            type="button"
            onClick={onOpenSuperAdminConsole}
            className={`inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg transition-colors cursor-pointer whitespace-nowrap shrink-0 ${palette.primaryBtn}`}
          >
            <ShieldCheck className="w-3.5 h-3.5" />
            {t('Manage in Super Admin Console', 'সুপার অ্যাডমিন কনসোলে পরিচালনা')}
          </button>
        )}
      </div>

      {/* Shareable Clinic Portal URL & Subscription Summary */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-5 border-b border-slate-200">
          <div className="min-w-0">
            <p className="text-xs font-medium text-slate-500">
              {t('Dedicated Clinic Portal URL', 'নির্ধারিত ক্লিনিক পোর্টাল URL')}
            </p>
            <div className="flex flex-wrap items-center gap-2 mt-1">
              <code
                title={shareUrl}
                className="font-mono text-xs sm:text-sm text-slate-900 bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 break-all"
              >
                {readableUrl}
              </code>
              <button
                type="button"
                onClick={handleCopyUrl}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer whitespace-nowrap"
              >
                {copiedUrl ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-700" />
                    {t('Copied', 'কপি হয়েছে')}
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    {t('Copy URL', 'URL কপি করুন')}
                  </>
                )}
              </button>
              <a
                href={shareUrl}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 whitespace-nowrap"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                {t('Open', 'খুলুন')}
              </a>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-6 text-xs tabular-nums shrink-0">
            <div>
              <p className="text-slate-500">{t('Plan Tier', 'প্ল্যান')}</p>
              <p className="font-semibold text-slate-900 mt-0.5">
                {planLabels[clinic.planTier].name}
              </p>
            </div>
            <div>
              <p className="text-slate-500">{t('Status', 'অবস্থা')}</p>
              <p className={`font-semibold mt-0.5 ${statusTone}`}>
                {subStatusLabels[clinic.subscriptionStatus]}
              </p>
            </div>
            <div>
              <p className="text-slate-500">{t('Billing', 'বিলিং')}</p>
              <p className="font-mono font-semibold text-slate-900 mt-0.5">
                {clinic.monthlyFeeAmount > 0
                  ? `${clinic.currencySymbol}${clinic.monthlyFeeAmount} · ${billingCycleLabels[clinic.billingCycle]}`
                  : billingCycleLabels[clinic.billingCycle]}
              </p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
          <div>
            <p className="text-slate-500">{t('Clinic Name & Branding', 'ক্লিনিকের নাম ও পরিচিতি')}</p>
            <p className="font-medium text-slate-900 mt-0.5">{clinic.clinicName}</p>
            {clinic.tagline && <p className="text-slate-500 mt-0.5">{clinic.tagline}</p>}
          </div>
          <div>
            <p className="text-slate-500">{t('Practitioner & Access', 'চিকিৎসক ও অ্যাক্সেস')}</p>
            <p className="font-medium text-slate-900 mt-0.5">{clinic.practitionerName}</p>
            <p className="font-mono text-slate-500 mt-0.5 truncate">
              {clinic.accessEmails.join(' · ')}
            </p>
          </div>
          <div>
            <p className="text-slate-500">{t('Hosting Environment', 'হোস্টিং পরিবেশ')}</p>
            <p className="font-medium text-slate-900 mt-0.5">
              {clinic.hostingProvider || 'Cloud Run / Render Free Tier'}
            </p>
            <p className="text-slate-500 mt-0.5">
              {t('Currency:', 'মুদ্রা:')} <span className="font-mono">{clinic.currencySymbol}</span>
            </p>
          </div>
        </div>

        {clinic.subscriptionNotes && (
          <div className="pt-3 border-t border-slate-100 text-xs text-slate-600">
            <span className="font-medium text-slate-800">{t('Plan Notes:', 'প্ল্যান নোট:')}</span>{' '}
            {clinic.subscriptionNotes}
          </div>
        )}
      </section>

      {/* Live Capacity Telemetry */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <div className="bg-white border border-slate-200 rounded-xl p-6">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 text-xs font-medium text-slate-600">
              <Database className={`w-4 h-4 ${palette.navIconActive}`} />
              <span>{t('Patient Database Quota', 'রোগী ডেটাবেস কোটা')}</span>
            </div>
            <span className="font-mono text-xs font-semibold text-slate-900 tabular-nums">
              {patientCount} / {clinic.patientLimit} {t('patients', 'জন রোগী')}
            </span>
          </div>
          <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all ${
                patientRatio >= 90 ? 'bg-red-600' : patientRatio >= 75 ? 'bg-amber-600' : palette.barFill
              }`}
              style={{ width: `${patientRatio}%` }}
            />
          </div>
          <p className="text-xs text-slate-500 mt-3 tabular-nums">
            {t(
              `${patientRatio}% utilized on ${planLabels[clinic.planTier].name}. ${Math.max(0, clinic.patientLimit - patientCount)} patient slots remaining.`,
              `${planLabels[clinic.planTier].name}-এ ${patientRatio}% ব্যবহৃত হয়েছে। আরও ${Math.max(0, clinic.patientLimit - patientCount)} জন রোগীর জায়গা বাকি আছে।`
            )}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-6">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 text-xs font-medium text-slate-600">
              <HardDrive className={`w-4 h-4 ${palette.navIconActive}`} />
              <span>{t('Photo Upload Server Storage', 'ফটো আপলোড সার্ভার স্টোরেজ')}</span>
            </div>
            <span className="font-mono text-xs font-semibold text-slate-900 tabular-nums">
              {formatBytes(storageStats.totalBytes)} / {clinic.storageLimitMb} MB
            </span>
          </div>
          <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all ${
                storageRatio >= 90 ? 'bg-red-600' : storageRatio >= 75 ? 'bg-amber-600' : palette.barFill
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
            {t('Platform Practice Plans', 'প্ল্যাটফর্ম প্র্যাকটিস প্ল্যানসমূহ')}
          </h2>
          {!isSuperAdmin && (
            <span className="text-xs text-slate-500">
              {t(
                `Managed by platform admin (${SUPER_ADMIN_EMAIL})`,
                `প্ল্যাটফর্ম অ্যাডমিন দ্বারা পরিচালিত (${SUPER_ADMIN_EMAIL})`
              )}
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {tiers.map((tierKey) => {
            const plan = PLAN_CATALOG[tierKey];
            const localized = planLabels[tierKey];
            const isCurrent = clinic.planTier === tierKey;

            return (
              <div
                key={tierKey}
                className={`bg-white rounded-xl p-6 flex flex-col justify-between border ${
                  isCurrent ? palette.ringSelected : 'border-slate-200'
                }`}
              >
                <div>
                  <p className={`text-xs font-medium ${palette.accentText}`}>{localized.audience}</p>
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
                    <div
                      className={`w-full py-2 px-4 text-xs font-medium border rounded-lg flex items-center justify-center gap-1.5 ${palette.softPanel}`}
                    >
                      <Check className="w-3.5 h-3.5" />
                      {t('Active Clinic Plan', 'সক্রিয় ক্লিনিক প্ল্যান')}
                    </div>
                  ) : isSuperAdmin && onOpenSuperAdminConsole ? (
                    <button
                      type="button"
                      onClick={onOpenSuperAdminConsole}
                      className="w-full py-2 px-4 text-xs font-medium text-slate-800 bg-slate-100 border border-slate-200 rounded-lg hover:bg-slate-200 transition-colors cursor-pointer whitespace-nowrap"
                    >
                      {t('Switch in Super Admin', 'সুপার অ্যাডমিনে পরিবর্তন করুন')}
                    </button>
                  ) : (
                    <div className="w-full py-2 px-4 text-xs text-center text-slate-500 bg-slate-50 border border-slate-200 rounded-lg">
                      {t('Contact platform admin to upgrade', 'আপগ্রেডের জন্য অ্যাডমিনের সাথে যোগাযোগ করুন')}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Free-Tier Infrastructure Breakdown */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Server className={`w-4 h-4 ${palette.navIconActive}`} />
            <h2 className="font-display text-base font-semibold text-slate-900">
              {t('Isolated Tenant Architecture (Free-Tier Ready)', 'আইসোলেটেড টেন্যান্ট আর্কিটেকচার (ফ্রি-টিয়ার উপযোগী)')}
            </h2>
          </div>
          <Sparkles className={`w-4 h-4 ${palette.navIconActive}`} />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs text-slate-600 leading-relaxed">
          <p>
            <span className="font-semibold text-slate-900">
              {t('1. Strict Clinic Isolation:', '১. সম্পূর্ণ ক্লিনিক আইসোলেশন:')}
            </span>{' '}
            {t(
              'All patients, consultations, clinical notes, cash fee ledgers, and photos are stored strictly under your dedicated clinic workspace and locked to authorized practitioner emails.',
              'সব রোগী, কনসাল্টেশন, ক্লিনিক্যাল নোট, নগদ ফি হিসাব এবং ছবি সম্পূর্ণ আলাদা ক্লিনিক ওয়ার্কস্পেসে অনুমোদিত চিকিৎসকের ইমেইলে সুরক্ষিত থাকে।'
            )}
          </p>
          <p>
            <span className="font-semibold text-slate-900">
              {t('2. Compressed Photo Disk Server:', '২. কম্প্রেসড ফটো ডিস্ক সার্ভার:')}
            </span>{' '}
            {t(
              'Clinical images are automatically resized and converted to WebP in the browser before uploading to your tenant directory, keeping storage lightweight.',
              'ক্লিনিক্যাল ছবিগুলো আপলোডের আগে ব্রাউজারেই WebP ফরম্যাটে ছোট হয়ে যায়, ফলে স্টোরেজ খরচ সর্বনিম্ন থাকে।'
            )}
          </p>
        </div>
      </section>
    </div>
  );
}
