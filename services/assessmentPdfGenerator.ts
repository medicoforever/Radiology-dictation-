import { AudioAssessmentReport } from '../types';

export interface BatchReportItem {
  batchName: string;
  report: AudioAssessmentReport;
}

const getScoreColor = (score: number) => {
  if (score >= 80) return { bg: '#ecfdf5', text: '#065f46', border: '#a7f3d0' };
  if (score >= 60) return { bg: '#fffbeb', text: '#92400e', border: '#fde68a' };
  return { bg: '#fef2f2', text: '#991b1b', border: '#fecaca' };
};

export const generateAssessmentReportHTML = (
  report: AudioAssessmentReport,
  reportTitle: string = 'Radiology Audio Assessment'
): string => {
  const scoreColors = getScoreColor(report.overallConfidenceScore);

  const findingsHTML = (report.findingInsights || [])
    .map((insight) => {
      const insightColors = getScoreColor(100 - insight.uncertaintyScore);
      const diffList = (insight.differentialConsiderations || [])
        .map((d) => `<li style="margin-bottom: 4px; color: #334155;">${escapeHtml(d)}</li>`)
        .join('');

      return `
        <div style="border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin-bottom: 16px; background-color: #ffffff; break-inside: avoid;">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px; border-bottom: 1px solid #f1f5f9; padding-bottom: 8px;">
            <div style="font-weight: 700; color: #0f172a; font-size: 15px;">
              Finding #${insight.findingIndex + 1}: <span style="color: #2563eb;">${escapeHtml(insight.findingTitleOrExcerpt)}</span>
            </div>
            <span style="background-color: ${insightColors.bg}; color: ${insightColors.text}; border: 1px solid ${insightColors.border}; padding: 3px 8px; border-radius: 9999px; font-size: 12px; font-weight: 700; white-space: nowrap;">
              Uncertainty: ${insight.uncertaintyScore}%
            </span>
          </div>

          <div style="margin-bottom: 8px;">
            <strong style="color: #475569; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em;">Acoustic Observation:</strong>
            <p style="margin: 3px 0 0 0; font-size: 13px; color: #1e293b; background-color: #f8fafc; padding: 8px; border-radius: 6px; border-left: 3px solid #0284c7;">
              ${escapeHtml(insight.acousticObservation)}
            </p>
          </div>

          <div style="margin-bottom: 8px;">
            <strong style="color: #475569; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em;">Clinical Significance & Bias Check:</strong>
            <p style="margin: 3px 0 0 0; font-size: 13px; color: #334155;">
              ${escapeHtml(insight.clinicalSignificance)}
            </p>
          </div>

          ${
            diffList
              ? `
          <div style="margin-bottom: 8px;">
            <strong style="color: #475569; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em;">Shadow Differential Counter-Checks:</strong>
            <ul style="margin: 4px 0 0 18px; padding: 0; font-size: 13px;">
              ${diffList}
            </ul>
          </div>`
              : ''
          }

          ${
            insight.suggestedChatInquiry
              ? `
          <div style="margin-top: 10px; background-color: #f0fdf4; border: 1px dashed #86efac; padding: 8px 12px; border-radius: 6px;">
            <strong style="color: #166534; font-size: 11px; text-transform: uppercase;">Suggested Co-pilot Query:</strong>
            <div style="font-size: 12px; color: #15803d; margin-top: 2px;">"${escapeHtml(insight.suggestedChatInquiry)}"</div>
          </div>`
              : ''
          }
        </div>
      `;
    })
    .join('');

  const keyDiffsHTML = (report.keyShadowDifferentials || [])
    .map((kd) => `<li style="margin-bottom: 6px; color: #1e293b;">${escapeHtml(kd)}</li>`)
    .join('');

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(reportTitle)} - Acoustic & Diagnostic Assessment</title>
  <style>
    @page {
      size: A4 portrait;
      margin: 15mm;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      line-height: 1.5;
      color: #0f172a;
      background-color: #ffffff;
      margin: 0;
      padding: 24px;
    }
    .header-box {
      border-bottom: 2px solid #0f172a;
      padding-bottom: 14px;
      margin-bottom: 20px;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
    }
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      margin-bottom: 20px;
    }
    .metric-card {
      background-color: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 12px;
      text-align: center;
    }
    .metric-value {
      font-size: 22px;
      font-weight: 800;
      margin-top: 4px;
    }
    .metric-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #64748b;
      font-weight: 600;
    }
    .summary-box {
      background-color: #f8fafc;
      border-left: 4px solid #0d9488;
      border-radius: 0 8px 8px 0;
      padding: 14px 18px;
      margin-bottom: 20px;
    }
    .print-button {
      position: fixed;
      bottom: 20px;
      right: 20px;
      background-color: #0d9488;
      color: white;
      border: none;
      padding: 10px 20px;
      font-weight: 700;
      border-radius: 8px;
      cursor: pointer;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
    }
    @media print {
      body {
        padding: 0;
      }
      .print-button {
        display: none !important;
      }
    }
  </style>
