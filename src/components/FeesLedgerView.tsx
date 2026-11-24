import { useMemo, useState } from 'react';
import { serverTimestamp, updateDoc } from 'firebase/firestore';
import {
  Banknote,
  CheckCircle2,
  Edit3,
  Plus,
  Search,
  Trash2,
  Users,
} from 'lucide-react';
import { auth, handleFirestoreError, OperationType } from '../firebase';
import { useLanguage } from '../i18n/LanguageContext';
import { FEE_CATEGORY_LABELS_I18N } from '../i18n/translations';
import {
  formatCashAmount,
  groupFeesByPatient,
  roundAmount,
  summarizeFees,
} from '../lib/feeCalculations';
import { ACCENT_THEME_PALETTES, buildSoftDeletePayload, tenantFeeDoc } from '../lib/tenantPaths';
import type { ClinicTenant, FeeRecord, Patient } from '../types/clinic';
import { FeeEntryModal } from './FeeEntryModal';

interface FeesLedgerViewProps {
  clinic: ClinicTenant;
  patients: Patient[];
  feeRecords: FeeRecord[];
  loading: boolean;
  onSelectPatient: (patientId: string) => void;
}

export function FeesLedgerView({
  clinic,
  patients,
  feeRecords,
  loading,
  onSelectPatient,
}: FeesLedgerViewProps) {
  const { language, t } = useLanguage();
  const palette = ACCENT_THEME_PALETTES[clinic.accentColor] || ACCENT_THEME_PALETTES.teal;
  const categoryLabels = FEE_CATEGORY_LABELS_I18N[language];
  const todayIso = new Date().toISOString().slice(0, 10);
  const monthPrefix = todayIso.slice(0, 7);

  const [viewMode, setViewMode] = useState<'ledger' | 'patients'>('ledger');
  const [searchQuery, setSearchQuery] = useState('');
  const [periodFilter, setPeriodFilter] = useState<'all' | 'today' | 'month'>('all');
  const [dueFilter, setDueFilter] = useState<'all' | 'paid' | 'due'>('all');

  const [showFeeModal, setShowFeeModal] = useState(false);
  const [editingFee, setEditingFee] = useState<FeeRecord | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [settlingFeeId, setSettlingFeeId] = useState<string | null>(null);
  const [settleAmountInput, setSettleAmountInput] = useState('');
  const [savingSettle, setSavingSettle] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const summary = useMemo(() => summarizeFees(feeRecords, todayIso), [feeRecords, todayIso]);

  const patientBalances = useMemo(() => {
    const grouped = groupFeesByPatient(feeRecords);
    const q = searchQuery.trim().toLowerCase();
    return grouped.filter((item) => {
      if (dueFilter === 'due' && item.totalDue <= 0) return false;
      if (dueFilter === 'paid' && item.totalDue > 0) return false;
      if (!q) return true;
      return (
        item.patientName.toLowerCase().includes(q) ||
        item.caseNumber.toLowerCase().includes(q)
      );
    });
  }, [feeRecords, searchQuery, dueFilter]);

  const filteredRecords = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return feeRecords.filter((rec) => {
      if (periodFilter === 'today' && rec.collectedDate !== todayIso) return false;
      if (periodFilter === 'month' && !rec.collectedDate.startsWith(monthPrefix)) return false;
      if (dueFilter === 'paid' && rec.dueAmount > 0) return false;
      if (dueFilter === 'due' && rec.dueAmount <= 0) return false;
      if (!q) return true;
      return (
        rec.patientName.toLowerCase().includes(q) ||
        rec.caseNumber.toLowerCase().includes(q) ||
        (rec.notes || '').toLowerCase().includes(q) ||
        categoryLabels[rec.feeType].toLowerCase().includes(q)
      );
    });
  }, [feeRecords, searchQuery, periodFilter, dueFilter, todayIso, monthPrefix, categoryLabels]);

  const filteredTotals = useMemo(
    () => summarizeFees(filteredRecords, todayIso),
    [filteredRecords, todayIso]
  );

  const openNewFeeModal = () => {
    setEditingFee(null);
    setShowFeeModal(true);
  };

  const openEditFeeModal = (rec: FeeRecord) => {
    setEditingFee(rec);
    setShowFeeModal(true);
  };

  const startSettleDue = (rec: FeeRecord) => {
    setConfirmDeleteId(null);
    setActionError(null);
    setSettlingFeeId(rec.id);
    setSettleAmountInput(String(rec.dueAmount));
  };

  const handleConfirmSettleDue = async (rec: FeeRecord) => {
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

  const handleDeleteFee = async (feeId: string) => {
    setActionError(null);
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    try {
      await updateDoc(tenantFeeDoc(clinic.id, feeId), buildSoftDeletePayload(uid, true));
      setConfirmDeleteId(null);
    } catch (error) {
      if (error instanceof Error && error.message.includes('Missing or insufficient permissions')) {
        handleFirestoreError(error, OperationType.UPDATE, `clinics/${clinic.id}/fee_records/${feeId}`);
      }
      setActionError(
        error instanceof Error
          ? error.message
          : t('Unable to delete fee record.', 'ফি রেকর্ড মুছে ফেলা যায়নি।')
      );
    }
  };

  const collectionRate =
    summary.totalNet > 0 ? Math.round((summary.totalCashCollected / summary.totalNet) * 100) : 100;

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
            {t('Cash Fees & Ledger', 'নগদ ফি ও হিসাব খাতা')}
          </h1>
          <p className="text-sm text-slate-500 mt-0.5 flex items-center gap-1.5">
            <Banknote className="w-4 h-4 text-teal-700 shrink-0" />
            <span>
              {t(
                'Cash-only fee collection, discounts, and patient due calculations.',
                'শুধুমাত্র নগদ ফি সংগ্রহ, ছাড় এবং রোগীদের বকেয়া হিসাব পরিচালনা।'
              )}
            </span>
          </p>
        </div>

        <button
          type="button"
          disabled={patients.length === 0}
          onClick={openNewFeeModal}
          className={`inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap shrink-0 self-start sm:self-auto ${palette.primaryBtn}`}
        >
          <Plus className="w-3.5 h-3.5" />
          {t('Record Cash Fee', 'নগদ ফি যোগ করুন')}
        </button>
      </div>

      {/* 4-Card KPI Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">
            {t("Today's Cash Collected", 'আজকের নগদ আদায়')}
          </p>
          <p className="font-display text-2xl font-semibold text-emerald-700 mt-1 tabular-nums">
            {formatCashAmount(summary.todayCash)}
          </p>
          <p className="text-xs text-slate-500 mt-1 tabular-nums">
            {summary.todayEntryCount} {t('entries today', 'টি এন্ট্রি আজ')} ·{' '}
            {t('Net billed', 'নিট বিল')} {formatCashAmount(summary.todayBilled)}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">
            {t("This Month's Cash", 'এই মাসের নগদ আদায়')}
          </p>
          <p className="font-display text-2xl font-semibold text-slate-900 mt-1 tabular-nums">
            {formatCashAmount(summary.monthCash)}
          </p>
          <p className="text-xs text-slate-500 mt-1 tabular-nums">
            {monthPrefix} · {summary.monthEntryCount} {t('receipts', 'টি রসিদ')}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">
            {t('Total Cash Collected', 'মোট নগদ আদায়')}
          </p>
          <p className="font-display text-2xl font-semibold text-slate-900 mt-1 tabular-nums">
            {formatCashAmount(summary.totalCashCollected)}
          </p>
          <p className="text-xs text-slate-500 mt-1 tabular-nums">
            {collectionRate}% {t('of net', 'আদায়')} ({formatCashAmount(summary.totalNet)})
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">
            {t('Total Pending Due', 'মোট বকেয়া')}
          </p>
          <p
            className={`font-display text-2xl font-semibold mt-1 tabular-nums ${
              summary.totalDue > 0 ? 'text-amber-700' : 'text-slate-900'
            }`}
          >
            {formatCashAmount(summary.totalDue)}
          </p>
          <p className="text-xs text-slate-500 mt-1 tabular-nums">
            {summary.dueEntryCount} {t('unsettled entries', 'টি বকেয়া এন্ট্রি')} ·{' '}
            {t('Discounts:', 'ছাড়:')} {formatCashAmount(summary.totalDiscount)}
          </p>
        </div>
      </div>

      {/* Controls Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
            <button
              type="button"
              onClick={() => setViewMode('ledger')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                viewMode === 'ledger'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {t('Fee Ledger', 'ফি খাতা')} ({feeRecords.length})
            </button>
            <button
              type="button"
              onClick={() => setViewMode('patients')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                viewMode === 'patients'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {t('Patient Balances', 'রোগীভিত্তিক হিসাব')} ({patientBalances.length})
            </button>
          </div>

          {viewMode === 'ledger' && (
            <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
              {(['all', 'today', 'month'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPeriodFilter(p)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                    periodFilter === p
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {p === 'all'
                    ? t('All Time', 'সব সময়')
                    : p === 'today'
                      ? t('Today', 'আজ')
                      : t('This Month', 'এই মাস')}
                </button>
              ))}
            </div>
          )}

          <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
            {(['all', 'due', 'paid'] as const).map((status) => (
              <button
                key={status}
                type="button"
                onClick={() => setDueFilter(status)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                  dueFilter === status
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {status === 'all'
                  ? t('All Status', 'সব')
                  : status === 'due'
                    ? t('Has Due', 'বকেয়া আছে')
                    : t('Paid in Full', 'পরিশোধিত')}
              </button>
            ))}
          </div>
        </div>

        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t(
              'Search patient, case #, note...',
              'রোগীর নাম, কেস নম্বর বা নোট...'
            )}
            className="pl-9 pr-3 py-1.5 text-xs w-60 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
          />
        </div>
      </div>

      {actionError && (
        <div className="p-3.5 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800">
          {actionError}
        </div>
      )}

      {loading ? (
        <div className="bg-white border border-slate-200 rounded-xl p-8 space-y-3">
          <div className="h-5 bg-slate-100 rounded w-1/3" />
          <div className="h-10 bg-slate-100 rounded" />
          <div className="h-10 bg-slate-100 rounded" />
        </div>
      ) : patients.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-12 text-center">
          <Users className="w-7 h-7 text-slate-400 mx-auto mb-3" />
          <h2 className="font-display text-base font-semibold text-slate-900">
            {t('Register a patient first', 'প্রথমে একজন রোগী নিবন্ধন করুন')}
          </h2>
          <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
            {t(
              'Cash fees are linked directly to patient case files so balances and dues calculate accurately.',
              'নগদ ফি ও বকেয়া সঠিকভাবে হিসাব করার জন্য প্রতিটি ফি রোগীর কেস ফাইলের সাথে যুক্ত থাকে।'
            )}
          </p>
        </div>
      ) : viewMode === 'patients' ? (
        patientBalances.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-xl p-12 text-center">
            <Banknote className="w-7 h-7 text-slate-400 mx-auto mb-3" />
            <h2 className="font-display text-base font-semibold text-slate-900">
              {t('No patient fee balances found', 'কোনো রোগীর ফি হিসাব পাওয়া যায়নি')}
            </h2>
          </div>
        ) : (
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold text-slate-500">
                    <th className="py-3 px-4 whitespace-nowrap">{t('Patient', 'রোগী')}</th>
                    <th className="py-3 px-4 whitespace-nowrap text-right">
                      {t('Entries', 'এন্ট্রি')}
                    </th>
                    <th className="py-3 px-4 whitespace-nowrap text-right">
                      {t('Gross Fee', 'মোট ফি')}
                    </th>
                    <th className="py-3 px-4 whitespace-nowrap text-right">
                      {t('Discount', 'ছাড়')}
                    </th>
                    <th className="py-3 px-4 whitespace-nowrap text-right">
                      {t('Net Payable', 'নিট প্রদেয়')}
                    </th>
                    <th className="py-3 px-4 whitespace-nowrap text-right">
                      {t('Cash Paid', 'নগদ আদায়')}
                    </th>
                    <th className="py-3 px-4 whitespace-nowrap text-right">
                      {t('Balance Due', 'বকেয়া')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 text-xs tabular-nums">
                  {patientBalances.map((row) => (
                    <tr
                      key={row.patientId}
                      onClick={() => onSelectPatient(row.patientId)}
                      className="hover:bg-slate-50 transition-colors cursor-pointer"
                    >
                      <td className="py-3 px-4 whitespace-nowrap">
                        <p className="font-medium text-slate-900">{row.patientName}</p>
                        <p className="text-[11px] font-mono text-slate-500">
                          {row.caseNumber} · {t('Last:', 'সর্বশেষ:')} {row.lastCollectedDate}
                        </p>
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-slate-600">
                        {row.entryCount}
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-slate-700">
                        {formatCashAmount(row.totalBilled)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-slate-500">
                        {row.totalDiscount > 0 ? formatCashAmount(row.totalDiscount) : '—'}
                      </td>
                      <td className="py-3 px-4 text-right font-mono font-medium text-slate-900">
                        {formatCashAmount(row.totalNet)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono font-semibold text-emerald-700">
                        {formatCashAmount(row.totalCashCollected)}
                      </td>
                      <td
                        className={`py-3 px-4 text-right font-mono font-semibold ${
                          row.totalDue > 0 ? 'text-amber-700' : 'text-slate-500'
                        }`}
                      >
                        {row.totalDue > 0 ? formatCashAmount(row.totalDue) : t('Paid', 'পরিশোধিত')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      ) : filteredRecords.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-12 text-center">
          <Banknote className="w-7 h-7 text-slate-400 mx-auto mb-3" />
          <h2 className="font-display text-base font-semibold text-slate-900">
            {feeRecords.length === 0
              ? t('No cash fees recorded yet', 'এখনও কোনো নগদ ফি লিপিবদ্ধ হয়নি')
              : t('No fee records match current filters', 'বর্তমান ফিল্টারে কোনো ফি পাওয়া যায়নি')}
          </h2>
          <p className="text-xs text-slate-500 mt-1 mb-5 max-w-sm mx-auto">
            {t(
              'Record consultation fees, medicine charges, discounts, and cash received to automatically calculate daily totals and due balances.',
              'কনসাল্টেশন ফি, ওষুধের মূল্য, ছাড় এবং নগদ জমা লিখে দৈনিক আয় ও বকেয়া স্বয়ংক্রিয়ভাবে হিসাব করুন।'
            )}
          </p>
          {feeRecords.length === 0 && (
            <button
              type="button"
              onClick={openNewFeeModal}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-lg hover:bg-teal-800 transition-colors cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              {t('Record First Cash Fee', 'প্রথম নগদ ফি যোগ করুন')}
            </button>
          )}
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold text-slate-500">
                  <th className="py-3 px-4 whitespace-nowrap">{t('Date', 'তারিখ')}</th>
                  <th className="py-3 px-4 whitespace-nowrap">{t('Patient', 'রোগী')}</th>
                  <th className="py-3 px-4 whitespace-nowrap">{t('Category', 'ধরন')}</th>
                  <th className="py-3 px-4 whitespace-nowrap text-right">{t('Fee', 'ফি')}</th>
                  <th className="py-3 px-4 whitespace-nowrap text-right">
                    {t('Discount', 'ছাড়')}
                  </th>
                  <th className="py-3 px-4 whitespace-nowrap text-right">{t('Net', 'নিট')}</th>
                  <th className="py-3 px-4 whitespace-nowrap text-right">
                    {t('Cash Paid', 'নগদ জমা')}
                  </th>
                  <th className="py-3 px-4 whitespace-nowrap text-right">{t('Due', 'বকেয়া')}</th>
                  <th className="py-3 px-4 whitespace-nowrap text-right">{t('Actions', 'কার্যক্রম')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-xs tabular-nums">
                {filteredRecords.map((rec) => {
                  const isSettling = settlingFeeId === rec.id;
                  const isDeleting = confirmDeleteId === rec.id;

                  return (
                    <tr key={rec.id} className="hover:bg-slate-50/70 align-top">
                      <td className="py-3 px-4 font-mono text-slate-600 whitespace-nowrap">
                        {rec.collectedDate}
                      </td>
                      <td className="py-3 px-4">
                        <button
                          type="button"
                          onClick={() => onSelectPatient(rec.patientId)}
                          className="text-left hover:text-teal-800 cursor-pointer"
                        >
                          <p className="font-medium text-slate-900">{rec.patientName}</p>
                          <p className="text-[11px] font-mono text-slate-500">{rec.caseNumber}</p>
                        </button>
                        {rec.notes && (
                          <p className="text-[11px] text-slate-500 mt-0.5 max-w-[220px] truncate">
                            {rec.notes}
                          </p>
                        )}
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <p className="text-slate-800">{categoryLabels[rec.feeType]}</p>
                        <p className="text-[11px] text-slate-500">
                          {t('Cash Only', 'শুধুমাত্র নগদ')}
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
                              aria-label={t('Cash received', 'নগদ গ্রহণ')}
                              className="w-20 px-2 py-1 text-xs font-mono bg-white border border-slate-300 rounded"
                            />
                            <button
                              type="button"
                              disabled={savingSettle}
                              onClick={() => handleConfirmSettleDue(rec)}
                              className="px-2 py-1 text-[11px] font-medium text-white bg-teal-700 rounded hover:bg-teal-800 cursor-pointer"
                            >
                              {savingSettle ? '...' : t('Collect', 'জমা')}
                            </button>
                            <button
                              type="button"
                              onClick={() => setSettlingFeeId(null)}
                              className="px-1.5 py-1 text-[11px] text-slate-600 hover:text-slate-900 cursor-pointer"
                            >
                              {t('Cancel', 'বাতিল')}
                            </button>
                          </div>
                        ) : isDeleting ? (
                          <div className="inline-flex items-center gap-1.5 bg-red-50 border border-red-200 rounded-lg px-2 py-1">
                            <button
                              type="button"
                              onClick={() => handleDeleteFee(rec.id)}
                              className="px-2 py-0.5 text-[11px] font-medium text-white bg-red-700 rounded hover:bg-red-800 cursor-pointer"
                            >
                              {t('Delete', 'মুছুন')}
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(null)}
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
                                onClick={() => startSettleDue(rec)}
                                title={t('Collect Cash Due', 'বকেয়া নগদ আদায়')}
                                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-teal-800 bg-teal-50 border border-teal-200 rounded hover:bg-teal-100 cursor-pointer"
                              >
                                <CheckCircle2 className="w-3 h-3" />
                                {t('Collect Cash', 'আদায়')}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => openEditFeeModal(rec)}
                              aria-label={t('Edit fee entry', 'ফি সম্পাদনা করুন')}
                              className="p-1.5 text-slate-400 hover:text-slate-900 rounded hover:bg-slate-100 cursor-pointer"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setSettlingFeeId(null);
                                setConfirmDeleteId(rec.id);
                              }}
                              aria-label={t('Delete fee entry', 'ফি মুছুন')}
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
              <tfoot>
                <tr className="border-t-2 border-slate-200 bg-slate-50/90 text-xs font-semibold text-slate-900 tabular-nums">
                  <td colSpan={3} className="py-3 px-4">
                    {t('Filtered Totals', 'ফিল্টারকৃত মোট হিসাব')} ({filteredRecords.length})
                  </td>
                  <td className="py-3 px-4 text-right font-mono">
                    {formatCashAmount(filteredTotals.totalBilled)}
                  </td>
                  <td className="py-3 px-4 text-right font-mono text-slate-600">
                    {formatCashAmount(filteredTotals.totalDiscount)}
                  </td>
                  <td className="py-3 px-4 text-right font-mono">
                    {formatCashAmount(filteredTotals.totalNet)}
                  </td>
                  <td className="py-3 px-4 text-right font-mono text-emerald-700">
                    {formatCashAmount(filteredTotals.totalCashCollected)}
                  </td>
                  <td className="py-3 px-4 text-right font-mono text-amber-700">
                    {formatCashAmount(filteredTotals.totalDue)}
                  </td>
                  <td className="py-3 px-4" />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {showFeeModal && (
        <FeeEntryModal
          clinic={clinic}
          patients={patients}
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
    </div>
  );
}
