import React from 'react';
import { AudioAssessmentReport } from '../types';
import Spinner from './ui/Spinner';
import { Activity, ShieldAlert, Sparkles, Download, RefreshCw, X, MessageSquare, Volume2, Gauge, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { downloadAssessmentPDF } from '../services/assessmentPdfGenerator';

export interface AudioAssessmentPanelProps {
  report: AudioAssessmentReport | null;
  isLoading: boolean;
  error?: string | null;
  hasAudio: boolean;
  onRunAssessment: () => void;
  onClose: () => void;
  onInquireInChat?: (query: string) => void;
}

export const AudioAssessmentPanel: React.FC<AudioAssessmentPanelProps> = ({
  report,
  isLoading,
  error,
  hasAudio,
  onRunAssessment,
  onClose,
  onInquireInChat,
}) => {
  const getConfidenceBadge = (score: number) => {
    if (score >= 80) {
      return {
        bg: 'bg-emerald-50 dark:bg-emerald-950/40',
        text: 'text-emerald-700 dark:text-emerald-300',
        border: 'border-emerald-200 dark:border-emerald-800',
        label: 'High Diagnostic Firmness',
        icon: CheckCircle2,
      };
    }
    if (score >= 60) {
      return {
        bg: 'bg-amber-50 dark:bg-amber-950/40',
        text: 'text-amber-700 dark:text-amber-300',
        border: 'border-amber-200 dark:border-amber-800',
        label: 'Moderate / Equivocal Nuance',
        icon: AlertTriangle,
      };
    }
    return {
      bg: 'bg-rose-50 dark:bg-rose-950/40',
      text: 'text-rose-700 dark:text-rose-300',
      border: 'border-rose-200 dark:border-rose-800',
      label: 'High Acoustic Hesitation',
      icon: ShieldAlert,
    };
  };

  const handleDownloadReport = () => {
    if (report) {
      downloadAssessmentPDF(report, 'Radiology_Dictation_Audio_Assessment');
    }
  };

  const badge = report ? getConfidenceBadge(report.overallConfidenceScore) : null;
  const BadgeIcon = badge ? badge.icon : null;

  return (
    <div
      id="audio-assessment-panel"
      className="mb-6 rounded-2xl border border-teal-200 dark:border-teal-800/80 bg-gradient-to-b from-teal-50/40 to-white dark:from-slate-900 dark:to-slate-800/90 shadow-md p-5 transition-all"
    >
      {/* Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-teal-100 dark:border-slate-700/80">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-teal-600 text-white shadow-sm">
            <Activity className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-bold text-slate-900 dark:text-slate-100 text-base sm:text-lg">
                Acoustic & Diagnostic Prosody Assessment
              </h3>
              <span className="text-[10px] uppercase font-mono tracking-wider px-2 py-0.5 rounded-full bg-teal-100 text-teal-800 dark:bg-teal-900/60 dark:text-teal-300 font-bold">
                Biomechanical Telemetry
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Evaluates vocal inflection, hesitation latency, speech cadence, and counterfactual shadow-differentials.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {report && !isLoading && (
            <button
              id="download-assessment-pdf-btn"
              onClick={handleDownloadReport}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 shadow-sm transition-all"
              title="Download formatted Assessment report"
            >
              <Download className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
              <span>Download PDF</span>
            </button>
          )}

          <button
            id="reassess-audio-btn"
            onClick={onRunAssessment}
            disabled={isLoading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-teal-600 hover:bg-teal-700 text-white shadow-sm disabled:opacity-50 transition-all"
            title="Re-analyze dictation audio telemetry"
          >
            {isLoading ? (
              <Spinner className="w-3.5 h-3.5" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            <span>{isLoading ? 'Assessing...' : report ? 'Re-Assess' : 'Analyze Telemetry'}</span>
          </button>

          <button
            id="close-assessment-panel-btn"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
            aria-label="Close Assessment Panel"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Loading State */}
      {isLoading && (
        <div className="py-8 flex flex-col items-center justify-center text-center">
          <div className="relative mb-3">
            <div className="w-12 h-12 rounded-full border-4 border-teal-200 dark:border-teal-900 border-t-teal-600 dark:border-t-teal-400 animate-spin" />
            <Activity className="w-5 h-5 text-teal-600 dark:text-teal-400 absolute inset-0 m-auto" />
          </div>
          <p className="text-sm font-bold text-slate-800 dark:text-slate-200">
            Analyzing Vocal Biomechanics & Hesitation Patterns...
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mt-1">
            Measuring pitch drops, auditory latency pauses, articulation clarity, and epistemic uncertainty against report findings.
          </p>
        </div>
      )}

      {/* Error State */}
      {error && !isLoading && (
        <div className="mt-4 p-4 rounded-xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900 text-rose-700 dark:text-rose-300 text-sm flex items-start gap-3">
          <ShieldAlert className="w-5 h-5 text-rose-600 dark:text-rose-400 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-bold">Assessment Failed</p>
            <p className="text-xs mt-0.5">{error}</p>
          </div>
          <button
            onClick={onRunAssessment}
            className="text-xs font-bold underline hover:no-underline text-rose-800 dark:text-rose-200"
          >
            Retry
          </button>
        </div>
      )}

      {/* Empty State / Not Yet Assessed */}
      {!report && !isLoading && !error && (
        <div className="py-6 text-center">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Ready to evaluate voice prosody, hesitation pauses, and diagnostic shadow-differentials for this dictation.
          </p>
          <button
            onClick={onRunAssessment}
            className="mt-3 inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold bg-teal-600 text-white hover:bg-teal-700 shadow transition-all"
          >
            <Activity className="w-4 h-4" />
            <span>Begin Acoustic Assessment</span>
          </button>
        </div>
      )}

      {/* Populated Report */}
      {report && !isLoading && (
        <div className="mt-4 space-y-4">
          {/* Telemetry Metrics Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className={`p-3 rounded-xl border ${badge?.border} ${badge?.bg} transition-all`}>
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold uppercase tracking-wider text-slate-600 dark:text-slate-400">
                  Confidence
                </span>
                {BadgeIcon && <BadgeIcon className={`w-4 h-4 ${badge?.text}`} />}
              </div>
              <div className={`text-2xl font-black mt-1 ${badge?.text}`}>
                {report.overallConfidenceScore}%
              </div>
              <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400 truncate mt-0.5">
                {badge?.label}
              </div>
            </div>

            <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white/80 dark:bg-slate-800/80">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Cadence
                </span>
                <Gauge className="w-4 h-4 text-slate-400" />
              </div>
              <div className="text-2xl font-black text-slate-800 dark:text-slate-100 mt-1">
                {report.estimatedWpm} <span className="text-xs font-medium text-slate-400">WPM</span>
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                {report.estimatedWpm > 170 ? 'Rapid Delivery' : report.estimatedWpm < 110 ? 'Deliberate / Methodical' : 'Optimal Pace'}
              </div>
            </div>

            <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white/80 dark:bg-slate-800/80">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Vocal Clarity
                </span>
                <Volume2 className="w-4 h-4 text-slate-400" />
              </div>
              <div className="text-base font-bold text-slate-800 dark:text-slate-100 mt-2 truncate">
                {report.speechClarity || 'Crisp & Clear'}
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                Articulation rating
              </div>
            </div>

            <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white/80 dark:bg-slate-800/80">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Analyzed
                </span>
                <Sparkles className="w-4 h-4 text-slate-400" />
              </div>
              <div className="text-2xl font-black text-slate-800 dark:text-slate-100 mt-1">
                {report.findingInsights?.length || 0}
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                Findings correlated
              </div>
            </div>
          </div>

          {/* Actionable Clinical Takeaway */}
          <div className="p-3.5 rounded-xl bg-teal-50/90 dark:bg-teal-950/40 border-l-4 border-teal-600 dark:border-teal-500 text-slate-800 dark:text-slate-200 shadow-sm">
            <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-teal-800 dark:text-teal-300">
              <Sparkles className="w-3.5 h-3.5" />
              <span>Actionable Clinical Takeaway</span>
            </div>
            <p className="text-sm mt-1 leading-relaxed text-slate-700 dark:text-slate-300">
              {report.actionableSummary || 'No significant diagnostic hesitation identified in this dictation.'}
            </p>
          </div>

          {/* Pacing & Hesitation Summary */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
            <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700/60">
              <span className="font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider block mb-1">
                Pacing & Vocal Rhythm
              </span>
              <p className="text-slate-600 dark:text-slate-400 leading-normal">
                {report.pacingEvaluation || 'Even, unhurried phrasing throughout dictation.'}
              </p>
            </div>
            <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700/60">
              <span className="font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider block mb-1">
                Hesitation & Cognitive Pauses
              </span>
              <p className="text-slate-600 dark:text-slate-400 leading-normal">
                {report.acousticHesitationSummary || 'No mid-utterance latency or pitch tremor flags detected.'}
              </p>
            </div>
          </div>

          {/* Key Shadow-Differentials (Bias Prevention) */}
          {report.keyShadowDifferentials && report.keyShadowDifferentials.length > 0 && (
            <div className="p-4 rounded-xl bg-amber-50/70 dark:bg-amber-950/30 border border-amber-200/80 dark:border-amber-900/60">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                <h4 className="text-xs font-bold uppercase tracking-wider text-amber-900 dark:text-amber-300">
                  Key Shadow-Differentials (Premature Closure Counter-Checks)
                </h4>
              </div>
              <ul className="space-y-1.5 text-xs text-amber-950 dark:text-amber-200 pl-4 list-disc">
                {report.keyShadowDifferentials.map((item, idx) => (
                  <li key={idx} className="leading-relaxed">
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Finding-by-finding Breakdown */}
          {report.findingInsights && report.findingInsights.length > 0 && (
            <div className="space-y-3 pt-2">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-slate-400">
                  Finding Uncertainty & Acoustic Correlation
                </h4>
                <span className="text-[11px] text-slate-400">
                  {report.findingInsights.length} finding{report.findingInsights.length === 1 ? '' : 's'} highlighted
                </span>
              </div>

              <div className="space-y-2.5">
                {report.findingInsights.map((insight, idx) => {
                  const isHighUncertainty = insight.uncertaintyScore >= 50;
                  return (
                    <div
                      key={idx}
                      className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-700/80 bg-white dark:bg-slate-800/90 shadow-sm space-y-2"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs font-bold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
                          <span className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-[10px] font-mono">
                            #{insight.findingIndex + 1}
                          </span>
                          <span className="text-blue-600 dark:text-blue-400 font-semibold">
                            {insight.findingTitleOrExcerpt}
                          </span>
                        </span>

                        <span
                          className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                            isHighUncertainty
                              ? 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800'
                              : 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800'
                          }`}
                        >
                          Uncertainty: {insight.uncertaintyScore}%
                        </span>
                      </div>

                      {/* Acoustic observation */}
                      {insight.acousticObservation && (
                        <div className="text-xs bg-slate-50 dark:bg-slate-900/60 p-2 rounded-lg border-l-2 border-sky-500">
                          <span className="font-semibold text-slate-700 dark:text-slate-300">Acoustics: </span>
                          <span className="text-slate-600 dark:text-slate-400">{insight.acousticObservation}</span>
                        </div>
                      )}

                      {/* Clinical significance */}
                      {insight.clinicalSignificance && (
                        <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                          <strong className="text-slate-700 dark:text-slate-200">Clinical Nuance: </strong>
                          {insight.clinicalSignificance}
                        </p>
                      )}

                      {/* Differential checks */}
                      {insight.differentialConsiderations && insight.differentialConsiderations.length > 0 && (
                        <div className="text-xs text-slate-600 dark:text-slate-400 space-y-1 pt-1">
                          <strong className="text-slate-700 dark:text-slate-200 text-[11px] block">
                            Differential Verifications:
                          </strong>
                          <ul className="pl-4 list-disc space-y-0.5">
                            {insight.differentialConsiderations.map((d, dIdx) => (
                              <li key={dIdx}>{d}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* Suggested Chat Inquiry */}
                      {insight.suggestedChatInquiry && onInquireInChat && (
                        <div className="pt-1 flex items-center justify-between gap-2">
                          <div className="text-[11px] text-teal-800 dark:text-teal-300 font-medium italic truncate flex-1">
                            "{insight.suggestedChatInquiry}"
                          </div>
                          <button
                            type="button"
                            onClick={() => onInquireInChat(insight.suggestedChatInquiry)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-teal-50 hover:bg-teal-100 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300 dark:hover:bg-teal-900 border border-teal-200 dark:border-teal-800 transition-all shadow-sm"
                          >
                            <MessageSquare className="w-3 h-3" />
                            <span>Ask Co-pilot</span>
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default AudioAssessmentPanel;
