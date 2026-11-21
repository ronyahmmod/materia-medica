import { useEffect, useState } from 'react';
import { BookmarkPlus, Check, Compass, HelpCircle, Loader2, Sparkles } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';
import {
  mapPatientConstitutionalThemes,
  type ConstitutionalConfidence,
  type ConstitutionalMapResponse,
  type ConstitutionalThemeCategory,
} from '../lib/constitutionalApi';
import type { ClinicalNote, Consultation, Patient } from '../types/clinic';

interface ConstitutionalMapperCardProps {
  patient: Patient;
  clinicalNotes: ClinicalNote[];
  consultations: Consultation[];
  onSaveSynthesisNote?: (summaryText: string) => Promise<void>;
}

const CATEGORY_LABELS: Record<'en' | 'bn', Record<ConstitutionalThemeCategory, string>> = {
  en: {
    'Mental & Emotional': 'Mental & Emotional',
    'Thermal & Physical': 'Thermal & Physical',
    'Miasmatic Tendency': 'Miasmatic Tendency',
    'Modality & Rhythm': 'Modality & Rhythm',
  },
  bn: {
    'Mental & Emotional': 'মানসিক ও আবেগগত',
    'Thermal & Physical': 'তাপমাত্রা ও শারীরিক',
    'Miasmatic Tendency': 'মায়াজমেটিক প্রবণতা',
    'Modality & Rhythm': 'মডালিটি ও ছন্দ',
  },
};

const CONFIDENCE_LABELS: Record<'en' | 'bn', Record<ConstitutionalConfidence, string>> = {
  en: {
    high: 'Strong Resonance',
    moderate: 'Moderate Cue',
    emerging: 'Emerging Pattern',
  },
  bn: {
    high: 'প্রবল সামঞ্জস্য',
    moderate: 'মাঝারি ইঙ্গিত',
    emerging: 'উদীয়মান ধারা',
  },
};

function confidenceDotClass(confidence: ConstitutionalConfidence): string {
  if (confidence === 'high') return 'bg-rose-600';
  if (confidence === 'moderate') return 'bg-amber-500';
  return 'bg-teal-600';
}

