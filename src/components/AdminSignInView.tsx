import { useState } from 'react';
import { signInWithPopup, signOut, type User } from 'firebase/auth';
import { ShieldCheck, LogOut, ArrowRight } from 'lucide-react';
import { auth, googleProvider } from '../firebase';
import { LanguageSwitcher, useLanguage } from '../i18n/LanguageContext';

interface AdminSignInViewProps {
  unauthorizedUser: User | null;
}

export function AdminSignInView({ unauthorizedUser }: AdminSignInViewProps) {
  const { t } = useLanguage();
  const [signingIn, setSigningIn] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSignIn = async () => {
    setSigningIn(true);
    setErrorMessage(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      const msg =
        error instanceof Error
          ? error.message
          : t('Unable to complete Google sign-in.', 'Google সাইন-ইন সম্পন্ন করা যায়নি।');
      setErrorMessage(msg);
    } finally {
      setSigningIn(false);
    }
  };

  const handleSignOut = async () => {
    await signOut(auth);
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center px-6 py-12">
      <div className="max-w-5xl w-full mx-auto bg-white border border-slate-200 rounded-xl overflow-hidden grid grid-cols-1 lg:grid-cols-12 items-stretch">
        <div className="lg:col-span-6 p-8 sm:p-12 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between gap-3 mb-10">
              <div className="flex items-center gap-2.5 text-teal-800">
                <ShieldCheck className="w-5 h-5 shrink-0" />
                <span className="font-display text-lg font-bold tracking-tight text-slate-900">
                  {t('Materia Medica Clinic', 'মেটেরিয়া মেডিকা ক্লিনিক')}
                </span>
              </div>
              <LanguageSwitcher />
            </div>

            <p className="text-xs font-medium text-teal-800 mb-3">
              {t('Practitioner Admin Workspace', 'চিকিৎসক অ্যাডমিন ওয়ার্কস্পেস')}
            </p>
            <h1 className="font-display text-3xl sm:text-4xl font-semibold text-slate-900 tracking-tight leading-tight text-balance mb-4">
              {t(
                'Constitutional case records and clinical photo logs',
                'কনস্টিটিউশনাল কেস রেকর্ড এবং ক্লিনিক্যাল ফটো লগ'
              )}
            </h1>
            <p className="text-sm sm:text-base text-slate-600 leading-relaxed mb-8 max-w-md">
              {t(
                'Private clinic console for managing homeopathic patient histories, remedy potencies, follow-up schedules, and compressed clinical photography on free-tier infrastructure.',
                'হোমিওপ্যাথিক রোগীর ইতিহাস, রেমেডি পোটেন্সি, ফলো-আপ সূচি এবং কম্প্রেসড ক্লিনিক্যাল ছবি ফ্রি-টিয়ার সার্ভারে পরিচালনার ব্যক্তিগত ক্লিনিক কনসোল।'
              )}
            </p>

            {unauthorizedUser ? (
              <div className="border border-red-200 bg-red-50/70 rounded-lg p-4 mb-6">
                <p className="text-sm font-medium text-red-900 mb-1">
                  {t('Admin Access Restricted', 'অ্যাডমিন অ্যাক্সেস সীমাবদ্ধ')}
                </p>
                <p className="text-xs text-red-800 leading-relaxed mb-3">
                  {t('Signed in as', 'সাইন ইন করা হয়েছে')}{' '}
                  <span className="font-mono">{unauthorizedUser.email}</span>.{' '}
                  {t(
                    'Patients and external accounts do not have access to this practitioner workspace.',
                    'রোগী বা বাহ্যিক অ্যাকাউন্টের এই চিকিৎসক ওয়ার্কস্পেসে প্রবেশের অনুমতি নেই।'
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
              <button
                type="button"
                onClick={handleSignIn}
                disabled={signingIn}
                className="inline-flex items-center justify-center gap-2.5 px-5 py-3 text-sm font-medium text-white bg-teal-700 rounded-lg hover:bg-teal-800 disabled:opacity-60 transition-colors cursor-pointer whitespace-nowrap"
              >
                <span>
                  {signingIn
                    ? t('Verifying Admin Account...', 'অ্যাডমিন অ্যাকাউন্ট যাচাই হচ্ছে...')
                    : t('Sign in as Clinic Admin', 'ক্লিনিক অ্যাডমিন হিসেবে সাইন ইন')}
                </span>
                <ArrowRight className="w-4 h-4" />
              </button>
            )}

            {errorMessage && (
              <p className="mt-4 text-xs text-red-700" role="alert">
                {errorMessage}
              </p>
            )}
          </div>

          <div className="pt-8 mt-10 border-t border-slate-200 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
            <span>{t('Admin-only access', 'শুধুমাত্র অ্যাডমিন অ্যাক্সেস')}</span>
            <span aria-hidden="true">·</span>
            <span>{t('Firestore Spark free tier', 'ফায়ারস্টোর স্পার্ক ফ্রি টিয়ার')}</span>
            <span aria-hidden="true">·</span>
            <span>{t('Zero patient self-login', 'রোগীর লগইন প্রয়োজন নেই')}</span>
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
