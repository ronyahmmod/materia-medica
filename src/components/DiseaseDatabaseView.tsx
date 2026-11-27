import { useEffect, useMemo, useState } from 'react';
import {
  deleteDoc,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';
import {
  BookMarked,
  Edit3,
  Plus,
  Search,
  Send,
  Trash2,
  UserCheck,
  X,
} from 'lucide-react';
import { auth, handleFirestoreError, OperationType, reportFirestoreError } from '../firebase';
import { useLanguage } from '../i18n/LanguageContext';
import {
  DISEASE_SCOPE_LABELS_I18N,
  PATIENT_TYPE_LABELS_I18N,
  REMEDY_TIMING_LABELS_I18N,
} from '../i18n/translations';
import { deriveRulesFromDiseaseEntry } from '../lib/diseaseCatalog';
import {
  ACCENT_THEME_PALETTES,
  tenantDiseaseRemediesCol,
  tenantDiseaseRemedyDoc,
} from '../lib/tenantPaths';
import {
  DISEASE_PATIENT_SCOPES,
  type ClinicTenant,
  type DiseasePatientScope,
  type DiseaseRemedyEntry,
  type DiseaseSymptomRule,
  type Patient,
} from '../types/clinic';
import {
  ConsultationFormModal,
  type ConsultationPrefill,
} from './ConsultationFormModal';
import { DiseaseProtocolModal } from './DiseaseProtocolModal';
import { SecureClinicalImage } from './SecureClinicalImage';

interface DiseaseDatabaseViewProps {
  clinic: ClinicTenant;
  patients: Patient[];
  isSuperAdmin: boolean;
  onConsultationSaved: (patientId: string) => void;
}

export function DiseaseDatabaseView({
  clinic,
  patients,
  isSuperAdmin,
  onConsultationSaved,
}: DiseaseDatabaseViewProps) {
  const { language, t } = useLanguage();
  const palette = ACCENT_THEME_PALETTES[clinic.accentColor] || ACCENT_THEME_PALETTES.teal;
  const scopeLabels = DISEASE_SCOPE_LABELS_I18N[language];
  const patientTypeLabels = PATIENT_TYPE_LABELS_I18N[language];
  const timingLabels = REMEDY_TIMING_LABELS_I18N[language];

  const [entries, setEntries] = useState<DiseaseRemedyEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [scopeFilter, setScopeFilter] = useState<'all' | DiseasePatientScope>('all');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Add / Edit Disease Entry Modal State (Multi-Symptom -> Multi-Remedy)
  const [showFormModal, setShowFormModal] = useState(false);
  const [editingEntry, setEditingEntry] = useState<DiseaseRemedyEntry | null>(null);

  // Prescribe to Selected Patient Flow
  const [prescribePrefill, setPrescribePrefill] = useState<ConsultationPrefill | null>(null);
  const [prescribeSummaryLabel, setPrescribeSummaryLabel] = useState('');
  const [prescribeScope, setPrescribeScope] = useState<DiseasePatientScope>('All');
  const [prescribeVisitSlot, setPrescribeVisitSlot] = useState<'morning' | 'afternoon' | 'biochemic'>('morning');
  const [prescribeSingleRule, setPrescribeSingleRule] = useState<{
    entry: DiseaseRemedyEntry;
    rule: DiseaseSymptomRule;
  } | null>(null);
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
        rows.sort((a, b) => (b.updatedAt?.toMillis?.() ?? 0) - (a.updatedAt?.toMillis?.() ?? 0));
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

  const filteredEntries = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return entries.filter((entry) => {
      if (scopeFilter !== 'all' && entry.patientScope !== scopeFilter) return false;
      if (!q) return true;
      const ruleHit = (entry.symptomRules || []).some(
        (rule) =>
          rule.symptom.toLowerCase().includes(q) ||
          rule.remedyName.toLowerCase().includes(q) ||
          (rule.potency || '').toLowerCase().includes(q) ||
          (rule.doseOrUnit || '').toLowerCase().includes(q) ||
          (rule.notes || '').toLowerCase().includes(q)
      );
      return (
        ruleHit ||
        entry.diseaseName.toLowerCase().includes(q) ||
        entry.symptoms.toLowerCase().includes(q) ||
        entry.firstRemedyMorning.toLowerCase().includes(q) ||
        (entry.firstRemedyPotency || '').toLowerCase().includes(q) ||
        (entry.secondRemedyAfternoon || '').toLowerCase().includes(q) ||
        (entry.secondRemedyPotency || '').toLowerCase().includes(q) ||
        (entry.dosageInstructions || '').toLowerCase().includes(q) ||
        (entry.clinicalNotes || '').toLowerCase().includes(q)
      );
    });
  }, [entries, scopeFilter, searchQuery]);

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

    if (!prescribePrefill || prescribeScope === 'All') {
      return filtered;
    }

    return [...filtered].sort((a, b) => {
      const aVet = a.patientType && a.patientType !== 'Human';
      const bVet = b.patientType && b.patientType !== 'Human';
      const wantVet = prescribeScope === 'Veterinary';
      const aMatch = wantVet ? aVet : !aVet;
      const bMatch = wantVet ? bVet : !bVet;
      if (aMatch === bMatch) return 0;
      return aMatch ? -1 : 1;
    });
  }, [patients, patientPickerQuery, prescribePrefill, prescribeScope]);

  const openCreateModal = () => {
    setEditingEntry(null);
    setShowFormModal(true);
  };

  const openEditModal = (entry: DiseaseRemedyEntry) => {
    setEditingEntry(entry);
    setShowFormModal(true);
  };

  const handleDeleteEntry = async (entryId: string) => {
    setActionError(null);
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    try {
      await deleteDoc(tenantDiseaseRemedyDoc(clinic.id, entryId));
      setConfirmDeleteId(null);
    } catch (error) {
      const msg = reportFirestoreError(
        error,
        OperationType.DELETE,
        `clinics/${clinic.id}/disease_remedies/${entryId}`
      );
      setActionError(
        msg || t('Unable to remove protocol.', 'রোগের প্রোটোকল মুছে ফেলা যায়নি।')
      );
    }
  };

  const mapRuleUnitToPrefill = (prefill: ConsultationPrefill, doseOrUnit?: string) => {
    const u = (doseOrUnit || '').trim();
    if (!u) return;
    const lower = u.toLowerCase();
    if (lower.includes('বড়ি') || lower.includes('বড়ি') || lower.includes('glob') || lower.includes('pill')) {
      prefill.globulesDose = u;
    } else if (lower.includes('আউন্স') || lower.includes('oz') || lower.includes('ounce')) {
      prefill.ounceAmount = u;
    } else if (lower.includes('ফাইল') || lower.includes('phial')) {
      prefill.phialCount = u;
    }
  };

  const buildPrefillForSingleRule = (
    entry: DiseaseRemedyEntry,
    rule: DiseaseSymptomRule,
    slot: 'morning' | 'afternoon' | 'biochemic'
  ): ConsultationPrefill => {
    const prefill: ConsultationPrefill = {
      diseaseName: entry.diseaseName,
      presentingSymptoms: `[${entry.diseaseName}] ${rule.symptom}`,
      dosage: entry.dosageInstructions || '',
      clinicalNotes: rule.notes || entry.clinicalNotes || '',
    };

    if (slot === 'afternoon') {
      prefill.secondRemedyAfternoon = rule.remedyName;
      prefill.secondRemedyPotency = rule.potency || '';
    } else if (slot === 'biochemic') {
      prefill.biochemicMedicine = [rule.remedyName, rule.potency].filter(Boolean).join(' ').trim();
    } else {
      prefill.firstRemedyMorning = rule.remedyName;
      prefill.firstRemedyPotency = rule.potency || '';
    }

    mapRuleUnitToPrefill(prefill, rule.doseOrUnit);
    return prefill;
  };

  const openPrescribeForEntry = (entry: DiseaseRemedyEntry) => {
    const rules = deriveRulesFromDiseaseEntry(entry);
    const prefill: ConsultationPrefill = {
      diseaseName: entry.diseaseName,
      presentingSymptoms: rules.map((r) => `[${entry.diseaseName}] ${r.symptom}`).join('\n'),
      dosage: entry.dosageInstructions || '',
      clinicalNotes: entry.clinicalNotes || '',
    };

    for (const rule of rules) {
      if (rule.timing === 'morning' && !prefill.firstRemedyMorning) {
        prefill.firstRemedyMorning = rule.remedyName;
        prefill.firstRemedyPotency = rule.potency;
      } else if (rule.timing === 'afternoon' && !prefill.secondRemedyAfternoon) {
        prefill.secondRemedyAfternoon = rule.remedyName;
        prefill.secondRemedyPotency = rule.potency;
      } else if (rule.timing === 'companion-morning' && !prefill.firstRemedyCompanion) {
        prefill.firstRemedyCompanion = rule.remedyName;
      } else if (rule.timing === 'companion-afternoon' && !prefill.secondRemedyCompanion) {
        prefill.secondRemedyCompanion = rule.remedyName;
      } else if (rule.timing === 'biochemic' && !prefill.biochemicMedicine) {
        prefill.biochemicMedicine = [rule.remedyName, rule.potency].filter(Boolean).join(' ').trim();
      } else if (rule.timing === 'general') {
        if (!prefill.firstRemedyMorning) {
          prefill.firstRemedyMorning = rule.remedyName;
          prefill.firstRemedyPotency = rule.potency || '';
        } else if (!prefill.secondRemedyAfternoon) {
          prefill.secondRemedyAfternoon = rule.remedyName;
          prefill.secondRemedyPotency = rule.potency || '';
        }
      }
      mapRuleUnitToPrefill(prefill, rule.doseOrUnit);
    }

    if (!prefill.firstRemedyMorning) {
      prefill.firstRemedyMorning = entry.firstRemedyMorning;
      prefill.firstRemedyPotency = entry.firstRemedyPotency || '';
    }

    setPatientPickerQuery('');
    setTargetPatient(null);
    setPrescribeSingleRule(null);
    setPrescribeScope(entry.patientScope || 'All');
    setPrescribeSummaryLabel(
      `${entry.diseaseName} · ${[prefill.firstRemedyMorning, prefill.firstRemedyPotency].filter(Boolean).join(' ')}`
    );
    setPrescribePrefill(prefill);
  };

  const openPrescribeForSingleRule = (entry: DiseaseRemedyEntry, rule: DiseaseSymptomRule) => {
    const initialSlot: 'morning' | 'afternoon' | 'biochemic' =
      rule.timing === 'biochemic'
        ? 'biochemic'
        : rule.timing === 'afternoon'
          ? 'afternoon'
          : 'morning';

    setPatientPickerQuery('');
    setTargetPatient(null);
    setPrescribeVisitSlot(initialSlot);
    setPrescribeSingleRule({ entry, rule });
    setPrescribeScope(entry.patientScope || 'All');
    setPrescribeSummaryLabel(
      `${entry.diseaseName} (${rule.symptom}) · ${[rule.remedyName, rule.potency].filter(Boolean).join(' ')}${rule.doseOrUnit ? ` · ${rule.doseOrUnit}` : ''}`
    );
    setPrescribePrefill(buildPrefillForSingleRule(entry, rule, initialSlot));
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
            {t('Disease, Symptoms & Remedy Database', 'রোগ, লক্ষণ ও ঔষধ ডেটাবেস')}
          </h1>
          <p className="text-sm text-slate-500 mt-0.5 tabular-nums">
            {entries.length} {t('saved diseases', 'টি সংরক্ষিত রোগ')} ·{' '}
            {t(
              'Map multiple symptoms per disease to specific remedies, potencies & units',
              'একটি রোগের একাধিক লক্ষণের জন্য আলাদা ঔষধ, শক্তি ও পরিমাণ সংরক্ষণ করুন'
            )}
          </p>
        </div>

        <button
          type="button"
          onClick={openCreateModal}
          className={`inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg transition-colors cursor-pointer whitespace-nowrap shrink-0 self-start sm:self-auto ${palette.primaryBtn}`}
        >
          <Plus className="w-3.5 h-3.5" />
          {t('Add Disease & Symptom Rules', 'নতুন রোগ ও লক্ষণ-ঔষধ যোগ করুন')}
        </button>
      </div>

      {/* Search & Scope Filter Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t(
              'Search disease name, symptoms, remedy, potency, ounce...',
              'রোগের নাম, লক্ষণ, ঔষধ, শক্তি বা আউন্স লিখে খুঁজুন...'
            )}
            className="w-full pl-9 pr-3 py-2 text-xs bg-slate-50 border border-slate-300 rounded-lg focus:outline-none focus:bg-white focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
          />
        </div>

        <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg shrink-0 self-start md:self-auto">
          {(['all', ...DISEASE_PATIENT_SCOPES] as const).map((scope) => (
            <button
              key={scope}
              type="button"
              onClick={() => setScopeFilter(scope)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
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

      {actionError && (
        <div className="p-3.5 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800">
          {actionError}
        </div>
      )}

      {/* Results Grid */}
      {loading ? (
        <div className="bg-white border border-slate-200 rounded-xl p-8 space-y-3">
          <div className="h-5 bg-slate-100 rounded w-1/3" />
          <div className="h-14 bg-slate-100 rounded" />
          <div className="h-14 bg-slate-100 rounded" />
        </div>
      ) : filteredEntries.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-12 text-center">
          <BookMarked className="w-7 h-7 text-slate-400 mx-auto mb-3" />
          <h2 className="font-display text-base font-semibold text-slate-900">
            {entries.length === 0
              ? t('No disease protocols saved yet', 'এখনও কোনো রোগ ও ঔষধ সংরক্ষিত নেই')
              : t('No matching disease protocols found', 'মিল থাকা কোনো রোগ বা লক্ষণ পাওয়া যায়নি')}
          </h2>
          <p className="text-xs text-slate-500 mt-1 mb-5 max-w-md mx-auto">
            {entries.length === 0
              ? t(
                  'Create a structured clinical encyclopedia: add a Disease (e.g. Cough) and map each symptom to its specific remedy, potency, and ounce/globule unit.',
                  'একটি রোগ (যেমন: কাশি) যোগ করে তার প্রতিটি লক্ষণের (যেমন: কাশতে কাশতে কুঁজো হয়ে যাওয়া) জন্য আলাদা ঔষধ, শক্তি ও আউন্স/বড়ি সংরক্ষণ করুন।'
                )
              : t(
                  'Try adjusting your search keywords or switching the scope filter.',
                  'অনুসন্ধান শব্দ পরিবর্তন করুন বা ফিল্টার বদলে দেখুন।'
                )}
          </p>
          {entries.length === 0 && (
            <button
              type="button"
              onClick={openCreateModal}
              className={`inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg transition-colors cursor-pointer ${palette.primaryBtn}`}
            >
              <Plus className="w-3.5 h-3.5" />
              {t('Add First Disease Guide', 'প্রথম রোগ ও ঔষধ যোগ করুন')}
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {filteredEntries.map((entry) => {
            const isDeleting = confirmDeleteId === entry.id;
            const rules = deriveRulesFromDiseaseEntry(entry);

            return (
              <article
                key={entry.id}
                className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-4"
              >
                <div className="space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2 mb-1.5">
                        <span
                          className={`inline-block px-2 py-0.5 text-[10px] font-semibold rounded-md border ${
                            entry.patientScope === 'Veterinary'
                              ? 'bg-amber-50 text-amber-900 border-amber-200'
                              : entry.patientScope === 'Human'
                                ? 'bg-teal-50 text-teal-900 border-teal-200'
                                : 'bg-slate-100 text-slate-700 border-slate-200'
                          }`}
                        >
                          {scopeLabels[entry.patientScope] || entry.patientScope}
                        </span>
                        <span className="text-[11px] font-mono text-slate-500 tabular-nums">
                          {rules.length} {t('symptom rules', 'টি লক্ষণ-নিয়ম')}
                        </span>
                      </div>
                      <h3 className="font-display text-base font-semibold text-slate-900 leading-snug">
                        {entry.diseaseName}
                      </h3>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => openEditModal(entry)}
                        aria-label={t('Edit protocol', 'সম্পাদনা')}
                        className="p-1.5 text-slate-400 hover:text-slate-900 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(isDeleting ? null : entry.id)}
                        aria-label={t('Delete protocol', 'মুছুন')}
                        className="p-1.5 text-slate-400 hover:text-red-700 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {isDeleting && (
                    <div className="p-2.5 bg-red-50 border border-red-200 rounded-lg flex items-center justify-between gap-2 text-xs">
                      <span className="text-red-900">
                        {t('Delete this protocol permanently?', 'এই তথ্যটি স্থায়ীভাবে মুছে ফেলবেন?')}
                      </span>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleDeleteEntry(entry.id)}
                          className="px-2.5 py-1 text-xs font-medium text-white bg-red-700 rounded hover:bg-red-800 cursor-pointer"
                        >
                          {t('Delete', 'মুছুন')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="px-2 py-1 text-xs text-slate-700 hover:text-slate-900 cursor-pointer"
                        >
                          {t('Cancel', 'বাতিল')}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Multi-Symptom -> Remedy Rules List */}
                  <div className="space-y-2">
                    {rules.map((rule) => (
                      <div
                        key={rule.id}
                        className="rounded-lg border border-slate-200 bg-slate-50/70 p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5"
                      >
                        <div className="min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span
                              className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${
                                rule.timing === 'general'
                                  ? 'bg-slate-100 text-slate-700 border-slate-200'
                                  : rule.timing === 'biochemic'
                                    ? 'bg-sky-50 text-sky-900 border-sky-200'
                                    : 'bg-amber-50 text-amber-900 border-amber-200'
                              }`}
                            >
                              {rule.timing === 'general'
                                ? t('Homeopathic', 'হোমিওপ্যাথিক')
                                : timingLabels[rule.timing]}
                            </span>
                            {rule.doseOrUnit && (
                              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-teal-50 text-teal-900 border border-teal-200">
                                {rule.doseOrUnit}
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-slate-800 leading-snug">{rule.symptom}</p>
                          <p className="text-xs font-semibold text-slate-900">
                            {rule.remedyName}
                            {rule.potency ? (
                              <span className="font-mono text-teal-800 ml-1">{rule.potency}</span>
                            ) : null}
                          </p>
                          {rule.notes && (
                            <p className="text-[11px] text-slate-500">{rule.notes}</p>
                          )}
                        </div>

                        <button
                          type="button"
                          disabled={patients.filter((p) => !p.isDeleted).length === 0}
                          onClick={() => openPrescribeForSingleRule(entry, rule)}
                          className="self-start sm:self-center shrink-0 px-2.5 py-1.5 text-[11px] font-medium text-teal-800 bg-white border border-teal-300 rounded-md hover:bg-teal-50 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
                        >
                          {t('Prescribe Rule', 'এই ঔষধ দিন')}
                        </button>
                      </div>
                    ))}
                  </div>

                  {entry.dosageInstructions && (
                    <p className="text-xs text-slate-600">
                      <span className="font-medium text-slate-700">
                        {t('Dosage:', 'সেবন বিধি:')}{' '}
                      </span>
                      {entry.dosageInstructions}
                    </p>
                  )}

                  {entry.clinicalNotes && (
                    <p className="text-xs text-slate-500 leading-relaxed">{entry.clinicalNotes}</p>
                  )}
                </div>

                <div className="pt-3 border-t border-slate-100 flex items-center justify-end">
                  <button
                    type="button"
                    disabled={patients.filter((p) => !p.isDeleted).length === 0}
                    onClick={() => openPrescribeForEntry(entry)}
                    className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap ${palette.primaryBtn}`}
                  >
                    <Send className="w-3.5 h-3.5" />
                    {t('Prescribe Full Disease Protocol', 'পুরো রোগের প্রোটোকল রোগীকে দিন')}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* Add / Edit Multi-Symptom Disease Modal */}
      {showFormModal && (
        <DiseaseProtocolModal
          clinic={clinic}
          entries={entries}
          existingEntry={editingEntry}
          defaultScope={scopeFilter === 'all' ? 'All' : scopeFilter}
          onClose={() => {
            setShowFormModal(false);
            setEditingEntry(null);
          }}
          onSaved={() => {
            setShowFormModal(false);
            setEditingEntry(null);
          }}
        />
      )}

      {/* Step 1 of Prescribe Flow: Patient Selector Modal */}
      {prescribePrefill && !targetPatient && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-lg my-8 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 className="font-display text-base font-semibold text-slate-900 flex items-center gap-2">
                  <UserCheck className="w-4 h-4 text-teal-700 shrink-0" />
                  <span>{t('Select Patient to Prescribe', 'চিকিৎসার জন্য রোগী নির্বাচন করুন')}</span>
                </h2>
                <p className="text-xs text-slate-500 truncate mt-0.5">{prescribeSummaryLabel}</p>
              </div>
              <button
                type="button"
                onClick={() => setPrescribePrefill(null)}
                aria-label={t('Close modal', 'বন্ধ করুন')}
                className="p-1.5 text-slate-400 hover:text-slate-900 rounded-lg hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 border-b border-slate-200 bg-slate-50 space-y-3">
              {prescribeSingleRule && (
                <div className="flex flex-wrap items-center justify-between gap-2 bg-white border border-slate-200 rounded-lg px-3 py-2">
                  <span className="text-[11px] font-medium text-slate-700">
                    {t('Visit Time Slot (ভিজিটে সেবন সময়):', 'ভিজিটে সেবনের সময় নির্বাচন করুন:')}
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
                        onClick={() => {
                          setPrescribeVisitSlot(slotOption.id);
                          setPrescribePrefill(
                            buildPrefillForSingleRule(
                              prescribeSingleRule.entry,
                              prescribeSingleRule.rule,
                              slotOption.id
                            )
                          );
                        }}
                        className={`px-2.5 py-1 text-[11px] font-medium rounded-md border cursor-pointer transition-colors ${
                          prescribeVisitSlot === slotOption.id
                            ? 'bg-teal-700 text-white border-teal-700'
                            : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                        }`}
                      >
                        {t(slotOption.en, slotOption.bn)}
                      </button>
                    ))}
                  </div>
                </div>
              )}

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

      {/* Step 2 of Prescribe Flow: Prefilled ConsultationFormModal */}
      {prescribePrefill && targetPatient && (
        <ConsultationFormModal
          clinic={clinic}
          patient={targetPatient}
          isSuperAdmin={isSuperAdmin}
          prefill={prescribePrefill}
          onClose={() => {
            setTargetPatient(null);
            setPrescribePrefill(null);
          }}
          onSaved={() => {
            const patientId = targetPatient.id;
            setTargetPatient(null);
            setPrescribePrefill(null);
            onConsultationSaved(patientId);
          }}
        />
      )}
    </div>
  );
}