</head>
<body>
  <div class="header-box">
    <div>
      <h1 style="margin: 0; font-size: 22px; font-weight: 800; color: #0f172a;">Acoustic & Diagnostic Prosody Assessment</h1>
      <p style="margin: 4px 0 0 0; font-size: 13px; color: #64748b;">${escapeHtml(reportTitle)}</p>
    </div>
    <div style="text-align: right; font-size: 12px; color: #64748b;">
      <div>Generated: ${new Date().toLocaleDateString()} ${report.assessedAt || ''}</div>
      <div style="font-weight: 600; color: #0d9488;">AI Diagnostic Co-Pilot Engine</div>
    </div>
  </div>

  <div class="metrics-grid">
    <div class="metric-card" style="border-color: ${scoreColors.border}; background-color: ${scoreColors.bg};">
      <div class="metric-label" style="color: ${scoreColors.text};">Confidence Index</div>
      <div class="metric-value" style="color: ${scoreColors.text};">${report.overallConfidenceScore}%</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Cadence</div>
      <div class="metric-value" style="color: #0f172a;">${report.estimatedWpm} <span style="font-size: 12px; font-weight: normal; color: #64748b;">WPM</span></div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Vocal Clarity</div>
      <div class="metric-value" style="color: #0f172a; font-size: 16px; margin-top: 8px;">${escapeHtml(report.speechClarity || 'Crisp & Clear')}</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Findings Assessed</div>
      <div class="metric-value" style="color: #0f172a;">${report.findingInsights?.length || 0}</div>
    </div>
  </div>

  <div class="summary-box">
    <h3 style="margin: 0 0 6px 0; font-size: 14px; font-weight: 700; color: #0f766e; text-transform: uppercase;">
      Actionable Diagnostic Takeaway
    </h3>
    <p style="margin: 0; font-size: 14px; color: #1e293b; line-height: 1.6;">
      ${escapeHtml(report.actionableSummary || 'No significant acoustic hesitation or ambiguity flags detected in this dictation.')}
    </p>
  </div>

  <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px;">
    <div style="border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; background-color: #fafafa;">
      <h4 style="margin: 0 0 6px 0; font-size: 12px; text-transform: uppercase; color: #475569;">Pacing & Rhythm Analysis</h4>
      <p style="margin: 0; font-size: 13px; color: #1e293b;">${escapeHtml(report.pacingEvaluation || 'Standard dictation cadence.')}</p>
    </div>
    <div style="border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; background-color: #fafafa;">
      <h4 style="margin: 0 0 6px 0; font-size: 12px; text-transform: uppercase; color: #475569;">Auditory Hesitation Mapping</h4>
      <p style="margin: 0; font-size: 13px; color: #1e293b;">${escapeHtml(report.acousticHesitationSummary || 'No abnormal vocal hesitation patterns.')}</p>
    </div>
  </div>

  ${
    keyDiffsHTML
      ? `
  <div style="border: 1px solid #fed7aa; background-color: #fffbeb; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
    <h3 style="margin: 0 0 8px 0; font-size: 14px; font-weight: 700; color: #9a3412;">
      Key Counterfactual Shadow-Differentials (Bias Prevention)
    </h3>
    <ul style="margin: 0 0 0 20px; padding: 0; font-size: 13px;">
      ${keyDiffsHTML}
    </ul>
  </div>`
      : ''
  }

  <h2 style="font-size: 16px; font-weight: 700; color: #0f172a; margin: 0 0 12px 0; border-bottom: 1px solid #cbd5e1; padding-bottom: 6px;">
    Finding-by-Finding Biomechanical Uncertainty Breakdown
  </h2>

  ${findingsHTML || '<p style="color: #64748b; font-size: 13px;">No individual finding hesitation flags recorded.</p>'}

  <button class="print-button" onclick="window.print()">Print / Save as PDF</button>
