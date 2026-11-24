import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  deleteDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  ArrowLeft,
  Banknote,
  Calendar,
  Camera,
  CheckCircle2,
  Compass,
  Edit3,
  FileText,
  Loader2,
  Plus,
  Printer,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { auth, handleFirestoreError, OperationType } from '../firebase';
import { formatCashAmount, roundAmount, summarizeFees } from '../lib/feeCalculations';
import { compressClinicalImage, formatBytes } from '../lib/imageCompressor';
import { deleteServerPhoto, uploadClinicalPhoto } from '../lib/photoApi';
import {
  fetchNoteRepertorySuggestions,
  type NoteRepertorySuggestion,
} from '../lib/repertoryApi';
import {
  ACCENT_THEME_PALETTES,
  tenantConsultationDoc,
  tenantConsultationsCol,
  tenantFeeDoc,
  tenantNoteDoc,
  tenantNotesCol,
  tenantPatientDoc,
  tenantPhotoDoc,
  tenantPhotosCol,
} from '../lib/tenantPaths';
import { useLanguage } from '../i18n/LanguageContext';
import {
  FEE_CATEGORY_LABELS_I18N,
  GENDER_LABELS_I18N,
  NOTE_FOCUS_LABELS_I18N,
  PHOTO_CATEGORY_LABELS_I18N,
  STATUS_LABELS_I18N,
  THERMAL_LABELS_I18N,
} from '../i18n/translations';
import {
  CLINICAL_NOTE_FOCUS_AREAS,
  FIELD_LIMITS,
  type ClinicalNote,
  type ClinicalNoteFocus,
  type ClinicTenant,
  type Consultation,
  type FeeRecord,
  type Patient,
  type PatientPhoto,
  type PatientStatus,
  type PhotoCategory,
} from '../types/clinic';
import { ConsultationFormModal } from './ConsultationFormModal';
import { ConstitutionalMapperCard } from './ConstitutionalMapperCard';
import { FeeEntryModal } from './FeeEntryModal';
import { PatientCasePrintView } from './PatientCasePrintView';
import { SecureClinicalImage } from './SecureClinicalImage';

interface PatientDetailViewProps {
  clinic: ClinicTenant;
  isSuperAdmin: boolean;
  patient: Patient;
  feeRecords: FeeRecord[];
  onBack: () => void;
  onEditPatient: (patient: Patient) => void;
  onDeletedPatient: () => void;
  onPhotoStorageChanged: () => void;
}