export function ConstitutionalMapperCard({
  patient,
  clinicalNotes,
  consultations,
  onSaveSynthesisNote,
}: ConstitutionalMapperCardProps) {
  const { language, t } = useLanguage();
  const [includeConsultations, setIncludeConsultations] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ConstitutionalMapResponse | null>(null);
  const [savingToNotes, setSavingToNotes] = useState(false);
  const [savedToNotes, setSavedToNotes] = useState(false);

  // Reset result if patient changes
  useEffect(() => {
    setResult(null);
    setError(null);
    setSavedToNotes(false);
  }, [patient.id]);

  const hasEnoughInput =
    clinicalNotes.length > 0 ||
    (includeConsultations && consultations.length > 0) ||
    Boolean(patient.constitutionNotes?.trim());

  const handleAnalyze = async () => {
    setError(null);
    setSavedToNotes(false);
    setLoading(true);
    try {
      const mapped = await mapPatientConstitutionalThemes(
        patient,
        clinicalNotes,
        consultations,
        includeConsultations,
        language
      );
      setResult(mapped);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t(
              'Unable to generate constitutional symptom map.',
              'ধাতুগত লক্ষণ ম্যাপ তৈরি করা যায়নি।'
            )
      );
    } finally {
      setLoading(false);
    }
  };

  const handleSaveAsClinicalNote = async () => {
    if (!result || !onSaveSynthesisNote) return;
    setSavingToNotes(true);
    setError(null);
    try {
      const themeLines = result.constitutionalThemes
        .map((item) => {
          const remedies =
            item.candidateRemedies.length > 0 ? ` [${item.candidateRemedies.join(', ')}]` : '';
          return `• ${item.theme}${remedies}: ${item.supportingEvidence}`;
        })
        .join('\n');

      const noteBody = [
        t('Constitutional Symptom Mapper Summary:', 'ধাতুগত লক্ষণ ম্যাপার সারসংক্ষেপ:'),
        result.overallSummary,
        '',
        themeLines,
      ].join('\n');

      await onSaveSynthesisNote(noteBody);
      setSavedToNotes(true);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t('Unable to save synthesis to clinical notes.', 'সারসংক্ষেপ ক্লিনিক্যাল নোটে সংরক্ষণ করা যায়নি।')
      );
    } finally {
      setSavingToNotes(false);
    }
  };

  return (
    <section
      aria-label={t('Constitutional Symptom Mapper', 'ধাতুগত লক্ষণ ম্যাপার')}
      className="space-y-5"
    >
      {/* Mapper Control Header */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
          <div className="space-y-1 max-w-2xl">
            <div className="flex items-center gap-2">
              <Compass className="w-4 h-4 text-teal-700 shrink-0" />
              <h2 className="font-display text-base font-semibold text-slate-900">
                {t('Constitutional Symptom Mapper', 'ধাতুগত লক্ষণ ম্যাপার')}
              </h2>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              {t(
                'Synthesize this patient’s dated clinical observations, baseline temperament, and consultation generals to surface recurring homeopathic constitutional themes, miasmatic cues, and candidate remedies.',
                'এই রোগীর তারিখভিত্তিক ক্লিনিক্যাল পর্যবেক্ষণ, প্রাথমিক ধাতুগত তথ্য এবং ভিজিটের সাধারণ লক্ষণ বিশ্লেষণ করে সম্ভাব্য হোমিওপ্যাথিক ধাতুগত থিম, মায়াজমেটিক ইঙ্গিত ও সহায়ক ওষুধের তালিকা তৈরি করুন।'
              )}
            </p>
          </div>

          <button
            type="button"
            disabled={loading || !hasEnoughInput}
            onClick={handleAnalyze}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-medium text-white bg-teal-700 rounded-lg hover:bg-teal-800 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            {loading ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {t('Mapping Themes...', 'থিম বিশ্লেষণ চলছে...')}
              </>
            ) : (
              <>
                <Sparkles className="w-3.5 h-3.5" />
                {result
                  ? t('Re-Analyze Clinical Notes', 'পুনরায় নোট বিশ্লেষণ করুন')
                  : t('Analyze Notes & Map Themes', 'নোট বিশ্লেষণ ও থিম তৈরি করুন')}
              </>
            )}
          </button>
        </div>

        {/* Input Source Summary & Toggle */}
        <div className="pt-3 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-slate-600 tabular-nums">
            <span>
              {t('Dated Clinical Notes:', 'তারিখভিত্তিক ক্লিনিক্যাল নোট:')}{' '}
              <strong className="text-slate-900 font-semibold">{clinicalNotes.length}</strong>
            </span>
            <span aria-hidden="true" className="text-slate-300">
              ·
            </span>
            <span>
              {t('Baseline Constitutional Note:', 'প্রাথমিক ধাতুগত নোট:')}{' '}
              <strong className="text-slate-900 font-semibold">
                {patient.constitutionNotes?.trim()
                  ? t('Recorded', 'সংরক্ষিত')
                  : t('None', 'নেই')}
              </strong>
            </span>
          </div>

          <label className="inline-flex items-center gap-2 text-slate-700 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={includeConsultations}
              onChange={(e) => setIncludeConsultations(e.target.checked)}
              className="rounded border-slate-300 text-teal-700 focus:ring-teal-700"
            />
            <span>
              {t('Include consultation generals & visit notes', 'কনসাল্টেশনের সাধারণ লক্ষণ ও ভিজিট নোট যুক্ত করুন')}{' '}
              <span className="font-mono text-slate-500 tabular-nums">
                ({consultations.length})
              </span>
            </span>
          </label>
        </div>

        {!hasEnoughInput && (
          <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900">
            {t(
              'Add at least one dated observation in the Clinical Notes tab (or a constitutional summary in the patient profile) before running the mapper.',
              'ম্যাপার চালানোর আগে ক্লিনিক্যাল নোট ট্যাবে অন্তত একটি তারিখভিত্তিক পর্যবেক্ষণ (অথবা রোগীর প্রোফাইলে ধাতুগত নোট) যুক্ত করুন।'
            )}
          </div>
        )}

        {error && (
          <div className="p-3.5 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800">
            {error}
          </div>
        )}
      </div>

      {/* Results Output */}
      {result && (
        <div className="space-y-5">
          {/* Holistic Constitutional Synthesis */}
          <div className="bg-teal-50/60 border border-teal-200 rounded-xl p-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-teal-900">
                {t('Holistic Constitutional Synthesis', 'সামগ্রিক ধাতুগত সারসংক্ষেপ')}
              </p>

              {onSaveSynthesisNote && (
                <button
                  type="button"
                  disabled={savingToNotes || savedToNotes}
                  onClick={handleSaveAsClinicalNote}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-teal-900 bg-white border border-teal-300 rounded-lg hover:bg-teal-50 disabled:opacity-60 transition-colors cursor-pointer whitespace-nowrap"
                >
                  {savedToNotes ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-700" />
                      {t('Saved to Clinical Notes', 'ক্লিনিক্যাল নোটে সংরক্ষিত হয়েছে')}
                    </>
                  ) : (
                    <>
                      <BookmarkPlus className="w-3.5 h-3.5" />
                      {savingToNotes
                        ? t('Saving...', 'সংরক্ষণ হচ্ছে...')
                        : t('Save Summary to Clinical Notes', 'ক্লিনিক্যাল নোটে সংরক্ষণ করুন')}
                    </>
                  )}
                </button>
              )}
            </div>
            <p className="text-sm text-slate-800 leading-relaxed">{result.overallSummary}</p>

            {/* Confidence Legend */}
            <div className="pt-2 border-t border-teal-200/70 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[11px] text-slate-600">
              <span className="font-medium text-slate-700">
                {t('Resonance Level:', 'সামঞ্জস্যের মাত্রা:')}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block w-2 h-2 rounded-full bg-rose-600" />
                {CONFIDENCE_LABELS[language].high}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block w-2 h-2 rounded-full bg-amber-500" />
                {CONFIDENCE_LABELS[language].moderate}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block w-2 h-2 rounded-full bg-teal-600" />
                {CONFIDENCE_LABELS[language].emerging}
              </span>
            </div>
          </div>

          {/* Constitutional Themes Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {result.constitutionalThemes.map((item, idx) => (
              <article
                key={`${item.theme}-${idx}`}
                className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-4"
              >
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                      {CATEGORY_LABELS[language][item.category] || item.category}
                    </span>
                    <span
                      className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-700 shrink-0"
                      title={CONFIDENCE_LABELS[language][item.confidence]}
                    >
                      <span
                        className={`inline-block w-2 h-2 rounded-full ${confidenceDotClass(
                          item.confidence
                        )}`}
                      />
                      {CONFIDENCE_LABELS[language][item.confidence]}
                    </span>
                  </div>

                  <h3 className="font-display text-sm font-semibold text-slate-900 leading-snug">
                    {item.theme}
                  </h3>

                  <p className="text-xs text-slate-600 leading-relaxed">
                    {item.supportingEvidence}
                  </p>

                  {item.keyTendencies.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {item.keyTendencies.map((tendency) => (
                        <span
                          key={tendency}
                          className="px-2 py-0.5 text-[11px] text-slate-700 bg-slate-100 border border-slate-200 rounded-md"
                        >
                          {tendency}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {item.candidateRemedies.length > 0 && (
                  <div className="pt-3 border-t border-slate-100 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
                    <span className="text-slate-500 font-medium">
                      {t('Candidate remedies:', 'সম্ভাব্য ওষুধ:')}
                    </span>
                    <span className="font-mono font-medium text-teal-800">
                      {item.candidateRemedies.join(' · ')}
                    </span>
                  </div>
                )}
              </article>
            ))}
          </div>

          {/* Recommended Next-Visit Case-Taking Questions */}
          {result.recommendedQuestions.length > 0 && (
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
              <div className="flex items-center gap-2">
                <HelpCircle className="w-4 h-4 text-teal-700 shrink-0" />
                <h3 className="font-display text-sm font-semibold text-slate-900">
                  {t(
                    'Follow-Up Case-Taking Prompts for Next Visit',
                    'পরবর্তী ভিজিটে যাচাইয়ের জন্য সহায়ক প্রশ্ন'
                  )}
                </h3>
              </div>
              <ul className="space-y-1.5 text-xs text-slate-700 list-disc pl-5">
                {result.recommendedQuestions.map((question, qIdx) => (
                  <li key={qIdx} className="leading-relaxed">
                    {question}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
