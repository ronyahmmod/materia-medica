import { FIELD_LIMITS, type FeeRecord } from '../types/clinic';

export interface FeeBreakdown {
  feeAmount: number;
  discountAmount: number;
  netAmount: number;
  cashPaid: number;
  dueAmount: number;
}

export interface FeeSummary {
  totalBilled: number;
  totalDiscount: number;
  totalNet: number;
  totalCashCollected: number;
  totalDue: number;
  todayCash: number;
  todayBilled: number;
  todayEntryCount: number;
  monthCash: number;
  monthBilled: number;
  monthEntryCount: number;
  entryCount: number;
  dueEntryCount: number;
}

export interface PatientFeeBalance {
  patientId: string;
  patientName: string;
  caseNumber: string;
  entryCount: number;
  totalBilled: number;
  totalDiscount: number;
  totalNet: number;
  totalCashCollected: number;
  totalDue: number;
  lastCollectedDate: string;
}

export function roundAmount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

export function parseNonNegativeAmount(raw: string | number): number {
  const num = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.min(FIELD_LIMITS.feeMaxAmount, roundAmount(num));
}

export function computeFeeBreakdown(
  rawFee: string | number,
  rawDiscount: string | number,
  rawCashPaid: string | number
): FeeBreakdown {
  const feeAmount = parseNonNegativeAmount(rawFee);
  const discountAmount = Math.min(feeAmount, parseNonNegativeAmount(rawDiscount));
  const netAmount = Math.max(0, roundAmount(feeAmount - discountAmount));
  const cashPaid = Math.min(netAmount, parseNonNegativeAmount(rawCashPaid));
  const dueAmount = Math.max(0, roundAmount(netAmount - cashPaid));

  return {
    feeAmount,
    discountAmount,
    netAmount,
    cashPaid,
    dueAmount,
  };
}

export function summarizeFees(records: FeeRecord[], referenceDateIso?: string): FeeSummary {
  const todayIso = referenceDateIso || new Date().toISOString().slice(0, 10);
  const monthPrefix = todayIso.slice(0, 7);

  let totalBilled = 0;
  let totalDiscount = 0;
  let totalNet = 0;
  let totalCashCollected = 0;
  let totalDue = 0;
  let todayCash = 0;
  let todayBilled = 0;
  let todayEntryCount = 0;
  let monthCash = 0;
  let monthBilled = 0;
  let monthEntryCount = 0;
  let dueEntryCount = 0;

  for (const rec of records) {
    const fee = roundAmount(rec.feeAmount);
    const discount = roundAmount(rec.discountAmount);
    const net = roundAmount(rec.netAmount);
    const cash = roundAmount(rec.cashPaid);
    const due = roundAmount(rec.dueAmount);

    totalBilled = roundAmount(totalBilled + fee);
    totalDiscount = roundAmount(totalDiscount + discount);
    totalNet = roundAmount(totalNet + net);
    totalCashCollected = roundAmount(totalCashCollected + cash);
    totalDue = roundAmount(totalDue + due);

    if (due > 0) {
      dueEntryCount += 1;
    }

    if (rec.collectedDate === todayIso) {
      todayCash = roundAmount(todayCash + cash);
      todayBilled = roundAmount(todayBilled + net);
      todayEntryCount += 1;
    }

    if (rec.collectedDate.startsWith(monthPrefix)) {
      monthCash = roundAmount(monthCash + cash);
      monthBilled = roundAmount(monthBilled + net);
      monthEntryCount += 1;
    }
  }

  return {
    totalBilled,
    totalDiscount,
    totalNet,
    totalCashCollected,
    totalDue,
    todayCash,
    todayBilled,
    todayEntryCount,
    monthCash,
    monthBilled,
    monthEntryCount,
    entryCount: records.length,
    dueEntryCount,
  };
}

export function groupFeesByPatient(records: FeeRecord[]): PatientFeeBalance[] {
  const map = new Map<string, PatientFeeBalance>();

  for (const rec of records) {
    const existing = map.get(rec.patientId);
    if (!existing) {
      map.set(rec.patientId, {
        patientId: rec.patientId,
        patientName: rec.patientName,
        caseNumber: rec.caseNumber,
        entryCount: 1,
        totalBilled: roundAmount(rec.feeAmount),
        totalDiscount: roundAmount(rec.discountAmount),
        totalNet: roundAmount(rec.netAmount),
        totalCashCollected: roundAmount(rec.cashPaid),
        totalDue: roundAmount(rec.dueAmount),
        lastCollectedDate: rec.collectedDate,
      });
    } else {
      existing.entryCount += 1;
      existing.totalBilled = roundAmount(existing.totalBilled + rec.feeAmount);
      existing.totalDiscount = roundAmount(existing.totalDiscount + rec.discountAmount);
      existing.totalNet = roundAmount(existing.totalNet + rec.netAmount);
      existing.totalCashCollected = roundAmount(existing.totalCashCollected + rec.cashPaid);
      existing.totalDue = roundAmount(existing.totalDue + rec.dueAmount);
      if (rec.collectedDate > existing.lastCollectedDate) {
        existing.lastCollectedDate = rec.collectedDate;
      }
    }
  }

  return Array.from(map.values()).sort((a, b) => {
    if (b.totalDue !== a.totalDue) return b.totalDue - a.totalDue;
    return b.lastCollectedDate.localeCompare(a.lastCollectedDate);
  });
}

let activeCurrencySymbol = '৳';

export function setActiveCurrencySymbol(symbol: string): void {
  activeCurrencySymbol = symbol || '৳';
}

export function getActiveCurrencySymbol(): string {
  return activeCurrencySymbol;
}

export function formatCashAmount(amount: number, currencySymbol?: string): string {
  const clean = roundAmount(amount);
  const hasDecimals = Math.abs(clean % 1) > 0.001;
  const symbol = currencySymbol || activeCurrencySymbol;
  return `${symbol}${clean.toLocaleString('en-US', {
    minimumFractionDigits: hasDecimals ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
}
