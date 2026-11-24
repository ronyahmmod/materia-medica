import { useState, type ChangeEvent, type FormEvent } from 'react';
import { serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { Upload, X, AlertCircle } from 'lucide-react';
import { auth, handleFirestoreError, OperationType } from '../firebase';
import { compressClinicalImage, formatBytes } from '../lib/imageCompressor';
import { uploadClinicalPhoto } from '../lib/photoApi';
import {
  ACCENT_THEME_PALETTES,
  tenantPatientDoc,
  tenantPhotoDoc,
} from '../lib/tenantPaths';
import { useLanguage } from '../i18n/LanguageContext';
import {
  GENDER_LABELS_I18N,
  STATUS_LABELS_I18N,
  THERMAL_LABELS_I18N,
} from '../i18n/translations';
import {
  CASE_NUMBER_REGEX,
  FIELD_LIMITS,
  type ClinicTenant,
  type GenderOption,
  type Patient,
  type PatientStatus,
  type ThermalState,
} from '../types/clinic';

interface PatientFormModalProps {
  clinic: ClinicTenant;
  existingPatient?: Patient | null;
  nextSuggestedCaseNumber: string;
  currentPatientCount: number;
  patientLimit: number;
  onClose: () => void;
  onSaved: (patientId: string) => void;
  onOpenPlans: () => void;
}

function generateId(): string {
  return `pat_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function PatientFormModal({
  clinic,
  existingPatient,
  nextSuggestedCaseNumber,
  currentPatientCount,
  patientLimit,
  onClose,
  onSaved,
  onOpenPlans,
}: PatientFormModalProps) {
  const palette = ACCENT_THEME_PALETTES[clinic.accentColor] || ACCENT_THEME_PALETTES.teal;
  const { language, t } = useLanguage();
  const genderLabels = GENDER_LABELS_I18N[language];
  const thermalLabels = THERMAL_LABELS_I18N[language];
  const statusLabels = STATUS_LABELS_I18N[language];

  const isEditing = Boolean(existingPatient);
  const atFreeLimit = !isEditing && currentPatientCount >= patientLimit;

  const [caseNumber, setCaseNumber] = useState(
    existingPatient?.caseNumber || nextSuggestedCaseNumber
  );
  const [fullName, setFullName] = useState(existingPatient?.fullName || '');
  const [age, setAge] = useState(existingPatient ? String(existingPatient.age) : '');
  const [gender, setGender] = useState<GenderOption>(existingPatient?.gender || 'Female');
  const [phone, setPhone] = useState(existingPatient?.phone || '');
  const [email, setEmail] = useState(existingPatient?.email || '');
  const [address, setAddress] = useState(existingPatient?.address || '');
  const [chiefComplaint, setChiefComplaint] = useState(existingPatient?.chiefComplaint || '');
  const [thermalState, setThermalState] = useState<ThermalState>(
    existingPatient?.thermalState || 'Unspecified'
  );
  const [constitutionNotes, setConstitutionNotes] = useState(
    existingPatient?.constitutionNotes || ''
  );
  const [allergies, setAllergies] = useState(existingPatient?.allergies || '');
  const [status, setStatus] = useState<PatientStatus>(existingPatient?.status || 'active');
  const [nextFollowUpDate, setNextFollowUpDate] = useState(
    existingPatient?.nextFollowUpDate || ''
  );

  const [pendingPhoto, setPendingPhoto] = useState<{
    previewUrl: string;
    dataBase64: string;
    originalBytes: number;
    compressedBytes: number;
  } | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handlePhotoChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setErrorMsg(null);
    try {
      const compressed = await compressClinicalImage(file, 960, 0.78);
      setPendingPhoto({
        previewUrl: compressed.dataBase64,
        dataBase64: compressed.dataBase64,
        originalBytes: compressed.originalBytes,
        compressedBytes: compressed.compressedBytes,
      });
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : t('Unable to process selected portrait.', 'নির্বাচিত ছবিটি প্রক্রিয়া করা যায়নি।')
      );
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    const trimmedCase = caseNumber.trim();
    const trimmedName = fullName.trim();
    const trimmedPhone = phone.trim();
    const trimmedComplaint = chiefComplaint.trim();
    const numericAge = Number(age);

    if (!CASE_NUMBER_REGEX.test(trimmedCase)) {
      setErrorMsg(
        t(
          'Case Number may only contain letters, numbers, hyphens, and underscores.',
          'কেস নম্বরে কেবল ইংরেজি অক্ষর, সংখ্যা, হাইফেন এবং আন্ডারস্কোর থাকতে পারবে।'
        )
      );
      return;
    }
    if (!trimmedName || trimmedName.length > FIELD_LIMITS.fullNameMax) {
      setErrorMsg(t('Please enter a valid patient full name.', 'অনুগ্রহ করে রোগীর সঠিক পূর্ণ নাম লিখুন।'));
      return;
    }
    if (Number.isNaN(numericAge) || numericAge < 0 || numericAge > 130) {
      setErrorMsg(t('Age must be between 0 and 130.', 'বয়স ০ থেকে ১৩০-এর মধ্যে হতে হবে।'));
      return;
    }
    if (trimmedPhone.length < 3) {
      setErrorMsg(t('Please enter a valid contact phone number.', 'অনুগ্রহ করে সঠিক ফোন নম্বর লিখুন।'));
      return;
    }
    if (!trimmedComplaint) {
      setErrorMsg(t('Chief complaint is required.', 'প্রধান সমস্যার বিবরণ আবশ্যক।'));
      return;
    }

    const uid = auth.currentUser?.uid;
    if (!uid) {
      setErrorMsg(t('Admin session expired. Please sign in again.', 'অ্যাডমিন সেশন শেষ হয়েছে। আবার সাইন ইন করুন।'));
      return;
    }

    setSubmitting(true);
    const patientId = existingPatient?.id || generateId();
    const path = `clinics/${clinic.id}/patients/${patientId}`;

    try {
      let portraitUrl = existingPatient?.portraitUrl;
      let portraitPhotoId = existingPatient?.portraitPhotoId;

      const basePayload: Record<string, unknown> = {
        caseNumber: trimmedCase.slice(0, FIELD_LIMITS.caseNumberMax),
        fullName: trimmedName.slice(0, FIELD_LIMITS.fullNameMax),
        age: Math.round(numericAge),
        gender,
        phone: trimmedPhone.slice(0, FIELD_LIMITS.phoneMax),
        chiefComplaint: trimmedComplaint.slice(0, FIELD_LIMITS.chiefComplaintMax),
        thermalState,
        status,
        updatedAt: serverTimestamp(),
      };

      if (email.trim()) basePayload.email = email.trim().slice(0, FIELD_LIMITS.emailMax);
      if (address.trim()) basePayload.address = address.trim().slice(0, FIELD_LIMITS.addressMax);
      if (constitutionNotes.trim()) {
        basePayload.constitutionNotes = constitutionNotes
          .trim()
          .slice(0, FIELD_LIMITS.constitutionNotesMax);
      }
      if (allergies.trim()) {
        basePayload.allergies = allergies.trim().slice(0, FIELD_LIMITS.allergiesMax);
      }
      if (nextFollowUpDate.trim()) {
        basePayload.nextFollowUpDate = nextFollowUpDate.trim().slice(0, 32);
      }

      if (isEditing && existingPatient) {
        if (portraitUrl) basePayload.portraitUrl = portraitUrl;
        if (portraitPhotoId) basePayload.portraitPhotoId = portraitPhotoId;
        if (existingPatient.lastVisitDate) basePayload.lastVisitDate = existingPatient.lastVisitDate;
        if (existingPatient.lastRemedy) basePayload.lastRemedy = existingPatient.lastRemedy;

        await updateDoc(tenantPatientDoc(clinic.id, patientId), basePayload);
      } else {
        basePayload.clinicId = clinic.id;
        basePayload.clinicAccessEmails = clinic.accessEmails;
        basePayload.clinicAccessUids = clinic.authorizedUids || [];
        basePayload.createdBy = uid;
        basePayload.createdAt = serverTimestamp();
        await setDoc(tenantPatientDoc(clinic.id, patientId), basePayload);
      }

      if (pendingPhoto) {
        const uploaded = await uploadClinicalPhoto(patientId, pendingPhoto.dataBase64, clinic.id);
        const photoDocId = `pho_${uploaded.photoId.slice(0, 24)}`;
        await setDoc(tenantPhotoDoc(clinic.id, patientId, photoDocId), {
          clinicId: clinic.id,
          clinicAccessEmails: clinic.accessEmails,
          clinicAccessUids: clinic.authorizedUids || [],
          patientId,
          fileName: uploaded.fileName,
          url: uploaded.url,
          mimeType: uploaded.mimeType,
          sizeBytes: uploaded.sizeBytes,
          category: 'portrait',
          caption: 'Patient portrait',
          uploadedBy: uid,
          createdAt: serverTimestamp(),
        });

        portraitUrl = uploaded.url;
        portraitPhotoId = photoDocId;

        await updateDoc(tenantPatientDoc(clinic.id, patientId), {
          portraitUrl,
          portraitPhotoId,
          updatedAt: serverTimestamp(),
        });
      }

      onSaved(patientId);
    } catch (error) {
      if (error instanceof Error && error.message.includes('Missing or insufficient permissions')) {
        handleFirestoreError(error, isEditing ? OperationType.UPDATE : OperationType.CREATE, path);
      }
      setErrorMsg(
        error instanceof Error
          ? error.message
          : t('Unable to save patient record.', 'রোগীর রেকর্ড সংরক্ষণ করা যায়নি।')
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-2xl my-8 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2 className="font-display text-lg font-semibold text-slate-900">
              {isEditing
                ? t('Edit Patient Record', 'রোগীর রেকর্ড সম্পাদনা')
                : t('Register New Patient', 'নতুন রোগী নিবন্ধন')}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5 tabular-nums">
              {isEditing
                ? `${t('Case', 'কেস')} ${existingPatient?.caseNumber}`
                : t(
                    `Clinic capacity: ${currentPatientCount} of ${patientLimit} patients`,
                    `ক্লিনিক ধারণক্ষমতা: ${patientLimit} জন রোগীর মধ্যে ${currentPatientCount} জন`
                  )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('Close modal', 'মোডাল বন্ধ করুন')}
            className="p-2 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {atFreeLimit && (
          <div className="mx-6 mt-5 p-4 bg-amber-50 border border-amber-200 rounded-lg flex items-start justify-between gap-4">
            <div className="flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
              <div className="text-xs text-amber-900">
                <p className="font-semibold">
                  {t(
                    `Patient plan capacity reached (${currentPatientCount}/${patientLimit})`,
                    `রোগী প্ল্যানের সীমা পূর্ণ হয়েছে (${currentPatientCount}/${patientLimit})`
                  )}
                </p>
                <p className="mt-0.5 text-amber-800">
                  {t(
                    'Your current plan limit is full. Upgrade your clinic plan to expand capacity as your practice grows.',
                    'আপনার বর্তমান প্ল্যানের সীমা পূর্ণ হয়েছে। প্র্যাকটিস বাড়ার সাথে সাথে ধারণক্ষমতা বাড়াতে প্ল্যান আপগ্রেড করুন।'
                  )}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onOpenPlans}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors shrink-0 cursor-pointer whitespace-nowrap ${palette.primaryBtn}`}
            >
              {t('View Plans', 'প্ল্যান দেখুন')}
            </button>
          </div>
        )}

        <form onSubmit={handleSubmit} className="p-6 space-y-5 max-h-[78vh] overflow-y-auto">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                {t('Case Number *', 'কেস নম্বর *')}
              </label>
              <input
                type="text"
                required
                maxLength={FIELD_LIMITS.caseNumberMax}
                value={caseNumber}
                onChange={(e) => setCaseNumber(e.target.value)}
                placeholder="HM-1042"
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                {t('Patient Full Name *', 'রোগীর পূর্ণ নাম *')}
              </label>
              <input
                type="text"
                required
                maxLength={FIELD_LIMITS.fullNameMax}
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder={t('e.g. Ananya Roy', 'যেমন: অনন্যা রায়')}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                {t('Age *', 'বয়স *')}
              </label>
              <input
                type="number"
                required
                min={0}
                max={130}
                value={age}
                onChange={(e) => setAge(e.target.value)}
                placeholder="34"
                className="w-full px-3 py-2 text-sm tabular-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                {t('Gender *', 'লিঙ্গ *')}
              </label>
              <select
                value={gender}
                onChange={(e) => setGender(e.target.value as GenderOption)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
              >
                <option value="Female">{genderLabels.Female}</option>
                <option value="Male">{genderLabels.Male}</option>
                <option value="Other">{genderLabels.Other}</option>
              </select>
            </div>

            <div className="col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                {t('Phone *', 'ফোন নম্বর *')}
              </label>
              <input
                type="tel"
                required
                maxLength={FIELD_LIMITS.phoneMax}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+880 1711 000000"
                className="w-full px-3 py-2 text-sm tabular-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                {t('Email (Optional)', 'ইমেইল (ঐচ্ছিক)')}
              </label>
              <input
                type="email"
                maxLength={FIELD_LIMITS.emailMax}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="patient@example.com"
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
              {t('Chief Complaint *', 'প্রধান সমস্যা *')}
            </label>
            <textarea
              required
              rows={2}
              maxLength={FIELD_LIMITS.chiefComplaintMax}
              value={chiefComplaint}
              onChange={(e) => setChiefComplaint(e.target.value)}
              placeholder={t(
                'Primary presenting condition, duration, and key location...',
                'মূল অসুস্থতা, সময়কাল এবং আক্রান্ত স্থান...'
              )}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                {t('Thermal Tendency', 'তাপমাত্রা প্রবণতা')}
              </label>
              <select
                value={thermalState}
                onChange={(e) => setThermalState(e.target.value as ThermalState)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
              >
                <option value="Unspecified">{thermalLabels.Unspecified}</option>
                <option value="Chilly">{thermalLabels.Chilly}</option>
                <option value="Hot">{thermalLabels.Hot}</option>
                <option value="Ambithermal">{thermalLabels.Ambithermal}</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                {t('Case Status', 'কেসের অবস্থা')}
              </label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as PatientStatus)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
              >
                <option value="active">{statusLabels.active}</option>
                <option value="follow-up">{statusLabels['follow-up']}</option>
                <option value="archived">{statusLabels.archived}</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                {t('Constitutional / Miasmatic Notes', 'ধাতুগত / মায়াজমেটিক নোট')}
              </label>
              <textarea
                rows={2}
                maxLength={FIELD_LIMITS.constitutionNotesMax}
                value={constitutionNotes}
                onChange={(e) => setConstitutionNotes(e.target.value)}
                placeholder={t(
                  'Sleep, cravings, temperament, past history...',
                  'ঘুম, খাদ্যের ইচ্ছা-অনিচ্ছা, মেজাজ, পূর্ব ইতিহাস...'
                )}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                {t('Allergies & Current Medications', 'অ্যালার্জি ও চলমান ওষুধ')}
              </label>
              <textarea
                rows={2}
                maxLength={FIELD_LIMITS.allergiesMax}
                value={allergies}
                onChange={(e) => setAllergies(e.target.value)}
                placeholder={t(
                  'Known drug allergies or allopathic medications...',
                  'কোনো ওষুধে অ্যালার্জি বা চলমান অ্যালোপ্যাথিক ওষুধ...'
                )}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              {t('Address (Optional)', 'ঠিকানা (ঐচ্ছিক)')}
            </label>
            <input
              type="text"
              maxLength={FIELD_LIMITS.addressMax}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder={t('City or street address', 'শহর বা বাড়ির ঠিকানা')}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
            />
          </div>

          <div className="border border-slate-200 rounded-lg p-4 bg-slate-50/70">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-medium text-slate-800">
                  {t(
                    'Patient Portrait Photo (Free-Tier Auto-Compressed)',
                    'রোগীর ছবি (ফ্রি-টিয়ার অটো-কম্প্রেসড)'
                  )}
                </p>
                <p className="text-xs text-slate-500 mt-0.5">
                  {t(
                    'Automatically resized to WebP before upload to conserve free-tier server storage.',
                    'ফ্রি-টিয়ার সার্ভার স্টোরেজ সাশ্রয় করতে আপলোডের আগে ছবি স্বয়ংক্রিয়ভাবে WebP ফরম্যাটে ছোট করা হয়।'
                  )}
                </p>
              </div>
              <label className="inline-flex items-center gap-2 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap shrink-0">
                <Upload className="w-3.5 h-3.5" />
                <span>
                  {pendingPhoto
                    ? t('Replace Photo', 'ছবি পরিবর্তন করুন')
                    : t('Choose Photo', 'ছবি নির্বাচন করুন')}
                </span>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={handlePhotoChange}
                  className="sr-only"
                />
              </label>
            </div>

            {pendingPhoto && (
              <div className="mt-3 flex items-center gap-3 pt-3 border-t border-slate-200">
                <img
                  src={pendingPhoto.previewUrl}
                  alt={t('Compressed patient portrait preview', 'কম্প্রেসড রোগীর ছবির প্রিভিউ')}
                  className="w-12 h-12 rounded-lg object-cover border border-slate-200"
                />
                <div className="text-xs text-slate-600 tabular-nums">
                  <p className="font-medium text-slate-800">
                    {t('Ready for upload', 'আপলোডের জন্য প্রস্তুত')}
                  </p>
                  <p>
                    {formatBytes(pendingPhoto.originalBytes)}{' '}
                    {t('compressed to', 'থেকে কমে')}{' '}
                    {formatBytes(pendingPhoto.compressedBytes)}
                  </p>
                </div>
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
              disabled={submitting || atFreeLimit}
              className={`px-5 py-2 text-sm font-medium rounded-lg disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap ${palette.primaryBtn}`}
            >
              {submitting
                ? t('Saving Record...', 'রেকর্ড সংরক্ষণ হচ্ছে...')
                : isEditing
                  ? t('Save Changes', 'পরিবর্তন সংরক্ষণ করুন')
                  : t('Create Patient', 'রোগী যোগ করুন')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
