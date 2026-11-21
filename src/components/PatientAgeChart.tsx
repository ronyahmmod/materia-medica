import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { BarChart3 } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';
import type { Patient } from '../types/clinic';

interface PatientAgeChartProps {
  patients: Patient[];
}

interface AgeBucketDatum {
  range: string;
  label: string;
  count: number;
  activeCount: number;
  percentage: number;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{ payload: AgeBucketDatum }>;
}

function AgeDistributionTooltip({ active, payload }: CustomTooltipProps) {
  const { t } = useLanguage();

  if (!active || !payload || payload.length === 0) {
    return null;
  }

  const item = payload[0].payload;

  return (
    <div className="bg-white border border-slate-200 rounded-lg px-3.5 py-2.5 shadow-sm text-xs space-y-1">
      <p className="font-semibold text-slate-900">
        {item.label} <span className="font-mono text-slate-500">({item.range})</span>
      </p>
      <div className="text-slate-700 tabular-nums space-y-0.5">
        <p>
          {t('Patients:', 'রোগী সংখ্যা:')}{' '}
          <span className="font-semibold text-slate-900">{item.count}</span> ({item.percentage}%)
        </p>
        <p className="text-slate-500">
          {t('Active cases:', 'সক্রিয় কেস:')}{' '}
          <span className="font-medium text-teal-800">{item.activeCount}</span>
        </p>
      </div>
    </div>
  );
}

export function PatientAgeChart({ patients }: PatientAgeChartProps) {
  const { t } = useLanguage();

  const { buckets, averageAge, peakBucket } = useMemo(() => {
    const definitions = [
      {
        range: '0–12',
        label: t('Pediatric (0–12)', 'শিশু (০–১২)'),
        min: 0,
        max: 12,
      },
      {
        range: '13–24',
        label: t('Youth (13–24)', 'কিশোর ও তরুণ (১৩–২৪)'),
        min: 13,
        max: 24,
      },
      {
        range: '25–44',
        label: t('Adult (25–44)', 'প্রাপ্তবয়স্ক (২৫–৪৪)'),
        min: 25,
        max: 44,
      },
      {
        range: '45–64',
        label: t('Middle Age (45–64)', 'মধ্যবয়সী (৪৫–৬৪)'),
        min: 45,
        max: 64,
      },
      {
        range: '65+',
        label: t('Senior (65+)', 'প্রবীণ (৬৫+)'),
        min: 65,
        max: Number.POSITIVE_INFINITY,
      },
    ];

    const validPatients = patients.filter(
      (p) => typeof p.age === 'number' && Number.isFinite(p.age) && p.age >= 0
    );
    const total = validPatients.length;

    const avg =
      total > 0
        ? Math.round(
            (validPatients.reduce((sum, p) => sum + p.age, 0) / total) * 10
          ) / 10
        : 0;

    const computed: AgeBucketDatum[] = definitions.map((def) => {
      const matched = validPatients.filter(
        (p) => p.age >= def.min && p.age <= def.max
      );
      const count = matched.length;
      const activeCount = matched.filter((p) => p.status === 'active').length;
      const percentage = total > 0 ? Math.round((count / total) * 100) : 0;

      return {
        range: def.range,
        label: def.label,
        count,
        activeCount,
        percentage,
      };
    });

    const peak = computed.reduce<AgeBucketDatum | null>((best, curr) => {
      if (curr.count === 0) return best;
      if (!best || curr.count > best.count) return curr;
      return best;
    }, null);

    return {
      buckets: computed,
      averageAge: avg,
      peakBucket: peak,
    };
  }, [patients, t]);

  return (
    <section
      aria-label={t('Patient Age Distribution', 'রোগীদের বয়সভিত্তিক বিন্যাস')}
      className="bg-white border border-slate-200 rounded-xl p-6"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-slate-100">
        <div>
          <div className="flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-teal-700" />
            <h2 className="font-display text-sm font-semibold text-slate-900">
              {t('Patient Age Distribution', 'রোগীদের বয়সভিত্তিক বিন্যাস')}
            </h2>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            {t(
              'Caseload breakdown across clinical age cohorts.',
              'ক্লিনিক্যাল বয়স গ্রুপ অনুযায়ী নিবন্ধিত রোগীদের সংখ্যা।'
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-6 text-xs tabular-nums">
          <div>
            <p className="text-slate-500">{t('Mean Age', 'গড় বয়স')}</p>
            <p className="font-display text-base font-semibold text-slate-900">
              {averageAge} {t('yrs', 'বছর')}
            </p>
          </div>
          <div>
            <p className="text-slate-500">{t('Primary Cohort', 'প্রধান বয়স গ্রুপ')}</p>
            <p className="font-display text-base font-semibold text-teal-800">
              {peakBucket ? `${peakBucket.range} (${peakBucket.percentage}%)` : '—'}
            </p>
          </div>
        </div>
      </div>

      <div className="mt-5 h-[250px] w-full min-w-0">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={buckets}
            margin={{ top: 8, right: 12, left: -16, bottom: 4 }}
          >
            <CartesianGrid
              stroke="#e2e8f0"
              strokeDasharray="3 3"
              vertical={false}
            />
            <XAxis
              dataKey="range"
              tick={{ fill: '#475569', fontSize: 12 }}
              axisLine={{ stroke: '#cbd5e1' }}
              tickLine={false}
            />
            <YAxis
              allowDecimals={false}
              tick={{ fill: '#64748b', fontSize: 12 }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              cursor={{ fill: '#f1f5f9' }}
              content={<AgeDistributionTooltip />}
            />
            <Bar
              dataKey="count"
              fill="#0f766e"
              radius={[6, 6, 0, 0]}
              maxBarSize={52}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
