import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  BookMarked,
  CopyPlus,
  Edit3,
  Plus,
  Search,
  Send,
  Trash2,
  UserCheck,
  X,
} from 'lucide-react';
import { auth, handleFirestoreError, OperationType } from '../firebase';
import { useLanguage } from '../i18n/LanguageContext';
import {
  DISEASE_SCOPE_LABELS_I18N,
  PATIENT_TYPE_LABELS_I18N,
  REMEDY_TIMING_LABELS_I18N,
} from '../i18n/translations';
import {
  ACCENT_THEME_PALETTES,
  buildSoftDeletePayload,
  tenantDiseaseRemediesCol,
  tenantDiseaseRemedyDoc,
} from '../lib/tenantPaths';
import {
  COMMON_REMEDIES,
  DISEASE_ENTRY_RULE_TYPES,
  DISEASE_PATIENT_SCOPES,
  FIELD_LIMITS,
  POTENCY_OPTIONS,
  type ClinicTenant,
  type DiseasePatientScope,
  type DiseaseRemedyEntry,
  type DiseaseSymptomRule,
  type Patient,
  type RemedyRuleTiming,
} from '../types/clinic';
import {
  ConsultationFormModal,
  type ConsultationPrefill,
} from './ConsultationFormModal';
import { SecureClinicalImage } from './SecureClinicalImage';

interface DiseaseDatabaseViewProps {
  clinic: ClinicTenant;
  patients: Patient[];
  isSuperAdmin: boolean;
  onConsultationSaved: (patientId: string) => void;
}

function createEmptyRule(timing: RemedyRuleTiming = 'general'): DiseaseSymptomRule {
  return {
    id: `rule_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`,
    symptom: '',
    remedyName: '',
    potency: '',
    doseOrUnit: '',
    timing,
    notes: '',
  };
}