</body>
</html>
  `;
};

export const generateBatchAssessmentsReportHTML = (
  items: BatchReportItem[],
  documentTitle: string = 'Batch Radiology Audio Assessments'
): string => {
  const sectionsHTML = items
    .map((item, idx) => {
      const r = item.report;
      const scoreColors = getScoreColor(r.overallConfidenceScore);
      const findingsSummary = (r.findingInsights || [])
        .map(
          (f) => `
          <div style="font-size: 13px; padding: 6px 0; border-bottom: 1px dashed #e2e8f0;">
            <strong style="color: #1e293b;">Finding #${f.findingIndex + 1}:</strong> ${escapeHtml(f.findingTitleOrExcerpt)}
            <span style="float: right; font-weight: bold; color: ${f.uncertaintyScore > 40 ? '#b91c1c' : '#047857'};">Uncertainty: ${f.uncertaintyScore}%</span>
            <div style="font-size: 12px; color: #64748b; margin-top: 2px;"><em>Acoustics:</em> ${escapeHtml(f.acousticObservation)}</div>
          </div>
        `
        )
        .join('');

      return `
        <div style="border: 1px solid #e2e8f0; border-radius: 8px; padding: 18px; margin-bottom: 24px; background-color: #ffffff; break-inside: avoid;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; border-bottom: 2px solid #f1f5f9; padding-bottom: 10px;">
            <h3 style="margin: 0; font-size: 17px; color: #0f172a;">${idx + 1}. ${escapeHtml(item.batchName)}</h3>
            <span style="background-color: ${scoreColors.bg}; color: ${scoreColors.text}; border: 1px solid ${scoreColors.border}; padding: 4px 10px; border-radius: 9999px; font-size: 13px; font-weight: 800;">
              Confidence: ${r.overallConfidenceScore}% | ${r.estimatedWpm} WPM
            </span>
          </div>

          <div style="margin-bottom: 12px; background-color: #f8fafc; padding: 10px; border-radius: 6px; font-size: 13px;">
            <strong>Actionable Summary:</strong> ${escapeHtml(r.actionableSummary || 'Normal evaluation.')}
          </div>

          <div style="margin-top: 10px;">
            <h4 style="margin: 0 0 8px 0; font-size: 12px; text-transform: uppercase; color: #475569;">Findings Breakdown</h4>
            ${findingsSummary || '<p style="color: #64748b; font-size: 12px;">No findings insights.</p>'}
          </div>
        </div>
      `;
    })
    .join('');

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(documentTitle)}</title>
  <style>
    @page { size: A4 portrait; margin: 15mm; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; color: #0f172a; padding: 24px; }
    .print-button {
      position: fixed;
      bottom: 20px;
      right: 20px;
      background-color: #0d9488;
      color: white;
      border: none;
      padding: 10px 20px;
      font-weight: 700;
      border-radius: 8px;
      cursor: pointer;
    }
    @media print { .print-button { display: none !important; } }
  </style>
</head>
<body>
  <div style="border-bottom: 2px solid #0f172a; padding-bottom: 12px; margin-bottom: 24px; display: flex; justify-content: space-between; align-items: flex-end;">
    <div>
      <h1 style="margin: 0; font-size: 22px;">Batch Radiology Acoustic & Uncertainty Reports</h1>
      <p style="margin: 4px 0 0 0; font-size: 13px; color: #64748b;">Total Studies: ${items.length}</p>
    </div>
    <div style="text-align: right; font-size: 12px; color: #64748b;">
      Generated: ${new Date().toLocaleDateString()}
    </div>
  </div>

  ${sectionsHTML}

  <button class="print-button" onclick="window.print()">Print / Save as PDF</button>
</body>
</html>
  `;
};

export const downloadAssessmentPDF = (
  report: AudioAssessmentReport,
  reportTitle: string = 'Radiology Audio Assessment'
): void => {
  const htmlContent = generateAssessmentReportHTML(report, reportTitle);
  triggerPrintOrDownload(htmlContent, `${reportTitle.replace(/\s+/g, '_')}_Audio_Assessment.html`);
};

export const downloadBatchAssessmentsPDF = (
  items: BatchReportItem[],
  filename: string = 'batch-radiology-assessments.html'
): void => {
  const htmlContent = generateBatchAssessmentsReportHTML(items);
  triggerPrintOrDownload(htmlContent, filename);
};

const triggerPrintOrDownload = (htmlContent: string, fallbackFilename: string) => {
  try {
    const printWindow = window.open('', '_blank');
    if (printWindow) {
      printWindow.document.open();
      printWindow.document.write(htmlContent);
      printWindow.document.close();
      setTimeout(() => {
        try {
          printWindow.focus();
          printWindow.print();
        } catch {
          // If print popup fails in iframe, fallback to file download
          downloadHtmlFile(htmlContent, fallbackFilename);
        }
      }, 350);
      return;
    }
  } catch {
    // Popup blocked, fallback to standard download
  }

  downloadHtmlFile(htmlContent, fallbackFilename);
};

const downloadHtmlFile = (content: string, filename: string) => {
  const blob = new Blob([content], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  }, 100);
};

const escapeHtml = (text: string): string => {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
};
