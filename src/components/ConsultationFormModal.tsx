import { useState, type ChangeEvent, type FormEvent } from 'react';
import { doc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { Upload, X } from 'lucide-react';
import { auth, db, handleFirestoreError, OperationType } from '../firebase';
import { compressClinicalImage, formatBytes } from '../lib/imageCompressor';
import { uploadClinicalPhoto } from '../lib/photoApi';
import { useLanguage } from '../i18n/LanguageContext';
import { PHOTO_CATEGORY_LABELS_I18N } from '../i18n/translations';
import {
  COMMON_REMEDIES,
  FIELD_LIMITS,
  POTENCY_OPTIONS,
  type Patient,
  type PhotoCategory,
} from '../types/clinic';

interface ConsultationFormModalProps {
  patient: Patient;
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

export function ConsultationFormModal({
  patient,
  onClose,
  onSaved,
}: ConsultationFormModalProps) {
  const { language, t } = useLanguage();
  const photoCategoryLabels = PHOTO_CATEGORY_LABELS_I18N[language];
  const todayStr = new Date().toISOString().slice(0, 10);

  const [visitDate, setVisitDate] = useState(todayStr);
  const [presentingSymptoms, setPresentingSymptoms] = useState('');
  const [mentalGenerals, setMentalGenerals] = useState('');
  const [physicalGenerals, setPhysicalGenerals] = useState('');
  const [modalitiesWorse, setModalitiesWorse] = useState('');
  const [modalitiesBetter, setModalitiesBetter] = useState('');
  const [remedyName, setRemedyName] = useState('');
  const [potency, setPotency] = useState('200C');
  const [dosage, setDosage] = useState(() =>
    t('3 globules once daily for 5 days', '৩টি গ্লোবিউলস দিনে একবার ৫ দিন')
  );
  const [clinicalNotes, setClinicalNotes] = useState('');
  const [nextFollowUpDate, setNextFollowUpDate] = useState('');

  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<PhotoCategory>('symptom');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

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

    if (!presentingSymptoms.trim() || !remedyName.trim() || !dosage.trim()) {
      setErrorMsg(
        t(
          'Presenting symptoms, remedy name, and dosage are required.',
          'বর্তমান লক্ষণ, ওষুধের নাম এবং মাত্রা আবশ্যক।'
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

    setSubmitting(true);
    const consultationId = `con_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const path = `patients/${patient.id}/consultations/${consultationId}`;

    try {
      const uploadedPhotoIds: string[] = [];

      for (const att of attachments) {
        const uploaded = await uploadClinicalPhoto(patient.id, att.dataBase64);
        const photoDocId = `pho_${uploaded.photoId.slice(0, 24)}`;
        await setDoc(doc(db, 'patients', patient.id, 'photos', photoDocId), {
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
        patientId: patient.id,
        visitDate: visitDate.slice(0, 32),
        presentingSymptoms: presentingSymptoms.trim().slice(0, FIELD_LIMITS.presentingSymptomsMax),
        remedyName: remedyName.trim().slice(0, FIELD_LIMITS.remedyNameMax),
        potency: potency.trim().slice(0, FIELD_LIMITS.potencyMax),
        dosage: dosage.trim().slice(0, FIELD_LIMITS.dosageMax),
        createdBy: uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };

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

      await setDoc(doc(db, 'patients', patient.id, 'consultations', consultationId), payload);

      const patientUpdate: Record<string, unknown> = {
        status: nextFollowUpDate ? 'follow-up' : 'active',
        lastVisitDate: visitDate,
        lastRemedy: `${remedyName.trim()} ${potency.trim()}`.slice(0, 160),
        updatedAt: serverTimestamp(),
      };
      if (nextFollowUpDate.trim()) {
        patientUpdate.nextFollowUpDate = nextFollowUpDate.trim().slice(0, 32);
      } else if (patient.nextFollowUpDate) {
        patientUpdate.nextFollowUpDate = patient.nextFollowUpDate;
      }

      await updateDoc(doc(db, 'patients', patient.id), patientUpdate);
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
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-3xl my-8 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2 className="font-display text-lg font-semibold text-slate-900">
              {t('Log Homeopathic Consultation', 'হোমিওপ্যাথিক কনসাল্টেশন লিপিবদ্ধ করুন')}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {patient.fullName} · <span className="font-mono">{patient.caseNumber}</span>
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

        <form onSubmit={handleSubmit} className="p-6 space-y-5 max-h-[80vh] overflow-y-auto">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                {t('Visit Date *', 'ভিজিটের তারিখ *')}
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
                placeholder={t('e.g. Cold air, midnight, motion', 'যেমন: ঠান্ডা বাতাস, মধ্যরাত, নড়াচড়ায়')}
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
                placeholder={t('e.g. Warm drinks, open air, pressure', 'যেমন: গরম পানীয়, খোলা বাতাস, চাপে')}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
              />
            </div>
          </div>

          <div className="border-t border-slate-200 pt-5">
            <h3 className="text-xs font-semibold text-slate-800 mb-3">
              {t('Prescription & Remedy Selection', 'প্রেসক্রিপশন ও ওষুধ নির্বাচন')}
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-12 gap-4">
              <div className="sm:col-span-5">
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  {t('Remedy Name *', 'ওষুধের নাম *')}
                </label>
                <input
                  type="text"
                  required
                  list="homeopathy-remedies"
                  maxLength={FIELD_LIMITS.remedyNameMax}
                  value={remedyName}
                  onChange={(e) => setRemedyName(e.target.value)}
                  placeholder="e.g. Arsenicum album"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                />
                <datalist id="homeopathy-remedies">
                  {COMMON_REMEDIES.map((rem) => (
                    <option key={rem} value={rem} />
                  ))}
                </datalist>
              </div>

              <div className="sm:col-span-3">
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  {t('Potency *', 'পোটেন্সি (শক্তি) *')}
                </label>
                <select
                  value={potency}
                  onChange={(e) => setPotency(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                >
                  {POTENCY_OPTIONS.map((pot) => (
                    <option key={pot} value={pot}>
                      {pot}
                    </option>
                  ))}
                </select>
              </div>

              <div className="sm:col-span-4">
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  {t('Dosage & Repetition *', 'মাত্রা ও পুনরাবৃত্তি *')}
                </label>
                <input
                  type="text"
                  required
                  maxLength={FIELD_LIMITS.dosageMax}
                  value={dosage}
                  onChange={(e) => setDosage(e.target.value)}
                  placeholder={t('3 globules BID x 7 days', '৩টি গ্লোবিউলস দিনে ২ বার ৭ দিন')}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                />
              </div>
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
              className="px-5 py-2 text-sm font-medium text-white bg-teal-700 rounded-lg hover:bg-teal-800 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
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