function deriveRulesFromLegacyEntry(entry: DiseaseRemedyEntry): DiseaseSymptomRule[] {
  if (entry.symptomRules && entry.symptomRules.length > 0) {
    return entry.symptomRules.map((r) => ({
      id: r.id || `rule_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`,
      symptom: r.symptom || '',
      remedyName: r.remedyName || '',
      potency: r.potency || '',
      doseOrUnit: r.doseOrUnit || '',
      timing: r.timing || 'general',
      notes: r.notes || '',
    }));
  }

  const rules: DiseaseSymptomRule[] = [
    {
      id: `rule_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`,
      symptom: entry.symptoms || entry.diseaseName,
      remedyName: entry.firstRemedyMorning || '',
      potency: entry.firstRemedyPotency || '',
      doseOrUnit: '',
      timing: 'general',
      notes: '',
    },
  ];

  if (entry.secondRemedyAfternoon?.trim()) {
    rules.push({
      id: `rule_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`,
      symptom: entry.symptoms || entry.diseaseName,
      remedyName: entry.secondRemedyAfternoon.trim(),
      potency: entry.secondRemedyPotency?.trim() || '',
      doseOrUnit: '',
      timing: 'general',
      notes: '',
    });
  }
  return rules;
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
  const [patientScope, setPatientScope] = useState<DiseasePatientScope>('All');
  const [diseaseName, setDiseaseName] = useState('');
  const [symptomRules, setSymptomRules] = useState<DiseaseSymptomRule[]>([createEmptyRule('general')]);
  const [dosageInstructions, setDosageInstructions] = useState('');
  const [clinicalNotes, setClinicalNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [activeRemedyDropdownRuleId, setActiveRemedyDropdownRuleId] = useState<string | null>(null);
  const [activePotencyDropdownRuleId, setActivePotencyDropdownRuleId] = useState<string | null>(null);
  const [lastAddedRuleId, setLastAddedRuleId] = useState<string | null>(null);
  const ruleCardRefs = useRef<Record<string, HTMLDivElement | null>>({});

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

  // Build unified remedy & potency suggestion catalogs from clinic DB + standard materia medica
  const { remedyCatalog, potencyCatalog } = useMemo(() => {
    const BIOCHEMIC_DEFAULTS = new Set([
      'calcarea fluorica',
      'calcarea phosphorica',
      'calcarea sulphurica',
      'ferrum phosphoricum',
      'kali muriaticum',
      'kali phosphoricum',
      'kali sulphuricum',
      'magnesia phosphorica',
      'natrum muriaticum',
      'natrum phosphoricum',
      'natrum sulphuricum',
      'silicea',
    ]);

    const remedyMap = new Map<
      string,
      { name: string; potencies: string[]; savedCount: number }
    >();
    const potencySet = new Set<string>(POTENCY_OPTIONS);

    const recordPair = (rawName: string, rawPotency?: string, isSaved = false) => {
      const name = rawName.trim();
      if (!name) return;
      const key = name.toLowerCase();
      const pot = (rawPotency || '').trim();
      if (pot) potencySet.add(pot);

      let item = remedyMap.get(key);
      if (!item) {
        item = { name, potencies: [], savedCount: 0 };
        remedyMap.set(key, item);
      }
      if (isSaved) item.savedCount += 1;
      if (pot && !item.potencies.some((p) => p.toLowerCase() === pot.toLowerCase())) {
        item.potencies.push(pot);
      }
    };

    for (const entry of entries) {
      const rules = deriveRulesFromLegacyEntry(entry);
      for (const r of rules) {
        recordPair(r.remedyName, r.potency, true);
      }
    }

    for (const r of symptomRules) {
      recordPair(r.remedyName, r.potency, false);
    }

    for (const rem of COMMON_REMEDIES) {
      const key = rem.toLowerCase();
      if (!remedyMap.has(key)) {
        const defaultPotencies = BIOCHEMIC_DEFAULTS.has(key)
          ? ['6X', '12X', '30C']
          : ['30C', '200C', '1M'];
        remedyMap.set(key, { name: rem, potencies: defaultPotencies, savedCount: 0 });
      } else {
        const existing = remedyMap.get(key)!;
        if (existing.potencies.length === 0) {
          existing.potencies = BIOCHEMIC_DEFAULTS.has(key)
            ? ['6X', '12X', '30C']
            : ['30C', '200C', '1M'];
        }
      }
    }

    const sortedRemedies = Array.from(remedyMap.values()).sort(
      (a, b) => b.savedCount - a.savedCount || a.name.localeCompare(b.name)
    );

    return {
      remedyCatalog: sortedRemedies,
      potencyCatalog: Array.from(potencySet),
    };
  }, [entries, symptomRules]);

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

  const openCreateModal = () => {
    setEditingEntry(null);
    setPatientScope(scopeFilter === 'all' ? 'All' : scopeFilter);
    setDiseaseName('');
    setSymptomRules([createEmptyRule('general')]);
    setDosageInstructions('');
    setClinicalNotes('');
    setFormError(null);
    setActiveRemedyDropdownRuleId(null);
    setActivePotencyDropdownRuleId(null);
    setShowFormModal(true);
  };

  const openEditModal = (entry: DiseaseRemedyEntry) => {
    setEditingEntry(entry);
    setPatientScope(entry.patientScope || 'All');
    setDiseaseName(entry.diseaseName);
    setSymptomRules(deriveRulesFromLegacyEntry(entry));
    setDosageInstructions(entry.dosageInstructions || '');
    setClinicalNotes(entry.clinicalNotes || '');
    setFormError(null);
    setActiveRemedyDropdownRuleId(null);
    setActivePotencyDropdownRuleId(null);
    setShowFormModal(true);
  };

  const updateRule = (id: string, patch: Partial<DiseaseSymptomRule>) => {
    setSymptomRules((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const addRuleRow = () => {
    if (symptomRules.length >= 50) return;
    const nextRule = createEmptyRule('general');
    setSymptomRules((prev) => [...prev, nextRule]);
    setLastAddedRuleId(nextRule.id);
  };

  const addAnotherRemedyForSameSymptom = (sourceRule: DiseaseSymptomRule) => {
    if (symptomRules.length >= 50) return;
    const nextRule: DiseaseSymptomRule = {
      ...createEmptyRule(sourceRule.timing || 'general'),
      symptom: sourceRule.symptom,
      notes: sourceRule.notes || '',
    };
    setSymptomRules((prev) => {
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
      return;
    }

    const sanitizedRules: DiseaseSymptomRule[] = [];
    for (const rule of symptomRules) {
      const sym = rule.symptom.trim();
      const rem = rule.remedyName.trim();
      const pot = (rule.potency || '').trim();
      if (!sym || !rem) {
        setFormError(
          t(
            'Every symptom row requires Symptom and Remedy Name.',
            'প্রতিটি সারিতে লক্ষণ এবং ঔষধের নাম পূরণ করা আবশ্যক।'
          )
        );
        return;
      }
      const cleanRule: DiseaseSymptomRule = {
        id: (rule.id || `rule_${crypto.randomUUID().slice(0, 8)}`).slice(0, 64),
        symptom: sym.slice(0, FIELD_LIMITS.ruleSymptomMax),
        remedyName: rem.slice(0, FIELD_LIMITS.remedyNameMax),
        potency: pot.slice(0, FIELD_LIMITS.potencyMax),
        timing: rule.timing || 'general',
      };
      if (rule.doseOrUnit?.trim()) {
        cleanRule.doseOrUnit = rule.doseOrUnit.trim().slice(0, FIELD_LIMITS.ruleUnitMax);
      }
      if (rule.notes?.trim()) {
        cleanRule.notes = rule.notes.trim().slice(0, FIELD_LIMITS.ruleNotesMax);
      }
      sanitizedRules.push(cleanRule);
    }

    if (sanitizedRules.length === 0) {
      setFormError(
        t('Add at least one symptom-to-remedy rule.', 'কমপক্ষে একটি লক্ষণ ও ঔষধের নিয়ম যোগ করুন।')
      );
      return;
    }

    const uid = auth.currentUser?.uid;
    if (!uid) {
      setFormError(t('Admin sign-in is required.', 'অ্যাডমিন সাইন-ইন প্রয়োজন।'));
      return;
    }

    // Derive summary fields cleanly from structured rules
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
      editingEntry?.id || `dis_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const path = `clinics/${clinic.id}/disease_remedies/${entryId}`;

    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        patientScope,
        diseaseName: cleanDisease.slice(0, FIELD_LIMITS.diseaseNameMax),
        symptoms: combinedSymptoms,
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

      if (editingEntry) {
        await updateDoc(tenantDiseaseRemedyDoc(clinic.id, entryId), payload);
      } else {
        payload.clinicId = clinic.id;
        payload.clinicAccessEmails = clinic.accessEmails;
        payload.clinicAccessUids = clinic.authorizedUids || [];
        payload.createdBy = uid;
        payload.createdAt = serverTimestamp();
        await setDoc(tenantDiseaseRemedyDoc(clinic.id, entryId), payload);
      }

      setShowFormModal(false);
    } catch (error) {
      if (error instanceof Error && error.message.includes('Missing or insufficient permissions')) {
        handleFirestoreError(
          error,
          editingEntry ? OperationType.UPDATE : OperationType.CREATE,
          path
        );
      }
      setFormError(
        error instanceof Error
          ? error.message
          : t('Unable to save disease protocol.', 'রোগ ও ঔষধের তথ্য সংরক্ষণ করা যায়নি।')
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleSoftDelete = async (entryId: string) => {
    setActionError(null);
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    try {
      await updateDoc(
        tenantDiseaseRemedyDoc(clinic.id, entryId),
        buildSoftDeletePayload(uid, true)
      );
      setConfirmDeleteId(null);
    } catch (error) {
      if (error instanceof Error && error.message.includes('Missing or insufficient permissions')) {
        handleFirestoreError(
          error,
          OperationType.UPDATE,
          `clinics/${clinic.id}/disease_remedies/${entryId}`
        );
      }
      setActionError(
        error instanceof Error
          ? error.message
          : t('Unable to remove protocol.', 'রোগের প্রোটোকল মুছে ফেলা যায়নি।')
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
    const rules = deriveRulesFromLegacyEntry(entry);
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
            const rules = deriveRulesFromLegacyEntry(entry);

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
                        {t('Move this protocol to deleted backup?', 'এই তথ্যটি মুছে ব্যাকআপে রাখবেন?')}
                      </span>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleSoftDelete(entry.id)}
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
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-3xl my-8 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h2 className="font-display text-lg font-semibold text-slate-900">
                  {editingEntry
                    ? t('Edit Disease & Symptom Rules', 'রোগ ও লক্ষণভিত্তিক ঔষধ সম্পাদনা')
                    : t('Add Disease with Multiple Symptoms & Remedies', 'নতুন রোগ, একাধিক লক্ষণ ও আলাদা ঔষধ যোগ করুন')}
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  {t(
                    'Enter disease, symptom, modalities (< / >), and remedy (potency is optional). Morning vs Afternoon timing is chosen at visit time.',
                    'রোগ, লক্ষণ, হ্রাস-বৃদ্ধি ও ঔষধ সংরক্ষণ করুন (পাওয়ার/শক্তি ঐচ্ছিক)। সকালে না বিকালে খাবে তা ভিজিটের সময় নির্ধারণ করা হবে।'
                  )}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowFormModal(false)}
                aria-label={t('Close modal', 'বন্ধ করুন')}
                className="p-2 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form
              onSubmit={handleSaveEntry}
              className="p-6 space-y-5 max-h-[82vh] overflow-y-auto"
            >
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
                    required
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

              {/* Dynamic Symptom -> Remedy Rules Builder */}
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="block text-xs font-semibold text-slate-800">
                    {t(
                      'Symptom-to-Remedy Rules (লক্ষণ অনুযায়ী ঔষধ) *',
                      'লক্ষণভিত্তিক ঔষধের তালিকা *'
                    )}{' '}
                    <span className="font-mono text-slate-500">({symptomRules.length}/50)</span>
                  </label>
                  <button
                    type="button"
                    onClick={addRuleRow}
                    disabled={symptomRules.length >= 50}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-teal-800 bg-teal-50 border border-teal-300 rounded-lg hover:bg-teal-100 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    {t('Add Another Symptom Rule', 'আরও লক্ষণ ও ঔষধ যোগ করুন')}
                  </button>
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

                    return (
                      <div
                        key={rule.id}
                        ref={(el) => {
                          ruleCardRefs.current[rule.id] = el;
                        }}
                        className="border border-slate-200 rounded-xl p-4 bg-slate-50/70 space-y-3"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-xs font-semibold text-slate-700 font-mono">
                            #{index + 1}
                          </span>
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              disabled={symptomRules.length >= 50}
                              onClick={() => addAnotherRemedyForSameSymptom(rule)}
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
                            {t('Specific Symptom / Pain Type *', 'নির্দিষ্ট লক্ষণ ও ব্যথার ধরন *')}
                          </label>
                          <input
                            type="text"
                            required
                            maxLength={FIELD_LIMITS.ruleSymptomMax}
                            value={rule.symptom}
                            onChange={(e) => updateRule(rule.id, { symptom: e.target.value })}
                            placeholder={t(
                              'e.g. Cramping pain better bending double or firm pressure (সামনের দিকে ঝুঁকলে বা চাপ দিলে ব্যথা কমা)',
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
                              required
                              autoComplete="off"
                              maxLength={FIELD_LIMITS.remedyNameMax}
                              value={rule.remedyName}
                              onFocus={() => setActiveRemedyDropdownRuleId(rule.id)}
                              onBlur={() => {
                                window.setTimeout(() => {
                                  setActiveRemedyDropdownRuleId((cur) =>
                                    cur === rule.id ? null : cur
                                  );
                                }, 120);
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
                                }, 120);
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
                              list="disease-unit-list"
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

                {/* Bottom Quick Add Button so users don't have to scroll up */}
                <div className="pt-1 flex justify-end">
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

              <datalist id="disease-unit-list">
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
                <p className="text-xs text-red-700 font-medium" role="alert">
                  {formError}
                </p>
              )}

              <div className="pt-4 border-t border-slate-200 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowFormModal(false)}
                  className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer whitespace-nowrap"
                >
                  {t('Cancel', 'বাতিল')}
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className={`px-5 py-2 text-sm font-medium rounded-lg disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap ${palette.primaryBtn}`}
                >
                  {submitting
                    ? t('Saving...', 'সংরক্ষণ হচ্ছে...')
                    : editingEntry
                      ? t('Save Changes', 'পরিবর্তন সংরক্ষণ')
                      : t('Save Disease Protocol', 'রোগ ও ঔষধ সংরক্ষণ')}
                </button>
              </div>
            </form>
          </div>
        </div>
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
