import { Mail, ShieldAlert } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';

interface CopyrightFooterProps {
  variant?: 'workspace' | 'auth';
}

export const AUTHOR_FOOTPRINT = {
  designerLabel: 'Designed With Engineer MD. RONY AHMMOD',
  email: 'rony.jib@gmail.com',
  facebookUrl: 'https://www.facebook.com/rony.ahmmod.9',
  copyrightYear: '2026',
} as const;

export function CopyrightFooter({ variant = 'workspace' }: CopyrightFooterProps) {
  const { t } = useLanguage();

  const containerClass =
    variant === 'auth'
      ? 'max-w-5xl w-full mx-auto mt-5 px-2 text-slate-600'
      : 'mt-auto border-t border-slate-200 bg-white px-6 lg:px-8 py-4 text-slate-600 print:hidden';

  return (
    <footer className={containerClass}>
      <div className="max-w-[1280px] mx-auto flex flex-col gap-2">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-semibold text-slate-900">
              {AUTHOR_FOOTPRINT.designerLabel}
            </span>
            <span className="text-slate-300 hidden sm:inline" aria-hidden="true">
              |
            </span>
            <a
              href={`mailto:${AUTHOR_FOOTPRINT.email}`}
              className="inline-flex items-center gap-1.5 font-mono text-[11px] text-teal-800 hover:underline"
            >
              <Mail className="w-3.5 h-3.5 shrink-0" />
              <span>{AUTHOR_FOOTPRINT.email}</span>
            </a>
            <span className="text-slate-300 hidden sm:inline" aria-hidden="true">
              |
            </span>
            <a
              href={AUTHOR_FOOTPRINT.facebookUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-[11px] font-medium text-teal-800 hover:underline"
            >
              <span>Facebook: /rony.ahmmod.9</span>
            </a>
          </div>

          <span className="text-[11px] font-mono text-slate-500 tabular-nums shrink-0">
            © {AUTHOR_FOOTPRINT.copyrightYear} Engineer MD. RONY AHMMOD ·{' '}
            {t('All Rights Reserved', 'সর্বস্বত্ব সংরক্ষিত')}
          </span>
        </div>

        <p className="text-[11px] text-slate-500 leading-relaxed flex items-start gap-1.5">
          <ShieldAlert className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
          <span>
            {t(
              'Copyright Act Notice: This software architecture, source code, and clinical workspace design are proprietary property of Engineer MD. RONY AHMMOD and protected under the Copyright Act (Bangladesh Copyright Act, 2000 & International Copyright Law). No one may copy, modify, redistribute, resell, or use any part of this system without prior written permission.',
              'কপিরাইট আইন বিজ্ঞপ্তি: এই সফটওয়্যার আর্কিটেকচার, সোর্স কোড ও ক্লিনিক্যাল ডিজাইন ইঞ্জিনিয়ার মোঃ রনি আহম্মদ (Engineer MD. RONY AHMMOD)-এর নিজস্ব মেধাস্বত্ব এবং বাংলাদেশ কপিরাইট আইন ও আন্তর্জাতিক কপিরাইট আইন দ্বারা সংরক্ষিত। পূর্বানুমতি ছাড়া এই সিস্টেমের কোনো অংশ কপি, পরিবর্তন, পুনঃবিতরণ বা ব্যবহার করা সম্পূর্ণ নিষিদ্ধ।'
            )}
          </span>
        </p>
      </div>
    </footer>
  );
}
