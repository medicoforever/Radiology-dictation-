// @ts-ignore
import mammoth from 'mammoth';

export interface ParsedDocxResult {
  fileName: string;
  text: string;
  html: string;
  fileSize: number;
}

/**
 * Parses a .docx File or Blob or ArrayBuffer using mammoth in browser
 */
export async function parseDocx(fileOrBlob: File | Blob): Promise<ParsedDocxResult> {
  const fileName = (fileOrBlob as File).name || 'template.docx';
  const fileSize = fileOrBlob.size || 0;
  const arrayBuffer = await fileOrBlob.arrayBuffer();

  try {
    // Extract HTML and raw text
    const htmlResult = await mammoth.convertToHtml({ arrayBuffer });
    const textResult = await mammoth.extractRawText({ arrayBuffer });

    const html = htmlResult.value || '';
    const text = textResult.value || '';

    return {
      fileName,
      text: text.trim(),
      html: html.trim(),
      fileSize,
    };
  } catch (err) {
    console.error('Failed to parse docx with mammoth:', err);
    throw new Error(err instanceof Error ? err.message : 'Failed to parse .docx file.');
  }
}

/**
 * Converts findings array into clean HTML suitable for rich text editor and Word/RTF
 */
export function findingsToRichHtml(findings: string[]): string {
  if (!findings || findings.length === 0) return '';

  const htmlParts: string[] = [];

  for (const finding of findings) {
    const trimmed = finding.trim();
    if (!trimmed) continue;

    // 1. Clinical profile
    if (trimmed.startsWith('*Clinical Profile:') && trimmed.endsWith('*')) {
      const inner = trimmed.slice(1, -1);
      htmlParts.push(`<p class="clinical-profile" style="margin-bottom: 14px; font-style: italic; background-color: #f1f5f9; color: #0f172a; padding: 8px 12px; border-left: 3px solid #0284c7; border-radius: 4px;"><strong>${escapeHtml(inner)}</strong></p>`);
      continue;
    }

    // 2. Impression section (starts with IMPRESSION:###)
    if (trimmed.startsWith('IMPRESSION:')) {
      const parts = trimmed.replace('IMPRESSION:', '').split('###').map(p => p.trim()).filter(Boolean);
      let impressionHtml = `<div class="impression-section" style="margin-top: 20px; padding: 12px 14px; background-color: #eff6ff; border: 1px solid #bfdbfe; border-radius: 6px;">`;
      impressionHtml += `<h3 style="margin: 0 0 8px 0; font-size: 16px; font-weight: bold; text-decoration: underline; text-transform: uppercase; color: #1e3a8a;">IMPRESSION</h3>`;
      if (parts.length > 0) {
        impressionHtml += `<ul style="margin: 0; padding-left: 20px; color: #1e293b;">`;
        for (const pt of parts) {
          impressionHtml += `<li style="margin-bottom: 6px; font-weight: bold; line-height: 1.5;">${escapeHtml(pt)}</li>`;
        }
        impressionHtml += `</ul>`;
      }
      impressionHtml += `</div>`;
      htmlParts.push(impressionHtml);
      continue;
    }

    // 3. Patient separator
    if (trimmed.startsWith('BOLD::--- PATIENT') || trimmed.startsWith('--- PATIENT')) {
      const cleanTitle = trimmed.replace('BOLD::', '');
      htmlParts.push(`<h2 style="margin-top: 24px; margin-bottom: 12px; font-size: 18px; font-weight: bold; border-bottom: 2px solid #3b82f6; padding-bottom: 4px; color: #1d4ed8;">${escapeHtml(cleanTitle)}</h2>`);
      continue;
    }

    // 4. Report title (e.g. ALL CAPS header at start)
    if (trimmed === trimmed.toUpperCase() && trimmed.length < 80 && !trimmed.startsWith('BOLD::') && htmlParts.length === 0) {
      htmlParts.push(`<h1 style="margin-bottom: 16px; font-size: 20px; font-weight: bold; text-align: center; text-decoration: underline; color: #0f172a;">${escapeHtml(trimmed)}</h1>`);
      continue;
    }

    // 5. Findings with BOLD:: (dictated modifications/abnormalities)
    if (trimmed.startsWith('BOLD::')) {
      const content = trimmed.replace(/^BOLD::/, '');
      htmlParts.push(`<p style="margin-bottom: 10px; line-height: 1.6; color: #0f172a;"><strong>${escapeHtml(content)}</strong></p>`);
    } else {
      // Normal template finding
      htmlParts.push(`<p style="margin-bottom: 10px; line-height: 1.6; color: #334155;">${escapeHtml(trimmed)}</p>`);
    }
  }

  return htmlParts.join('\n');
}

