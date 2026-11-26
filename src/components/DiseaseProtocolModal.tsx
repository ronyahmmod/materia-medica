import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { CopyPlus, Loader2, Pill, Plus, Trash2, X } from 'lucide-react';
import { auth, OperationType, reportFirestoreError } from '../firebase';
import { useLanguage } from '../i18n/LanguageContext';
import {
  DISEASE_SCOPE_LABELS_I18N,
  REMEDY_TIMING_LABELS_I18N,
} from '../i18n/translations';
import {
  buildRemedyAndPotencyCatalog,
  createEmptyDiseaseRule,
  deriveRulesFromDiseaseEntry,
} from '../lib/diseaseCatalog';
import {
  ACCENT_THEME_PALETTES,
  tenantDiseaseRemedyDoc,
} from '../lib/tenantPaths';
import {
  DISEASE_ENTRY_RULE_TYPES,
  DISEASE_PATIENT_SCOPES,
  FIELD_LIMITS,
  type ClinicTenant,
  type DiseasePatientScope,
  type DiseaseRemedyEntry,
  type DiseaseSymptomRule,
  type RemedyRuleTiming,
} from '../types/clinic';

interface DiseaseProtocolModalProps {
  clinic: ClinicTenant;
  entries: DiseaseRemedyEntry[];
  existingEntry: DiseaseRemedyEntry | null;
  defaultScope?: DiseasePatientScope;
  focusRuleId?: string | null;
  onClose: () => void;
  onSaved: () => void;
}

