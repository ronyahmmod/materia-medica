import { useEffect, useMemo, useState } from 'react';
import { ArrowUpDown, Camera, Printer, X } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';
import {
  GENDER_LABELS_I18N,
  NOTE_FOCUS_LABELS_I18N,
  PHOTO_CATEGORY_LABELS_I18N,
  STATUS_LABELS_I18N,
  THERMAL_LABELS_I18N,
} from '../i18n/translations';
import type { ClinicalNote, Consultation, Patient, PatientPhoto } from '../types/clinic';
import { SecureClinicalImage } from './SecureClinicalImage';

interface PatientCasePrintViewProps {
  patient: Patient;
  consultations: Consultation[];
  clinicalNotes: ClinicalNote[];
  photos: PatientPhoto[];
  clinicName?: string;
  practitionerName?: string;
  onClose: () => void;
}

export function PatientCasePrintView({
  patient,
  consultations,
  clinicalNotes,
  photos,
  clinicName,
  practitionerName,
  onClose,
}: PatientCasePrintViewProps) {
  const { language, t } = useLanguage();
  const [sortOrder, setSortOrder] = useState<'chronological' | 'newest'>('chronological');
  const [includePhotos, setIncludePhotos] = useState(false);

  const statusLabels = STATUS_LABELS_I18N[language];
  const genderLabels = GENDER_LABELS_I18N[language];
  const thermalLabels = THERMAL_LABELS_I18N[language];
  const noteFocusLabels = NOTE_FOCUS_LABELS_I18N[language];
  const photoCategoryLabels = PHOTO_CATEGORY_LABELS_I18N[language];

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const sortedConsultations = useMemo(() => {
    const list = [...consultations];
    list.sort((a, b) =>
      sortOrder === 'chronological'
        ? a.visitDate.localeCompare(b.visitDate)
        : b.visitDate.localeCompare(a.visitDate)
    );
    return list;
  }, [consultations, sortOrder]);

  const sortedNotes = useMemo(() => {
    const list = [...clinicalNotes];
    list.sort((a, b) =>
      sortOrder === 'chronological'
        ? a.observedDate.localeCompare(b.observedDate)
        : b.observedDate.localeCompare(a.observedDate)
    );
    return list;
  }, [clinicalNotes, sortOrder]);

  const printedOn = new Date().toLocaleDateString(language === 'bn' ? 'bn-BD' : 'en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  const resolvedClinicName =
    clinicName?.trim() || t('Materia Medica Clinic', 'মেটেরিয়া মেডিকা ক্লিনিক');
  const resolvedPractitioner =
    practitionerName?.trim() || t('Clinic Administrator', 'ক্লিনিক অ্যাডমিনিস্ট্রেটর');

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('Print-Friendly Patient Case Sheet', 'প্রিন্ট-উপযোগী রোগীর কেস শিট')}
      className="fixed inset-0 z-50 bg-slate-100/95 overflow-y-auto print:static print:inset-auto print:z-auto print:bg-white print:overflow-visible"
    >
      {/* Screen-only Preview Toolbar */}
      <div className="sticky top-0 z-10 bg-white border-b border-slate-200 px-4 sm:px-8 py-3 print:hidden">
        <div className="max-w-4xl mx-auto flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-900 truncate">
              {t('Print-Friendly Case Preview', 'প্রিন্ট-উপযোগী কেস প্রিভিউ')} · {patient.caseNumber}
            </p>
            <p className="text-xs text-slate-500 truncate">
              {patient.fullName} · {consultations.length} {t('remedy logs', 'টি ওষুধের লগ')} ·{' '}
              {clinicalNotes.length} {t('clinical notes', 'টি ক্লিনিক্যাল নোট')}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() =>
                setSortOrder((prev) => (prev === 'chronological' ? 'newest' : 'chronological'))
              }
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer whitespace-nowrap"
            >
              <ArrowUpDown className="w-3.5 h-3.5 text-slate-500" />
              {sortOrder === 'chronological'
                ? t('Order: Chronological', 'ক্রম: পুরোনো থেকে নতুন')
                : t('Order: Newest First', 'ক্রম: নতুন থেকে পুরোনো')}
            </button>

            {photos.length > 0 && (
              <label className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer select-none whitespace-nowrap">
                <input
                  type="checkbox"
                  checked={includePhotos}
                  onChange={(e) => setIncludePhotos(e.target.checked)}
                  className="rounded border-slate-300 text-teal-700 focus:ring-teal-700"
                />
                <Camera className="w-3.5 h-3.5 text-slate-500" />
                <span>
                  {t('Include Photos', 'ছবি যুক্ত করুন')} ({photos.length})
                </span>
              </label>
            )}

            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium text-white bg-teal-700 rounded-lg hover:bg-teal-800 transition-colors cursor-pointer whitespace-nowrap"
            >
              <Printer className="w-3.5 h-3.5" />
              {t('Print / Save PDF', 'প্রিন্ট / PDF সংরক্ষণ')}
            </button>

            <button
              type="button"
              onClick={onClose}
              aria-label={t('Close print preview', 'প্রিন্ট প্রিভিউ বন্ধ করুন')}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer whitespace-nowrap"
            >
              <X className="w-3.5 h-3.5" />
              {t('Close', 'বন্ধ করুন')}
            </button>
          </div>
        </div>
      </div>

      {/* Printable Case Paper */}
      <div className="py-6 px-4 sm:px-8 print:p-0">
        <article className="max-w-4xl mx-auto bg-white border border-slate-200 rounded-xl p-8 sm:p-10 space-y-7 text-slate-900 print:max-w-none print:border-0 print:rounded-none print:p-0">
          {/* Clinic & Document Masthead */}
          <header className="pb-5 border-b-2 border-slate-900 flex flex-col sm:flex-row sm:items-end justify-between gap-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-teal-800">
                {t('Homeopathic Clinical Case Record', 'হোমিওপ্যাথিক ক্লিনিক্যাল কেস রেকর্ড')}
              </p>
              <h1 className="font-display text-2xl font-bold text-slate-900 mt-1">
                {resolvedClinicName}
              </h1>
              <p className="text-xs text-slate-600 mt-0.5">
                {t('Practitioner:', 'চিকিৎসক:')} {resolvedPractitioner}
              </p>
            </div>

            <div className="sm:text-right text-xs text-slate-600 space-y-0.5 tabular-nums">
              <p>
                {t('Case No:', 'কেস নং:')}{' '}
                <span className="font-mono font-semibold text-slate-900">{patient.caseNumber}</span>
              </p>
              <p>
                {t('Case Status:', 'কেসের অবস্থা:')}{' '}
                <span className="font-medium text-slate-900">
                  {statusLabels[patient.status] || patient.status}
                </span>
              </p>
              <p>
                {t('Printed on:', 'প্রিন্টের তারিখ:')} {printedOn}
              </p>
            </div>
          </header>

          {/* Patient Profile & Constitutional Baseline */}
          <section className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-baseline justify-between gap-2 pb-2 border-b border-slate-200">
              <h2 className="font-display text-lg font-semibold text-slate-900">
                {patient.fullName}
              </h2>
              <p className="text-xs text-slate-600 tabular-nums">
                {patient.age} {t('yrs', 'বছর')} · {genderLabels[patient.gender] || patient.gender}{' '}
                · {patient.phone}
                {patient.email ? ` · ${patient.email}` : ''}
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
              <div className="sm:col-span-2">
                <p className="font-semibold text-slate-500 uppercase tracking-wide text-[10px] mb-1">
                  {t('Chief Complaint', 'প্রধান সমস্যা')}
                </p>
                <p className="text-sm text-slate-900 leading-relaxed">{patient.chiefComplaint}</p>
              </div>
              <div className="space-y-2 tabular-nums">
                <div>
                  <p className="font-semibold text-slate-500 uppercase tracking-wide text-[10px] mb-0.5">
                    {t('Thermal Tendency', 'তাপমাত্রা প্রবণতা')}
                  </p>
                  <p className="text-slate-900">
                    {patient.thermalState
                      ? thermalLabels[patient.thermalState] || patient.thermalState
                      : thermalLabels.Unspecified}
                  </p>
                </div>
                {patient.lastRemedy && (
                  <div>
                    <p className="font-semibold text-slate-500 uppercase tracking-wide text-[10px] mb-0.5">
                      {t('Latest Remedy', 'সর্বশেষ ওষুধ')}
                    </p>
                    <p className="text-slate-900 font-medium">{patient.lastRemedy}</p>
                  </div>
                )}
                {patient.nextFollowUpDate && (
                  <div>
                    <p className="font-semibold text-slate-500 uppercase tracking-wide text-[10px] mb-0.5">
                      {t('Next Follow-Up', 'পরবর্তী ফলো-আপ')}
                    </p>
                    <p className="text-slate-900">{patient.nextFollowUpDate}</p>
                  </div>
                )}
              </div>
            </div>

            {(patient.constitutionNotes || patient.allergies || patient.address) && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-3 border-t border-slate-200 text-xs">
                {patient.constitutionNotes && (
                  <div>
                    <p className="font-semibold text-slate-500 uppercase tracking-wide text-[10px] mb-1">
                      {t('Constitutional Summary', 'ধাতুগত সারসংক্ষেপ')}
                    </p>
                    <p className="text-slate-800 leading-relaxed whitespace-pre-line">
                      {patient.constitutionNotes}
                    </p>
                  </div>
                )}
                <div className="space-y-2">
                  {patient.allergies && (
                    <div>
                      <p className="font-semibold text-slate-500 uppercase tracking-wide text-[10px] mb-1">
                        {t('Allergies & Medications', 'অ্যালার্জি ও চলমান ওষুধ')}
                      </p>
                      <p className="text-slate-800 leading-relaxed">{patient.allergies}</p>
                    </div>
                  )}
                  {patient.address && (
                    <div>
                      <p className="font-semibold text-slate-500 uppercase tracking-wide text-[10px] mb-1">
                        {t('Address', 'ঠিকানা')}
                      </p>
                      <p className="text-slate-800">{patient.address}</p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>

          {/* Remedy Prescription Log Summary Table */}
          <section className="space-y-2.5">
            <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-slate-800 pb-1.5 border-b border-slate-300">
              {t('Remedy Prescription Log', 'ওষুধ প্রদানের লগ')} ({sortedConsultations.length})
            </h2>

            {sortedConsultations.length === 0 ? (
              <p className="text-xs text-slate-500 italic py-2">
                {t('No remedies or consultations recorded yet.', 'এখনও কোনো ওষুধ বা ভিজিট লিপিবদ্ধ হয়নি।')}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-300 text-slate-600">
                      <th className="py-2 pr-3 font-semibold">{t('Visit Date', 'তারিখ')}</th>
                      <th className="py-2 px-3 font-semibold">{t('Remedy', 'ওষুধ')}</th>
                      <th className="py-2 px-3 font-semibold">{t('Potency', 'পোটেন্সি')}</th>
                      <th className="py-2 px-3 font-semibold">{t('Dosage', 'মাত্রা ও বিধি')}</th>
                      <th className="py-2 pl-3 font-semibold">{t('Follow-Up', 'ফলো-আপ')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {sortedConsultations.map((con) => (
                      <tr key={`log-${con.id}`} className="align-top">
                        <td className="py-2 pr-3 font-mono tabular-nums text-slate-700 whitespace-nowrap">
                          {con.visitDate}
                        </td>
                        <td className="py-2 px-3 font-semibold text-slate-900">{con.remedyName}</td>
                        <td className="py-2 px-3 font-mono text-teal-800 whitespace-nowrap">
                          {con.potency}
                        </td>
                        <td className="py-2 px-3 text-slate-700">{con.dosage}</td>
                        <td className="py-2 pl-3 font-mono tabular-nums text-slate-600 whitespace-nowrap">
                          {con.nextFollowUpDate || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Detailed Consultation Case-Taking History */}
          {sortedConsultations.length > 0 && (
            <section className="space-y-3">
              <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-slate-800 pb-1.5 border-b border-slate-300">
                {t('Consultation Case-Taking Details', 'ভিজিটভিত্তিক কেস-টেকিং বিবরণ')}
              </h2>

              <div className="space-y-3">
                {sortedConsultations.map((con, idx) => (
                  <div
                    key={con.id}
                    className="border border-slate-200 rounded-lg p-4 space-y-2.5 break-inside-avoid"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2 pb-2 border-b border-slate-200">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="text-[11px] font-mono text-slate-500 tabular-nums">
                          #{idx + 1} · {con.visitDate}
                        </span>
                        <span className="text-sm font-semibold text-slate-900">
                          {con.remedyName}
                        </span>
                        <span className="font-mono text-xs font-medium text-teal-800">
                          {con.potency}
                        </span>
                      </div>
                      <span className="text-xs text-slate-600">{con.dosage}</span>
                    </div>

                    <div className="text-xs">
                      <p className="font-semibold text-slate-500 mb-0.5">
                        {t('Presenting Symptoms', 'বর্তমান লক্ষণসমূহ')}
                      </p>
                      <p className="text-slate-900 leading-relaxed whitespace-pre-line">
                        {con.presentingSymptoms}
                      </p>
                    </div>

                    {(con.mentalGenerals ||
                      con.physicalGenerals ||
                      con.modalitiesWorse ||
                      con.modalitiesBetter) && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1 text-xs">
                        {con.mentalGenerals && (
                          <div>
                            <p className="font-semibold text-slate-500 mb-0.5">
                              {t('Mental Generals', 'মানসিক সাধারণ লক্ষণ')}
                            </p>
                            <p className="text-slate-800 leading-relaxed">{con.mentalGenerals}</p>
                          </div>
                        )}
                        {con.physicalGenerals && (
                          <div>
                            <p className="font-semibold text-slate-500 mb-0.5">
                              {t('Physical Generals', 'শারীরিক সাধারণ লক্ষণ')}
                            </p>
                            <p className="text-slate-800 leading-relaxed">{con.physicalGenerals}</p>
                          </div>
                        )}
                        {con.modalitiesWorse && (
                          <div>
                            <p className="font-semibold text-slate-500 mb-0.5">
                              {t('Aggravation (<)', 'বৃদ্ধি (<)')}
                            </p>
                            <p className="text-slate-800">{con.modalitiesWorse}</p>
                          </div>
                        )}
                        {con.modalitiesBetter && (
                          <div>
                            <p className="font-semibold text-slate-500 mb-0.5">
                              {t('Amelioration (>)', 'উপশম (>)')}
                            </p>
                            <p className="text-slate-800">{con.modalitiesBetter}</p>
                          </div>
                        )}
                      </div>
                    )}

                    {con.clinicalNotes && (
                      <div className="pt-1 text-xs">
                        <p className="font-semibold text-slate-500 mb-0.5">
                          {t('Visit Clinical Notes', 'ভিজিট নোট')}
                        </p>
                        <p className="text-slate-800 leading-relaxed whitespace-pre-line">
                          {con.clinicalNotes}
                        </p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Dated Clinical Notes (Constitution & Mental State) */}
          <section className="space-y-3">
            <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-slate-800 pb-1.5 border-b border-slate-300">
              {t('Clinical Notes & Constitutional Observations', 'ক্লিনিক্যাল নোট ও ধাতুগত পর্যবেক্ষণ')} (
              {sortedNotes.length})
            </h2>

            {sortedNotes.length === 0 ? (
              <p className="text-xs text-slate-500 italic py-2">
                {t('No dated clinical notes recorded.', 'কোনো তারিখভিত্তিক ক্লিনিক্যাল নোট লেখা হয়নি।')}
              </p>
            ) : (
              <div className="space-y-2.5">
                {sortedNotes.map((note) => (
                  <div
                    key={note.id}
                    className="border border-slate-200 rounded-lg p-3.5 space-y-1.5 break-inside-avoid"
                  >
                    <div className="flex items-center gap-2 text-xs tabular-nums">
                      <span className="font-mono font-semibold text-slate-900">
                        {note.observedDate}
                      </span>
                      <span aria-hidden="true" className="text-slate-400">
                        ·
                      </span>
                      <span className="font-medium text-teal-800">
                        {noteFocusLabels[note.focusArea] || note.focusArea}
                      </span>
                    </div>
                    <p className="text-xs text-slate-800 leading-relaxed whitespace-pre-line">
                      {note.content}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Optional Attached Clinical Photos */}
          {includePhotos && photos.length > 0 && (
            <section className="space-y-3">
              <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-slate-800 pb-1.5 border-b border-slate-300">
                {t('Clinical Reference Photos', 'ক্লিনিক্যাল রেফারেন্স ছবি')} ({photos.length})
              </h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                {photos.map((photo) => (
                  <figure
                    key={photo.id}
                    className="border border-slate-200 rounded-lg overflow-hidden break-inside-avoid"
                  >
                    <div className="aspect-[4/3] bg-slate-100">
                      <SecureClinicalImage
                        src={photo.url}
                        alt={photo.caption || photoCategoryLabels[photo.category]}
                      />
                    </div>
                    <figcaption className="p-2 text-[11px] text-slate-700">
                      <p className="font-medium text-slate-900 truncate">
                        {photo.caption || photoCategoryLabels[photo.category]}
                      </p>
                      <p className="text-slate-500">{photoCategoryLabels[photo.category]}</p>
                    </figcaption>
                  </figure>
                ))}
              </div>
            </section>
          )}

          {/* Print Footer & Practitioner Signature Line */}
          <footer className="pt-6 mt-4 border-t border-slate-300 flex flex-col sm:flex-row sm:items-end justify-between gap-6 text-[11px] text-slate-500 break-inside-avoid">
            <p>
              {t(
                'Confidential Homeopathic Clinical Case Sheet — Practitioner Record',
                'গোপনীয় হোমিওপ্যাথিক ক্লিনিক্যাল কেস শিট — চিকিৎসকের সংরক্ষিত নথি'
              )}
            </p>
            <div className="sm:text-right">
              <div className="w-44 border-b border-slate-400 mb-1 sm:ml-auto" />
              <p className="text-slate-700 font-medium">{resolvedPractitioner}</p>
            </div>
          </footer>
        </article>
      </div>
    </div>
  );
}
