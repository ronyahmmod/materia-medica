import { useEffect, useMemo, useState } from 'react';
import { onSnapshot, query, where } from 'firebase/firestore';
import { Pill, Search, Send, UserCheck, X } from 'lucide-react';
import { auth, handleFirestoreError, OperationType } from '../firebase';
import { useLanguage } from '../i18n/LanguageContext';
import {
  DISEASE_SCOPE_LABELS_I18N,
  PATIENT_TYPE_LABELS_I18N,
  REMEDY_TIMING_LABELS_I18N,
} from '../i18n/translations';
import {
  ACCENT_THEME_PALETTES,
  tenantDiseaseRemediesCol,
} from '../lib/tenantPaths';
import {
  DISEASE_PATIENT_SCOPES,
  type ClinicTenant,
  type DiseasePatientScope,
  type DiseaseRemedyEntry,
  type Patient,
  type RemedyRuleTiming,
} from '../types/clinic';
import {
  ConsultationFormModal,
  type ConsultationPrefill,
} from './ConsultationFormModal';
import { SecureClinicalImage } from './SecureClinicalImage';

interface RemedyReverseLookupViewProps {
  clinic: ClinicTenant;
  patients: Patient[];
  isSuperAdmin: boolean;
  onConsultationSaved: (patientId: string) => void;
}

interface ReverseIndication {
  id: string;
  remedyName: string;
  potency: string;
  doseOrUnit: string;
  timing: RemedyRuleTiming;
  diseaseId: string;
  diseaseName: string;
  patientScope: DiseasePatientScope;
  symptom: string;
  dosageInstructions: string;
  clinicalNotes: string;
}

interface MedicineGroup {
  remedyKey: string;
  remedyName: string;
  potencies: string[];
  diseaseNames: string[];
  indications: ReverseIndication[];
}