export function PatientDetailView({
  clinic,
  isSuperAdmin,
  patient,
  feeRecords,
  onBack,
  onEditPatient,
  onDeletedPatient,
  onPhotoStorageChanged,
}: PatientDetailViewProps) {
  const { language, t } = useLanguage();
  const palette = ACCENT_THEME_PALETTES[clinic.accentColor] || ACCENT_THEME_PALETTES.teal;
  const statusLabels = STATUS_LABELS_I18N[language];
  const photoCategoryLabels = PHOTO_CATEGORY_LABELS_I18N[language];
  const noteFocusLabels = NOTE_FOCUS_LABELS_I18N[language];
  const feeCategoryLabels = FEE_CATEGORY_LABELS_I18N[language];
  const thermalLabels = THERMAL_LABELS_I18N[language];
  const genderLabels = GENDER_LABELS_I18N[language];
  const [consultations, setConsultations] = useState<Consultation[]>([]);
  const [clinicalNotes, setClinicalNotes] = useState<ClinicalNote[]>([]);
  const [photos, setPhotos] = useState<PatientPhoto[]>([]);
  const [loadingSubdata, setLoadingSubdata] = useState(true);
  const [activeTab, setActiveTab] = useState<
    'consultations' | 'notes' | 'mapper' | 'photos' | 'fees'
  >('consultations');

  const [showConsultationModal, setShowConsultationModal] = useState(false);
  const [showFeeModal, setShowFeeModal] = useState(false);
  const [editingFee, setEditingFee] = useState<FeeRecord | null>(null);
  const [settlingFeeId, setSettlingFeeId] = useState<string | null>(null);
  const [settleAmountInput, setSettleAmountInput] = useState('');
  const [savingSettle, setSavingSettle] = useState(false);
  const [confirmDeleteFeeId, setConfirmDeleteFeeId] = useState<string | null>(null);
  const [showPrintView, setShowPrintView] = useState(false);
  const [lightboxPhoto, setLightboxPhoto] = useState<PatientPhoto | null>(null);
  const [uploadCategory, setUploadCategory] = useState<PhotoCategory>('symptom');
  const [uploadCaption, setUploadCaption] = useState('');
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmDeletePatient, setConfirmDeletePatient] = useState(false);
  const [deletingPatient, setDeletingPatient] = useState(false);

  // Clinical Notes composer & edit state
  const [noteDate, setNoteDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [noteFocus, setNoteFocus] = useState<ClinicalNoteFocus>('Constitution');
  const [noteContent, setNoteContent] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [noteFilter, setNoteFilter] = useState<'all' | ClinicalNoteFocus>('all');
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editNoteDate, setEditNoteDate] = useState('');
  const [editNoteFocus, setEditNoteFocus] = useState<ClinicalNoteFocus>('Constitution');
  const [editNoteContent, setEditNoteContent] = useState('');
  const [confirmDeleteNoteId, setConfirmDeleteNoteId] = useState<string | null>(null);

  // Live Gemini repertory symptom auto-suggestions for Clinical Notes
  const [autoSuggestEnabled, setAutoSuggestEnabled] = useState(true);
  const [noteSuggestions, setNoteSuggestions] = useState<NoteRepertorySuggestion[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const [manualSuggestTick, setManualSuggestTick] = useState(0);
  const noteTextareaRef = useRef<HTMLTextAreaElement>(null);
  const skipNextSuggestRef = useRef(false);
  const lastQueriedNoteRef = useRef('');
  const prevManualTickRef = useRef(0);

  useEffect(() => {
    setLoadingSubdata(true);
    const consPath = `clinics/${clinic.id}/patients/${patient.id}/consultations`;
    const photosPath = `clinics/${clinic.id}/patients/${patient.id}/photos`;
    const notesPath = `clinics/${clinic.id}/patients/${patient.id}/clinical_notes`;
    const userUid = auth.currentUser?.uid || '';

    const consSource = isSuperAdmin
      ? tenantConsultationsCol(clinic.id, patient.id)
      : query(
          tenantConsultationsCol(clinic.id, patient.id),
          where('clinicAccessUids', 'array-contains', userUid)
        );
    const photosSource = isSuperAdmin
      ? tenantPhotosCol(clinic.id, patient.id)
      : query(
          tenantPhotosCol(clinic.id, patient.id),
          where('clinicAccessUids', 'array-contains', userUid)
        );
    const notesSource = isSuperAdmin
      ? tenantNotesCol(clinic.id, patient.id)
      : query(
          tenantNotesCol(clinic.id, patient.id),
          where('clinicAccessUids', 'array-contains', userUid)
        );

    const unsubCons = onSnapshot(
      consSource,
      (snapshot) => {
        const rows = snapshot.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<Consultation, 'id'>),
        }));
        rows.sort((a, b) => (b.visitDate || '').localeCompare(a.visitDate || ''));
        setConsultations(rows);
        setLoadingSubdata(false);
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, consPath);
      }
    );

    const unsubPhotos = onSnapshot(
      photosSource,
      (snapshot) => {
        const rows = snapshot.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<PatientPhoto, 'id'>),
        }));
        rows.sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
        setPhotos(rows);
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, photosPath);
      }
    );

    const unsubNotes = onSnapshot(
      notesSource,
      (snapshot) => {
        const rows = snapshot.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<ClinicalNote, 'id'>),
        }));
        rows.sort((a, b) => (b.observedDate || '').localeCompare(a.observedDate || ''));
        setClinicalNotes(rows);
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, notesPath);
      }
    );

    return () => {
      unsubCons();
      unsubPhotos();
      unsubNotes();
    };
  }, [clinic.id, isSuperAdmin, patient.id]);

  useEffect(() => {
    setNoteSuggestions([]);
    setSuggestionError(null);
    lastQueriedNoteRef.current = '';
  }, [patient.id]);

  useEffect(() => {
    const isManualTrigger = manualSuggestTick !== prevManualTickRef.current;
    prevManualTickRef.current = manualSuggestTick;

    if (activeTab !== 'notes') return;
    if (skipNextSuggestRef.current && !isManualTrigger) {
      skipNextSuggestRef.current = false;
      return;
    }

    const trimmed = noteContent.trim();
    const minLen = isManualTrigger ? 8 : 12;
    if (trimmed.length < minLen) {
      setNoteSuggestions([]);
      setSuggestionError(null);
      setLoadingSuggestions(false);
      return;
    }

    if (!autoSuggestEnabled && !isManualTrigger) {
      return;
    }

    const querySignature = `${language}:${noteFocus}:${trimmed}`;
    if (querySignature === lastQueriedNoteRef.current && !isManualTrigger) {
      return;
    }

    const controller = new AbortController();
    const delayMs = isManualTrigger ? 0 : 750;

    const timerId = window.setTimeout(async () => {
      setLoadingSuggestions(true);
      setSuggestionError(null);
      try {
        const res = await fetchNoteRepertorySuggestions(
          trimmed,
          noteFocus,
          language,
          controller.signal
        );
        lastQueriedNoteRef.current = querySignature;
        setNoteSuggestions(res.suggestions);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setSuggestionError(
          err instanceof Error
            ? err.message
            : t(
                'Unable to fetch repertory suggestions.',
                'রেপার্টরি পরামর্শ আনা যায়নি।'
              )
        );
      } finally {
        if (!controller.signal.aborted) {
          setLoadingSuggestions(false);
        }
      }
    }, delayMs);

    return () => {
      window.clearTimeout(timerId);
      controller.abort();
    };
  }, [activeTab, autoSuggestEnabled, language, manualSuggestTick, noteContent, noteFocus, t]);

  const handleStatusChange = async (newStatus: PatientStatus) => {
    setActionError(null);
    try {
      await updateDoc(tenantPatientDoc(clinic.id, patient.id), {
        status: newStatus,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `clinics/${clinic.id}/patients/${patient.id}`);
    }
  };

  const handleDirectPhotoUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const uid = auth.currentUser?.uid;
    if (!uid) return;

    setUploadingPhoto(true);
    setActionError(null);
    try {
      const compressed = await compressClinicalImage(file, 1200, 0.78);
      const uploaded = await uploadClinicalPhoto(patient.id, compressed.dataBase64, clinic.id);
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
        category: uploadCategory,
        caption: (uploadCaption.trim() || file.name.replace(/\.[^.]+$/, '')).slice(
          0,
          FIELD_LIMITS.captionMax
        ),
        uploadedBy: uid,
        createdAt: serverTimestamp(),
      });

      if (uploadCategory === 'portrait') {
        await updateDoc(tenantPatientDoc(clinic.id, patient.id), {
          portraitUrl: uploaded.url,
          portraitPhotoId: photoDocId,
          updatedAt: serverTimestamp(),
        });
      }

      setUploadCaption('');
      onPhotoStorageChanged();
    } catch (err) {
      setActionError(
        err instanceof Error
          ? err.message
          : t('Unable to upload photo.', 'ছবি আপলোড করা যায়নি।')
      );
    } finally {
      setUploadingPhoto(false);
      e.target.value = '';
    }
  };

  const handleDeletePhoto = async (photo: PatientPhoto) => {
    setActionError(null);
    try {
      await deleteServerPhoto(patient.id, photo.fileName, photo.url, clinic.id);
      await deleteDoc(tenantPhotoDoc(clinic.id, patient.id, photo.id));
      if (patient.portraitPhotoId === photo.id) {
        await updateDoc(tenantPatientDoc(clinic.id, patient.id), {
          portraitUrl: '',
          portraitPhotoId: '',
          updatedAt: serverTimestamp(),
        });
      }
      if (lightboxPhoto?.id === photo.id) {
        setLightboxPhoto(null);
      }
      onPhotoStorageChanged();
    } catch (error) {
      if (error instanceof Error && error.message.includes('Missing or insufficient permissions')) {
        handleFirestoreError(
          error,
          OperationType.DELETE,
          `clinics/${clinic.id}/patients/${patient.id}/photos/${photo.id}`
        );
      }
      setActionError(
        error instanceof Error
          ? error.message
          : t('Failed to delete photo.', 'ছবি মুছে ফেলা যায়নি।')
      );
    }
  };

  const handleDeleteConsultation = async (consultationId: string) => {
    setActionError(null);
    try {
      await deleteDoc(tenantConsultationDoc(clinic.id, patient.id, consultationId));
    } catch (error) {
      handleFirestoreError(
        error,
        OperationType.DELETE,
        `clinics/${clinic.id}/patients/${patient.id}/consultations/${consultationId}`
      );
    }
  };

  const handleAddClinicalNote = async (e: FormEvent) => {
    e.preventDefault();
    setActionError(null);

    const trimmed = noteContent.trim();
    if (!trimmed) {
      setActionError(
        t('Please enter an observation before saving.', 'সংরক্ষণের আগে অনুগ্রহ করে একটি পর্যবেক্ষণ লিখুন।')
      );
      return;
    }

    const uid = auth.currentUser?.uid;
    if (!uid) return;

    const noteId = `note_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const path = `clinics/${clinic.id}/patients/${patient.id}/clinical_notes/${noteId}`;

    setSavingNote(true);
    try {
      await setDoc(tenantNoteDoc(clinic.id, patient.id, noteId), {
        clinicId: clinic.id,
        clinicAccessEmails: clinic.accessEmails,
        clinicAccessUids: clinic.authorizedUids || [],
        patientId: patient.id,
        observedDate: noteDate.slice(0, 32),
        focusArea: noteFocus,
        content: trimmed.slice(0, FIELD_LIMITS.clinicalObservationMax),
        createdBy: uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setNoteContent('');
      setNoteSuggestions([]);
      setSuggestionError(null);
      lastQueriedNoteRef.current = '';
    } catch (error) {
      if (error instanceof Error && error.message.includes('Missing or insufficient permissions')) {
        handleFirestoreError(error, OperationType.CREATE, path);
      }
      setActionError(
        error instanceof Error
          ? error.message
          : t('Unable to save clinical note.', 'ক্লিনিক্যাল নোট সংরক্ষণ করা যায়নি।')
      );
    } finally {
      setSavingNote(false);
    }
  };

  const startEditingNote = (note: ClinicalNote) => {
    setEditingNoteId(note.id);
    setEditNoteDate(note.observedDate);
    setEditNoteFocus(note.focusArea);
    setEditNoteContent(note.content);
    setConfirmDeleteNoteId(null);
  };

  const handleUpdateClinicalNote = async (note: ClinicalNote) => {
    setActionError(null);
    const trimmed = editNoteContent.trim();
    if (!trimmed) {
      setActionError(
        t('Observation text cannot be empty.', 'পর্যবেক্ষণের লেখা খালি রাখা যাবে না।')
      );
      return;
    }
    const path = `clinics/${clinic.id}/patients/${patient.id}/clinical_notes/${note.id}`;
    try {
      await updateDoc(tenantNoteDoc(clinic.id, patient.id, note.id), {
        observedDate: editNoteDate.slice(0, 32),
        focusArea: editNoteFocus,
        content: trimmed.slice(0, FIELD_LIMITS.clinicalObservationMax),
        updatedAt: serverTimestamp(),
      });
      setEditingNoteId(null);
    } catch (error) {
      if (error instanceof Error && error.message.includes('Missing or insufficient permissions')) {
        handleFirestoreError(error, OperationType.UPDATE, path);
      }
      setActionError(
        error instanceof Error
          ? error.message
          : t('Unable to update clinical note.', 'ক্লিনিক্যাল নোট আপডেট করা যায়নি।')
      );
    }
  };

  const handleDeleteClinicalNote = async (noteId: string) => {
    setActionError(null);
    try {
      await deleteDoc(tenantNoteDoc(clinic.id, patient.id, noteId));
      setConfirmDeleteNoteId(null);
    } catch (error) {
      handleFirestoreError(
        error,
        OperationType.DELETE,
        `clinics/${clinic.id}/patients/${patient.id}/clinical_notes/${noteId}`
      );
    }
  };

  const handleInsertSuggestedRubric = (suggestion: NoteRepertorySuggestion) => {
    const remediesSuffix =
      suggestion.keyRemedies.length > 0 ? ` (${suggestion.keyRemedies.join(', ')})` : '';
    const line = `[${suggestion.chapter}] ${suggestion.rubric}${remediesSuffix}`;

    skipNextSuggestRef.current = true;
    setNoteContent((prev) => {
      const separator = prev.trim().length > 0 ? (prev.endsWith('\n') ? '' : '\n') : '';
      return `${prev}${separator}${line}`.slice(0, FIELD_LIMITS.clinicalObservationMax);
    });
    setNoteSuggestions((prev) => prev.filter((item) => item.rubric !== suggestion.rubric));
    noteTextareaRef.current?.focus();
  };

  const handleSaveMappedNote = async (summaryText: string) => {
    const uid = auth.currentUser?.uid;
    if (!uid) {
      throw new Error(t('Admin sign-in is required.', 'অ্যাডমিন সাইন-ইন প্রয়োজন।'));
    }

    const noteId = `note_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const path = `clinics/${clinic.id}/patients/${patient.id}/clinical_notes/${noteId}`;
    const todayDate = new Date().toISOString().slice(0, 10);

    try {
      await setDoc(tenantNoteDoc(clinic.id, patient.id, noteId), {
        clinicId: clinic.id,
        clinicAccessEmails: clinic.accessEmails,
        clinicAccessUids: clinic.authorizedUids || [],
        patientId: patient.id,
        observedDate: todayDate,
        focusArea: 'Constitution' as ClinicalNoteFocus,
        content: summaryText.slice(0, FIELD_LIMITS.clinicalObservationMax),
        createdBy: uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('Missing or insufficient permissions')) {
        handleFirestoreError(error, OperationType.CREATE, path);
      }
      throw error;
    }
  };

  const filteredClinicalNotes = useMemo(() => {
    if (noteFilter === 'all') return clinicalNotes;
    return clinicalNotes.filter((n) => n.focusArea === noteFilter);
  }, [clinicalNotes, noteFilter]);

  const patientFeeSummary = useMemo(() => summarizeFees(feeRecords), [feeRecords]);

  const handleConfirmSettleFee = async (rec: FeeRecord) => {
    setActionError(null);
    const addCash = roundAmount(Number(settleAmountInput));
    if (!Number.isFinite(addCash) || addCash <= 0) {
      setActionError(
        t('Enter a valid cash amount greater than 0.', '০ এর বেশি একটি সঠিক নগদ টাকা লিখুন।')
      );
      return;
    }
    if (addCash > rec.dueAmount) {
      setActionError(
        t(
          'Collected cash cannot exceed the remaining due amount.',
          'আদায় করা নগদ টাকা বকেয়ার চেয়ে বেশি হতে পারবে না।'
        )
      );
      return;
    }
    const newCashPaid = roundAmount(rec.cashPaid + addCash);
    const newDueAmount = Math.max(0, roundAmount(rec.netAmount - newCashPaid));

    setSavingSettle(true);
    try {
      await updateDoc(tenantFeeDoc(clinic.id, rec.id), {
        cashPaid: newCashPaid,
        dueAmount: newDueAmount,
        updatedAt: serverTimestamp(),
      });
      setSettlingFeeId(null);
      setSettleAmountInput('');
    } catch (error) {
      if (error instanceof Error && error.message.includes('Missing or insufficient permissions')) {
        handleFirestoreError(error, OperationType.UPDATE, `clinics/${clinic.id}/fee_records/${rec.id}`);
      }
      setActionError(
        error instanceof Error
          ? error.message
          : t('Unable to record cash settlement.', 'বকেয়া নগদ আদায় সংরক্ষণ করা যায়নি।')
      );
    } finally {
      setSavingSettle(false);
    }
  };

  const handleDeleteFeeRecord = async (feeId: string) => {
    setActionError(null);
    try {
      await deleteDoc(tenantFeeDoc(clinic.id, feeId));
      setConfirmDeleteFeeId(null);
    } catch (error) {
      if (error instanceof Error && error.message.includes('Missing or insufficient permissions')) {
        handleFirestoreError(error, OperationType.DELETE, `clinics/${clinic.id}/fee_records/${feeId}`);
      }
      setActionError(
        error instanceof Error
          ? error.message
          : t('Unable to delete cash fee entry.', 'নগদ ফি রেকর্ড মুছে ফেলা যায়নি।')
      );
    }
  };

  const handleDeleteFullPatient = async () => {
    setDeletingPatient(true);
    setActionError(null);
    try {
      for (const photo of photos) {
        await deleteServerPhoto(patient.id, photo.fileName, photo.url, clinic.id);
        await deleteDoc(tenantPhotoDoc(clinic.id, patient.id, photo.id));
      }
      for (const con of consultations) {
        await deleteDoc(tenantConsultationDoc(clinic.id, patient.id, con.id));
      }
      for (const note of clinicalNotes) {
        await deleteDoc(tenantNoteDoc(clinic.id, patient.id, note.id));
      }
      for (const fee of feeRecords) {
        await deleteDoc(tenantFeeDoc(clinic.id, fee.id));
      }
      await deleteDoc(tenantPatientDoc(clinic.id, patient.id));
      onPhotoStorageChanged();
      onDeletedPatient();
    } catch (error) {
      if (error instanceof Error && error.message.includes('Missing or insufficient permissions')) {
        handleFirestoreError(error, OperationType.DELETE, `clinics/${clinic.id}/patients/${patient.id}`);
      }
      setActionError(
        error instanceof Error
          ? error.message
          : t('Unable to delete patient record.', 'রোগীর রেকর্ড মুছে ফেলা যায়নি।')
      );
      setDeletingPatient(false);
    }
  };

  const initials = patient.fullName
    .split(' ')
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <>
      <div className={showPrintView ? 'space-y-6 print:hidden' : 'space-y-6'}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-2 text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors cursor-pointer whitespace-nowrap"
          >
            <ArrowLeft className="w-4 h-4" />
            {t('Back to Patient Registry', 'রোগী তালিকায় ফিরে যান')}
          </button>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => setShowPrintView(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer whitespace-nowrap"
            >
              <Printer className="w-3.5 h-3.5" />
              {t('Print Case', 'কেস প্রিন্ট করুন')}
            </button>
            <button
              type="button"
              onClick={() => onEditPatient(patient)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer whitespace-nowrap"
            >
              <Edit3 className="w-3.5 h-3.5" />
              {t('Edit Profile', 'প্রোফাইল সম্পাদনা')}
            </button>
            <button
              type="button"
              onClick={() => setShowConsultationModal(true)}
              className={`inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg transition-colors cursor-pointer whitespace-nowrap ${palette.primaryBtn}`}
            >
              <Plus className="w-3.5 h-3.5" />
              {t('Log Consultation', 'ভিজিট লিপিবদ্ধ করুন')}
            </button>
          </div>
        </div>

      {/* Patient Case Summary Header */}
      <section className="bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-6">
          <div className="flex items-start gap-5">
            <div className="w-20 h-20 rounded-xl overflow-hidden border border-slate-200 shrink-0 bg-slate-100">
              <SecureClinicalImage
                src={patient.portraitUrl}
                alt={`${patient.fullName} portrait`}
                fallbackLabel={initials}
              />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 mb-1">
                <span className="font-mono font-medium text-slate-700 tabular-nums">
                  {patient.caseNumber}
                </span>
                <span aria-hidden="true">·</span>
                <span className="tabular-nums">
                  {patient.age} {t('yrs', 'বছর')}
                </span>
                <span aria-hidden="true">·</span>
                <span>{genderLabels[patient.gender] || patient.gender}</span>
                <span aria-hidden="true">·</span>
                <span className="tabular-nums">{patient.phone}</span>
              </div>
              <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
                {patient.fullName}
              </h1>
              <p className="text-sm text-slate-600 mt-1.5 max-w-2xl leading-relaxed">
                {patient.chiefComplaint}
              </p>
            </div>
          </div>

          <div className="flex flex-col sm:items-end gap-3 shrink-0">
            <div className="flex items-center gap-2">
              <label htmlFor="patient-status" className="text-xs text-slate-500">
                {t('Status', 'অবস্থা')}
              </label>
              <select
                id="patient-status"
                value={patient.status}
                onChange={(e) => handleStatusChange(e.target.value as PatientStatus)}
                className="px-3 py-1.5 text-xs font-medium border border-slate-300 rounded-lg bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
              >
                <option value="active">{statusLabels.active}</option>
                <option value="follow-up">{statusLabels['follow-up']}</option>
                <option value="archived">{statusLabels.archived}</option>
              </select>
            </div>

            <div className="text-xs text-slate-500 sm:text-right space-y-0.5 tabular-nums">
              {patient.lastRemedy && (
                <p>
                  {t('Last remedy:', 'সর্বশেষ ওষুধ:')}{' '}
                  <span className="text-slate-800 font-medium">{patient.lastRemedy}</span>
                </p>
              )}
              {patient.nextFollowUpDate && (
                <p>
                  {t('Next follow-up:', 'পরবর্তী ফলো-আপ:')}{' '}
                  <span className="text-slate-800 font-medium">{patient.nextFollowUpDate}</span>
                </p>
              )}
              {feeRecords.length > 0 && (
                <button
                  type="button"
                  onClick={() => setActiveTab('fees')}
                  className="text-slate-600 hover:text-teal-800 cursor-pointer"
                >
                  {t('Cash Paid:', 'নগদ জমা:')}{' '}
                  <span className="font-mono font-semibold text-emerald-700">
                    {formatCashAmount(patientFeeSummary.totalCashCollected)}
                  </span>
                  {patientFeeSummary.totalDue > 0 && (
                    <>
                      {' · '}
                      {t('Due:', 'বকেয়া:')}{' '}
                      <span className="font-mono font-semibold text-amber-700">
                        {formatCashAmount(patientFeeSummary.totalDue)}
                      </span>
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="mt-6 pt-5 border-t border-slate-200 grid grid-cols-1 md:grid-cols-3 gap-6 text-sm">
          <div>
            <p className="text-xs font-medium text-slate-500 mb-1">
              {t('Thermal Tendency', 'তাপমাত্রা প্রবণতা')}
            </p>
            <p className="text-slate-800">
              {patient.thermalState
                ? thermalLabels[patient.thermalState] || patient.thermalState
                : thermalLabels.Unspecified}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium text-slate-500 mb-1">
              {t('Constitutional Notes', 'ধাতুগত নোট')}
            </p>
            <p className="text-slate-700 text-xs leading-relaxed">
              {patient.constitutionNotes ||
                t('No constitutional notes recorded yet.', 'এখনও কোনো ধাতুগত নোট লেখা হয়নি।')}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium text-slate-500 mb-1">
              {t('Allergies & Medications', 'অ্যালার্জি ও চলমান ওষুধ')}
            </p>
            <p className="text-slate-700 text-xs leading-relaxed">
              {patient.allergies || t('None reported.', 'কোনো তথ্য উল্লেখ করা হয়নি।')}
            </p>
          </div>
        </div>
      </section>

      {actionError && (
        <div className="p-3.5 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800">
          {actionError}
        </div>
      )}

      {/* Segmented Navigation Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="inline-flex flex-wrap items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
          <button
            type="button"
            onClick={() => setActiveTab('consultations')}
            className={`px-4 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap tabular-nums ${
              activeTab === 'consultations'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {t('Consultations & Remedies', 'কনসাল্টেশন ও ওষুধ')} ({consultations.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('notes')}
            className={`px-4 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap tabular-nums ${
              activeTab === 'notes'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {t('Clinical Notes', 'ক্লিনিক্যাল নোট')} ({clinicalNotes.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('mapper')}
            className={`inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
              activeTab === 'mapper'
                ? 'bg-white text-teal-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Compass className="w-3.5 h-3.5 text-teal-700" />
            {t('Constitutional Mapper', 'ধাতুগত ম্যাপার')}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('photos')}
            className={`px-4 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap tabular-nums ${
              activeTab === 'photos'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {t('Clinical Photo Gallery', 'ক্লিনিক্যাল ছবির গ্যালারি')} ({photos.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('fees')}
            className={`inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap tabular-nums ${
              activeTab === 'fees'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Banknote className="w-3.5 h-3.5 text-teal-700" />
            {t('Cash Fees', 'নগদ ফি')} ({feeRecords.length})
          </button>
        </div>

        {!confirmDeletePatient ? (
          <button
            type="button"
            onClick={() => setConfirmDeletePatient(true)}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-red-700 transition-colors cursor-pointer whitespace-nowrap"
          >
            <Trash2 className="w-3.5 h-3.5" />
            {t('Delete Patient Record', 'রোগীর রেকর্ড মুছুন')}
          </button>
        ) : (
          <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-1.5">
            <span className="text-xs text-red-900">
              {t('Delete case & all photos?', 'কেস ও সব ছবি মুছে ফেলবেন?')}
            </span>
            <button
              type="button"
              disabled={deletingPatient}
              onClick={handleDeleteFullPatient}
              className="px-2.5 py-1 text-xs font-medium text-white bg-red-700 rounded hover:bg-red-800 cursor-pointer whitespace-nowrap"
            >
              {deletingPatient
                ? t('Deleting...', 'মুছে ফেলা হচ্ছে...')
                : t('Confirm Delete', 'নিশ্চিত মুছুন')}
            </button>
            <button
              type="button"
              onClick={() => setConfirmDeletePatient(false)}
              className="px-2 py-1 text-xs text-slate-700 hover:text-slate-900 cursor-pointer"
            >
              {t('Cancel', 'বাতিল')}
            </button>
          </div>
        )}
      </div>

      {/* Tab Content */}
      {activeTab === 'consultations' ? (
        <div className="space-y-4">
          {loadingSubdata ? (
            <div className="bg-white border border-slate-200 rounded-xl p-8 text-sm text-slate-500">
              {t('Loading consultation timeline...', 'কনসাল্টেশন টাইমলাইন লোড হচ্ছে...')}
            </div>
          ) : consultations.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-xl p-10 text-center">
              <Calendar className="w-6 h-6 text-slate-400 mx-auto mb-2.5" />
              <h3 className="font-display text-base font-semibold text-slate-900">
                {t('No consultations logged yet', 'এখনও কোনো কনসাল্টেশন যুক্ত করা হয়নি')}
              </h3>
              <p className="text-xs text-slate-500 mt-1 mb-5 max-w-sm mx-auto">
                {t(
                  'Record the initial homeopathic case-taking, mental and physical generals, modalities, and prescribed potency.',
                  'প্রাথমিক হোমিওপ্যাথিক কেস-টেকিং, মানসিক ও শারীরিক সাধারণ লক্ষণ, মডালিটি এবং নির্ধারিত পোটেন্সি লিপিবদ্ধ করুন।'
                )}
              </p>
              <button
                type="button"
                onClick={() => setShowConsultationModal(true)}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-lg hover:bg-teal-800 transition-colors cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                {t('Log First Consultation', 'প্রথম ভিজিট যুক্ত করুন')}
              </button>
            </div>
          ) : (
            consultations.map((con) => {
              const linkedPhotos = photos.filter(
                (p) => p.consultationId === con.id || con.photoIds?.includes(p.id)
              );

              return (
                <article
                  key={con.id}
                  className="bg-white border border-slate-200 rounded-xl p-6 space-y-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-4 pb-4 border-b border-slate-200">
                    <div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 tabular-nums mb-1">
                        <span>
                          {t('Visit', 'ভিজিট')} {con.visitDate}
                        </span>
                        {con.nextFollowUpDate && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>
                              {t('Follow-up', 'ফলো-আপ')} {con.nextFollowUpDate}
                            </span>
                          </>
                        )}
                      </div>
                      <h3 className="font-display text-base font-semibold text-slate-900">
                        {con.remedyName}{' '}
                        <span className="font-mono text-sm font-medium text-teal-800 ml-1">
                          {con.potency}
                        </span>
                      </h3>
                      <p className="text-xs text-slate-600 mt-0.5">{con.dosage}</p>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleDeleteConsultation(con.id)}
                      aria-label={t('Delete consultation', 'কনসাল্টেশন মুছুন')}
                      className="p-1.5 text-slate-400 hover:text-red-700 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>

                  <div>
                    <p className="text-xs font-medium text-slate-500 mb-1">
                      {t('Presenting Symptoms', 'বর্তমান লক্ষণসমূহ')}
                    </p>
                    <p className="text-sm text-slate-800 leading-relaxed whitespace-pre-line">
                      {con.presentingSymptoms}
                    </p>
                  </div>

                  {(con.mentalGenerals || con.physicalGenerals || con.modalitiesWorse || con.modalitiesBetter) && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 text-xs">
                      {con.mentalGenerals && (
                        <div>
                          <p className="font-medium text-slate-500 mb-0.5">
                            {t('Mental Generals', 'মানসিক সাধারণ লক্ষণ')}
                          </p>
                          <p className="text-slate-700 leading-relaxed">{con.mentalGenerals}</p>
                        </div>
                      )}
                      {con.physicalGenerals && (
                        <div>
                          <p className="font-medium text-slate-500 mb-0.5">
                            {t('Physical Generals', 'শারীরিক সাধারণ লক্ষণ')}
                          </p>
                          <p className="text-slate-700 leading-relaxed">{con.physicalGenerals}</p>
                        </div>
                      )}
                      {con.modalitiesWorse && (
                        <div>
                          <p className="font-medium text-slate-500 mb-0.5">
                            {t('Aggravation (<)', 'বৃদ্ধি (<)')}
                          </p>
                          <p className="text-slate-700">{con.modalitiesWorse}</p>
                        </div>
                      )}
                      {con.modalitiesBetter && (
                        <div>
                          <p className="font-medium text-slate-500 mb-0.5">
                            {t('Amelioration (>)', 'উপশম (>)')}
                          </p>
                          <p className="text-slate-700">{con.modalitiesBetter}</p>
                        </div>
                      )}
                    </div>
                  )}

                  {con.clinicalNotes && (
                    <div className="pt-2 text-xs">
                      <p className="font-medium text-slate-500 mb-0.5">
                        {t('Clinical Notes', 'ক্লিনিক্যাল নোট')}
                      </p>
                      <p className="text-slate-700 leading-relaxed">{con.clinicalNotes}</p>
                    </div>
                  )}

                  {linkedPhotos.length > 0 && (
                    <div className="pt-3 border-t border-slate-100">
                      <p className="text-xs font-medium text-slate-500 mb-2">
                        {t('Attached Clinical Photos', 'সংযুক্ত ক্লিনিক্যাল ছবি')}
                      </p>
                      <div className="flex flex-wrap gap-3">
                        {linkedPhotos.map((photo) => (
                          <button
                            key={photo.id}
                            type="button"
                            onClick={() => setLightboxPhoto(photo)}
                            className="w-20 h-20 rounded-lg overflow-hidden border border-slate-200 hover:border-teal-700 transition-colors cursor-pointer"
                          >
                            <SecureClinicalImage
                              src={photo.url}
                              alt={photo.caption || t('Clinical photo', 'ক্লিনিক্যাল ছবি')}
                            />
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </article>
              );
            })
          )}
        </div>
      ) : activeTab === 'notes' ? (
        <section aria-label={t('Clinical Notes', 'ক্লিনিক্যাল নোট')} className="space-y-5">
          {/* Unstructured Clinical Observation Composer */}
          <form
            onSubmit={handleAddClinicalNote}
            className="bg-white border border-slate-200 rounded-xl p-6 space-y-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-base font-semibold text-slate-900">
                  {t(
                    'Clinical Notes & Constitutional Observations',
                    'ক্লিনিক্যাল নোট ও ধাতুগত পর্যবেক্ষণ'
                  )}
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  {t(
                    'Record dated, unstructured notes on temperament, mental state, miasmatic cues, and longitudinal observations.',
                    'রোগীর মেজাজ, মানসিক অবস্থা, মায়াজমেটিক ইঙ্গিত ও দীর্ঘমেয়াদী পর্যবেক্ষণ তারিখসহ স্বাধীনভাবে লিপিবদ্ধ করুন।'
                  )}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setActiveTab('mapper')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-teal-800 bg-teal-50 border border-teal-200 rounded-lg hover:bg-teal-100 transition-colors cursor-pointer whitespace-nowrap"
                >
                  <Compass className="w-3.5 h-3.5" />
                  {t('Map Constitutional Themes', 'ধাতুগত থিম ম্যাপ করুন')}
                </button>
                <span className="text-[11px] font-mono text-slate-400 tabular-nums">
                  {noteContent.length} / {FIELD_LIMITS.clinicalObservationMax}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label
                  htmlFor="clinical-note-date"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  {t('Observation Date', 'পর্যবেক্ষণের তারিখ')}
                </label>
                <input
                  id="clinical-note-date"
                  type="date"
                  required
                  value={noteDate}
                  onChange={(e) => setNoteDate(e.target.value)}
                  className="w-full px-3 py-2 text-xs tabular-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                />
              </div>
              <div>
                <label
                  htmlFor="clinical-note-focus"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  {t('Observation Focus', 'পর্যবেক্ষণের ক্ষেত্র')}
                </label>
                <select
                  id="clinical-note-focus"
                  value={noteFocus}
                  onChange={(e) => setNoteFocus(e.target.value as ClinicalNoteFocus)}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                >
                  {CLINICAL_NOTE_FOCUS_AREAS.map((area) => (
                    <option key={area} value={area}>
                      {noteFocusLabels[area]}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
                <label
                  htmlFor="clinical-note-content"
                  className="block text-xs font-medium text-slate-700"
                >
                  {t('Unstructured Observation', 'বিস্তারিত পর্যবেক্ষণ')}
                </label>

                <div className="flex items-center gap-3">
                  <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-600 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={autoSuggestEnabled}
                      onChange={(e) => {
                        setAutoSuggestEnabled(e.target.checked);
                        if (!e.target.checked) {
                          setNoteSuggestions([]);
                          setSuggestionError(null);
                        }
                      }}
                      className="rounded border-slate-300 text-teal-700 focus:ring-teal-700"
                    />
                    <span>{t('Auto-suggest repertory symptoms', 'স্বয়ংক্রিয় রেপার্টরি লক্ষণ পরামর্শ')}</span>
                  </label>

                  <button
                    type="button"
                    disabled={loadingSuggestions || noteContent.trim().length < 8}
                    onClick={() => setManualSuggestTick((c) => c + 1)}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-teal-800 bg-teal-50 border border-teal-200 rounded-md hover:bg-teal-100 disabled:opacity-45 transition-colors cursor-pointer whitespace-nowrap"
                  >
                    <Sparkles className="w-3 h-3" />
                    {t('Suggest now', 'এখনই পরামর্শ')}
                  </button>
                </div>
              </div>

              <textarea
                ref={noteTextareaRef}
                id="clinical-note-content"
                rows={4}
                required
                maxLength={FIELD_LIMITS.clinicalObservationMax}
                value={noteContent}
                onChange={(e) => setNoteContent(e.target.value)}
                placeholder={t(
                  'Write free-form observations on constitutional shifts, emotional triggers, grief history, dreams, or practitioner impressions...',
                  'ধাতুগত পরিবর্তন, মানসিক অনুভূতি, শোকের ইতিহাস, স্বপ্ন বা চিকিৎসকের নিজস্ব পর্যবেক্ষণ লিখুন...'
                )}
                className="w-full px-3 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
              />

              {/* Live Repertory Auto-Suggestion Tray */}
              {(loadingSuggestions || suggestionError || noteSuggestions.length > 0) && (
                <div
                  aria-live="polite"
                  className="mt-2.5 bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-700">
                      {loadingSuggestions ? (
                        <Loader2 className="w-3.5 h-3.5 text-teal-700 animate-spin" />
                      ) : (
                        <Sparkles className="w-3.5 h-3.5 text-teal-700" />
                      )}
                      <span>
                        {loadingSuggestions
                          ? t(
                              'Analyzing typed observation for repertory symptoms...',
                              'লেখা অনুযায়ী রেপার্টরি লক্ষণ খোঁজা হচ্ছে...'
                            )
                          : t(
                              'Suggested Repertory Symptoms (click to insert into note)',
                              'প্রস্তাবিত রেপার্টরি লক্ষণ (নোটে যুক্ত করতে ক্লিক করুন)'
                            )}
                      </span>
                    </div>

                    {noteSuggestions.length > 0 && !loadingSuggestions && (
                      <button
                        type="button"
                        onClick={() => setNoteSuggestions([])}
                        className="text-[11px] text-slate-500 hover:text-slate-800 cursor-pointer"
                      >
                        {t('Dismiss', 'বন্ধ করুন')}
                      </button>
                    )}
                  </div>

                  {suggestionError && (
                    <p className="text-xs text-red-700">{suggestionError}</p>
                  )}

                  {noteSuggestions.length > 0 && (
                    <div className="grid grid-cols-1 gap-1.5">
                      {noteSuggestions.map((sug, idx) => (
                        <div
                          key={`${sug.chapter}-${sug.rubric}-${idx}`}
                          className="bg-white border border-slate-200 rounded-md px-3 py-2 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                        >
                          <div className="min-w-0 space-y-0.5">
                            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                                {sug.chapter}
                              </span>
                              <span className="text-xs font-medium text-slate-900">
                                {sug.rubric}
                              </span>
                            </div>
                            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px]">
                              {sug.matchReason && (
                                <span className="text-slate-500">{sug.matchReason}</span>
                              )}
                              {sug.keyRemedies.length > 0 && (
                                <span className="font-mono font-medium text-teal-800">
                                  {sug.keyRemedies.join(' · ')}
                                </span>
                              )}
                            </div>
                          </div>

                          <button
                            type="button"
                            onClick={() => handleInsertSuggestedRubric(sug)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-teal-800 bg-teal-50 border border-teal-200 rounded-md hover:bg-teal-100 transition-colors cursor-pointer whitespace-nowrap shrink-0 self-start sm:self-center"
                          >
                            <Plus className="w-3 h-3" />
                            {t('Insert Rubric', 'রুব্রিক যুক্ত করুন')}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end">
              <button
                type="submit"
                disabled={savingNote}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-lg hover:bg-teal-800 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
              >
                <Plus className="w-3.5 h-3.5" />
                {savingNote
                  ? t('Saving Observation...', 'পর্যবেক্ষণ সংরক্ষণ হচ্ছে...')
                  : t('Add Clinical Note', 'ক্লিনিক্যাল নোট যোগ করুন')}
              </button>
            </div>
          </form>

          {/* Focus Filter */}
          {clinicalNotes.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-200/70 rounded-lg w-fit">
              <button
                type="button"
                onClick={() => setNoteFilter('all')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                  noteFilter === 'all'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {t('All Notes', 'সব নোট')}
              </button>
              {CLINICAL_NOTE_FOCUS_AREAS.map((area) => (
                <button
                  key={area}
                  type="button"
                  onClick={() => setNoteFilter(area)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                    noteFilter === area
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {noteFocusLabels[area]}
                </button>
              ))}
            </div>
          )}

          {/* Notes Timeline */}
          {filteredClinicalNotes.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-xl p-10 text-center">
              <FileText className="w-6 h-6 text-slate-400 mx-auto mb-2.5" />
              <h3 className="font-display text-base font-semibold text-slate-900">
                {clinicalNotes.length === 0
                  ? t('No clinical notes recorded yet', 'এখনও কোনো ক্লিনিক্যাল নোট লেখা হয়নি')
                  : t('No notes match this focus filter', 'এই ফিল্টারের সাথে কোনো নোট মেলেনি')}
              </h3>
              <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
                {clinicalNotes.length === 0
                  ? t(
                      'Use the form above to record dated, free-form observations about the patient’s constitution and mental state.',
                      'রোগীর ধাতু ও মানসিক অবস্থা সম্পর্কে তারিখসহ নোট লিখতে উপরের ফর্মটি ব্যবহার করুন।'
                    )
                  : t(
                      'Select All Notes above to view all dated clinical observations.',
                      'সব তারিখভিত্তিক পর্যবেক্ষণ দেখতে উপরের সব নোট নির্বাচন করুন।'
                    )}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredClinicalNotes.map((note) => {
                const isEditing = editingNoteId === note.id;
                const isDeleting = confirmDeleteNoteId === note.id;

                return (
                  <article
                    key={note.id}
                    className="bg-white border border-slate-200 rounded-xl p-5 space-y-3"
                  >
                    {isEditing ? (
                      <div className="space-y-3">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <input
                            type="date"
                            value={editNoteDate}
                            onChange={(e) => setEditNoteDate(e.target.value)}
                            className="px-3 py-1.5 text-xs tabular-nums border border-slate-300 rounded-lg"
                          />
                          <select
                            value={editNoteFocus}
                            onChange={(e) =>
                              setEditNoteFocus(e.target.value as ClinicalNoteFocus)
                            }
                            className="px-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                          >
                            {CLINICAL_NOTE_FOCUS_AREAS.map((area) => (
                              <option key={area} value={area}>
                                {noteFocusLabels[area]}
                              </option>
                            ))}
                          </select>
                        </div>
                        <textarea
                          rows={4}
                          maxLength={FIELD_LIMITS.clinicalObservationMax}
                          value={editNoteContent}
                          onChange={(e) => setEditNoteContent(e.target.value)}
                          className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                        />
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => setEditingNoteId(null)}
                            className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
                          >
                            {t('Cancel', 'বাতিল')}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleUpdateClinicalNote(note)}
                            className="px-3.5 py-1.5 text-xs font-medium text-white bg-teal-700 rounded-lg hover:bg-teal-800 cursor-pointer"
                          >
                            {t('Save Note', 'নোট সংরক্ষণ করুন')}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center justify-between gap-4">
                          <div className="flex items-center gap-2 text-xs text-slate-500 tabular-nums">
                            <span className="font-mono font-medium text-slate-800">
                              {note.observedDate}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span className="font-medium text-teal-800">
                              {noteFocusLabels[note.focusArea] || note.focusArea}
                            </span>
                          </div>

                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              onClick={() => startEditingNote(note)}
                              aria-label={t('Edit clinical note', 'নোট সম্পাদনা করুন')}
                              className="p-1.5 text-slate-400 hover:text-slate-900 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteNoteId(isDeleting ? null : note.id)}
                              aria-label={t('Delete clinical note', 'নোট মুছুন')}
                              className="p-1.5 text-slate-400 hover:text-red-700 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>

                        {isDeleting && (
                          <div className="p-2.5 bg-red-50 border border-red-200 rounded-lg flex items-center justify-between gap-2 text-xs">
                            <span className="text-red-900">
                              {t('Delete this clinical observation?', 'এই ক্লিনিক্যাল পর্যবেক্ষণটি মুছে ফেলবেন?')}
                            </span>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => handleDeleteClinicalNote(note.id)}
                                className="px-2.5 py-1 text-xs font-medium text-white bg-red-700 rounded hover:bg-red-800 cursor-pointer"
                              >
                                {t('Delete', 'মুছুন')}
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteNoteId(null)}
                                className="px-2 py-1 text-xs text-slate-700 hover:text-slate-900 cursor-pointer"
                              >
                                {t('Cancel', 'বাতিল')}
                              </button>
                            </div>
                          </div>
                        )}

                        <p className="text-sm text-slate-800 leading-relaxed whitespace-pre-line">
                          {note.content}
                        </p>
                      </>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      ) : activeTab === 'mapper' ? (
        <ConstitutionalMapperCard
          patient={patient}
          clinicalNotes={clinicalNotes}
          consultations={consultations}
          onSaveSynthesisNote={handleSaveMappedNote}
        />
          ) : activeTab === 'fees' ? (
        <section aria-label={t('Cash Fees', 'নগদ ফি')} className="space-y-5">
          {/* Patient Cash Fee Summary & Header */}
          <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="font-display text-base font-semibold text-slate-900">
                {t('Patient Cash Fee Account', 'রোগীর নগদ ফি হিসাব')}
              </h2>
              <p className="text-xs text-slate-500 mt-0.5 flex items-center gap-1.5">
                <Banknote className="w-3.5 h-3.5 text-teal-700" />
                <span>
                  {t(
                    'Cash-only collection history, discounts, and remaining balance calculation.',
                    'শুধুমাত্র নগদ ফি সংগ্রহ, ছাড় ও বকেয়া হিসাব।'
                  )}
                </span>
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setEditingFee(null);
                setShowFeeModal(true);
              }}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-lg hover:bg-teal-800 transition-colors cursor-pointer whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              {t('Record Cash Fee', 'নগদ ফি যোগ করুন')}
            </button>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 tabular-nums">
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <p className="text-xs text-slate-500">{t('Total Billed', 'মোট বিল')}</p>
              <p className="font-mono text-lg font-semibold text-slate-900 mt-1">
                {formatCashAmount(patientFeeSummary.totalBilled)}
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <p className="text-xs text-slate-500">{t('Total Discount', 'মোট ছাড়')}</p>
              <p className="font-mono text-lg font-semibold text-slate-700 mt-1">
                {formatCashAmount(patientFeeSummary.totalDiscount)}
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <p className="text-xs text-slate-500">{t('Cash Collected', 'মোট নগদ জমা')}</p>
              <p className="font-mono text-lg font-semibold text-emerald-700 mt-1">
                {formatCashAmount(patientFeeSummary.totalCashCollected)}
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <p className="text-xs text-slate-500">{t('Remaining Due', 'মোট বকেয়া')}</p>
              <p
                className={`font-mono text-lg font-semibold mt-1 ${
                  patientFeeSummary.totalDue > 0 ? 'text-amber-700' : 'text-slate-900'
                }`}
              >
                {formatCashAmount(patientFeeSummary.totalDue)}
              </p>
            </div>
          </div>

          {feeRecords.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-xl p-10 text-center">
              <Banknote className="w-6 h-6 text-slate-400 mx-auto mb-2.5" />
              <h3 className="font-display text-base font-semibold text-slate-900">
                {t('No cash fees recorded for this patient', 'এই রোগীর কোনো নগদ ফি রেকর্ড নেই')}
              </h3>
              <p className="text-xs text-slate-500 mt-1 mb-5 max-w-sm mx-auto">
                {t(
                  'Record consultation or medicine fees collected in cash to calculate net payable and due balance.',
                  'নগদ কনসাল্টেশন বা ওষুধের ফি লিপিবদ্ধ করে নিট হিসাব ও বকেয়া পরিচালনা করুন।'
                )}
              </p>
              <button
                type="button"
                onClick={() => {
                  setEditingFee(null);
                  setShowFeeModal(true);
                }}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-lg hover:bg-teal-800 transition-colors cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                {t('Record First Cash Fee', 'প্রথম নগদ ফি যোগ করুন')}
              </button>
            </div>
          ) : (
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold text-slate-500">
                      <th className="py-3 px-4 whitespace-nowrap">{t('Date', 'তারিখ')}</th>
                      <th className="py-3 px-4 whitespace-nowrap">{t('Category', 'ধরন')}</th>
                      <th className="py-3 px-4 whitespace-nowrap text-right">{t('Fee', 'ফি')}</th>
                      <th className="py-3 px-4 whitespace-nowrap text-right">{t('Discount', 'ছাড়')}</th>
                      <th className="py-3 px-4 whitespace-nowrap text-right">{t('Net', 'নিট')}</th>
                      <th className="py-3 px-4 whitespace-nowrap text-right">{t('Cash Paid', 'নগদ জমা')}</th>
                      <th className="py-3 px-4 whitespace-nowrap text-right">{t('Due', 'বকেয়া')}</th>
                      <th className="py-3 px-4 whitespace-nowrap text-right">{t('Actions', 'কার্যক্রম')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 text-xs tabular-nums">
                    {feeRecords.map((rec) => {
                      const isSettling = settlingFeeId === rec.id;
                      const isDeleting = confirmDeleteFeeId === rec.id;
                      return (
                        <tr key={rec.id} className="hover:bg-slate-50/70 align-top">
                          <td className="py-3 px-4 font-mono text-slate-600 whitespace-nowrap">
                            {rec.collectedDate}
                          </td>
                          <td className="py-3 px-4">
                            <p className="font-medium text-slate-800">
                              {feeCategoryLabels[rec.feeType]}
                            </p>
                            <p className="text-[11px] text-slate-500">
                              {t('Cash Only', 'শুধুমাত্র নগদ')}
                              {rec.notes ? ` · ${rec.notes}` : ''}
                            </p>
                          </td>
                          <td className="py-3 px-4 text-right font-mono text-slate-700 whitespace-nowrap">
                            {formatCashAmount(rec.feeAmount)}
                          </td>
                          <td className="py-3 px-4 text-right font-mono text-slate-500 whitespace-nowrap">
                            {rec.discountAmount > 0 ? formatCashAmount(rec.discountAmount) : '—'}
                          </td>
                          <td className="py-3 px-4 text-right font-mono font-medium text-slate-900 whitespace-nowrap">
                            {formatCashAmount(rec.netAmount)}
                          </td>
                          <td className="py-3 px-4 text-right font-mono font-semibold text-emerald-700 whitespace-nowrap">
                            {formatCashAmount(rec.cashPaid)}
                          </td>
                          <td
                            className={`py-3 px-4 text-right font-mono font-semibold whitespace-nowrap ${
                              rec.dueAmount > 0 ? 'text-amber-700' : 'text-slate-500'
                            }`}
                          >
                            {rec.dueAmount > 0 ? formatCashAmount(rec.dueAmount) : t('Paid', 'পরিশোধ')}
                          </td>
                          <td className="py-3 px-4 text-right whitespace-nowrap">
                            {isSettling ? (
                              <div className="inline-flex items-center gap-1.5 bg-teal-50 border border-teal-200 rounded-lg p-1">
                                <input
                                  type="number"
                                  min={1}
                                  max={rec.dueAmount}
                                  step="any"
                                  value={settleAmountInput}
                                  onChange={(e) => setSettleAmountInput(e.target.value)}
                                  className="w-20 px-2 py-1 text-xs font-mono bg-white border border-slate-300 rounded"
                                />
                                <button
                                  type="button"
                                  disabled={savingSettle}
                                  onClick={() => handleConfirmSettleFee(rec)}
                                  className="px-2 py-1 text-[11px] font-medium text-white bg-teal-700 rounded hover:bg-teal-800 cursor-pointer"
                                >
                                  {savingSettle ? '...' : t('Collect', 'জমা')}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setSettlingFeeId(null)}
                                  className="px-1.5 py-1 text-[11px] text-slate-600 cursor-pointer"
                                >
                                  {t('Cancel', 'বাতিল')}
                                </button>
                              </div>
                            ) : isDeleting ? (
                              <div className="inline-flex items-center gap-1.5 bg-red-50 border border-red-200 rounded-lg px-2 py-1">
                                <button
                                  type="button"
                                  onClick={() => handleDeleteFeeRecord(rec.id)}
                                  className="px-2 py-0.5 text-[11px] font-medium text-white bg-red-700 rounded hover:bg-red-800 cursor-pointer"
                                >
                                  {t('Delete', 'মুছুন')}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteFeeId(null)}
                                  className="px-1.5 py-0.5 text-[11px] text-slate-700 cursor-pointer"
                                >
                                  {t('Cancel', 'বাতিল')}
                                </button>
                              </div>
                            ) : (
                              <div className="inline-flex items-center gap-1">
                                {rec.dueAmount > 0 && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setConfirmDeleteFeeId(null);
                                      setSettlingFeeId(rec.id);
                                      setSettleAmountInput(String(rec.dueAmount));
                                    }}
                                    className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-teal-800 bg-teal-50 border border-teal-200 rounded hover:bg-teal-100 cursor-pointer"
                                  >
                                    <CheckCircle2 className="w-3 h-3" />
                                    {t('Collect Cash', 'আদায়')}
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingFee(rec);
                                    setShowFeeModal(true);
                                  }}
                                  aria-label={t('Edit cash fee', 'ফি সম্পাদনা করুন')}
                                  className="p-1.5 text-slate-400 hover:text-slate-900 rounded hover:bg-slate-100 cursor-pointer"
                                >
                                  <Edit3 className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSettlingFeeId(null);
                                    setConfirmDeleteFeeId(rec.id);
                                  }}
                                  aria-label={t('Delete cash fee', 'ফি মুছুন')}
                                  className="p-1.5 text-slate-400 hover:text-red-700 rounded hover:bg-slate-100 cursor-pointer"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      ) : (
        <div className="space-y-5">
          {/* Direct Photo Upload Bar */}
          <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-wrap items-end justify-between gap-4">
            <div className="flex flex-wrap items-end gap-3 flex-1 min-w-[260px]">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t('Photo Category', 'ছবির ধরন')}
                </label>
                <select
                  value={uploadCategory}
                  onChange={(e) => setUploadCategory(e.target.value as PhotoCategory)}
                  className="px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                >
                  <option value="symptom">{photoCategoryLabels.symptom}</option>
                  <option value="skin">{photoCategoryLabels.skin}</option>
                  <option value="tongue">{photoCategoryLabels.tongue}</option>
                  <option value="prescription">{photoCategoryLabels.prescription}</option>
                  <option value="portrait">{photoCategoryLabels.portrait}</option>
                </select>
              </div>
              <div className="flex-1 min-w-[180px]">
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t('Caption (Optional)', 'ক্যাপশন (ঐচ্ছিক)')}
                </label>
                <input
                  type="text"
                  maxLength={FIELD_LIMITS.captionMax}
                  value={uploadCaption}
                  onChange={(e) => setUploadCaption(e.target.value)}
                  placeholder={t(
                    'e.g. Right forearm eczema before Sulphur 200C',
                    'যেমন: সালফার ২০০C দেওয়ার আগে ডান হাতের একজিমা'
                  )}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                />
              </div>
            </div>

            <label className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-lg hover:bg-teal-800 transition-colors cursor-pointer whitespace-nowrap shrink-0">
              <Camera className="w-3.5 h-3.5" />
              <span>
                {uploadingPhoto
                  ? t('Compressing & Uploading...', 'কম্প্রেস ও আপলোড হচ্ছে...')
                  : t('Upload Photo', 'ছবি আপলোড করুন')}
              </span>
              <input
                type="file"
                disabled={uploadingPhoto}
                accept="image/jpeg,image/png,image/webp"
                onChange={handleDirectPhotoUpload}
                className="sr-only"
              />
            </label>
          </div>

          {photos.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-xl p-10 text-center">
              <Camera className="w-6 h-6 text-slate-400 mx-auto mb-2.5" />
              <h3 className="font-display text-base font-semibold text-slate-900">
                {t('No clinical photos uploaded', 'কোনো ক্লিনিক্যাল ছবি আপলোড করা হয়নি')}
              </h3>
              <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
                {t(
                  'Upload lesion, skin, tongue, or old prescription photos above. Images are automatically compressed to WebP before saving to your free-tier server.',
                  'ক্ষত, ত্বক, জিহ্বা বা পুরোনো প্রেসক্রিপশনের ছবি উপরে আপলোড করুন। ফ্রি-টিয়ার সার্ভারে সংরক্ষণের আগে ছবিগুলো স্বয়ংক্রিয়ভাবে WebP ফরম্যাটে কম্প্রেস হয়।'
                )}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {photos.map((photo) => (
                <div
                  key={photo.id}
                  className="bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col"
                >
                  <button
                    type="button"
                    onClick={() => setLightboxPhoto(photo)}
                    className="aspect-[4/3] w-full bg-slate-100 overflow-hidden cursor-pointer block"
                  >
                    <SecureClinicalImage
                      src={photo.url}
                      alt={photo.caption || photoCategoryLabels[photo.category]}
                    />
                  </button>
                  <div className="p-4 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-slate-900 truncate">
                        {photo.caption || photoCategoryLabels[photo.category]}
                      </p>
                      <p className="text-[11px] text-slate-500 mt-0.5 tabular-nums">
                        {photoCategoryLabels[photo.category]} · {formatBytes(photo.sizeBytes)}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleDeletePhoto(photo)}
                      aria-label={t('Delete photo', 'ছবি মুছুন')}
                      className="p-1.5 text-slate-400 hover:text-red-700 rounded hover:bg-slate-100 transition-colors cursor-pointer shrink-0"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {showConsultationModal && (
        <ConsultationFormModal
          clinic={clinic}
          patient={patient}
          onClose={() => setShowConsultationModal(false)}
          onSaved={() => {
            setShowConsultationModal(false);
            onPhotoStorageChanged();
          }}
        />
      )}

      {showFeeModal && (
        <FeeEntryModal
          clinic={clinic}
          patients={[patient]}
          lockedPatient={patient}
          existingFee={editingFee}
          onClose={() => {
            setShowFeeModal(false);
            setEditingFee(null);
          }}
          onSaved={() => {
            setShowFeeModal(false);
            setEditingFee(null);
          }}
        />
      )}

      {lightboxPhoto && (
        <div className="fixed inset-0 z-50 bg-slate-900/80 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl max-w-3xl w-full overflow-hidden border border-slate-200">
            <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-900 truncate">
                  {lightboxPhoto.caption || photoCategoryLabels[lightboxPhoto.category]}
                </p>
                <p className="text-xs text-slate-500 tabular-nums">
                  {photoCategoryLabels[lightboxPhoto.category]} ·{' '}
                  {formatBytes(lightboxPhoto.sizeBytes)} · {lightboxPhoto.mimeType}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setLightboxPhoto(null)}
                aria-label={t('Close preview', 'প্রিভিউ বন্ধ করুন')}
                className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="bg-slate-950 max-h-[75vh] flex items-center justify-center overflow-hidden">
              <SecureClinicalImage
                src={lightboxPhoto.url}
                alt={lightboxPhoto.caption || t('Clinical photo preview', 'ক্লিনিক্যাল ছবি প্রিভিউ')}
                className="max-h-[75vh] w-auto object-contain"
              />
            </div>
          </div>
        </div>
      )}
      </div>

      {showPrintView && (
        <PatientCasePrintView
          patient={patient}
          consultations={consultations}
          clinicalNotes={clinicalNotes}
          photos={photos}
          clinicName={clinic.clinicName}
          practitionerName={clinic.practitionerName}
          onClose={() => setShowPrintView(false)}
        />
      )}
    </>
  );
}
