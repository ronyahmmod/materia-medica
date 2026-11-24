import { useState, type FormEvent } from 'react';
import {
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import {
  AlertCircle,
  ArrowRight,
  Eye,
  EyeOff,
  Lock,
  LogOut,
  Mail,
  PauseCircle,
  ShieldCheck,
} from 'lucide-react';
import { auth, googleProvider } from '../firebase';
import { LanguageSwitcher, useLanguage } from '../i18n/LanguageContext';
import { ACCENT_THEME_PALETTES, SUPER_ADMIN_EMAIL } from '../lib/tenantPaths';
import type { ClinicPublicProfile } from '../types/clinic';

interface AdminSignInViewProps {
  unauthorizedUser: User | null;
  superAdminSessionEmail?: string | null;
  publicClinic?: ClinicPublicProfile | null;
  loadingSlug?: boolean;
  slugNotFound?: boolean;
  requestedSlug?: string | null;
  isRootPortal?: boolean;
  accessDeniedReason?: string | null;
}

export function AdminSignInView({
  unauthorizedUser,
  superAdminSessionEmail = null,
  publicClinic,
  loadingSlug = false,
  slugNotFound = false,
  requestedSlug,
  isRootPortal = false,
  accessDeniedReason,
}: AdminSignInViewProps) {
  const { t } = useLanguage();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [googleSigningIn, setGoogleSigningIn] = useState(false);
  const [showSuperAdminPanel, setShowSuperAdminPanel] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const palette = publicClinic
    ? ACCENT_THEME_PALETTES[publicClinic.accentColor] || ACCENT_THEME_PALETTES.teal
    : ACCENT_THEME_PALETTES.teal;

  const isSuspendedClinic = publicClinic?.subscriptionStatus === 'suspended';
  const showSuperAdminOption = isRootPortal && !publicClinic && !requestedSlug;

  const mapAuthError = (error: unknown): string => {
    const code = (error as { code?: string })?.code || '';
    switch (code) {
      case 'auth/invalid-credential':
      case 'auth/wrong-password':
      case 'auth/user-not-found':
        return t(
          'Invalid clinic email or password. Contact your Super Admin if you need a password reset.',
          'ইমেইল বা পাসওয়ার্ড সঠিক নয়। পাসওয়ার্ড রিসেটের জন্য সুপার অ্যাডমিনের সাথে যোগাযোগ করুন।'
        );
      case 'auth/invalid-email':
        return t(
          'Please enter a valid email address.',
          'অনুগ্রহ করে একটি সঠিক ইমেইল ঠিকানা লিখুন।'
        );
      case 'auth/user-disabled':
        return t(
          'This clinic login account has been disabled by the administrator.',
          'অ্যাডমিন দ্বারা এই ক্লিনিক লগইন অ্যাকাউন্টটি নিষ্ক্রিয় করা হয়েছে।'
        );
      case 'auth/operation-not-allowed':
        return t(
          'Email & Password sign-in is not yet enabled in Firebase Console -> Authentication -> Sign-in method.',
          'Firebase Console -> Authentication -> Sign-in method থেকে Email/Password লগইন এখনো চালু করা হয়নি।'
        );
      case 'auth/too-many-requests':
        return t(
          'Too many failed sign-in attempts. Please wait a minute and try again.',
          'অনেকবার ভুল চেষ্টা হয়েছে। অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন।'
        );
      case 'auth/network-request-failed':
        return t(
          'Network error while connecting to authentication service.',
          'অথেনটিকেশন সার্ভারে সংযোগ পেতে নেটওয়ার্ক সমস্যা হয়েছে।'
        );
      default:
        return error instanceof Error
          ? error.message
          : t('Unable to sign in. Please try again.', 'সাইন ইন করা যায়নি। অনুগ্রহ করে আবার চেষ্টা করুন।');
    }
  };

  const handleEmailPasswordSignIn = async (e: FormEvent) => {
    e.preventDefault();
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !password) {
      setErrorMessage(
        t(
          'Enter both your assigned clinic email and password.',
          'আপনার নির্ধারিত ক্লিনিক ইমেইল এবং পাসওয়ার্ড লিখুন।'
        )
      );
      return;
    }

    setSigningIn(true);
    setErrorMessage(null);
    try {
      await signInWithEmailAndPassword(auth, cleanEmail, password);
    } catch (error) {
      setErrorMessage(mapAuthError(error));
    } finally {
      setSigningIn(false);
    }
  };

  const handleSuperAdminGoogleSignIn = async () => {
    setGoogleSigningIn(true);
    setErrorMessage(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : t('Unable to complete Super Admin sign-in.', 'সুপার অ্যাডমিন সাইন-ইন সম্পন্ন করা যায়নি।')
      );
    } finally {
      setGoogleSigningIn(false);
    }
  };

  const handleSignOut = async () => {
    setErrorMessage(null);
    await signOut(auth);
  };

  const headerClinicName = publicClinic
    ? publicClinic.clinicName
    : t('Materia Medica Clinic', 'মেটেরিয়া মেডিকা ক্লিনিক');

  const subtitleLabel = publicClinic
    ? `${publicClinic.practitionerName} · ${t('Assigned Clinic Portal', 'নির্ধারিত ক্লিনিক পোর্টাল')}`
    : t('Multi-Clinic Homeopathy Workspace', 'মাল্টি-ক্লিনিক হোমিওপ্যাথি ওয়ার্কস্পেস');

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center px-6 py-12">
      <div className="max-w-5xl w-full mx-auto bg-white border border-slate-200 rounded-xl overflow-hidden grid grid-cols-1 lg:grid-cols-12 items-stretch">
        <div className="lg:col-span-6 p-8 sm:p-12 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between gap-3 mb-9">
              <div className="flex items-center gap-2.5 min-w-0">
                <img
                  src="/clinic-icon.svg"
                  alt=""
                  width={28}
                  height={28}
                  className="w-7 h-7 rounded-md shrink-0"
                />
                <span className="font-display text-lg font-bold tracking-tight text-slate-900 truncate">
                  {headerClinicName}
                </span>
              </div>
              <LanguageSwitcher />
            </div>

            {loadingSlug ? (
              <div className="py-10 space-y-3">
                <div className="h-4 w-40 bg-slate-100 rounded" />
                <div className="h-8 w-3/4 bg-slate-100 rounded" />
                <div className="h-16 w-full bg-slate-100 rounded" />
              </div>
            ) : (
              <>
                <p className={`text-xs font-medium mb-3 ${palette.accentText}`}>
                  {subtitleLabel}
                </p>

                <h1 className="font-display text-3xl sm:text-4xl font-semibold text-slate-900 tracking-tight leading-tight text-balance mb-4">
                  {publicClinic
                    ? publicClinic.tagline ||
                      t(
                        'Constitutional case records, clinical photos, and cash ledger',
                        'কনস্টিটিউশনাল কেস রেকর্ড, ক্লিনিক্যাল ছবি এবং নগদ হিসাব'
                      )
                    : t(
                        'Constitutional case records and multi-clinic SaaS workspace',
                        'কনস্টিটিউশনাল কেস রেকর্ড এবং মাল্টি-ক্লিনিক SaaS ওয়ার্কস্পেস'
                      )}
                </h1>

                <p className="text-sm text-slate-600 leading-relaxed mb-7 max-w-md">
                  {publicClinic
                    ? t(
                        `Sign in using the Email & Password assigned by the administrator for ${publicClinic.clinicName}.`,
                        `${publicClinic.clinicName}-এ প্রবেশ করতে সুপার অ্যাডমিনের নির্ধারিত ইমেইল ও পাসওয়ার্ড ব্যবহার করে সাইন ইন করুন।`
                      )
                    : t(
                        'Sign in with the clinic Email & Password assigned by your administrator to open your isolated workspace.',
                        'আপনার নির্ধারিত ক্লিনিক ওয়ার্কস্পেস খুলতে অ্যাডমিনের দেওয়া ইমেইল ও পাসওয়ার্ড দিয়ে সাইন ইন করুন।'
                      )}
                </p>

                {slugNotFound && requestedSlug && (
                  <div className="border border-amber-200 bg-amber-50/80 rounded-lg p-4 mb-6 flex items-start gap-2.5">
                    <AlertCircle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                    <div className="text-xs text-amber-900 leading-relaxed">
                      <p className="font-semibold">
                        {t('Clinic link not found', 'ক্লিনিক লিংক পাওয়া যায়নি')}
                      </p>
                      <p className="mt-0.5">
                        {t(
                          `No active clinic workspace matched "${requestedSlug}". You can still sign in below with your assigned credentials.`,
                          `"${requestedSlug}" নামে কোনো ক্লিনিক পাওয়া যায়নি। অনুমোদিত ইমেইল ও পাসওয়ার্ড দিয়ে নিচে সাইন ইন করতে পারেন।`
                        )}
                      </p>
                    </div>
                  </div>
                )}

                {isSuspendedClinic && (
                  <div className="border border-amber-200 bg-amber-50/80 rounded-lg p-4 mb-6 flex items-start gap-2.5">
                    <PauseCircle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                    <div className="text-xs text-amber-900 leading-relaxed">
                      <p className="font-semibold">
                        {t('Clinic Subscription Paused', 'ক্লিনিক সাবস্ক্রিপশন সাময়িক স্থগিত')}
                      </p>
                      <p className="mt-0.5">
                        {t(
                          `This clinic workspace is currently suspended. Contact platform admin (${SUPER_ADMIN_EMAIL}) to reactivate access.`,
                          `এই ক্লিনিক ওয়ার্কস্পেসটি বর্তমানে স্থগিত আছে। পুনরায় চালু করতে অ্যাডমিনের (${SUPER_ADMIN_EMAIL}) সাথে যোগাযোগ করুন।`
                        )}
                      </p>
                    </div>
                  </div>
                )}

                {superAdminSessionEmail && !unauthorizedUser && (
                  <div className="border border-slate-200 bg-slate-50 rounded-lg p-4 mb-6 max-w-md space-y-2">
                    <p className="text-xs text-slate-700 leading-relaxed">
                      {t(
                        `Browser has an active Super Admin session (${superAdminSessionEmail}), which cannot bypass a client clinic URL. Enter this clinic's Email & Password below to sign into the client portal.`,
                        `ব্রাউজারে সুপার অ্যাডমিন সেশন (${superAdminSessionEmail}) চালু থাকলেও ক্লায়েন্ট URL-এ সরাসরি প্রবেশ করা যাবে না। ক্লায়েন্ট পোর্টালে ঢুকতে নিচে ক্লিনিকের ইমেইল ও পাসওয়ার্ড দিন।`
                      )}
                    </p>
                    <a
                      href="/"
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-teal-800 hover:underline"
                    >
                      <ShieldCheck className="w-3.5 h-3.5" />
                      <span>
                        {t('Return to Super Admin Console', 'সুপার অ্যাডমিন কনসোলে ফিরুন')}
                      </span>
                    </a>
                  </div>
                )}

                {unauthorizedUser ? (
                  <div className="border border-red-200 bg-red-50/70 rounded-lg p-4 mb-6">
                    <p className="text-sm font-medium text-red-900 mb-1">
                      {t('Clinic Access Restricted', 'ক্লিনিক অ্যাক্সেস সীমাবদ্ধ')}
                    </p>
                    <p className="text-xs text-red-800 leading-relaxed mb-3">
                      {t('Signed in as', 'সাইন ইন করা হয়েছে')}{' '}
                      <span className="font-mono">{unauthorizedUser.email}</span>.{' '}
                      {accessDeniedReason ||
                        t(
                          'This account is not authorized for this clinic workspace. Sign out and log in with your assigned clinic email and password.',
                          'এই অ্যাকাউন্টটি এই ক্লিনিক ওয়ার্কস্পেসের জন্য অনুমোদিত নয়। সাইন আউট করে নির্ধারিত ক্লিনিক ইমেইল ও পাসওয়ার্ড দিয়ে লগইন করুন।'
                        )}
                    </p>
                    <button
                      type="button"
                      onClick={handleSignOut}
                      className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-red-900 bg-white border border-red-300 rounded-lg hover:bg-red-50 transition-colors cursor-pointer whitespace-nowrap"
                    >
                      <LogOut className="w-3.5 h-3.5" />
                      {t('Sign out and switch account', 'সাইন আউট ও অ্যাকাউন্ট পরিবর্তন')}
                    </button>
                  </div>
                ) : (
                  <form onSubmit={handleEmailPasswordSignIn} className="space-y-4 max-w-md">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1.5">
                        {t('Assigned Clinic Email', 'নির্ধারিত ক্লিনিক ইমেইল')}
                      </label>
                      <div className="relative">
                        <Mail className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                        <input
                          type="email"
                          required
                          autoComplete="email"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          placeholder="clinic-admin@example.com"
                          className="w-full pl-9 pr-3 py-2.5 text-sm font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1.5">
                        {t('Password', 'পাসওয়ার্ড')}
                      </label>
                      <div className="relative">
                        <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                        <input
                          type={showPassword ? 'text' : 'password'}
                          required
                          autoComplete="current-password"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          placeholder="••••••••••••"
                          className="w-full pl-9 pr-10 py-2.5 text-sm font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword((prev) => !prev)}
                          aria-label={showPassword ? 'Hide password' : 'Show password'}
                          className="p-1 text-slate-400 hover:text-slate-700 absolute right-2.5 top-1/2 -translate-y-1/2 cursor-pointer"
                        >
                          {showPassword ? (
                            <EyeOff className="w-4 h-4" />
                          ) : (
                            <Eye className="w-4 h-4" />
                          )}
                        </button>
                      </div>
                    </div>

                    <button
                      type="submit"
                      disabled={signingIn || googleSigningIn}
                      className={`w-full inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-medium rounded-lg disabled:opacity-60 transition-colors cursor-pointer whitespace-nowrap ${palette.primaryBtn}`}
                    >
                      <span>
                        {signingIn
                          ? t('Verifying Credentials...', 'তথ্য যাচাই হচ্ছে...')
                          : publicClinic
                            ? t(
                                `Sign in to ${publicClinic.clinicName}`,
                                `${publicClinic.clinicName}-এ সাইন ইন`
                              )
                            : t('Sign in to Clinic Workspace', 'ক্লিনিক ওয়ার্কস্পেসে সাইন ইন')}
                      </span>
                      <ArrowRight className="w-4 h-4" />
                    </button>
                  </form>
                )}

                {errorMessage && (
                  <div
                    className="mt-4 max-w-md border border-red-200 bg-red-50/70 rounded-lg p-3 text-xs text-red-800"
                    role="alert"
                  >
                    {errorMessage}
                  </div>
                )}

                {/* Super Admin Login Toggle — Strictly hidden on all client clinic URLs */}
                {showSuperAdminOption && !unauthorizedUser && (
                  <div className="mt-6 pt-5 border-t border-slate-200 max-w-md">
                    {!showSuperAdminPanel ? (
                      <button
                        type="button"
                        onClick={() => setShowSuperAdminPanel(true)}
                        className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-900 cursor-pointer"
                      >
                        <ShieldCheck className="w-3.5 h-3.5" />
                        <span>{t('Platform Super Admin Access', 'প্ল্যাটফর্ম সুপার অ্যাডমিন প্রবেশ')}</span>
                      </button>
                    ) : (
                      <div className="space-y-2.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-medium text-slate-700 flex items-center gap-1.5">
                            <ShieldCheck className="w-3.5 h-3.5 text-teal-700" />
                            {t('Super Admin Console Login', 'সুপার অ্যাডমিন কনসোল লগইন')}
                          </span>
                          <button
                            type="button"
                            onClick={() => setShowSuperAdminPanel(false)}
                            className="text-slate-400 hover:text-slate-700 cursor-pointer"
                          >
                            {t('Hide', 'লুকান')}
                          </button>
                        </div>
                        <button
                          type="button"
                          onClick={handleSuperAdminGoogleSignIn}
                          disabled={googleSigningIn || signingIn}
                          className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium text-slate-800 bg-slate-100 border border-slate-300 rounded-lg hover:bg-slate-200 disabled:opacity-60 transition-colors cursor-pointer"
                        >
                          <ShieldCheck className="w-3.5 h-3.5 text-teal-700" />
                          <span>
                            {googleSigningIn
                              ? t('Verifying Super Admin...', 'সুপার অ্যাডমিন যাচাই হচ্ছে...')
                              : t(
                                  'Sign in as Platform Super Admin',
                                  'প্ল্যাটফর্ম সুপার অ্যাডমিন হিসেবে সাইন ইন'
                                )}
                          </span>
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="pt-8 mt-10 border-t border-slate-200 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
            <span>{t('Admin-assigned credentials', 'অ্যাডমিন নির্ধারিত লগইন')}</span>
            <span aria-hidden="true">·</span>
            <span>{t('Isolated tenant database', 'সম্পূর্ণ আলাদা ক্লিনিক ডেটাবেস')}</span>
            <span aria-hidden="true">·</span>
            <span>{t('Custom clinic URL', 'কাস্টম ক্লিনিক URL')}</span>
          </div>
        </div>

        <div className="lg:col-span-6 bg-slate-100 relative min-h-[320px]">
          <img
            src="/src/assets/images/hero_apothecary_clinic_1795222751094.jpg"
            alt={t(
              'Homeopathic apothecary remedies and clinical case ledger on consultation desk',
              'কনসালটেশন ডেস্কে হোমিওপ্যাথিক রেমেডি ও কেস লেজার'
            )}
            referrerPolicy="no-referrer"
            className="w-full h-full object-cover"
          />
        </div>
      </div>
    </div>
  );
}