export function RemedyReverseLookupView({
  clinic,
  patients,
  isSuperAdmin,
  onConsultationSaved,
}: RemedyReverseLookupViewProps) {
  const { language, t } = useLanguage();
  const palette = ACCENT_THEME_PALETTES[clinic.accentColor] || ACCENT_THEME_PALETTES.teal;
  const scopeLabels = DISEASE_SCOPE_LABELS_I18N[language];
  const patientTypeLabels = PATIENT_TYPE_LABELS_I18N[language];
  const timingLabels = REMEDY_TIMING_LABELS_I18N[language];

  const [entries, setEntries] = useState<DiseaseRemedyEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedMedicineKey, setSelectedMedicineKey] = useState<string>('all');
  const [potencyFilter, setPotencyFilter] = useState<string>('all');
  const [scopeFilter, setScopeFilter] = useState<'all' | DiseasePatientScope>('all');

  // Prescribe Flow
  const [prescribeTarget, setPrescribeTarget] = useState<ReverseIndication | null>(null);
  const [prescribeSlot, setPrescribeSlot] = useState<'morning' | 'afternoon' | 'biochemic'>(
    'morning'
  );
  const [patientPickerQuery, setPatientPickerQuery] = useState('');
  const [targetPatient, setTargetPatient] = useState<Patient | null>(null);

  useEffect(() => {
    setLoading(true);
    const userUid = auth.currentUser?.uid || '';
    const path = `clinics/${clinic.id}/disease_remedies`;
    const source = isSuperAdmin
      ? tenantDiseaseRemediesCol(clinic.id)
      : query(
          tenantDiseaseRemediesCol(clinic.id),
          where('clinicAccessUids', 'array-contains', userUid)
        );

    const unsub = onSnapshot(
      source,
      (snapshot) => {
        const rows = snapshot.docs
          .map((d) => ({
            id: d.id,
            ...(d.data() as Omit<DiseaseRemedyEntry, 'id'>),
          }))
          .filter((row) => !row.isDeleted);
        setEntries(rows);
        setLoading(false);
      },
      (error) => {
        setLoading(false);
        handleFirestoreError(error, OperationType.LIST, path);
      }
    );

    return () => unsub();
  }, [clinic.id, isSuperAdmin]);

  // Flatten all disease rules + legacy fields into reverse Remedy -> Potency -> Disease -> Symptom index
  const { allIndications, allMedicines, allPotencies } = useMemo(() => {
    const flat: ReverseIndication[] = [];
    const medNamesMap = new Map<string, string>();
    const potencySet = new Set<string>();

    for (const entry of entries) {
      if (entry.symptomRules && entry.symptomRules.length > 0) {
        for (const rule of entry.symptomRules) {
          const cleanName = rule.remedyName.trim();
          const cleanPot = (rule.potency || '').trim();
          if (!cleanName) continue;
          medNamesMap.set(cleanName.toLowerCase(), cleanName);
          if (cleanPot) potencySet.add(cleanPot);
          flat.push({
            id: `${entry.id}-${rule.id}`,
            remedyName: cleanName,
            potency: cleanPot,
            doseOrUnit: rule.doseOrUnit || '',
            timing: rule.timing || 'general',
            diseaseId: entry.id,
            diseaseName: entry.diseaseName,
            patientScope: entry.patientScope,
            symptom: rule.symptom,
            dosageInstructions: entry.dosageInstructions || '',
            clinicalNotes: rule.notes || entry.clinicalNotes || '',
          });
        }
      } else {
        if (entry.firstRemedyMorning?.trim()) {
          const cleanName = entry.firstRemedyMorning.trim();
          const cleanPot = (entry.firstRemedyPotency || '').trim();
          medNamesMap.set(cleanName.toLowerCase(), cleanName);
          if (cleanPot) potencySet.add(cleanPot);
          flat.push({
            id: `${entry.id}-morning`,
            remedyName: cleanName,
            potency: cleanPot,
            doseOrUnit: '',
            timing: 'morning',
            diseaseId: entry.id,
            diseaseName: entry.diseaseName,
            patientScope: entry.patientScope,
            symptom: entry.symptoms,
            dosageInstructions: entry.dosageInstructions || '',
            clinicalNotes: entry.clinicalNotes || '',
          });
        }
        if (entry.secondRemedyAfternoon?.trim()) {
          const cleanName = entry.secondRemedyAfternoon.trim();
          const cleanPot = (entry.secondRemedyPotency || '').trim();
          medNamesMap.set(cleanName.toLowerCase(), cleanName);
          if (cleanPot) potencySet.add(cleanPot);
          flat.push({
            id: `${entry.id}-afternoon`,
            remedyName: cleanName,
            potency: cleanPot,
            doseOrUnit: '',
            timing: 'afternoon',
            diseaseId: entry.id,
            diseaseName: entry.diseaseName,
            patientScope: entry.patientScope,
            symptom: entry.symptoms,
            dosageInstructions: entry.dosageInstructions || '',
            clinicalNotes: entry.clinicalNotes || '',
          });
        }
      }
    }

    const sortedMeds = Array.from(medNamesMap.entries())
      .map(([key, label]) => ({
        key,
        label,
        count: flat.filter((item) => item.remedyName.toLowerCase() === key).length,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));

    const sortedPotencies = Array.from(potencySet).sort((a, b) => a.localeCompare(b));

    return {
      allIndications: flat,
      allMedicines: sortedMeds,
      allPotencies: sortedPotencies,
    };
  }, [entries]);

  const groupedMedicines = useMemo<MedicineGroup[]>(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = allIndications.filter((item) => {
      if (selectedMedicineKey !== 'all' && item.remedyName.toLowerCase() !== selectedMedicineKey) {
        return false;
      }
      if (potencyFilter !== 'all' && item.potency !== potencyFilter) {
        return false;
      }
      if (scopeFilter !== 'all' && item.patientScope !== scopeFilter) {
        return false;
      }
      if (!q) return true;
      return (
        item.remedyName.toLowerCase().includes(q) ||
        item.potency.toLowerCase().includes(q) ||
        item.diseaseName.toLowerCase().includes(q) ||
        item.symptom.toLowerCase().includes(q) ||
        item.doseOrUnit.toLowerCase().includes(q) ||
        item.clinicalNotes.toLowerCase().includes(q)
      );
    });

    const groups = new Map<string, MedicineGroup>();
    for (const item of filtered) {
      const key = item.remedyName.toLowerCase();
      const existing = groups.get(key);
      if (!existing) {
        groups.set(key, {
          remedyKey: key,
          remedyName: item.remedyName,
          potencies: item.potency ? [item.potency] : [],
          diseaseNames: [item.diseaseName],
          indications: [item],
        });
      } else {
        if (item.potency && !existing.potencies.includes(item.potency)) {
          existing.potencies.push(item.potency);
        }
        if (!existing.diseaseNames.includes(item.diseaseName)) {
          existing.diseaseNames.push(item.diseaseName);
        }
        existing.indications.push(item);
      }
    }

    return Array.from(groups.values()).sort((a, b) =>
      a.remedyName.localeCompare(b.remedyName)
    );
  }, [allIndications, potencyFilter, scopeFilter, searchQuery, selectedMedicineKey]);

  const pickerPatients = useMemo(() => {
    const activeList = patients.filter((p) => !p.isDeleted);
    const q = patientPickerQuery.trim().toLowerCase();
    const filtered = activeList.filter((p) => {
      if (!q) return true;
      return (
        p.fullName.toLowerCase().includes(q) ||
        p.caseNumber.toLowerCase().includes(q) ||
        p.phone.toLowerCase().includes(q) ||
        (p.address || '').toLowerCase().includes(q) ||
        (p.ownerOrGuardianName || '').toLowerCase().includes(q) ||
        (p.animalSpeciesOrBreed || '').toLowerCase().includes(q) ||
        (p.patientType || '').toLowerCase().includes(q)
      );
    });

    if (!prescribeTarget || prescribeTarget.patientScope === 'All') {
      return filtered;
    }

    return [...filtered].sort((a, b) => {
      const aVet = a.patientType && a.patientType !== 'Human';
      const bVet = b.patientType && b.patientType !== 'Human';
      const wantVet = prescribeTarget.patientScope === 'Veterinary';
      const aMatch = wantVet ? aVet : !aVet;
      const bMatch = wantVet ? bVet : !bVet;
      if (aMatch === bMatch) return 0;
      return aMatch ? -1 : 1;
    });
  }, [patients, patientPickerQuery, prescribeTarget]);

  const buildPrefillFromIndication = (
    ind: ReverseIndication,
    chosenSlot: 'morning' | 'afternoon' | 'biochemic'
  ): ConsultationPrefill => {
    const prefill: ConsultationPrefill = {
      diseaseName: ind.diseaseName,
      presentingSymptoms: `[${ind.diseaseName}] ${ind.symptom}`,
      dosage: ind.dosageInstructions || '',
      clinicalNotes: ind.clinicalNotes || '',
    };

    if (chosenSlot === 'afternoon') {
      prefill.secondRemedyAfternoon = ind.remedyName;
      prefill.secondRemedyPotency = ind.potency;
    } else if (chosenSlot === 'biochemic') {
      prefill.biochemicMedicine = `${ind.remedyName} ${ind.potency}`.trim();
    } else {
      prefill.firstRemedyMorning = ind.remedyName;
      prefill.firstRemedyPotency = ind.potency;
    }

    const u = ind.doseOrUnit.toLowerCase();
    if (u.includes('বড়ি') || u.includes('বড়ি') || u.includes('glob') || u.includes('pill')) {
      prefill.globulesDose = ind.doseOrUnit;
    } else if (u.includes('আউন্স') || u.includes('oz') || u.includes('ounce')) {
      prefill.ounceAmount = ind.doseOrUnit;
    } else if (u.includes('ফাইল') || u.includes('phial')) {
      prefill.phialCount = ind.doseOrUnit;
    }

    return prefill;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
            {t('Reverse Medicine Lookup (Materia Medica)', 'ঔষধ নির্দেশিকা — রিভার্স লুকআপ')}
          </h1>
          <p className="text-sm text-slate-500 mt-0.5 tabular-nums">
            {allMedicines.length} {t('indexed medicines', 'টি তালিকাভুক্ত ঔষধ')} ·{' '}
            {allIndications.length} {t('symptom indications', 'টি লক্ষণ ও ব্যবহার')}{' '}
            —{' '}
            {t(
              'Select a medicine & potency to view every disease and symptom it treats',
              'যেকোনো ঔষধ ও শক্তি নির্বাচন করে দেখুন এটি কোন কোন রোগ ও লক্ষণে ব্যবহৃত হয়'
            )}
          </p>
        </div>
      </div>

      {/* Search, Potency & Scope Filters */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t(
                'Search medicine (e.g. Calcarea phosphorica), potency (30C), disease, or symptom...',
                'ঔষধ (যেমন: ক্যালকেরিয়া ফস / Calcarea), শক্তি (30C), রোগ বা লক্ষণ খুঁজুন...'
              )}
              className="w-full pl-9 pr-3 py-2 text-xs bg-slate-50 border border-slate-300 rounded-lg focus:outline-none focus:bg-white focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <select
              value={potencyFilter}
              onChange={(e) => setPotencyFilter(e.target.value)}
              className="px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg bg-white text-slate-800 focus:outline-none focus:border-teal-700"
            >
              <option value="all">{t('All Potencies (সব শক্তি)', 'সব শক্তি (Potency)')}</option>
              {allPotencies.map((pot) => (
                <option key={pot} value={pot}>
                  {pot}
                </option>
              ))}
            </select>

            <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
              {(['all', ...DISEASE_PATIENT_SCOPES] as const).map((scope) => (
                <button
                  key={scope}
                  type="button"
                  onClick={() => setScopeFilter(scope)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                    scopeFilter === scope
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {scope === 'all' ? t('All', 'সব') : scopeLabels[scope]}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Quick Medicine Index Selector */}
        {allMedicines.length > 0 && (
          <div className="pt-2 border-t border-slate-100 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setSelectedMedicineKey('all')}
              className={`px-2.5 py-1 text-[11px] font-medium rounded-md border transition-colors cursor-pointer ${
                selectedMedicineKey === 'all'
                  ? palette.softPanel
                  : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
              }`}
            >
              {t('All Medicines', 'সব ঔষধ')} ({allMedicines.length})
            </button>
            {allMedicines.map((med) => (
              <button
                key={med.key}
                type="button"
                onClick={() =>
                  setSelectedMedicineKey((prev) => (prev === med.key ? 'all' : med.key))
                }
                className={`px-2.5 py-1 text-[11px] font-medium rounded-md border transition-colors cursor-pointer ${
                  selectedMedicineKey === med.key
                    ? palette.softPanel
                    : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                }`}
              >
                {med.label}{' '}
                <span className="font-mono text-[10px] opacity-75">({med.count})</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Results */}
      {loading ? (
        <div className="bg-white border border-slate-200 rounded-xl p-8 space-y-3">
          <div className="h-5 bg-slate-100 rounded w-1/3" />
          <div className="h-14 bg-slate-100 rounded" />
          <div className="h-14 bg-slate-100 rounded" />
        </div>
      ) : groupedMedicines.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-12 text-center">
          <Pill className="w-7 h-7 text-slate-400 mx-auto mb-3" />
          <h2 className="font-display text-base font-semibold text-slate-900">
            {entries.length === 0
              ? t('No medicine indications indexed yet', 'এখনও কোনো ঔষধের তথ্য যুক্ত হয়নি')
              : t('No matching medicine or potency found', 'মিল থাকা কোনো ঔষধ বা শক্তি পাওয়া যায়নি')}
          </h2>
          <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
            {entries.length === 0
              ? t(
                  'Add disease protocols & symptom rules in Disease & Remedies to automatically build this reverse Remedy Lookup encyclopedia.',
                  'রোগ ও ঔষধ ডেটাবেসে রোগ, লক্ষণ এবং ঔষধ যুক্ত করলে স্বয়ংক্রিয়ভাবে এখানে ঔষধভিত্তিক রিভার্স তালিকা তৈরি হয়ে যাবে।'
                )
              : t(
                  'Try clearing filters or searching with another medicine name or potency.',
                  'ফিল্টার পরিবর্তন করে অথবা অন্য ঔষধ বা শক্তি লিখে খুঁজুন।'
                )}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {groupedMedicines.map((group) => (
            <section
              key={group.remedyKey}
              className="bg-white border border-slate-200 rounded-xl overflow-hidden"
            >
              <div className="px-5 py-4 bg-slate-50/70 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-display text-lg font-semibold text-slate-900">
                      {group.remedyName}
                    </h2>
                    <span className="text-[11px] font-mono text-slate-500 tabular-nums">
                      · {group.diseaseNames.length} {t('diseases', 'টি রোগ')} ·{' '}
                      {group.indications.length} {t('symptoms', 'টি লক্ষণ')}
                    </span>
                  </div>
                </div>

                {group.potencies.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] font-medium text-slate-500 mr-1">
                      {t('Potencies:', 'শক্তিসমূহ:')}
                    </span>
                    {group.potencies.map((pot) => (
                      <button
                        key={pot}
                        type="button"
                        onClick={() =>
                          setPotencyFilter((prev) => (prev === pot ? 'all' : pot))
                        }
                        className={`px-2 py-0.5 text-[11px] font-mono font-semibold rounded border cursor-pointer transition-colors ${
                          potencyFilter === pot
                            ? 'bg-teal-700 text-white border-teal-700'
                            : 'bg-white text-teal-800 border-teal-300 hover:bg-teal-50'
                        }`}
                      >
                        {pot}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="divide-y divide-slate-200">
                {group.indications.map((ind) => (
                  <div
                    key={ind.id}
                    className="px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-slate-50/50 transition-colors"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-semibold text-slate-900">
                          {ind.diseaseName}
                        </span>
                        <span
                          className={`px-1.5 py-0.5 text-[10px] font-semibold rounded border ${
                            ind.patientScope === 'Veterinary'
                              ? 'bg-amber-50 text-amber-900 border-amber-200'
                              : ind.patientScope === 'Human'
                                ? 'bg-teal-50 text-teal-900 border-teal-200'
                                : 'bg-slate-100 text-slate-700 border-slate-200'
                          }`}
                        >
                          {scopeLabels[ind.patientScope]}
                        </span>
                        {ind.potency && (
                          <span className="px-1.5 py-0.5 text-[10px] font-mono font-semibold rounded bg-teal-50 text-teal-900 border border-teal-200">
                            {ind.potency}
                          </span>
                        )}
                        {ind.doseOrUnit && (
                          <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-sky-50 text-sky-900 border border-sky-200">
                            {ind.doseOrUnit}
                          </span>
                        )}
                        <span className="text-[10px] text-slate-500">
                          (
                          {ind.timing === 'general'
                            ? t('Homeopathic', 'হোমিওপ্যাথিক')
                            : timingLabels[ind.timing]}
                          )
                        </span>
                      </div>

                      <p className="text-xs text-slate-700 leading-relaxed whitespace-pre-line">
                        {ind.symptom}
                      </p>

                      {ind.clinicalNotes && (
                        <p className="text-[11px] text-slate-500">{ind.clinicalNotes}</p>
                      )}
                    </div>

                    <button
                      type="button"
                      disabled={patients.filter((p) => !p.isDeleted).length === 0}
                      onClick={() => {
                        setPatientPickerQuery('');
                        setTargetPatient(null);
                        setPrescribeSlot(
                          ind.timing === 'biochemic'
                            ? 'biochemic'
                            : ind.timing === 'afternoon'
                              ? 'afternoon'
                              : 'morning'
                        );
                        setPrescribeTarget(ind);
                      }}
                      className={`self-start sm:self-center shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap ${palette.primaryBtn}`}
                    >
                      <Send className="w-3 h-3" />
                      {t('Prescribe to Patient', 'রোগীকে দিন')}
                    </button>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {/* Step 1: Patient Selector Modal */}
      {prescribeTarget && !targetPatient && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-lg my-8 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 className="font-display text-base font-semibold text-slate-900 flex items-center gap-2">
                  <UserCheck className="w-4 h-4 text-teal-700 shrink-0" />
                  <span>{t('Select Patient to Prescribe', 'চিকিৎসার জন্য রোগী নির্বাচন করুন')}</span>
                </h2>
                <p className="text-xs text-slate-500 truncate mt-0.5">
                  {[prescribeTarget.remedyName, prescribeTarget.potency].filter(Boolean).join(' ')}
                  {prescribeTarget.doseOrUnit ? ` · ${prescribeTarget.doseOrUnit}` : ''} —{' '}
                  {prescribeTarget.diseaseName}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPrescribeTarget(null)}
                aria-label={t('Close modal', 'বন্ধ করুন')}
                className="p-1.5 text-slate-400 hover:text-slate-900 rounded-lg hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 border-b border-slate-200 bg-slate-50 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 bg-white border border-slate-200 rounded-lg px-3 py-2">
                <span className="text-[11px] font-medium text-slate-700">
                  {t('Visit Time Slot (ভিজিটে সেবন সময়):', 'ভিজিটে সেবনের সময়:')}
                </span>
                <div className="inline-flex items-center gap-1">
                  {(
                    [
                      { id: 'morning', en: '1st (Morning)', bn: '১ম (সকালে)' },
                      { id: 'afternoon', en: '2nd (Afternoon)', bn: '২য় (বিকালে)' },
                      { id: 'biochemic', en: 'Biochemic', bn: 'বায়োকেমিক' },
                    ] as const
                  ).map((slotOption) => (
                    <button
                      key={slotOption.id}
                      type="button"
                      onClick={() => setPrescribeSlot(slotOption.id)}
                      className={`px-2.5 py-1 text-[11px] font-medium rounded-md border cursor-pointer transition-colors ${
                        prescribeSlot === slotOption.id
                          ? 'bg-teal-700 text-white border-teal-700'
                          : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                      }`}
                    >
                      {t(slotOption.en, slotOption.bn)}
                    </button>
                  ))}
                </div>
              </div>

              <div className="relative">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="search"
                  autoFocus
                  value={patientPickerQuery}
                  onChange={(e) => setPatientPickerQuery(e.target.value)}
                  placeholder={t(
                    'Search patient name, case #, phone, address, cow/goat...',
                    'রোগীর নাম, কেস নং, ফোন, ঠিকানা, গরু/ছাগল লিখুন...'
                  )}
                  className="w-full pl-9 pr-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                />
              </div>
            </div>

            <div className="max-h-80 overflow-y-auto divide-y divide-slate-200">
              {pickerPatients.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-500">
                  {t('No matching patients found.', 'মিল থাকা কোনো রোগী পাওয়া যায়নি।')}
                </div>
              ) : (
                pickerPatients.map((pat) => {
                  const initials = pat.fullName
                    .split(' ')
                    .map((s) => s[0])
                    .join('')
                    .slice(0, 2)
                    .toUpperCase();
                  const isVet = pat.patientType && pat.patientType !== 'Human';

                  return (
                    <button
                      key={pat.id}
                      type="button"
                      onClick={() => setTargetPatient(pat)}
                      className="w-full text-left px-5 py-3 hover:bg-slate-50 transition-colors flex items-center justify-between gap-3 cursor-pointer"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-8 h-8 rounded-md overflow-hidden border border-slate-200 bg-slate-100 shrink-0">
                          <SecureClinicalImage
                            src={pat.portraitUrl}
                            alt={pat.fullName}
                            fallbackLabel={initials}
                          />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="text-xs font-semibold text-slate-900 truncate">
                              {pat.fullName}
                            </p>
                            {isVet && pat.patientType && (
                              <span className="px-1.5 py-0.5 text-[10px] font-medium bg-amber-50 text-amber-900 border border-amber-200 rounded shrink-0">
                                {patientTypeLabels[pat.patientType] || pat.patientType}
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-slate-500 truncate mt-0.5 tabular-nums">
                            <span className="font-mono">{pat.caseNumber}</span> · {pat.phone}
                            {pat.ownerOrGuardianName ? ` · ${pat.ownerOrGuardianName}` : ''}
                            {pat.address ? ` · ${pat.address}` : ''}
                          </p>
                        </div>
                      </div>
                      <span className="text-[11px] font-medium text-teal-800 shrink-0">
                        {t('Select', 'নির্বাচন')}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* Step 2: Prefilled Consultation Modal */}
      {prescribeTarget && targetPatient && (
        <ConsultationFormModal
          clinic={clinic}
          patient={targetPatient}
          isSuperAdmin={isSuperAdmin}
          prefill={buildPrefillFromIndication(prescribeTarget, prescribeSlot)}
          onClose={() => {
            setTargetPatient(null);
            setPrescribeTarget(null);
          }}
          onSaved={() => {
            const patientId = targetPatient.id;
            setTargetPatient(null);
            setPrescribeTarget(null);
            onConsultationSaved(patientId);
          }}
        />
      )}
    </div>
  );
}
