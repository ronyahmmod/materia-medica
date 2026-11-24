import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import { getDocs, query, serverTimestamp, setDoc, updateDoc, where } from 'firebase/firestore';
import {
  Banknote,
  BookMarked,
  Calculator,
  Check,
  Search,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import { auth, handleFirestoreError, OperationType } from '../firebase';
import { computeFeeBreakdown, formatCashAmount } from '../lib/feeCalculations';
import { compressClinicalImage, formatBytes } from '../lib/imageCompressor';
import { uploadClinicalPhoto } from '../lib/photoApi';
import {
  ACCENT_THEME_PALETTES,
  tenantConsultationDoc,
  tenantDiseaseRemediesCol,
  tenantFeeDoc,
  tenantPatientDoc,
  tenantPhotoDoc,
} from '../lib/tenantPaths';
import { useLanguage } from '../i18n/LanguageContext';
import {
  DISEASE_SCOPE_LABELS_I18N,
  PATIENT_TYPE_LABELS_I18N,
  PHOTO_CATEGORY_LABELS_I18N,
  REMEDY_TIMING_LABELS_I18N,
} from '../i18n/translations';
import {
  CLINICAL_DISPENSING_PRESETS,
  COMMON_REMEDIES,
  FIELD_LIMITS,
  POTENCY_OPTIONS,
  type ClinicTenant,
  type DiseaseRemedyEntry,
  type DiseaseSymptomRule,
  type Patient,
  type PhotoCategory,
  type RemedyRuleTiming,
} from '../types/clinic';

export interface ConsultationPrefill {
  diseaseName?: string;
  presentingSymptoms?: string;
  firstRemedyMorning?: string;
  firstRemedyCompanion?: string;
  firstRemedyPotency?: string;
  secondRemedyAfternoon?: string;
  secondRemedyCompanion?: string;
  secondRemedyPotency?: string;
  globulesDose?: string;
  ounceAmount?: string;
  phialCount?: string;
  extraPotency?: string;
  biochemicMedicine?: string;
  dosage?: string;
  clinicalNotes?: string;
}

interface ConsultationFormModalProps {
  clinic: ClinicTenant;
  patient: Patient;
  isSuperAdmin?: boolean;
  prefill?: ConsultationPrefill | null;
  onClose: () => void;
  onSaved: () => void;
}

interface PendingAttachment {
  id: string;
  previewUrl: string;
  dataBase64: string;
  category: PhotoCategory;
  caption: string;
  compressedBytes: number;
}

interface FlatSymptomMatch {
  entry: DiseaseRemedyEntry;
  rule: DiseaseSymptomRule;
}

export function ConsultationFormModal({
  clinic,
  patient,
  isSuperAdmin = false,
  prefill = null,
  onClose,
  onSaved,
}: ConsultationFormModalProps) {
  const { language, t } = useLanguage();
  const palette = ACCENT_THEME_PALETTES[clinic.accentColor] || ACCENT_THEME_PALETTES.teal;
  const currency = clinic.currencySymbol || '৳';
  const photoCategoryLabels = PHOTO_CATEGORY_LABELS_I18N[language];
  const patientTypeLabels = PATIENT_TYPE_LABELS_I18N[language];
  const scopeLabels = DISEASE_SCOPE_LABELS_I18N[language];
  const timingLabels = REMEDY_TIMING_LABELS_I18N[language];
  const todayStr = new Date().toISOString().slice(0, 10);

  const isVetPatient = Boolean(patient.patientType && patient.patientType !== 'Human');

  const [visitDate, setVisitDate] = useState(todayStr);
  const [diseaseName, setDiseaseName] = useState(prefill?.diseaseName || '');
  const [presentingSymptoms, setPresentingSymptoms] = useState(
    prefill?.presentingSymptoms || ''
  );
  const [mentalGenerals, setMentalGenerals] = useState('');
  const [physicalGenerals, setPhysicalGenerals] = useState('');
  const [modalitiesWorse, setModalitiesWorse] = useState('');
  const [modalitiesBetter, setModalitiesBetter] = useState('');

  // Morning (1st) & Afternoon (2nd) structured remedies + companion remedies + potencies
  const [firstRemedyMorning, setFirstRemedyMorning] = useState(
    prefill?.firstRemedyMorning || ''
  );
  const [firstRemedyCompanion, setFirstRemedyCompanion] = useState(
    prefill?.firstRemedyCompanion || ''
  );
  const [firstRemedyPotency, setFirstRemedyPotency] = useState(
    prefill?.firstRemedyPotency || '200C'
  );
  const [secondRemedyAfternoon, setSecondRemedyAfternoon] = useState(
    prefill?.secondRemedyAfternoon || ''
  );
  const [secondRemedyCompanion, setSecondRemedyCompanion] = useState(
    prefill?.secondRemedyCompanion || ''
  );
  const [secondRemedyPotency, setSecondRemedyPotency] = useState(
    prefill?.secondRemedyPotency || '30C'
  );
  const [showCompanionFields, setShowCompanionFields] = useState(
    isVetPatient ||
      Boolean(prefill?.firstRemedyCompanion) ||
      Boolean(prefill?.secondRemedyCompanion)
  );

  // Notebook Dispensing Columns: ৩০/৪০ বড়ি | আউন্স | ফাইল | শক্তি | বায়োকেমিক
  const [globulesDose, setGlobulesDose] = useState(prefill?.globulesDose || '');
  const [ounceAmount, setOunceAmount] = useState(prefill?.ounceAmount || '');
  const [phialCount, setPhialCount] = useState(prefill?.phialCount || '');
  const [extraPotency, setExtraPotency] = useState(prefill?.extraPotency || '');
  const [biochemicMedicine, setBiochemicMedicine] = useState(
    prefill?.biochemicMedicine || ''
  );
  const [showDispensingColumns, setShowDispensingColumns] = useState(
    !isVetPatient ||
      Boolean(
        prefill?.globulesDose ||
          prefill?.ounceAmount ||
          prefill?.phialCount ||
          prefill?.extraPotency ||
          prefill?.biochemicMedicine
      )
  );

  const [dosage, setDosage] = useState(
    prefill?.dosage ||
      t('Morning & afternoon before meals (5 days)', 'সকাল ও বিকালে খাবারের আগে (৫ দিন)')
  );
  const [clinicalNotes, setClinicalNotes] = useState(prefill?.clinicalNotes || '');
  const [nextFollowUpDate, setNextFollowUpDate] = useState('');

  // Disease & Multi-Symptom Matcher inside Consultation modal
  const [showDiseasePicker, setShowDiseasePicker] = useState(false);
  const [diseaseEntries, setDiseaseEntries] = useState<DiseaseRemedyEntry[]>([]);
  const [loadingDiseases, setLoadingDiseases] = useState(false);
  const [diseasePickerQuery, setDiseasePickerQuery] = useState('');
  const [assignedSlotsByRuleId, setAssignedSlotsByRuleId] = useState<
    Record<string, RemedyRuleTiming>
  >({});

  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<PhotoCategory>('symptom');
  const [feeInput, setFeeInput] = useState('');
  const [discountInput, setDiscountInput] = useState('');
  const [cashPaidInput, setCashPaidInput] = useState('');
  const [cashManuallyEdited, setCashManuallyEdited] = useState(false);
  const [feeNotes, setFeeNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Preload clinic's disease database on modal open so symptom lookup is instant
  useEffect(() => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;

    let cancelled = false;
    setLoadingDiseases(true);
    const source = isSuperAdmin
      ? tenantDiseaseRemediesCol(clinic.id)
      : query(
          tenantDiseaseRemediesCol(clinic.id),
          where('clinicAccessUids', 'array-contains', uid)
        );

    getDocs(source)
      .then((snap) => {
        if (cancelled) return;
        const rows = snap.docs
          .map((d) => ({
            id: d.id,
            ...(d.data() as Omit<DiseaseRemedyEntry, 'id'>),
          }))
          .filter((item) => !item.isDeleted)
          .sort((a, b) => a.diseaseName.localeCompare(b.diseaseName));
        setDiseaseEntries(rows);
      })
      .catch(() => {
        // Ignore transient picker fetch error
      })
      .finally(() => {
        if (!cancelled) setLoadingDiseases(false);
      });

    return () => {
      cancelled = true;
    };
  }, [clinic.id, isSuperAdmin]);

  const scopeCompatibleEntries = useMemo(() => {
    return diseaseEntries.filter((item) => {
      if (isVetPatient && item.patientScope === 'Human') return false;
      if (!isVetPatient && patient.patientType === 'Human' && item.patientScope === 'Veterinary') {
        return false;
      }
      return true;
    });
  }, [diseaseEntries, isVetPatient, patient.patientType]);

  const filteredDiseaseEntries = useMemo(() => {
    const q = diseasePickerQuery.trim().toLowerCase();
    return scopeCompatibleEntries.filter((item) => {
      if (!q) return true;
      const ruleMatch = (item.symptomRules || []).some(
        (rule) =>
          rule.symptom.toLowerCase().includes(q) ||
          rule.remedyName.toLowerCase().includes(q) ||
          rule.potency.toLowerCase().includes(q) ||
          (rule.doseOrUnit || '').toLowerCase().includes(q) ||
          (rule.notes || '').toLowerCase().includes(q)
      );
      return (
        ruleMatch ||
        item.diseaseName.toLowerCase().includes(q) ||
        item.symptoms.toLowerCase().includes(q) ||
        item.firstRemedyMorning.toLowerCase().includes(q) ||
        (item.secondRemedyAfternoon || '').toLowerCase().includes(q)
      );
    });
  }, [diseasePickerQuery, scopeCompatibleEntries]);

  // Direct flat symptom matches when practitioner types what the patient says
  const matchingSymptomRules = useMemo<FlatSymptomMatch[]>(() => {
    const q = diseasePickerQuery.trim().toLowerCase();
    if (!q) return [];
    const results: FlatSymptomMatch[] = [];
    for (const entry of scopeCompatibleEntries) {
      if (entry.symptomRules && entry.symptomRules.length > 0) {
        for (const rule of entry.symptomRules) {
          const hit =
            rule.symptom.toLowerCase().includes(q) ||
            rule.remedyName.toLowerCase().includes(q) ||
            rule.potency.toLowerCase().includes(q) ||
            (rule.doseOrUnit || '').toLowerCase().includes(q) ||
            (rule.notes || '').toLowerCase().includes(q) ||
            entry.diseaseName.toLowerCase().includes(q);
          if (hit) {
            results.push({ entry, rule });
          }
        }
      }
    }
    return results.slice(0, 20);
  }, [diseasePickerQuery, scopeCompatibleEntries]);

  const applyUnitHint = (unitText?: string) => {
    const u = (unitText || '').trim();
    if (!u) return;
    const lower = u.toLowerCase();
    if (lower.includes('বড়ি') || lower.includes('বড়ি') || lower.includes('glob') || lower.includes('pill')) {
      setGlobulesDose(u);
      setShowDispensingColumns(true);
    } else if (lower.includes('আউন্স') || lower.includes('oz') || lower.includes('ounce')) {
      setOunceAmount(u);
      setShowDispensingColumns(true);
    } else if (lower.includes('ফাইল') || lower.includes('phial')) {
      setPhialCount(u);
      setShowDispensingColumns(true);
    }
  };

  const applySingleSymptomRule = (
    entry: DiseaseRemedyEntry,
    rule: DiseaseSymptomRule,
    explicitSlot?: RemedyRuleTiming
  ) => {
    const resolvedSlot: RemedyRuleTiming =
      explicitSlot ??
      (rule.timing === 'general'
        ? !firstRemedyMorning.trim()
          ? 'morning'
          : !secondRemedyAfternoon.trim()
            ? 'afternoon'
            : 'morning'
        : rule.timing);

    setAssignedSlotsByRuleId((prev) => ({
      ...prev,
      [rule.id]: resolvedSlot,
    }));

    setDiseaseName((prev) => {
      if (!prev.trim()) return entry.diseaseName;
      if (prev.toLowerCase().includes(entry.diseaseName.toLowerCase())) return prev;
      return `${prev.trim()}, ${entry.diseaseName}`.slice(0, FIELD_LIMITS.diseaseNameMax);
    });

    const symptomLine = `[${entry.diseaseName}] ${rule.symptom}`;
    setPresentingSymptoms((prev) => {
      if (prev.includes(symptomLine)) return prev;
      return prev.trim() ? `${prev.trim()}\n${symptomLine}` : symptomLine;
    });

    if (resolvedSlot === 'morning') {
      setFirstRemedyMorning(rule.remedyName);
      setFirstRemedyPotency(rule.potency || '30C');
    } else if (resolvedSlot === 'afternoon') {
      setSecondRemedyAfternoon(rule.remedyName);
      setSecondRemedyPotency(rule.potency || '30C');
    } else if (resolvedSlot === 'companion-morning') {
      setFirstRemedyCompanion(rule.remedyName);
      setShowCompanionFields(true);
      if (!firstRemedyPotency.trim() && rule.potency) {
        setFirstRemedyPotency(rule.potency);
      }
    } else if (resolvedSlot === 'companion-afternoon') {
      setSecondRemedyCompanion(rule.remedyName);
      setShowCompanionFields(true);
      if (!secondRemedyPotency.trim() && rule.potency) {
        setSecondRemedyPotency(rule.potency);
      }
    } else if (resolvedSlot === 'biochemic') {
      setBiochemicMedicine(`${rule.remedyName}${rule.potency ? ` ${rule.potency}` : ''}`.trim());
      setShowDispensingColumns(true);
    }

    applyUnitHint(rule.doseOrUnit);

    if (rule.notes?.trim()) {
      setClinicalNotes((prev) => {
        if (prev.includes(rule.notes!.trim())) return prev;
        return prev.trim() ? `${prev.trim()}\n${rule.notes!.trim()}` : rule.notes!.trim();
      });
    }
  };

  const applyDiseaseEntry = (entry: DiseaseRemedyEntry) => {
    setDiseaseName(entry.diseaseName);
    if (entry.symptomRules && entry.symptomRules.length > 0) {
      entry.symptomRules.forEach((rule) => applySingleSymptomRule(entry, rule));
    } else {
      setPresentingSymptoms((prev) =>
        prev.trim()
          ? `${prev.trim()}\n[${entry.diseaseName}] ${entry.symptoms}`
          : `[${entry.diseaseName}] ${entry.symptoms}`
      );
      setFirstRemedyMorning(entry.firstRemedyMorning);
      setFirstRemedyPotency(entry.firstRemedyPotency || '200C');
      setSecondRemedyAfternoon(entry.secondRemedyAfternoon || '');
      setSecondRemedyPotency(entry.secondRemedyPotency || '30C');
    }
    if (entry.dosageInstructions?.trim()) {
      setDosage(entry.dosageInstructions.trim());
    }
    if (entry.clinicalNotes?.trim()) {
      setClinicalNotes((prev) =>
        prev.includes(entry.clinicalNotes!.trim())
          ? prev
          : prev.trim()
            ? `${prev.trim()}\n${entry.clinicalNotes}`
            : entry.clinicalNotes || ''
      );
    }
    setShowDiseasePicker(false);
  };

  const feeBreakdown = useMemo(
    () => computeFeeBreakdown(feeInput, discountInput, cashPaidInput),
    [feeInput, discountInput, cashPaidInput]
  );

  const handleFeeInputChange = (val: string) => {
    setFeeInput(val);
    if (!cashManuallyEdited) {
      const next = computeFeeBreakdown(val, discountInput, val);
      setCashPaidInput(next.netAmount > 0 ? String(next.netAmount) : '');
    }
  };

  const handleDiscountInputChange = (val: string) => {
    setDiscountInput(val);
    if (!cashManuallyEdited) {
      const next = computeFeeBreakdown(feeInput, val, feeInput);
      setCashPaidInput(next.netAmount > 0 ? String(next.netAmount) : '');
    }
  };

  const handleAttachPhoto = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    if (attachments.length + files.length > 5) {
      setErrorMsg(
        t(
          'You can attach up to 5 photos per consultation.',
          'প্রতি কনসাল্টেশনে সর্বোচ্চ ৫টি ছবি সংযুক্ত করতে পারবেন।'
        )
      );
      return;
    }

    setErrorMsg(null);
    try {
      const processed: PendingAttachment[] = [];
      for (const file of files) {
        const compressed = await compressClinicalImage(file, 1200, 0.78);
        processed.push({
          id: crypto.randomUUID().slice(0, 8),
          previewUrl: compressed.dataBase64,
          dataBase64: compressed.dataBase64,
          category: selectedCategory,
          caption: file.name.replace(/\.[^.]+$/, '').slice(0, 80),
          compressedBytes: compressed.compressedBytes,
        });
      }
      setAttachments((prev) => [...prev, ...processed]);
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : t('Unable to attach image.', 'ছবি সংযুক্ত করা যায়নি।')
      );
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((item) => item.id !== id));
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    const morningRem = firstRemedyMorning.trim();
    const morningComp = firstRemedyCompanion.trim();
    const morningPot = firstRemedyPotency.trim() || '30C';
    const afternoonRem = secondRemedyAfternoon.trim();
    const afternoonComp = secondRemedyCompanion.trim();
    const afternoonPot = secondRemedyPotency.trim() || '30C';

    if (!presentingSymptoms.trim() || !morningRem || !dosage.trim()) {
      setErrorMsg(
        t(
          'Presenting symptoms, 1st Morning Remedy, and dosage are required.',
          'বর্তমান লক্ষণ, ১ম ঔষধ (সকালে) এবং মাত্রা আবশ্যক।'
        )
      );
      return;
    }

    const rawFeeNum = Number(feeInput || 0);
    const rawDiscountNum = Number(discountInput || 0);
    const rawCashNum = Number(cashPaidInput || 0);
    if (rawFeeNum > 0 && rawDiscountNum > feeBreakdown.feeAmount) {
      setErrorMsg(
        t(
          'Fee discount cannot exceed total fee amount.',
          'ফি-এর ছাড় মোট ফি-এর চেয়ে বেশি হতে পারবে না।'
        )
      );
      return;
    }
    if (rawFeeNum > 0 && rawCashNum > feeBreakdown.netAmount) {
      setErrorMsg(
        t(
          'Cash collected cannot exceed the net payable fee.',
          'আদায় করা নগদ টাকা নিট প্রদেয় ফি-এর চেয়ে বেশি হতে পারবে না।'
        )
      );
      return;
    }

    const uid = auth.currentUser?.uid;
    if (!uid) {
      setErrorMsg(
        t(
          'Admin session expired. Please sign in again.',
          'অ্যাডমিন সেশন শেষ হয়েছে। আবার সাইন ইন করুন।'
        )
      );
      return;
    }

    const morningJoined = morningComp ? `${morningRem} + ${morningComp}` : morningRem;
    const afternoonJoined = afternoonRem
      ? afternoonComp
        ? `${afternoonRem} + ${afternoonComp}`
        : afternoonRem
      : afternoonComp;

    const summaryRemedyName = (
      afternoonJoined ? `${morningJoined} | ${afternoonJoined}` : morningJoined
    ).slice(0, FIELD_LIMITS.remedyNameMax);
    const summaryPotency = (
      afternoonJoined ? `${morningPot} / ${afternoonPot}` : morningPot
    ).slice(0, FIELD_LIMITS.potencyMax);
    const summaryLastRemedy = (
      afternoonJoined
        ? `${morningJoined} (${morningPot}) · ${afternoonJoined} (${afternoonPot})`
        : `${morningJoined} ${morningPot}`
    ).slice(0, FIELD_LIMITS.remedyNameMax);

    setSubmitting(true);
    const consultationId = `con_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const path = `clinics/${clinic.id}/patients/${patient.id}/consultations/${consultationId}`;

    try {
      const uploadedPhotoIds: string[] = [];

      for (const att of attachments) {
        const uploaded = await uploadClinicalPhoto(patient.id, att.dataBase64, clinic.id);
        const photoDocId = `pho_${uploaded.photoId.slice(0, 24)}`;
        await setDoc(tenantPhotoDoc(clinic.id, patient.id, photoDocId), {
          clinicId: clinic.id,
          clinicAccessEmails: clinic.accessEmails,
          clinicAccessUids: clinic.authorizedUids || [],
          patientId: patient.id,
          fileName: uploaded.fileName,
          url: uploaded.url,
          mimeType: uploaded.mimeType,
          sizeBytes: uploaded.sizeBytes,
          category: att.category,
          caption: att.caption.slice(0, FIELD_LIMITS.captionMax),
          consultationId,
          uploadedBy: uid,
          createdAt: serverTimestamp(),
        });
        uploadedPhotoIds.push(photoDocId);
      }

      const payload: Record<string, unknown> = {
        clinicId: clinic.id,
        clinicAccessEmails: clinic.accessEmails,
        clinicAccessUids: clinic.authorizedUids || [],
        patientId: patient.id,
        visitDate: visitDate.slice(0, 32),
        presentingSymptoms: presentingSymptoms.trim().slice(0, FIELD_LIMITS.presentingSymptomsMax),
        firstRemedyMorning: morningRem.slice(0, FIELD_LIMITS.remedyNameMax),
        firstRemedyPotency: morningPot.slice(0, FIELD_LIMITS.potencyMax),
        remedyName: summaryRemedyName,
        potency: summaryPotency,
        dosage: dosage.trim().slice(0, FIELD_LIMITS.dosageMax),
        createdBy: uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };

      if (diseaseName.trim()) {
        payload.diseaseName = diseaseName.trim().slice(0, FIELD_LIMITS.diseaseNameMax);
      }
      if (morningComp) {
        payload.firstRemedyCompanion = morningComp.slice(0, FIELD_LIMITS.remedyNameMax);
      }
      if (afternoonRem) {
        payload.secondRemedyAfternoon = afternoonRem.slice(0, FIELD_LIMITS.remedyNameMax);
        payload.secondRemedyPotency = afternoonPot.slice(0, FIELD_LIMITS.potencyMax);
      } else if (afternoonComp) {
        payload.secondRemedyPotency = afternoonPot.slice(0, FIELD_LIMITS.potencyMax);
      }
      if (afternoonComp) {
        payload.secondRemedyCompanion = afternoonComp.slice(0, FIELD_LIMITS.remedyNameMax);
      }
      if (globulesDose.trim()) {
        payload.globulesDose = globulesDose.trim().slice(0, FIELD_LIMITS.dispensingUnitMax);
      }
      if (ounceAmount.trim()) {
        payload.ounceAmount = ounceAmount.trim().slice(0, FIELD_LIMITS.dispensingUnitMax);
      }
      if (phialCount.trim()) {
        payload.phialCount = phialCount.trim().slice(0, FIELD_LIMITS.dispensingUnitMax);
      }
      if (extraPotency.trim()) {
        payload.extraPotency = extraPotency.trim().slice(0, FIELD_LIMITS.potencyMax);
      }
      if (biochemicMedicine.trim()) {
        payload.biochemicMedicine = biochemicMedicine.trim().slice(0, FIELD_LIMITS.remedyNameMax);
      }
      if (mentalGenerals.trim()) {
        payload.mentalGenerals = mentalGenerals.trim().slice(0, FIELD_LIMITS.generalsMax);
      }
      if (physicalGenerals.trim()) {
        payload.physicalGenerals = physicalGenerals.trim().slice(0, FIELD_LIMITS.generalsMax);
      }
      if (modalitiesWorse.trim()) {
        payload.modalitiesWorse = modalitiesWorse.trim().slice(0, FIELD_LIMITS.modalitiesMax);
      }
      if (modalitiesBetter.trim()) {
        payload.modalitiesBetter = modalitiesBetter.trim().slice(0, FIELD_LIMITS.modalitiesMax);
      }
      if (clinicalNotes.trim()) {
        payload.clinicalNotes = clinicalNotes.trim().slice(0, FIELD_LIMITS.clinicalNotesMax);
      }
      if (nextFollowUpDate.trim()) {
        payload.nextFollowUpDate = nextFollowUpDate.trim().slice(0, 32);
      }
      if (uploadedPhotoIds.length > 0) {
        payload.photoIds = uploadedPhotoIds;
      }

      await setDoc(tenantConsultationDoc(clinic.id, patient.id, consultationId), payload);

      const patientUpdate: Record<string, unknown> = {
        status: nextFollowUpDate ? 'follow-up' : 'active',
        lastVisitDate: visitDate,
        lastRemedy: summaryLastRemedy,
        updatedAt: serverTimestamp(),
      };
      if (nextFollowUpDate.trim()) {
        patientUpdate.nextFollowUpDate = nextFollowUpDate.trim().slice(0, 32);
      } else if (patient.nextFollowUpDate) {
        patientUpdate.nextFollowUpDate = patient.nextFollowUpDate;
      }

      await updateDoc(tenantPatientDoc(clinic.id, patient.id), patientUpdate);

      if (feeBreakdown.feeAmount > 0) {
        const feeId = `fee_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
        const resolvedNote = (feeNotes.trim() || summaryLastRemedy).slice(
          0,
          FIELD_LIMITS.feeNotesMax
        );
        const feePayload: Record<string, unknown> = {
          clinicId: clinic.id,
          clinicAccessEmails: clinic.accessEmails,
          clinicAccessUids: clinic.authorizedUids || [],
          patientId: patient.id,
          patientName: patient.fullName.slice(0, FIELD_LIMITS.fullNameMax),
          caseNumber: patient.caseNumber.slice(0, FIELD_LIMITS.caseNumberMax),
          consultationId,
          collectedDate: visitDate.slice(0, 32),
          feeType: 'consultation',
          feeAmount: feeBreakdown.feeAmount,
          discountAmount: feeBreakdown.discountAmount,
          netAmount: feeBreakdown.netAmount,
          cashPaid: feeBreakdown.cashPaid,
          dueAmount: feeBreakdown.dueAmount,
          createdBy: uid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        };
        if (resolvedNote) {
          feePayload.notes = resolvedNote;
        }
        await setDoc(tenantFeeDoc(clinic.id, feeId), feePayload);
      }

      onSaved();
    } catch (error) {
      if (error instanceof Error && error.message.includes('Missing or insufficient permissions')) {
        handleFirestoreError(error, OperationType.CREATE, path);
      }
      setErrorMsg(
        error instanceof Error
          ? error.message
          : t('Unable to save consultation.', 'কনসাল্টেশন সংরক্ষণ করা যায়নি।')
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-4xl my-8 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-display text-lg font-semibold text-slate-900">
              {t('Log Homeopathic Consultation', 'ভিজিট ও ঔষধ লিপিবদ্ধ করুন')}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5 truncate">
              {patient.fullName}
              {patient.patientType && patient.patientType !== 'Human'
                ? ` (${patientTypeLabels[patient.patientType]})`
                : ''}{' '}
              · <span className="font-mono">{patient.caseNumber}</span>
              {diseaseName ? ` · ${diseaseName}` : ''}
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setShowDiseasePicker((prev) => !prev)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors cursor-pointer whitespace-nowrap ${
                showDiseasePicker
                  ? palette.softPanel
                  : 'bg-teal-50/70 border-teal-300 text-teal-900 hover:bg-teal-100/70'
              }`}
            >
              <BookMarked className="w-3.5 h-3.5" />
              {t('Symptom & Disease Matcher', 'রোগ ও লক্ষণ অনুযায়ী নির্বাচন')}
            </button>

            <button
              type="button"
              onClick={onClose}
              aria-label={t('Close modal', 'মোডাল বন্ধ করুন')}
              className="p-2 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5 max-h-[82vh] overflow-y-auto">
          {/* Interactive Disease & Spoken-Symptom Matcher */}
          {showDiseasePicker && (
            <div className="bg-slate-50 border border-teal-200 rounded-xl p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-xs font-semibold text-slate-900 flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-teal-700" />
                    <span>
                      {t(
                        'Search Spoken Patient Symptoms or Disease Name',
                        'রোগীর বলা লক্ষণ বা রোগের নাম লিখে ঔষধ নির্বাচন করুন'
                      )}
                    </span>
                  </p>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    {t(
                      'Match patient symptoms and choose whether each selected remedy is taken Morning (1st), Afternoon (2nd), Companion, or Biochemic.',
                      'রোগীর লক্ষণ অনুযায়ী ঔষধ খুঁজে এখানে থেকেই ঠিক করুন কোনটি সকালে (১ম) আর কোনটি বিকালে (২য়) খাবে।'
                    )}
                  </p>
                </div>
                <div className="relative w-full sm:w-72">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="search"
                    autoFocus
                    value={diseasePickerQuery}
                    onChange={(e) => setDiseasePickerQuery(e.target.value)}
                    placeholder={t(
                      'Type symptom, disease, remedy...',
                      'যেমন: পেটব্যথা, ঝুঁকলে কমে, Colocynth...'
                    )}
                    className="w-full pl-8 pr-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-teal-700"
                  />
                </div>
              </div>

              {loadingDiseases ? (
                <p className="text-xs text-slate-500 py-2">
                  {t('Loading clinic disease database...', 'রোগ ও ঔষধ ডেটাবেস লোড হচ্ছে...')}
                </p>
              ) : filteredDiseaseEntries.length === 0 ? (
                <p className="text-xs text-slate-500 py-2">
                  {t(
                    'No matching disease guides found. Add rules in Disease & Remedies Database.',
                    'মিল থাকা কোনো রোগ-লক্ষণ গাইড পাওয়া যায়নি। রোগ ও ঔষধ ডেটাবেস মেনু থেকে যোগ করুন।'
                  )}
                </p>
              ) : (
                <div className="space-y-3">
                  {/* Direct Matched Symptom Rules when searching */}
                  {matchingSymptomRules.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-[11px] font-semibold text-teal-900">
                        {t('Matching Symptom-to-Remedy Rules', 'লক্ষণ অনুযায়ী সরাসরি ঔষধের মিল')} (
                        {matchingSymptomRules.length})
                      </p>
                      <div className="max-h-52 overflow-y-auto divide-y divide-slate-200 bg-white border border-teal-200 rounded-lg">
                        {matchingSymptomRules.map(({ entry, rule }) => {
                          const assignedSlot = assignedSlotsByRuleId[rule.id];
                          return (
                            <div
                              key={`${entry.id}-${rule.id}`}
                              className={`px-3.5 py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 ${
                                assignedSlot ? 'bg-teal-50/60' : ''
                              }`}
                            >
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className="text-[11px] font-semibold text-slate-900">
                                    {entry.diseaseName}
                                  </span>
                                  {assignedSlot && (
                                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-teal-700 text-white">
                                      <Check className="w-2.5 h-2.5" />
                                      {timingLabels[assignedSlot]}
                                    </span>
                                  )}
                                </div>
                                <p className="text-xs text-slate-700 mt-0.5">{rule.symptom}</p>
                                {rule.notes && (
                                  <p className="text-[11px] text-slate-500 mt-0.5">{rule.notes}</p>
                                )}
                                <p className="text-[11px] text-teal-800 font-medium mt-0.5">
                                  {rule.remedyName}{' '}
                                  <span className="font-mono">{rule.potency}</span>
                                  {rule.doseOrUnit ? ` · ${rule.doseOrUnit}` : ''}
                                </p>
                              </div>

                              <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                                <button
                                  type="button"
                                  onClick={() => applySingleSymptomRule(entry, rule, 'morning')}
                                  className={`px-2 py-1 text-[10px] font-medium rounded border cursor-pointer whitespace-nowrap transition-colors ${
                                    assignedSlot === 'morning'
                                      ? 'bg-teal-700 text-white border-teal-700'
                                      : 'bg-amber-50 text-amber-900 border-amber-200 hover:bg-amber-100'
                                  }`}
                                >
                                  {t('+ 1st Morning', '+ ১ম সকালে')}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => applySingleSymptomRule(entry, rule, 'afternoon')}
                                  className={`px-2 py-1 text-[10px] font-medium rounded border cursor-pointer whitespace-nowrap transition-colors ${
                                    assignedSlot === 'afternoon'
                                      ? 'bg-teal-700 text-white border-teal-700'
                                      : 'bg-slate-100 text-slate-800 border-slate-300 hover:bg-slate-200'
                                  }`}
                                >
                                  {t('+ 2nd Afternoon', '+ ২য় বিকালে')}
                                </button>
                                {(showCompanionFields || isVetPatient) && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      applySingleSymptomRule(entry, rule, 'companion-morning')
                                    }
                                    className={`px-2 py-1 text-[10px] font-medium rounded border cursor-pointer whitespace-nowrap transition-colors ${
                                      assignedSlot === 'companion-morning'
                                        ? 'bg-teal-700 text-white border-teal-700'
                                        : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
                                    }`}
                                  >
                                    {t('+ Companion', '+ সহায়ক')}
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => applySingleSymptomRule(entry, rule, 'biochemic')}
                                  className={`px-2 py-1 text-[10px] font-medium rounded border cursor-pointer whitespace-nowrap transition-colors ${
                                    assignedSlot === 'biochemic'
                                      ? 'bg-teal-700 text-white border-teal-700'
                                      : 'bg-sky-50 text-sky-900 border-sky-200 hover:bg-sky-100'
                                  }`}
                                >
                                  {t('+ Biochemic', '+ বায়োকেমিক')}
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Disease Cards with Selectable Symptom Rules */}
                  <div className="max-h-64 overflow-y-auto divide-y divide-slate-200 bg-white border border-slate-200 rounded-lg">
                    {filteredDiseaseEntries.map((item) => (
                      <div key={item.id} className="p-3 space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-semibold text-slate-900">
                              {item.diseaseName}
                            </span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
                              {scopeLabels[item.patientScope]}
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={() => applyDiseaseEntry(item)}
                            className="px-2.5 py-1 text-[11px] font-medium text-teal-800 bg-teal-50 border border-teal-200 rounded-md hover:bg-teal-100 cursor-pointer whitespace-nowrap"
                          >
                            {t('Apply Full Disease', 'সম্পূর্ণ প্রোটোকল নিন')}
                          </button>
                        </div>

                        {item.symptomRules && item.symptomRules.length > 0 ? (
                          <div className="space-y-1.5">
                            {item.symptomRules.map((rule) => {
                              const assignedSlot = assignedSlotsByRuleId[rule.id];
                              return (
                                <div
                                  key={rule.id}
                                  className={`px-2.5 py-2 rounded-md border text-[11px] flex flex-col sm:flex-row sm:items-center justify-between gap-2 transition-colors ${
                                    assignedSlot
                                      ? 'bg-teal-50/70 border-teal-300 text-teal-950'
                                      : 'bg-slate-50/70 border-slate-200 text-slate-700'
                                  }`}
                                >
                                  <div className="min-w-0 flex-1 space-y-0.5">
                                    <div>
                                      <span className="font-medium text-slate-900">
                                        {rule.symptom}
                                      </span>{' '}
                                      →{' '}
                                      <span className="font-semibold text-teal-800">
                                        {rule.remedyName}
                                      </span>{' '}
                                      <span className="font-mono">{rule.potency}</span>
                                      {rule.doseOrUnit ? ` (${rule.doseOrUnit})` : ''}
                                    </div>
                                    {rule.notes && (
                                      <p className="text-[10px] text-slate-500">{rule.notes}</p>
                                    )}
                                  </div>

                                  <div className="flex flex-wrap items-center gap-1 shrink-0">
                                    <button
                                      type="button"
                                      onClick={() => applySingleSymptomRule(item, rule, 'morning')}
                                      className={`px-2 py-0.5 text-[10px] font-medium rounded border cursor-pointer whitespace-nowrap ${
                                        assignedSlot === 'morning'
                                          ? 'bg-teal-700 text-white border-teal-700'
                                          : 'bg-white text-amber-900 border-amber-300 hover:bg-amber-50'
                                      }`}
                                    >
                                      {t('Morning', 'সকালে')}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => applySingleSymptomRule(item, rule, 'afternoon')}
                                      className={`px-2 py-0.5 text-[10px] font-medium rounded border cursor-pointer whitespace-nowrap ${
                                        assignedSlot === 'afternoon'
                                          ? 'bg-teal-700 text-white border-teal-700'
                                          : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
                                      }`}
                                    >
                                      {t('Afternoon', 'বিকালে')}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => applySingleSymptomRule(item, rule, 'biochemic')}
                                      className={`px-2 py-0.5 text-[10px] font-medium rounded border cursor-pointer whitespace-nowrap ${
                                        assignedSlot === 'biochemic'
                                          ? 'bg-teal-700 text-white border-teal-700'
                                          : 'bg-white text-sky-900 border-sky-300 hover:bg-sky-50'
                                      }`}
                                    >
                                      {t('Biochemic', 'বায়োকেমিক')}
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <p className="text-[11px] text-slate-600">
                            {item.symptoms} —{' '}
                            <span className="font-medium text-teal-800">
                              {item.firstRemedyMorning} ({item.firstRemedyPotency})
                              {item.secondRemedyAfternoon
                                ? ` + ${item.secondRemedyAfternoon} (${item.secondRemedyPotency || '30C'})`
                                : ''}
                            </span>
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Visit Date, Disease Tag & Next Follow-up */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                {t('Visit Date (তাং) *', 'ভিজিটের তারিখ (তাং) *')}
              </label>
              <input
                type="date"
                required
                value={visitDate}
                onChange={(e) => setVisitDate(e.target.value)}
                className="w-full px-3 py-2 text-sm tabular-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                {t('Diagnosed Disease (Optional)', 'রোগের নাম (ঐচ্ছিক)')}
              </label>
              <input
                type="text"
                maxLength={FIELD_LIMITS.diseaseNameMax}
                value={diseaseName}
                onChange={(e) => setDiseaseName(e.target.value)}
                placeholder={t('e.g. Cough, Fever, Mastitis', 'যেমন: কাশি, জ্বর, ওলান ফোলা')}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                {t('Next Follow-up Date', 'পরবর্তী ফলো-আপ তারিখ')}
              </label>
              <input
                type="date"
                value={nextFollowUpDate}
                onChange={(e) => setNextFollowUpDate(e.target.value)}
                className="w-full px-3 py-2 text-sm tabular-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              {t('Presenting Symptoms & Case Progression *', 'বর্তমান লক্ষণ ও রোগের অগ্রগতি *')}
            </label>
            <textarea
              required
              rows={3}
              maxLength={FIELD_LIMITS.presentingSymptomsMax}
              value={presentingSymptoms}
              onChange={(e) => setPresentingSymptoms(e.target.value)}
              placeholder={t(
                'Location, sensation, intensity, changes since previous dose...',
                'অবস্থান, অনুভূতি, তীব্রতা, আগের ডোজের পর পরিবর্তন...'
              )}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                {t('Mental & Emotional Generals', 'মানসিক ও আবেগিক সাধারণ লক্ষণ')}
              </label>
              <textarea
                rows={2}
                maxLength={FIELD_LIMITS.generalsMax}
                value={mentalGenerals}
                onChange={(e) => setMentalGenerals(e.target.value)}
                placeholder={t(
                  'Disposition, fears, irritability, consolation response...',
                  'মেজাজ, ভয়, খিটখিটে ভাব, সান্ত্বনায় প্রতিক্রিয়া...'
                )}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                {t('Physical Generals', 'শারীরিক সাধারণ লক্ষণ')}
              </label>
              <textarea
                rows={2}
                maxLength={FIELD_LIMITS.generalsMax}
                value={physicalGenerals}
                onChange={(e) => setPhysicalGenerals(e.target.value)}
                placeholder={t(
                  'Thirst, appetite, cravings/aversions, perspiration, sleep...',
                  'পিপাসা, ক্ষুধা, খাদ্যের পছন্দ/অপছন্দ, ঘাম, ঘুম...'
                )}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                {t('Aggravation (< Worse From)', 'বৃদ্ধি (< কিসে বাড়ে)')}
              </label>
              <input
                type="text"
                maxLength={FIELD_LIMITS.modalitiesMax}
                value={modalitiesWorse}
                onChange={(e) => setModalitiesWorse(e.target.value)}
                placeholder={t(
                  'e.g. Cold air, midnight, motion',
                  'যেমন: ঠান্ডা বাতাস, মধ্যরাত, নড়াচড়ায়'
                )}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                {t('Amelioration (> Better From)', 'উপশম (> কিসে কমে)')}
              </label>
              <input
                type="text"
                maxLength={FIELD_LIMITS.modalitiesMax}
                value={modalitiesBetter}
                onChange={(e) => setModalitiesBetter(e.target.value)}
                placeholder={t(
                  'e.g. Warm drinks, open air, pressure',
                  'যেমন: গরম পানীয়, খোলা বাতাস, চাপে'
                )}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
              />
            </div>
          </div>

          {/* Morning (1st) & Afternoon (2nd) Prescription Fields + Companion Veterinary Slots */}
          <div className="border-t border-slate-200 pt-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs font-semibold text-slate-800">
                {t(
                  'Morning & Afternoon Remedy Prescription',
                  '১ম ও ২য় ঔষধ, শক্তি এবং মাত্রা নির্ধারণ'
                )}
              </h3>
              <div className="flex flex-wrap items-center gap-2">
                {!isVetPatient && (
                  <button
                    type="button"
                    onClick={() => setShowCompanionFields((prev) => !prev)}
                    className="text-[11px] font-medium text-slate-600 hover:text-teal-800 underline cursor-pointer"
                  >
                    {showCompanionFields
                      ? t('Hide companion medicine slots', 'সহায়ক ঔষধ স্লট লুকান')
                      : t('Add companion medicine slots', '+ সহায়ক ঔষধ যোগ করুন')}
                  </button>
                )}
                {isVetPatient && (
                  <button
                    type="button"
                    onClick={() => setShowDispensingColumns((prev) => !prev)}
                    className="text-[11px] font-medium text-slate-600 hover:text-teal-800 underline cursor-pointer"
                  >
                    {showDispensingColumns
                      ? t('Hide globules/oz/phial fields', 'বড়ি/আউন্স/ফাইল লুকান')
                      : t('Show globules/oz/phial fields', '+ বড়ি/আউন্স/ফাইল/বায়োকেমিক')}
                  </button>
                )}
              </div>
            </div>

            <datalist id="homeopathy-remedies">
              {COMMON_REMEDIES.map((rem) => (
                <option key={rem} value={rem} />
              ))}
            </datalist>
            <datalist id="homeopathy-potencies">
              {POTENCY_OPTIONS.map((pot) => (
                <option key={pot} value={pot} />
              ))}
            </datalist>

            {/* 1st Remedy (Morning) Row */}
            <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 bg-amber-50/40 border border-amber-200/70 rounded-lg p-3.5">
              <div className={showCompanionFields ? 'sm:col-span-5' : 'sm:col-span-8'}>
                <label className="block text-xs font-medium text-slate-800 mb-1.5">
                  {t('1st Remedy (Morning) *', '১ম ঔষধ (সকালে) *')}
                </label>
                <input
                  type="text"
                  required
                  list="homeopathy-remedies"
                  maxLength={FIELD_LIMITS.remedyNameMax}
                  value={firstRemedyMorning}
                  onChange={(e) => setFirstRemedyMorning(e.target.value)}
                  placeholder={t('e.g. Arsenicum album / AN-IV.', 'যেমন: Arsenicum album / AN-IV.')}
                  className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                />
              </div>

              {showCompanionFields && (
                <div className="sm:col-span-4">
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    {t('1st Remedy (Companion)', '১ম ঔষধ (সহায়ক)')}
                  </label>
                  <input
                    type="text"
                    list="homeopathy-remedies"
                    maxLength={FIELD_LIMITS.remedyNameMax}
                    value={firstRemedyCompanion}
                    onChange={(e) => setFirstRemedyCompanion(e.target.value)}
                    placeholder={t('e.g. 2C (-)', 'যেমন: 2C (-)')}
                    className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                  />
                </div>
              )}

              <div className={showCompanionFields ? 'sm:col-span-3' : 'sm:col-span-4'}>
                <label className="block text-xs font-medium text-slate-800 mb-1.5">
                  {t('Potency (শক্তি) *', 'শক্তি (১ম) *')}
                </label>
                <input
                  type="text"
                  required
                  list="homeopathy-potencies"
                  maxLength={FIELD_LIMITS.potencyMax}
                  value={firstRemedyPotency}
                  onChange={(e) => setFirstRemedyPotency(e.target.value)}
                  placeholder="200C / Phyto"
                  className="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                />
              </div>
            </div>

            {/* 2nd Remedy (Afternoon) Row */}
            <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 bg-slate-50 border border-slate-200 rounded-lg p-3.5">
              <div className={showCompanionFields ? 'sm:col-span-5' : 'sm:col-span-8'}>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  {t('2nd Remedy (Afternoon — Optional)', '২য় ঔষধ (বিকালে — ঐচ্ছিক)')}
                </label>
                <input
                  type="text"
                  list="homeopathy-remedies"
                  maxLength={FIELD_LIMITS.remedyNameMax}
                  value={secondRemedyAfternoon}
                  onChange={(e) => setSecondRemedyAfternoon(e.target.value)}
                  placeholder={t(
                    'e.g. Nux vomica (leave empty if single remedy)',
                    'যেমন: Nux vomica (না থাকলে খালি রাখুন)'
                  )}
                  className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                />
              </div>

              {showCompanionFields && (
                <div className="sm:col-span-4">
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    {t('2nd Remedy (Companion)', '২য় ঔষধ (সহায়ক)')}
                  </label>
                  <input
                    type="text"
                    list="homeopathy-remedies"
                    maxLength={FIELD_LIMITS.remedyNameMax}
                    value={secondRemedyCompanion}
                    onChange={(e) => setSecondRemedyCompanion(e.target.value)}
                    placeholder={t('Optional 2nd companion', 'ঐচ্ছিক সহায়ক ঔষধ')}
                    className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                  />
                </div>
              )}

              <div className={showCompanionFields ? 'sm:col-span-3' : 'sm:col-span-4'}>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  {t('Potency (শক্তি ২য়)', 'শক্তি (২য়)')}
                </label>
                <input
                  type="text"
                  list="homeopathy-potencies"
                  maxLength={FIELD_LIMITS.potencyMax}
                  value={secondRemedyPotency}
                  onChange={(e) => setSecondRemedyPotency(e.target.value)}
                  placeholder="30C"
                  className="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                />
              </div>
            </div>

            {/* Notebook Dispensing Columns: ৩০/৪০ বড়ি | আউন্স | ফাইল | শক্তি | বায়োকেমিক */}
            {showDispensingColumns && (
              <div className="bg-teal-50/30 border border-teal-200/80 rounded-lg p-3.5 space-y-3">
                <p className="text-[11px] font-semibold text-teal-950">
                  {t(
                    'Dispensing Format & Biochemic Details (৩০/৪০ বড়ি · আউন্স · ফাইল · শক্তি · বায়োকেমিক)',
                    'বড়ি, আউন্স, ফাইল, শক্তি ও বায়োকেমিক তথ্য'
                  )}
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="block text-[11px] font-medium text-slate-700">
                        {t('30/40 Globules', '৩০/৪০ বড়ি')}
                      </label>
                      <div className="flex items-center gap-1">
                        {['৩০ বড়ি', '৪০ বড়ি'].map((preset) => (
                          <button
                            key={preset}
                            type="button"
                            onClick={() => setGlobulesDose(preset)}
                            className={`px-1.5 py-0.5 text-[10px] rounded border cursor-pointer ${
                              globulesDose === preset
                                ? 'bg-teal-700 text-white border-teal-700'
                                : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                            }`}
                          >
                            {preset.replace(' বড়ি', '')}
                          </button>
                        ))}
                      </div>
                    </div>
                    <input
                      type="text"
                      list="dispensing-globules-list"
                      maxLength={FIELD_LIMITS.dispensingUnitMax}
                      value={globulesDose}
                      onChange={(e) => setGlobulesDose(e.target.value)}
                      placeholder={t('30 / 40 বড়ি', 'যেমন: ৩০ বড়ি')}
                      className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-teal-700"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-slate-700 mb-1">
                      {t('Ounce (আউন্স)', 'আউন্স')}
                    </label>
                    <input
                      type="text"
                      list="dispensing-ounces-list"
                      maxLength={FIELD_LIMITS.dispensingUnitMax}
                      value={ounceAmount}
                      onChange={(e) => setOunceAmount(e.target.value)}
                      placeholder={t('e.g. ৩০ আউন্স / 1 oz', 'যেমন: ৩০ আউন্স')}
                      className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-teal-700"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-slate-700 mb-1">
                      {t('Phial (ফাইল)', 'ফাইল')}
                    </label>
                    <input
                      type="text"
                      list="dispensing-phials-list"
                      maxLength={FIELD_LIMITS.dispensingUnitMax}
                      value={phialCount}
                      onChange={(e) => setPhialCount(e.target.value)}
                      placeholder={t('e.g. ১ ফাইল', 'যেমন: ১ ফাইল')}
                      className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-teal-700"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-slate-700 mb-1">
                      {t('Potency (শক্তি)', 'শক্তি (ফাইল/অতিরিক্ত)')}
                    </label>
                    <input
                      type="text"
                      list="homeopathy-potencies"
                      maxLength={FIELD_LIMITS.potencyMax}
                      value={extraPotency}
                      onChange={(e) => setExtraPotency(e.target.value)}
                      placeholder="30C / 6X"
                      className="w-full px-2.5 py-1.5 text-xs font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-teal-700"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-slate-700 mb-1">
                      {t('Biochemic (বায়োকেমিক)', 'বায়োকেমিক')}
                    </label>
                    <input
                      type="text"
                      list="homeopathy-remedies"
                      maxLength={FIELD_LIMITS.remedyNameMax}
                      value={biochemicMedicine}
                      onChange={(e) => setBiochemicMedicine(e.target.value)}
                      placeholder={t('e.g. Calc phos 6X', 'যেমন: Calc phos 6X')}
                      className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-teal-700"
                    />
                  </div>
                </div>

                <datalist id="dispensing-globules-list">
                  {CLINICAL_DISPENSING_PRESETS.globules.map((item) => (
                    <option key={item} value={item} />
                  ))}
                </datalist>
                <datalist id="dispensing-ounces-list">
                  {CLINICAL_DISPENSING_PRESETS.ounces.map((item) => (
                    <option key={item} value={item} />
                  ))}
                </datalist>
                <datalist id="dispensing-phials-list">
                  {CLINICAL_DISPENSING_PRESETS.phials.map((item) => (
                    <option key={item} value={item} />
                  ))}
                </datalist>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                {t('Dosage & Repetition *', 'মাত্রা ও সেবনবিধি *')}
              </label>
              <input
                type="text"
                required
                maxLength={FIELD_LIMITS.dosageMax}
                value={dosage}
                onChange={(e) => setDosage(e.target.value)}
                placeholder={t(
                  'Morning & afternoon before meals (5 days)',
                  'সকাল ও বিকালে খাবারের আগে (৫ দিন)'
                )}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              {t('Clinical Notes & Kent Observation', 'ক্লিনিক্যাল নোট ও কেন্টের পর্যবেক্ষণ')}
            </label>
            <textarea
              rows={2}
              maxLength={FIELD_LIMITS.clinicalNotesMax}
              value={clinicalNotes}
              onChange={(e) => setClinicalNotes(e.target.value)}
              placeholder={t(
                'Repertorization notes, antidote precautions, dietary advice...',
                'রেপার্টরাইজেশন নোট, অ্যান্টিডোট সতর্কতা, পথ্য ও খাদ্যাভ্যাস পরামর্শ...'
              )}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
            />
          </div>

          <div className="border border-slate-200 rounded-lg p-4 bg-slate-50/70">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-medium text-slate-800">
                  {t(
                    'Clinical Photos (Lesion, Tongue, Skin, Lab Report)',
                    'ক্লিনিক্যাল ছবি (ক্ষত, জিহ্বা, ত্বক, ল্যাব রিপোর্ট)'
                  )}
                </p>
                <p className="text-xs text-slate-500 mt-0.5">
                  {t(
                    'Compressed client-side and stored on your free-tier upload server.',
                    'ব্রাউজারেই কম্প্রেস হয়ে আপনার ফ্রি-টিয়ার আপলোড সার্ভারে সংরক্ষিত হয়।'
                  )}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={selectedCategory}
                  onChange={(e) => setSelectedCategory(e.target.value as PhotoCategory)}
                  className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                >
                  <option value="symptom">{photoCategoryLabels.symptom}</option>
                  <option value="skin">{photoCategoryLabels.skin}</option>
                  <option value="tongue">{photoCategoryLabels.tongue}</option>
                  <option value="prescription">{photoCategoryLabels.prescription}</option>
                </select>
                <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap">
                  <Upload className="w-3.5 h-3.5" />
                  <span>{t('Attach Photo', 'ছবি সংযুক্ত করুন')}</span>
                  <input
                    type="file"
                    multiple
                    accept="image/jpeg,image/png,image/webp"
                    onChange={handleAttachPhoto}
                    className="sr-only"
                  />
                </label>
              </div>
            </div>

            {attachments.length > 0 && (
              <div className="mt-3 pt-3 border-t border-slate-200 grid grid-cols-1 sm:grid-cols-2 gap-3">
                {attachments.map((att) => (
                  <div
                    key={att.id}
                    className="flex items-center gap-3 bg-white border border-slate-200 rounded-lg p-2"
                  >
                    <img
                      src={att.previewUrl}
                      alt={att.caption}
                      className="w-12 h-12 rounded object-cover shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <input
                        type="text"
                        value={att.caption}
                        maxLength={FIELD_LIMITS.captionMax}
                        onChange={(e) => {
                          const val = e.target.value;
                          setAttachments((prev) =>
                            prev.map((p) => (p.id === att.id ? { ...p, caption: val } : p))
                          );
                        }}
                        className="w-full text-xs font-medium text-slate-800 border-b border-transparent focus:border-slate-300 focus:outline-none truncate"
                      />
                      <p className="text-[11px] text-slate-500 tabular-nums mt-0.5">
                        {photoCategoryLabels[att.category]} · {formatBytes(att.compressedBytes)}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeAttachment(att.id)}
                      aria-label={t('Remove attachment', 'সংযুক্তি সরান')}
                      className="p-1 text-slate-400 hover:text-red-700 cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Cash-Only Fee Collection & Calculation (টাকা) */}
          <div className="border border-slate-200 rounded-lg p-4 bg-slate-50/70 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <Calculator className="w-3.5 h-3.5 text-teal-700" />
                <p className="text-xs font-semibold text-slate-800">
                  {t(
                    'Consultation Cash Fee — টাকা (Optional)',
                    'কনসাল্টেশন নগদ ফি — টাকা (ঐচ্ছিক)'
                  )}
                </p>
              </div>
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-teal-800 bg-teal-50 border border-teal-200 px-2 py-0.5 rounded-md">
                <Banknote className="w-3 h-3" />
                {t('Cash Only', 'শুধুমাত্র নগদ')}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-slate-700 mb-1">
                  {t(`Fee Amount (${currency})`, `ফি পরিমাণ (${currency})`)}
                </label>
                <input
                  type="number"
                  min={0}
                  max={FIELD_LIMITS.feeMaxAmount}
                  step="any"
                  value={feeInput}
                  onChange={(e) => handleFeeInputChange(e.target.value)}
                  placeholder="0"
                  className="w-full px-3 py-1.5 text-xs font-mono tabular-nums bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-700 mb-1">
                  {t(`Discount (${currency})`, `ছাড় (${currency})`)}
                </label>
                <input
                  type="number"
                  min={0}
                  max={feeBreakdown.feeAmount || FIELD_LIMITS.feeMaxAmount}
                  step="any"
                  value={discountInput}
                  onChange={(e) => handleDiscountInputChange(e.target.value)}
                  placeholder="0"
                  className="w-full px-3 py-1.5 text-xs font-mono tabular-nums bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-[11px] font-medium text-slate-700">
                    {t(`Cash Paid (${currency})`, `নগদ জমা (${currency})`)}
                  </label>
                  {feeBreakdown.netAmount > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        setCashManuallyEdited(true);
                        setCashPaidInput(String(feeBreakdown.netAmount));
                      }}
                      className={`text-[10px] font-medium hover:underline cursor-pointer ${palette.accentText}`}
                    >
                      {t('Full Cash', 'সম্পূর্ণ নগদ')}
                    </button>
                  )}
                </div>
                <input
                  type="number"
                  min={0}
                  max={feeBreakdown.netAmount || FIELD_LIMITS.feeMaxAmount}
                  step="any"
                  value={cashPaidInput}
                  onChange={(e) => {
                    setCashManuallyEdited(true);
                    setCashPaidInput(e.target.value);
                  }}
                  placeholder="0"
                  className="w-full px-3 py-1.5 text-xs font-mono tabular-nums bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                />
              </div>
            </div>

            {feeBreakdown.feeAmount > 0 && (
              <div className="pt-2.5 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3 text-xs tabular-nums">
                <div className="flex flex-wrap items-center gap-4">
                  <span className="text-slate-600">
                    {t('Net:', 'নিট:')}{' '}
                    <strong className="font-mono text-slate-900">
                      {formatCashAmount(feeBreakdown.netAmount, currency)}
                    </strong>
                  </span>
                  <span className="text-slate-600">
                    {t('Cash:', 'নগদ:')}{' '}
                    <strong className="font-mono text-emerald-700">
                      {formatCashAmount(feeBreakdown.cashPaid, currency)}
                    </strong>
                  </span>
                  <span className="text-slate-600">
                    {t('Due:', 'বকেয়া:')}{' '}
                    <strong
                      className={`font-mono ${
                        feeBreakdown.dueAmount > 0 ? 'text-amber-700' : 'text-slate-700'
                      }`}
                    >
                      {formatCashAmount(feeBreakdown.dueAmount, currency)}
                    </strong>
                  </span>
                </div>
                <input
                  type="text"
                  maxLength={FIELD_LIMITS.feeNotesMax}
                  value={feeNotes}
                  onChange={(e) => setFeeNotes(e.target.value)}
                  placeholder={t('Fee note (optional)', 'ফি নোট (ঐচ্ছিক)')}
                  className="px-2.5 py-1 text-xs bg-white border border-slate-300 rounded-md w-full sm:w-52 focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                />
              </div>
            )}
          </div>

          {errorMsg && (
            <p className="text-xs text-red-700 font-medium" role="alert">
              {errorMsg}
            </p>
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
              className={`px-5 py-2 text-sm font-medium rounded-lg disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap ${palette.primaryBtn}`}
            >
              {submitting
                ? t('Recording Visit...', 'ভিজিট সংরক্ষণ হচ্ছে...')
                : t('Save Consultation', 'কনসাল্টেশন সংরক্ষণ করুন')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
