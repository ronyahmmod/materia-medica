import { useMemo, useState, type FormEvent } from 'react';
import { serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { Banknote, Calculator, X } from 'lucide-react';
import { auth, OperationType, reportFirestoreError } from '../firebase';
import { useLanguage } from '../i18n/LanguageContext';
import { FEE_CATEGORY_LABELS_I18N } from '../i18n/translations';
import { computeFeeBreakdown, formatCashAmount } from '../lib/feeCalculations';
import { ACCENT_THEME_PALETTES, tenantFeeDoc } from '../lib/tenantPaths';
import {
  FEE_CATEGORIES,
  FIELD_LIMITS,
  type ClinicTenant,
  type FeeCategory,
  type FeeRecord,
  type Patient,
} from '../types/clinic';

interface FeeEntryModalProps {
  clinic: ClinicTenant;
  patients: Patient[];
  lockedPatient?: Patient;
  existingFee?: FeeRecord | null;
  onClose: () => void;
  onSaved: () => void;
}

const FEE_PRESETS = [200, 300, 500, 1000];

export function FeeEntryModal({
  clinic,
  patients,
  lockedPatient,
  existingFee,
  onClose,
  onSaved,
}: FeeEntryModalProps) {
  const { language, t } = useLanguage();
  const palette = ACCENT_THEME_PALETTES[clinic.accentColor] || ACCENT_THEME_PALETTES.teal;
  const currency = clinic.currencySymbol || '৳';
  const categoryLabels = FEE_CATEGORY_LABELS_I18N[language];
  const todayStr = new Date().toISOString().slice(0, 10);

  const [selectedPatientId, setSelectedPatientId] = useState(
    existingFee?.patientId || lockedPatient?.id || patients[0]?.id || ''
  );
  const [collectedDate, setCollectedDate] = useState(
    existingFee?.collectedDate || todayStr
  );
  const [feeType, setFeeType] = useState<FeeCategory>(
    existingFee?.feeType || 'consultation'
  );
  const [feeInput, setFeeInput] = useState(
    existingFee ? String(existingFee.feeAmount) : ''
  );
  const [discountInput, setDiscountInput] = useState(
    existingFee && existingFee.discountAmount > 0 ? String(existingFee.discountAmount) : ''
  );
  const [cashPaidInput, setCashPaidInput] = useState(
    existingFee ? String(existingFee.cashPaid) : ''
  );
  const [cashManuallyEdited, setCashManuallyEdited] = useState(Boolean(existingFee));
  const [notes, setNotes] = useState(existingFee?.notes || '');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const selectedPatient = useMemo(() => {
    if (lockedPatient) return lockedPatient;
    return patients.find((p) => p.id === selectedPatientId) || null;
  }, [lockedPatient, patients, selectedPatientId]);

  const breakdown = useMemo(
    () => computeFeeBreakdown(feeInput, discountInput, cashPaidInput),
    [feeInput, discountInput, cashPaidInput]
  );

  const handleFeeChange = (val: string) => {
    setFeeInput(val);
    if (!cashManuallyEdited) {
      const next = computeFeeBreakdown(val, discountInput, val);
      setCashPaidInput(next.netAmount > 0 ? String(next.netAmount) : '');
    }
  };

  const handleDiscountChange = (val: string) => {
    setDiscountInput(val);
    if (!cashManuallyEdited) {
      const next = computeFeeBreakdown(feeInput, val, feeInput);
      setCashPaidInput(next.netAmount > 0 ? String(next.netAmount) : '');
    }
  };

  const applyPresetFee = (amount: number) => {
    const val = String(amount);
    setFeeInput(val);
    if (!cashManuallyEdited) {
      const next = computeFeeBreakdown(val, discountInput, val);
      setCashPaidInput(next.netAmount > 0 ? String(next.netAmount) : '');
    }
  };

  const applyCashMode = (mode: 'full' | 'half' | 'due') => {
    setCashManuallyEdited(true);
    if (mode === 'full') {
      setCashPaidInput(String(breakdown.netAmount));
    } else if (mode === 'half') {
      const half = Math.round((breakdown.netAmount / 2) * 100) / 100;
      setCashPaidInput(String(half));
    } else {
      setCashPaidInput('0');
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    if (!selectedPatient) {
      setErrorMsg(
        t('Please select a patient first.', 'অনুগ্রহ করে প্রথমে একজন রোগী নির্বাচন করুন।')
      );
      return;
    }

    if (breakdown.feeAmount <= 0) {
      setErrorMsg(
        t(
          'Fee amount must be greater than 0.',
          'ফি-এর পরিমাণ ০ এর বেশি হতে হবে।'
        )
      );
      return;
    }

    const rawDiscountNum = Number(discountInput || 0);
    if (rawDiscountNum > breakdown.feeAmount) {
      setErrorMsg(
        t(
          'Discount cannot exceed the total fee amount.',
          'ছাড় মোট ফি-এর চেয়ে বেশি হতে পারবে না।'
        )
      );
      return;
    }

    const rawCashNum = Number(cashPaidInput || 0);
    if (rawCashNum > breakdown.netAmount) {
      setErrorMsg(
        t(
          'Cash collected cannot exceed the net payable amount.',
          'নগদ আদায় নিট প্রদেয় টাকার চেয়ে বেশি হতে পারবে না।'
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
    const feeId =
      existingFee?.id || `fee_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const path = `clinics/${clinic.id}/fee_records/${feeId}`;
    const trimmedNotes = notes.trim().slice(0, FIELD_LIMITS.feeNotesMax);

    try {
      if (existingFee) {
        const updatePayload: Record<string, unknown> = {
          patientName: selectedPatient.fullName.slice(0, FIELD_LIMITS.fullNameMax),
          caseNumber: selectedPatient.caseNumber.slice(0, FIELD_LIMITS.caseNumberMax),
          collectedDate: collectedDate.slice(0, 32),
          feeType,
          feeAmount: breakdown.feeAmount,
          discountAmount: breakdown.discountAmount,
          netAmount: breakdown.netAmount,
          cashPaid: breakdown.cashPaid,
          dueAmount: breakdown.dueAmount,
          updatedAt: serverTimestamp(),
        };
        if (trimmedNotes || existingFee.notes !== undefined) {
          updatePayload.notes = trimmedNotes;
        }
        await updateDoc(tenantFeeDoc(clinic.id, feeId), updatePayload);
      } else {
        const createPayload: Record<string, unknown> = {
          clinicId: clinic.id,
          clinicAccessEmails: clinic.accessEmails,
          clinicAccessUids: clinic.authorizedUids || [],
          patientId: selectedPatient.id,
          patientName: selectedPatient.fullName.slice(0, FIELD_LIMITS.fullNameMax),
          caseNumber: selectedPatient.caseNumber.slice(0, FIELD_LIMITS.caseNumberMax),
          collectedDate: collectedDate.slice(0, 32),
          feeType,
          feeAmount: breakdown.feeAmount,
          discountAmount: breakdown.discountAmount,
          netAmount: breakdown.netAmount,
          cashPaid: breakdown.cashPaid,
          dueAmount: breakdown.dueAmount,
          createdBy: uid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        };
        if (trimmedNotes) {
          createPayload.notes = trimmedNotes;
        }
        await setDoc(tenantFeeDoc(clinic.id, feeId), createPayload);
      }

      onSaved();
    } catch (error) {
      const msg = reportFirestoreError(
        error,
        existingFee ? OperationType.UPDATE : OperationType.CREATE,
        path
      );
      setErrorMsg(
        msg || t('Unable to save cash fee entry.', 'নগদ ফি-এর হিসাব সংরক্ষণ করা যায়নি।')
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-xl my-8 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2 className="font-display text-lg font-semibold text-slate-900">
              {existingFee
                ? t('Edit Cash Fee Entry', 'নগদ ফি-এর হিসাব সম্পাদনা')
                : t('Record Cash Fee', 'নগদ ফি সংগ্রহ ও হিসাব')}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5 flex items-center gap-1.5">
              <Banknote className="w-3.5 h-3.5 text-teal-700" />
              <span>
                {t(
                  'Cash collection only (no other payment methods)',
                  'শুধুমাত্র নগদ গ্রহণযোগ্য (অন্য কোনো পেমেন্ট মাধ্যম নেই)'
                )}
              </span>
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

        <form onSubmit={handleSubmit} className="p-6 space-y-5 max-h-[82vh] overflow-y-auto">
          {/* Patient Selection */}
          <div>
            <label
              htmlFor="fee-patient-select"
              className="block text-xs font-medium text-slate-700 mb-1.5"
            >
              {t('Patient *', 'রোগী *')}
            </label>
            {lockedPatient || existingFee ? (
              <div className="px-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-800 flex items-center justify-between">
                <span className="font-medium">
                  {selectedPatient?.fullName || existingFee?.patientName}
                </span>
                <span className="font-mono text-xs text-slate-500">
                  {selectedPatient?.caseNumber || existingFee?.caseNumber}
                </span>
              </div>
            ) : (
              <select
                id="fee-patient-select"
                required
                value={selectedPatientId}
                onChange={(e) => setSelectedPatientId(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
              >
                {patients.length === 0 ? (
                  <option value="">
                    {t('No patients available', 'কোনো রোগী পাওয়া যায়নি')}
                  </option>
                ) : (
                  patients.map((pat) => (
                    <option key={pat.id} value={pat.id}>
                      {pat.fullName} ({pat.caseNumber})
                    </option>
                  ))
                )}
              </select>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="fee-collected-date"
                className="block text-xs font-medium text-slate-700 mb-1.5"
              >
                {t('Collection Date *', 'সংগ্রহের তারিখ *')}
              </label>
              <input
                id="fee-collected-date"
                type="date"
                required
                value={collectedDate}
                onChange={(e) => setCollectedDate(e.target.value)}
                className="w-full px-3 py-2 text-sm tabular-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
              />
            </div>

            <div>
              <label
                htmlFor="fee-category"
                className="block text-xs font-medium text-slate-700 mb-1.5"
              >
                {t('Fee Category *', 'ফি-এর ধরন *')}
              </label>
              <select
                id="fee-category"
                value={feeType}
                onChange={(e) => setFeeType(e.target.value as FeeCategory)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
              >
                {FEE_CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>
                    {categoryLabels[cat]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Interactive Cash Fee Calculator */}
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800">
                <Calculator className="w-3.5 h-3.5 text-teal-700" />
                <span>{t('Cash Fee Calculation', 'নগদ ফি-এর হিসাব')}</span>
              </div>
              <span className="text-[11px] font-medium text-teal-800 bg-teal-50 border border-teal-200 px-2 py-0.5 rounded-md">
                {t('Cash Only', 'শুধুমাত্র নগদ')}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label
                  htmlFor="fee-gross-amount"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  {t(`Total Fee (${currency}) *`, `মোট ফি (${currency}) *`)}
                </label>
                <input
                  id="fee-gross-amount"
                  type="number"
                  min={1}
                  max={FIELD_LIMITS.feeMaxAmount}
                  step="any"
                  required
                  value={feeInput}
                  onChange={(e) => handleFeeChange(e.target.value)}
                  placeholder="500"
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                />
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {FEE_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => applyPresetFee(preset)}
                      className="px-2 py-0.5 text-[11px] font-mono tabular-nums text-slate-700 bg-white border border-slate-300 rounded hover:bg-slate-100 cursor-pointer"
                    >
                      {currency}{preset}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label
                  htmlFor="fee-discount-amount"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  {t(`Discount (${currency})`, `ছাড় / ডিসকাউন্ট (${currency})`)}
                </label>
                <input
                  id="fee-discount-amount"
                  type="number"
                  min={0}
                  max={breakdown.feeAmount || FIELD_LIMITS.feeMaxAmount}
                  step="any"
                  value={discountInput}
                  onChange={(e) => handleDiscountChange(e.target.value)}
                  placeholder="0"
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                />
                <p className="text-[11px] text-slate-500 mt-2 tabular-nums">
                  {t('Net Payable:', 'নিট প্রদেয়:')}{' '}
                  <span className="font-mono font-semibold text-slate-900">
                    {formatCashAmount(breakdown.netAmount, currency)}
                  </span>
                </p>
              </div>
            </div>

            <div>
              <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                <label
                  htmlFor="fee-cash-paid"
                  className="block text-xs font-medium text-slate-700"
                >
                  {t(`Cash Collected (${currency}) *`, `নগদ আদায় (${currency}) *`)}
                </label>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => applyCashMode('full')}
                    className={`px-2 py-0.5 text-[11px] font-medium border rounded cursor-pointer ${palette.softPanel}`}
                  >
                    {t('Full Cash', 'সম্পূর্ণ নগদ')}
                  </button>
                  <button
                    type="button"
                    onClick={() => applyCashMode('half')}
                    className="px-2 py-0.5 text-[11px] font-medium text-slate-700 bg-white border border-slate-300 rounded hover:bg-slate-100 cursor-pointer"
                  >
                    {t('50%', '৫০%')}
                  </button>
                  <button
                    type="button"
                    onClick={() => applyCashMode('due')}
                    className="px-2 py-0.5 text-[11px] font-medium text-amber-800 bg-amber-50 border border-amber-200 rounded hover:bg-amber-100 cursor-pointer"
                  >
                    {t(`${currency}0 (Due)`, `${currency}০ (বকেয়া)`)}
                  </button>
                </div>
              </div>
              <input
                id="fee-cash-paid"
                type="number"
                min={0}
                max={breakdown.netAmount || FIELD_LIMITS.feeMaxAmount}
                step="any"
                required
                value={cashPaidInput}
                onChange={(e) => {
                  setCashManuallyEdited(true);
                  setCashPaidInput(e.target.value);
                }}
                placeholder="0"
                className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
              />
            </div>

            {/* Live Calculation Summary Bar */}
            <div className="grid grid-cols-3 gap-3 pt-3 border-t border-slate-200 text-xs tabular-nums">
              <div>
                <p className="text-slate-500">{t('Net Fee', 'নিট ফি')}</p>
                <p className="font-mono text-sm font-semibold text-slate-900 mt-0.5">
                  {formatCashAmount(breakdown.netAmount, currency)}
                </p>
              </div>
              <div>
                <p className="text-slate-500">{t('Cash Received', 'নগদ জমা')}</p>
                <p className="font-mono text-sm font-semibold text-emerald-700 mt-0.5">
                  {formatCashAmount(breakdown.cashPaid, currency)}
                </p>
              </div>
              <div>
                <p className="text-slate-500">{t('Balance Due', 'বকেয়া')}</p>
                <p
                  className={`font-mono text-sm font-semibold mt-0.5 ${
                    breakdown.dueAmount > 0 ? 'text-amber-700' : 'text-slate-700'
                  }`}
                >
                  {formatCashAmount(breakdown.dueAmount, currency)}
                </p>
              </div>
            </div>
          </div>

          <div>
            <label
              htmlFor="fee-notes"
              className="block text-xs font-medium text-slate-700 mb-1.5"
            >
              {t('Notes (Optional)', 'নোট (ঐচ্ছিক)')}
            </label>
            <input
              id="fee-notes"
              type="text"
              maxLength={FIELD_LIMITS.feeNotesMax}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t(
                'e.g. Initial case-taking + 15 days globules',
                'যেমন: প্রথম ভিজিট ও ১৫ দিনের ওষুধের ফি'
              )}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
            />
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
              disabled={submitting || !selectedPatient}
              className={`px-5 py-2 text-sm font-medium rounded-lg disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap ${palette.primaryBtn}`}
            >
              {submitting
                ? t('Saving...', 'সংরক্ষণ হচ্ছে...')
                : existingFee
                  ? t('Update Cash Entry', 'হিসাব আপডেট করুন')
                  : t('Save Cash Fee', 'নগদ ফি সংরক্ষণ করুন')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