/**
 * Escapes HTML characters
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Generates an RTF 1.5 compliant document string from HTML or text
 */
export function generateRtfDocument(htmlOrText: string, title = 'Radiology Report'): string {
  // Simple plain text extractor from HTML
  const tempDiv = typeof document !== 'undefined' ? document.createElement('div') : null;
  let plainText = htmlOrText;
  if (tempDiv) {
    tempDiv.innerHTML = htmlOrText;
    plainText = tempDiv.innerText || tempDiv.textContent || htmlOrText;
  } else {
    plainText = htmlOrText.replace(/<[^>]+>/g, '\n');
  }

  // Format paragraphs for RTF
  const lines = plainText.split('\n').map(l => l.trim()).filter(Boolean);
  const rtfBody = lines.map(line => {
    // Escape special RTF characters: \, {, }
    const escaped = line
      .replace(/\\/g, '\\\\')
      .replace(/{/g, '\\{')
      .replace(/}/g, '\\}');
    
    if (line.startsWith('IMPRESSION') || line === line.toUpperCase() && line.length < 80) {
      return `\\pard\\b\\fs24 ${escaped}\\b0\\par`;
    }
    return `\\pard\\fs22 ${escaped}\\par`;
  }).join('\n');

  return `{\\rtf1\\ansi\\deff0
{\\fonttbl{\\f0\\fnil\\fcharset0 Calibri;}{\\f1\\fnil\\fcharset0 Arial;}}
{\\colortbl ;\\red0\\green0\\blue0;\\red30\\green64\\blue175;\\red15\\green23\\blue42;}
\\viewkind4\\uc1\\pard\\lang1033\\f0\\fs28\\b\\qc ${title}\\b0\\par
\\pard\\fs18\\qc Generated by Radiology Dictation & Template Merge\\par\\par
${rtfBody}
}`;
}

/**
 * Generates a full Microsoft Word-compatible HTML (.doc) document
 */
export function generateWordHtmlDoc(bodyHtml: string, title = 'Radiology Report'): string {
  return `<!DOCTYPE html>
<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
<head>
<meta charset='utf-8'>
<title>${escapeHtml(title)}</title>
<!--[if gte mso 9]>
<xml>
<w:WordDocument>
<w:View>Print</w:View>
<w:Zoom>100</w:Zoom>
<w:DoNotOptimizeForBrowser/>
</w:WordDocument>
</xml>
<![endif]-->
<style>
  @page {
    size: 8.5in 11.0in;
    margin: 1.0in;
  }
  body {
    font-family: 'Calibri', 'Segoe UI', Arial, sans-serif;
    font-size: 11pt;
    line-height: 1.5;
    color: #111827;
  }
  h1 { font-size: 16pt; font-weight: bold; text-align: center; margin-bottom: 12pt; text-decoration: underline; }
  h2 { font-size: 13pt; font-weight: bold; margin-top: 14pt; margin-bottom: 6pt; color: #1e40af; border-bottom: 1pt solid #cbd5e1; }
  h3 { font-size: 12pt; font-weight: bold; margin-top: 12pt; margin-bottom: 4pt; }
  p { margin-bottom: 8pt; }
  strong { font-weight: bold; }
  .clinical-profile { background-color: #f8fafc; padding: 6pt 10pt; border-left: 3pt solid #0284c7; font-style: italic; }
  .impression-section { margin-top: 14pt; padding: 8pt 10pt; background-color: #f0fdf4; border: 1pt solid #bbf7d0; }
  ul { margin-top: 4pt; margin-bottom: 8pt; padding-left: 18pt; }
  li { margin-bottom: 4pt; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

/**
 * Triggers download of a string or blob as a file
 */
export function downloadFile(content: string | Blob, fileName: string, mimeType: string) {
  const blob = typeof content === 'string' ? new Blob([content], { type: mimeType }) : content;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  }, 100);
}