export function DiseaseProtocolModal({
  clinic,
  entries,
  existingEntry,
  defaultScope = 'All',
  focusRuleId = null,
  onClose,
  onSaved,
}: DiseaseProtocolModalProps) {
  const { language, t } = useLanguage();
  const palette = ACCENT_THEME_PALETTES[clinic.accentColor] || ACCENT_THEME_PALETTES.teal;
  const scopeLabels = DISEASE_SCOPE_LABELS_I18N[language];
  const timingLabels = REMEDY_TIMING_LABELS_I18N[language];

  const [patientScope, setPatientScope] = useState<DiseasePatientScope>(
    existingEntry?.patientScope || defaultScope
  );
  const [diseaseName, setDiseaseName] = useState(existingEntry?.diseaseName || '');
  const [symptomRules, setSymptomRules] = useState<DiseaseSymptomRule[]>(() =>
    existingEntry ? deriveRulesFromDiseaseEntry(existingEntry) : [createEmptyDiseaseRule('general')]
  );
  const [dosageInstructions, setDosageInstructions] = useState(
    existingEntry?.dosageInstructions || ''
  );
  const [clinicalNotes, setClinicalNotes] = useState(existingEntry?.clinicalNotes || '');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [activeRemedyDropdownRuleId, setActiveRemedyDropdownRuleId] = useState<string | null>(null);
  const [activePotencyDropdownRuleId, setActivePotencyDropdownRuleId] = useState<string | null>(null);
  const [lastAddedRuleId, setLastAddedRuleId] = useState<string | null>(focusRuleId);

  const scrollContainerRef = useRef<HTMLFormElement | null>(null);
  const ruleCardRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const { remedyCatalog, potencyCatalog } = useMemo(
    () => buildRemedyAndPotencyCatalog(entries, symptomRules),
    [entries, symptomRules]
  );

  const getRemedySuggestions = (queryText: string) => {
    const q = queryText.trim().toLowerCase();
    if (!q) {
      return remedyCatalog.slice(0, 10);
    }
    const prefixMatches: typeof remedyCatalog = [];
    const wordMatches: typeof remedyCatalog = [];
    const substringMatches: typeof remedyCatalog = [];

    for (const item of remedyCatalog) {
      const lower = item.name.toLowerCase();
      if (lower.startsWith(q)) {
        prefixMatches.push(item);
      } else if (lower.split(/[\s(/]+/).some((part) => part.startsWith(q))) {
        wordMatches.push(item);
      } else if (lower.includes(q)) {
        substringMatches.push(item);
      }
    }
    return [...prefixMatches, ...wordMatches, ...substringMatches].slice(0, 12);
  };

  const getPotencySuggestions = (queryText: string) => {
    const q = queryText.trim().toLowerCase();
    if (!q) return potencyCatalog.slice(0, 12);
    const starts: string[] = [];
    const contains: string[] = [];
    for (const pot of potencyCatalog) {
      const lower = pot.toLowerCase();
      if (lower.startsWith(q)) starts.push(pot);
      else if (lower.includes(q)) contains.push(pot);
    }
    return [...starts, ...contains].slice(0, 12);
  };

  useEffect(() => {
    if (!lastAddedRuleId) return;
    const el = ruleCardRefs.current[lastAddedRuleId];
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    setLastAddedRuleId(null);
  }, [lastAddedRuleId, symptomRules.length]);

  const updateRule = (id: string, patch: Partial<DiseaseSymptomRule>) => {
    setSymptomRules((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const addRuleRow = () => {
    if (symptomRules.length >= 50) return;
    const nextRule = createEmptyDiseaseRule('general');
    setSymptomRules((prev) => [...prev, nextRule]);
    setLastAddedRuleId(nextRule.id);
  };

  const addMedicineSameSymptomRow = (sourceRule?: DiseaseSymptomRule) => {
    if (symptomRules.length >= 50) return;
    const fallbackRule = sourceRule || symptomRules[symptomRules.length - 1];
    const nextRule: DiseaseSymptomRule = {
      ...createEmptyDiseaseRule(fallbackRule?.timing || 'general'),
      symptom: fallbackRule?.symptom || diseaseName.trim(),
      notes: fallbackRule?.notes || '',
    };
    setSymptomRules((prev) => {
      if (!sourceRule) return [...prev, nextRule];
      const idx = prev.findIndex((r) => r.id === sourceRule.id);
      if (idx === -1) return [...prev, nextRule];
      const copy = [...prev];
      copy.splice(idx + 1, 0, nextRule);
      return copy;
    });
    setLastAddedRuleId(nextRule.id);
  };

  const removeRuleRow = (id: string) => {
    if (symptomRules.length <= 1) return;
    setSymptomRules((prev) => prev.filter((r) => r.id !== id));
  };

  const handleSaveEntry = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const cleanDisease = diseaseName.trim();
    if (!cleanDisease) {
      setFormError(t('Disease name is required.', 'রোগের নাম আবশ্যক।'));
      scrollContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    const nonEmptyRows = symptomRules.filter(
      (r) => r.symptom.trim().length > 0 || r.remedyName.trim().length > 0
    );

    if (nonEmptyRows.length === 0) {
      setFormError(
        t(
          'Add at least one symptom and medicine name.',
          'কমপক্ষে একটি লক্ষণ ও ঔষধের নাম যোগ করুন।'
        )
      );
      return;
    }

    const sanitizedRules: DiseaseSymptomRule[] = [];
    let lastValidSymptom =
      nonEmptyRows.find((r) => r.symptom.trim().length > 0)?.symptom.trim() || cleanDisease;

    for (let idx = 0; idx < nonEmptyRows.length; idx += 1) {
      const rule = nonEmptyRows[idx];
      const rawSym = rule.symptom.trim();
      const rem = rule.remedyName.trim();
      const pot = (rule.potency || '').trim();

      if (!rem) {
        setFormError(
          t(
            `Rule #${idx + 1} is missing a Remedy Name.`,
            `সারি #${idx + 1}-এ ঔষধের নাম পূরণ করা আবশ্যক।`
          )
        );
        ruleCardRefs.current[rule.id]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }

      // If practitioner added/edited a medicine without retyping a symptom, inherit previous symptom or disease name
      const resolvedSymptom = rawSym || lastValidSymptom || cleanDisease;
      if (rawSym) {
        lastValidSymptom = rawSym;
      }

      const validTiming: RemedyRuleTiming = (
        ['general', 'morning', 'afternoon', 'companion-morning', 'companion-afternoon', 'biochemic'] as const
      ).includes(rule.timing)
        ? rule.timing
        : 'general';

      const cleanRule: DiseaseSymptomRule = {
        id: (rule.id || `rule_${crypto.randomUUID().slice(0, 8)}`).slice(0, 64),
        symptom: resolvedSymptom.slice(0, FIELD_LIMITS.ruleSymptomMax),
        remedyName: rem.slice(0, FIELD_LIMITS.remedyNameMax),
        potency: pot.slice(0, FIELD_LIMITS.potencyMax),
        timing: validTiming,
      };
      if (rule.doseOrUnit?.trim()) {
        cleanRule.doseOrUnit = rule.doseOrUnit.trim().slice(0, FIELD_LIMITS.ruleUnitMax);
      }
      if (rule.notes?.trim()) {
        cleanRule.notes = rule.notes.trim().slice(0, FIELD_LIMITS.ruleNotesMax);
      }
      sanitizedRules.push(cleanRule);
    }

    const uid = auth.currentUser?.uid;
    if (!uid) {
      setFormError(t('Sign-in is required to save changes.', 'সংরক্ষণ করতে সাইন-ইন প্রয়োজন।'));
      return;
    }

    const combinedSymptoms = sanitizedRules
      .map((r) => {
        const remLabel = [r.remedyName, r.potency].filter(Boolean).join(' ');
        return r.doseOrUnit ? `${r.symptom} [${remLabel} · ${r.doseOrUnit}]` : r.symptom;
      })
      .join('\n')
      .slice(0, FIELD_LIMITS.diseaseSymptomsMax);

    const morningRule =
      sanitizedRules.find((r) => r.timing === 'morning') ||
      sanitizedRules.find((r) => r.timing !== 'biochemic') ||
      sanitizedRules[0];
    const afternoonRule =
      sanitizedRules.find((r) => r.timing === 'afternoon') ||
      sanitizedRules.find((r) => r.id !== morningRule.id && r.timing !== 'biochemic');

    const entryId =
      existingEntry?.id || `dis_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const path = `clinics/${clinic.id}/disease_remedies/${entryId}`;

    const accessEmails =
      clinic.accessEmails && clinic.accessEmails.length > 0
        ? clinic.accessEmails
        : [clinic.ownerEmail.trim().toLowerCase()].filter(Boolean);
    const accessUids =
      clinic.authorizedUids && clinic.authorizedUids.length > 0
        ? clinic.authorizedUids
        : [uid];

    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        clinicAccessEmails: accessEmails,
        clinicAccessUids: accessUids,
        patientScope,
        diseaseName: cleanDisease.slice(0, FIELD_LIMITS.diseaseNameMax),
        symptoms: (combinedSymptoms || cleanDisease).slice(0, FIELD_LIMITS.diseaseSymptomsMax),
        symptomRules: sanitizedRules,
        firstRemedyMorning: morningRule.remedyName.slice(0, FIELD_LIMITS.remedyNameMax),
        firstRemedyPotency: (morningRule.potency || '').slice(0, FIELD_LIMITS.potencyMax),
        secondRemedyAfternoon: afternoonRule
          ? afternoonRule.remedyName.slice(0, FIELD_LIMITS.remedyNameMax)
          : '',
        secondRemedyPotency: afternoonRule
          ? (afternoonRule.potency || '').slice(0, FIELD_LIMITS.potencyMax)
          : '',
        dosageInstructions: dosageInstructions.trim().slice(0, FIELD_LIMITS.dosageMax),
        clinicalNotes: clinicalNotes.trim().slice(0, FIELD_LIMITS.symptomNotesMax),
        updatedAt: serverTimestamp(),
      };

      if (existingEntry) {
        if (!existingEntry.clinicId) {
          payload.clinicId = clinic.id;
        }
        await updateDoc(tenantDiseaseRemedyDoc(clinic.id, entryId), payload);
      } else {
        payload.clinicId = clinic.id;
        payload.createdBy = uid;
        payload.createdAt = serverTimestamp();
        await setDoc(tenantDiseaseRemedyDoc(clinic.id, entryId), payload);
      }

      onSaved();
    } catch (error) {
      const msg = reportFirestoreError(
        error,
        existingEntry ? OperationType.UPDATE : OperationType.CREATE,
        path
      );
      if (msg.toLowerCase().includes('permission')) {
        const signedInEmail = (auth.currentUser?.email || 'unknown').toLowerCase();
        const providerId = auth.currentUser?.providerData?.[0]?.providerId || 'unknown';
        const op = existingEntry ? 'update' : 'create';
        const uidOk = Boolean(clinic.authorizedUids?.includes(uid));
        const emailOk = Boolean(clinic.accessEmails?.includes(signedInEmail));
        const allowedKeys = new Set([
          'id',
          'clinicId',
          'clinicAccessEmails',
          'clinicAccessUids',
          'patientScope',
          'diseaseName',
          'symptoms',
          'symptomRules',
          'firstRemedyMorning',
          'firstRemedyPotency',
          'secondRemedyAfternoon',
          'secondRemedyPotency',
          'dosageInstructions',
          'clinicalNotes',
          'isDeleted',
          'deletedAt',
          'deletedBy',
          'restoredAt',
          'createdBy',
          'createdAt',
          'updatedAt',
        ]);
        const extraKeys = existingEntry
          ? Object.keys(existingEntry).filter((k) => !allowedKeys.has(k))
          : [];
        const flags = [
          `op:${op}`,
          `uidOk:${uidOk}`,
          `emailOk:${emailOk}`,
          `cId:${Boolean(existingEntry?.clinicId ?? true)}`,
          `cBy:${Boolean(existingEntry?.createdBy ?? true)}`,
          `cAt:${Boolean(existingEntry?.createdAt ?? true)}`,
          ...(extraKeys.length > 0 ? [`extra:${extraKeys.join(',')}`] : []),
        ].join(' ');
        const diag = `[${signedInEmail} · ${providerId} · status:${clinic.subscriptionStatus} · ${flags}] ${msg}`;
        setFormError(
          t(
            `Permission denied while saving (${diag}). Please refresh the page or check clinic access permissions.`,
            `সংরক্ষণের অনুমতি পাওয়া যায়নি (${diag})। পেজ রিলোড করে আবার চেষ্টা করুন বা ক্লিনিক অ্যাক্সেস যাচাই করুন।`
          )
        );
      } else {
        setFormError(
          msg || t('Unable to save disease protocol.', 'রোগ ও ঔষধের তথ্য সংরক্ষণ করা যায়নি।')
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-3xl my-8 overflow-hidden shadow-2xl">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-lg font-semibold text-slate-900">
              {existingEntry
                ? t('Edit Disease, Symptoms & Medicines', 'রোগ, লক্ষণ ও ঔষধ সম্পাদনা')
                : t('Add Disease with Symptoms & Remedies', 'নতুন রোগ, লক্ষণ ও ঔষধ যোগ করুন')}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {t(
                'Add or edit multiple remedies per disease or per symptom (potency is optional).',
                'একটি রোগ বা একই লক্ষণের বিপরীতে একাধিক ঔষধ যোগ ও সম্পাদনা করুন (পাওয়ার/শক্তি ঐচ্ছিক)।'
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('Close modal', 'বন্ধ করুন')}
            className="p-2 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form
          ref={scrollContainerRef}
          noValidate
          onSubmit={handleSaveEntry}
          className="p-6 space-y-5 max-h-[82vh] overflow-y-auto"
        >
          {formError && (
            <div
              className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800 font-medium"
              role="alert"
            >
              {formError}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                {t('Patient Scope *', 'রোগীর ধরন *')}
              </label>
              <select
                value={patientScope}
                onChange={(e) => setPatientScope(e.target.value as DiseasePatientScope)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
              >
                {DISEASE_PATIENT_SCOPES.map((sc) => (
                  <option key={sc} value={sc}>
                    {scopeLabels[sc]}
                  </option>
                ))}
              </select>
            </div>

            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                {t('Disease Name *', 'রোগের নাম *')}
              </label>
              <input
                type="text"
                maxLength={FIELD_LIMITS.diseaseNameMax}
                value={diseaseName}
                onChange={(e) => setDiseaseName(e.target.value)}
                placeholder={t(
                  'e.g. Abdominal Pain (পেটব্যথা), Cough (কাশি), Mastitis in Cow',
                  'যেমন: পেটব্যথা, কাশি, গরুর ওলান ফোলা, জ্বর'
                )}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
              />
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="block text-xs font-semibold text-slate-800">
                {t(
                  'Symptom-to-Remedy Rules (লক্ষণ অনুযায়ী ঔষধ) *',
                  'লক্ষণ ও ঔষধের তালিকা *'
                )}{' '}
                <span className="font-mono text-slate-500">({symptomRules.length}/50)</span>
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => addMedicineSameSymptomRow()}
                  disabled={symptomRules.length >= 50}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
                >
                  <Pill className="w-3.5 h-3.5 text-teal-700" />
                  {t('+ Add Medicine', '+ নতুন ঔষধ')}
                </button>
                <button
                  type="button"
                  onClick={addRuleRow}
                  disabled={symptomRules.length >= 50}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-teal-800 bg-teal-50 border border-teal-300 rounded-lg hover:bg-teal-100 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" />
                  {t('Add Symptom Rule', 'নতুন লক্ষণ ও ঔষধ')}
                </button>
              </div>
            </div>

            <div className="space-y-3">
              {symptomRules.map((rule, index) => {
                const ruleOptions = DISEASE_ENTRY_RULE_TYPES.includes(rule.timing)
                  ? DISEASE_ENTRY_RULE_TYPES
                  : [rule.timing, ...DISEASE_ENTRY_RULE_TYPES];

                const remedySuggestions =
                  activeRemedyDropdownRuleId === rule.id
                    ? getRemedySuggestions(rule.remedyName)
                    : [];
                const potencySuggestions =
                  activePotencyDropdownRuleId === rule.id
                    ? getPotencySuggestions(rule.potency || '')
                    : [];
                const isHighlighted = focusRuleId === rule.id;

                return (
                  <div
                    key={rule.id}
                    ref={(el) => {
                      ruleCardRefs.current[rule.id] = el;
                    }}
                    className={`border rounded-xl p-4 space-y-3 ${
                      isHighlighted
                        ? 'border-teal-500 bg-teal-50/40'
                        : 'border-slate-200 bg-slate-50/70'
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-700 font-mono">
                        #{index + 1}
                      </span>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          disabled={symptomRules.length >= 50}
                          onClick={() => addMedicineSameSymptomRow(rule)}
                          title={t(
                            'Add another remedy for this same symptom',
                            'এই একই লক্ষণে আরেকটি ঔষধ যোগ করুন'
                          )}
                          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-teal-800 bg-white border border-teal-200 rounded-md hover:bg-teal-50 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
                        >
                          <CopyPlus className="w-3 h-3" />
                          {t('+ Remedy (Same Symptom)', '+ একই লক্ষণে আরেকটি ঔষধ')}
                        </button>
                        <select
                          value={rule.timing}
                          onChange={(e) =>
                            updateRule(rule.id, { timing: e.target.value as RemedyRuleTiming })
                          }
                          className="px-2.5 py-1 text-xs border border-slate-300 rounded-md bg-white text-slate-800"
                        >
                          {ruleOptions.map((tm) => (
                            <option key={tm} value={tm}>
                              {tm === 'general'
                                ? t('Homeopathic (General)', 'হোমিওপ্যাথিক ঔষধ')
                                : tm === 'biochemic'
                                  ? t('Biochemic', 'বায়োকেমিক ঔষধ')
                                  : timingLabels[tm]}
                            </option>
                          ))}
                        </select>
                        {symptomRules.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeRuleRow(rule.id)}
                            aria-label={t('Remove symptom row', 'সারি মুছুন')}
                            className="p-1 text-slate-400 hover:text-red-700 rounded hover:bg-white cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>

                    <div>
                      <label className="block text-[11px] font-medium text-slate-700 mb-1">
                        {t(
                          'Specific Symptom / Indication (inherits above symptom if blank)',
                          'নির্দিষ্ট লক্ষণ ও ব্যথার ধরন (খালি রাখলে আগের লক্ষণ বা রোগের নাম ব্যবহৃত হবে)'
                        )}
                      </label>
                      <input
                        type="text"
                        maxLength={FIELD_LIMITS.ruleSymptomMax}
                        value={rule.symptom}
                        onChange={(e) => updateRule(rule.id, { symptom: e.target.value })}
                        placeholder={t(
                          'e.g. Cramping pain better bending double or firm pressure',
                          'যেমন: সামনের দিকে ঝুঁকলে বা চাপ দিলে পেটের কামড়ানো ব্যথা কমে / কাশতে কাশতে কুঁজো হয়ে যাওয়া'
                        )}
                        className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                      />
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
                      <div className="sm:col-span-5 relative">
                        <label className="block text-[11px] font-medium text-slate-700 mb-1">
                          {t('Remedy Name *', 'ঔষধের নাম *')}
                        </label>
                        <input
                          type="text"
                          autoComplete="off"
                          maxLength={FIELD_LIMITS.remedyNameMax}
                          value={rule.remedyName}
                          onFocus={() => setActiveRemedyDropdownRuleId(rule.id)}
                          onBlur={() => {
                            window.setTimeout(() => {
                              setActiveRemedyDropdownRuleId((cur) =>
                                cur === rule.id ? null : cur
                              );
                            }, 140);
                          }}
                          onChange={(e) => {
                            updateRule(rule.id, { remedyName: e.target.value });
                            setActiveRemedyDropdownRuleId(rule.id);
                          }}
                          placeholder={t(
                            'Type 1st letter (e.g. C, A, B)...',
                            'প্রথম অক্ষর লিখুন (যেমন: C, A, B)...'
                          )}
                          className="w-full px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                        />
                        {activeRemedyDropdownRuleId === rule.id &&
                          remedySuggestions.length > 0 && (
                            <div className="absolute left-0 right-0 top-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-30 max-h-56 overflow-y-auto divide-y divide-slate-100">
                              <div className="px-2.5 py-1 bg-slate-50 text-[10px] font-medium text-slate-500 flex items-center justify-between">
                                <span>
                                  {t('Suggested Remedies & Potency', 'সম্ভাব্য ঔষধ ও পাওয়ার')}
                                </span>
                                <span>{remedySuggestions.length}</span>
                              </div>
                              {remedySuggestions.map((item) => (
                                <div
                                  key={item.name}
                                  className="px-2.5 py-1.5 hover:bg-teal-50/70 flex items-center justify-between gap-2 text-xs"
                                >
                                  <button
                                    type="button"
                                    onMouseDown={(e) => {
                                      e.preventDefault();
                                      updateRule(rule.id, {
                                        remedyName: item.name,
                                      });
                                      setActiveRemedyDropdownRuleId(null);
                                    }}
                                    className="flex-1 text-left font-medium text-slate-900 truncate cursor-pointer"
                                  >
                                    {item.name}
                                  </button>
                                  <div className="flex items-center gap-1 shrink-0">
                                    {item.potencies.slice(0, 3).map((pot) => (
                                      <button
                                        key={pot}
                                        type="button"
                                        onMouseDown={(e) => {
                                          e.preventDefault();
                                          updateRule(rule.id, {
                                            remedyName: item.name,
                                            potency: pot,
                                          });
                                          setActiveRemedyDropdownRuleId(null);
                                        }}
                                        className="px-1.5 py-0.5 text-[10px] font-mono font-semibold bg-teal-50 text-teal-800 border border-teal-200 rounded hover:bg-teal-700 hover:text-white transition-colors cursor-pointer"
                                      >
                                        {pot}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                      </div>

                      <div className="sm:col-span-3 relative">
                        <label className="block text-[11px] font-medium text-slate-700 mb-1">
                          {t('Potency (Optional)', 'পাওয়ার / শক্তি (ঐচ্ছিক)')}
                        </label>
                        <input
                          type="text"
                          autoComplete="off"
                          maxLength={FIELD_LIMITS.potencyMax}
                          value={rule.potency || ''}
                          onFocus={() => setActivePotencyDropdownRuleId(rule.id)}
                          onBlur={() => {
                            window.setTimeout(() => {
                              setActivePotencyDropdownRuleId((cur) =>
                                cur === rule.id ? null : cur
                              );
                            }, 140);
                          }}
                          onChange={(e) => {
                            updateRule(rule.id, { potency: e.target.value });
                            setActivePotencyDropdownRuleId(rule.id);
                          }}
                          placeholder={t('Optional (30C / 200C)', 'ঐচ্ছিক (30C / 200C)')}
                          className="w-full px-3 py-1.5 text-xs font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                        />
                        {activePotencyDropdownRuleId === rule.id &&
                          potencySuggestions.length > 0 && (
                            <div className="absolute left-0 right-0 top-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-30 max-h-48 overflow-y-auto p-1.5 grid grid-cols-2 gap-1">
                              {potencySuggestions.map((pot) => (
                                <button
                                  key={pot}
                                  type="button"
                                  onMouseDown={(e) => {
                                    e.preventDefault();
                                    updateRule(rule.id, { potency: pot });
                                    setActivePotencyDropdownRuleId(null);
                                  }}
                                  className={`px-2 py-1 text-left text-[11px] font-mono rounded hover:bg-teal-50 hover:text-teal-900 cursor-pointer truncate ${
                                    rule.potency === pot
                                      ? 'bg-teal-50 font-semibold text-teal-800'
                                      : 'text-slate-700'
                                  }`}
                                >
                                  {pot}
                                </button>
                              ))}
                            </div>
                          )}
                      </div>

                      <div className="sm:col-span-4">
                        <label className="block text-[11px] font-medium text-slate-700 mb-1">
                          {t('Ounce / Globules / Phial', 'পরিমাণ (আউন্স / বড়ি / ফাইল)')}
                        </label>
                        <input
                          type="text"
                          list="disease-unit-list-shared"
                          maxLength={FIELD_LIMITS.ruleUnitMax}
                          value={rule.doseOrUnit || ''}
                          onChange={(e) => updateRule(rule.id, { doseOrUnit: e.target.value })}
                          placeholder={t('e.g. ৩০ আউন্স / ৩০ বড়ি', 'যেমন: ৩০ আউন্স / ৩০ বড়ি')}
                          className="w-full px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-teal-700"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-[11px] font-medium text-slate-700 mb-1">
                        {t(
                          'Modalities (< Worse / > Better) & Mental State (Optional)',
                          'হ্রাস-বৃদ্ধি ও মানসিক অবস্থা (ঐচ্ছিক)'
                        )}
                      </label>
                      <input
                        type="text"
                        maxLength={FIELD_LIMITS.ruleNotesMax}
                        value={rule.notes || ''}
                        onChange={(e) => updateRule(rule.id, { notes: e.target.value })}
                        placeholder={t(
                          'e.g. > Warmth & hard pressure; < Anger; or > Bending backward',
                          'যেমন: গরম সেঁকে আরাম, রাগে বাড়ে / পেছনের দিকে বাঁকা হলে আরাম / খাবার পর ভারী'
                        )}
                        className="w-full px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-teal-700"
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="pt-1 flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => addMedicineSameSymptomRow()}
                disabled={symptomRules.length >= 50}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-dashed border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
              >
                <Pill className="w-3.5 h-3.5 text-teal-700" />
                {t('Add New Medicine (Same Symptom)', 'নতুন ঔষধ যোগ করুন (একই লক্ষণে)')}
              </button>
              <button
                type="button"
                onClick={addRuleRow}
                disabled={symptomRules.length >= 50}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-medium text-teal-800 bg-teal-50 border border-dashed border-teal-400 rounded-lg hover:bg-teal-100 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
              >
                <Plus className="w-3.5 h-3.5" />
                {t('Add New Symptom & Remedy', 'নতুন লক্ষণ ও ঔষধ যোগ করুন')} ({symptomRules.length}/50)
              </button>
            </div>
          </div>

          <datalist id="disease-unit-list-shared">
            <option value="৩০ আউন্স" />
            <option value="১৫ আউন্স" />
            <option value="৩০ বড়ি" />
            <option value="৪০ বড়ি" />
            <option value="১ ফাইল" />
            <option value="২ ফাইল" />
          </datalist>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              {t('General Dosage & Administration', 'সাধারণ সেবন বিধি ও মাত্রা')}
            </label>
            <input
              type="text"
              maxLength={FIELD_LIMITS.dosageMax}
              value={dosageInstructions}
              onChange={(e) => setDosageInstructions(e.target.value)}
              placeholder={t(
                'e.g. 5 drops in water morning & afternoon for 5 days',
                'যেমন: সকালে ও বিকালে ৫ ফোঁটা করে পানির সাথে ৫ দিন'
              )}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              {t('Clinical Reference Notes', 'ক্লিনিক্যাল নোট')}
            </label>
            <textarea
              rows={2}
              maxLength={FIELD_LIMITS.symptomNotesMax}
              value={clinicalNotes}
              onChange={(e) => setClinicalNotes(e.target.value)}
              placeholder={t(
                'Dietary advice, follow-up interval, or differential remedies...',
                'পথ্য নির্দেশনা, ফলো-আপ পরামর্শ বা বিকল্প ঔষধ নোট...'
              )}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
            />
          </div>

          {formError && (
            <div
              className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800 font-medium"
              role="alert"
            >
              {formError}
            </div>
          )}

          <div className="pt-4 border-t border-slate-200 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer whitespace-nowrap"
            >
              {t('Cancel', 'বাতিল')}
            </button>
            <button
              type="submit"
              disabled={submitting}
              className={`inline-flex items-center gap-1.5 px-5 py-2 text-sm font-medium rounded-lg disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap ${palette.primaryBtn}`}
            >
              {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
              {submitting
                ? t('Saving...', 'সংরক্ষণ হচ্ছে...')
                : existingEntry
                  ? t('Save Changes', 'পরিবর্তন সংরক্ষণ')
                  : t('Save Disease Protocol', 'রোগ ও ঔষধ সংরক্ষণ')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
