import React from 'react';
import { AlertTriangle, CheckCircle2, ShieldAlert, Sparkles, Clock } from 'lucide-react';
import { ClinicalQaAssessment, CriticalUrgencyLevel } from '../../services/geminiService';
import Spinner from './Spinner';

export function getUrgencyBadgeMeta(level: CriticalUrgencyLevel): {
  label: string;
  shortLabel: string;
  pillClass: string;
} {
  switch (level) {
    case 'critical_stat':
      return {
        label: 'Critical STAT Alert',
        shortLabel: 'CRITICAL STAT',
        pillClass:
          'bg-rose-600 text-white border-rose-700 animate-pulse shadow-xs',
      };
    case 'urgent':
      return {
        label: 'Urgent Finding',
        shortLabel: 'URGENT',
        pillClass:
          'bg-amber-500 text-slate-950 border-amber-600 shadow-2xs',
      };
    case 'prompt_follow_up':
      return {
        label: 'Prompt Follow-up',
        shortLabel: 'Follow-up',
        pillClass:
          'bg-sky-100 text-sky-800 border-sky-300 dark:bg-sky-900/50 dark:text-sky-200 dark:border-sky-700',
      };
    default:
      return {
        label: 'Routine',
        shortLabel: 'Routine',
        pillClass:
          'bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-900/50 dark:text-emerald-200 dark:border-emerald-700',
      };
  }
}

interface ClinicalQaPanelProps {
  assessment?: ClinicalQaAssessment | null;
  errorCheckStatus?: 'idle' | 'checking' | 'complete';
  errorCount?: number;
  className?: string;
}

const ClinicalQaPanel: React.FC<ClinicalQaPanelProps> = ({
  assessment,
  errorCheckStatus = 'idle',
  errorCount = 0,
  className = '',
}) => {
  if (errorCheckStatus === 'checking') {
    return (
      <div
        className={`p-3 rounded-xl border border-blue-200 dark:border-blue-800/70 bg-blue-50/70 dark:bg-blue-950/30 flex items-center gap-2.5 text-xs sm:text-sm text-blue-800 dark:text-blue-200 ${className}`}
        role="status"
      >
        <Spinner className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />
        <span className="font-medium">
          Running Gemini Decision-1 Clinical QA (laterality, contradictions, impression numbers, critical urgency &amp; completeness)...
        </span>
      </div>
    );
  }

  if (!assessment) return null;

  const { criticalUrgency, reportCompleteness, rules, invokedDetailedGenerator, decisionLatencyMs } = assessment;
  const urgencyMeta = getUrgencyBadgeMeta(criticalUrgency.level);
  const isCriticalOrUrgent = criticalUrgency.level === 'critical_stat' || criticalUrgency.level === 'urgent';

  const completenessPct = Math.round((reportCompleteness.score / 3) * 100);
  const completenessTone =
    reportCompleteness.score >= 2.3
      ? 'bg-emerald-500'
      : reportCompleteness.score >= 1.5
      ? 'bg-sky-500'
      : reportCompleteness.score >= 0.8
      ? 'bg-amber-500'
      : 'bg-rose-500';

  return (
    <div className={`space-y-2.5 ${className}`}>
      {isCriticalOrUrgent && (
        <div
          role="alert"
          className={`p-3.5 rounded-xl border-2 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 shadow-sm ${
            criticalUrgency.level === 'critical_stat'
              ? 'bg-rose-50 dark:bg-rose-950/50 border-rose-500 dark:border-rose-600 text-rose-900 dark:text-rose-100'
              : 'bg-amber-50 dark:bg-amber-950/40 border-amber-400 dark:border-amber-600 text-amber-950 dark:text-amber-100'
          }`}
        >
          <div className="flex items-start sm:items-center gap-2.5">
            <ShieldAlert
              className={`w-5 h-5 shrink-0 mt-0.5 sm:mt-0 ${
                criticalUrgency.level === 'critical_stat'
                  ? 'text-rose-600 dark:text-rose-400 animate-pulse'
                  : 'text-amber-600 dark:text-amber-400'
              }`}
            />
            <div className="text-xs sm:text-sm">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-extrabold uppercase tracking-wide">
                  {urgencyMeta.label}
                </span>
                <span className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-white/80 dark:bg-slate-900/60 border border-current/20">
                  Acuity {criticalUrgency.expectedScore.toFixed(2)}/3 • {Math.round(criticalUrgency.confidence * 100)}% conf
                </span>
              </div>
              <p className="text-xs opacity-90 mt-0.5">
                {criticalUrgency.level === 'critical_stat'
                  ? 'Potential immediately life-threatening or time-critical finding detected — prioritize STAT clinical communication.'
                  : 'Acute abnormality detected — prompt same-day clinical correlation / management recommended.'}
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-700/80 bg-slate-50/90 dark:bg-slate-900/40 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold border ${urgencyMeta.pillClass}`}>
              {urgencyMeta.label}
            </span>

            <div
              className="inline-flex items-center gap-2 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200"
              title={`Completeness Score: ${reportCompleteness.score.toFixed(2)} / 3 (${Math.round(reportCompleteness.confidence * 100)}% confidence)`}
            >
              <span>Completeness: <strong>{reportCompleteness.score.toFixed(1)}/3</strong> ({reportCompleteness.label})</span>
              <span className="w-12 h-1.5 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden inline-block">
                <span className={`block h-full ${completenessTone}`} style={{ width: `${completenessPct}%` }} />
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
            <Sparkles className="w-3.5 h-3.5 text-blue-500 shrink-0" />
            {invokedDetailedGenerator ? (
              <span className="font-semibold text-amber-700 dark:text-amber-300">
                {errorCount} issue{errorCount === 1 ? '' : 's'} detailed
              </span>
            ) : (
              <span className="font-semibold text-emerald-700 dark:text-emerald-400">
                0 flags • Generative call skipped
              </span>
            )}
            {typeof decisionLatencyMs === 'number' && (
              <span className="inline-flex items-center gap-0.5 font-mono text-[10px] opacity-80">
                <Clock className="w-3 h-3" />
                {decisionLatencyMs}ms
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {rules.map((rule) => (
            <span
              key={rule.id}
              title={`${rule.label}: P(issue)=${(rule.probability * 100).toFixed(0)}% | Confidence=${(rule.confidence * 100).toFixed(0)}% (Threshold ≥ 70%)`}
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] font-semibold border ${
                rule.triggered
                  ? 'bg-amber-100/90 dark:bg-amber-950/60 border-amber-400 dark:border-amber-700 text-amber-900 dark:text-amber-200'
                  : 'bg-white dark:bg-slate-800/80 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
              }`}
            >
              {rule.triggered ? (
                <AlertTriangle className="w-3 h-3 text-amber-600 dark:text-amber-400 shrink-0" />
              ) : (
                <CheckCircle2 className="w-3 h-3 text-emerald-600 dark:text-emerald-400 shrink-0" />
              )}
              <span>{rule.label}</span>
              {rule.triggered && (
                <span className="font-mono text-[10px] opacity-85">
                  ({Math.round(rule.probability * 100)}%)
                </span>
              )}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
};

export default ClinicalQaPanel;
