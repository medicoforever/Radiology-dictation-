// @ts-ignore
import mammoth from 'mammoth';
import {
  Document,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  Packer,
  Table,
  TableRow,
  TableCell,
  WidthType,
} from 'docx';

export interface ParsedDocxResult {
  fileName: string;
  text: string;
  html: string;
  fileSize: number;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
  method: number;
  crc32: number;
}

// CRC32 table for ZIP creation
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c >>> 0;
}

function calculateCRC32(bytes: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

async function compressDeflate(rawBytes: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream !== 'undefined') {
    const cs = new CompressionStream('deflate-raw');
    const writer = cs.writable.getWriter();
    writer.write(rawBytes);
    writer.close();
    const response = new Response(cs.readable);
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }
  return rawBytes;
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64.replace(/[\r\n\s]/g, ''));
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

export async function parseZip(buffer: ArrayBuffer | ArrayBufferLike): Promise<Map<string, ZipEntry>> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const entries = new Map<string, ZipEntry>();
  let offset = 0;
  const len = bytes.length;

  while (offset + 30 <= len) {
    const sig = view.getUint32(offset, true);
    if (sig !== 0x04034b50) break;

    const method = view.getUint16(offset + 8, true);
    const crc32 = view.getUint32(offset + 14, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const uncompressedSize = view.getUint32(offset + 22, true);
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);

    const nameBytes = bytes.slice(offset + 30, offset + 30 + nameLen);
    const name = new TextDecoder('utf-8').decode(nameBytes);

    const dataStart = offset + 30 + nameLen + extraLen;
    const compressedData = bytes.slice(dataStart, dataStart + compressedSize);
    let uncompressedData: Uint8Array = compressedData;

    if (method === 8 && typeof DecompressionStream !== 'undefined') {
      try {
        const ds = new DecompressionStream('deflate-raw');
        const writer = ds.writable.getWriter();
        writer.write(compressedData);
        writer.close();
        const response = new Response(ds.readable);
        const buf = await response.arrayBuffer();
        uncompressedData = new Uint8Array(buf);
      } catch (e) {
        uncompressedData = compressedData;
      }
    }

    entries.set(name, {
      name,
      data: uncompressedData,
      method,
      crc32,
    });

    offset = dataStart + compressedSize;
  }

  return entries;
}

export async function createZip(entries: Map<string, Uint8Array>): Promise<Blob> {
  const localFileHeaders: Uint8Array[] = [];
  const centralDirHeaders: Uint8Array[] = [];
  let offset = 0;

  for (const [name, rawData] of entries) {
    const nameBytes = new TextEncoder().encode(name);
    const crc32 = calculateCRC32(rawData);
    const uncompressedSize = rawData.length;
    const compressedData = await compressDeflate(rawData);
    const compressedSize = compressedData.length;
    const method = 8; // DEFLATE

    // Local file header (30 bytes + filename length)
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0, true);
    lv.setUint32(14, crc32, true);
    lv.setUint32(18, compressedSize, true);
    lv.setUint32(22, uncompressedSize, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    localFileHeaders.push(localHeader);
    localFileHeaders.push(compressedData);

    // Central directory header (46 bytes + filename length)
    const cdHeader = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cdHeader.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc32, true);
    cv.setUint32(20, compressedSize, true);
    cv.setUint32(24, uncompressedSize, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    cdHeader.set(nameBytes, 46);

    centralDirHeaders.push(cdHeader);
    offset += localHeader.length + compressedData.length;
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const cdh of centralDirHeaders) cdSize += cdh.length;

  // End of central directory record (22 bytes)
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.size, true);
  ev.setUint16(10, entries.size, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdOffset, true);
  ev.setUint16(20, 0, true);

  const allChunks: BlobPart[] = [...localFileHeaders, ...centralDirHeaders, eocd];
  return new Blob(allChunks, {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

/**
 * Converts mammoth HTML into structured text where <table> elements
 * are preserved as clean Markdown tables (| Col 1 | Col 2 |).
 */
export function htmlToTextWithMarkdownTables(html: string): string {
  if (!html) return '';
  if (!html.includes('<table')) {
    if (typeof DOMParser !== 'undefined') {
      try {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        return (doc.body.innerText || doc.body.textContent || '').trim();
      } catch {
        // fallback
      }
    }
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  if (typeof DOMParser === 'undefined') return html.replace(/<[^>]+>/g, ' ').trim();

  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const blocks: string[] = [];

    const processNode = (node: Node) => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement;
        const tag = el.tagName.toLowerCase();

        if (tag === 'table') {
          const rows: string[][] = [];
          const trElements = Array.from(el.querySelectorAll('tr'));
          trElements.forEach(tr => {
            const cells = Array.from(tr.querySelectorAll('th, td')).map(cell => {
              return (cell.textContent || '').trim().replace(/\|/g, '/').replace(/\s+/g, ' ');
            });
            if (cells.length > 0 && cells.some(c => c.length > 0)) {
              rows.push(cells);
            }
          });

          if (rows.length > 0) {
            const maxCols = Math.max(...rows.map(r => r.length), 1);
            const mdRows = rows.map(r => {
              const padded = [...r];
              while (padded.length < maxCols) padded.push('');
              return `| ${padded.join(' | ')} |`;
            });
            blocks.push(mdRows.join('\n'));
          }
          return;
        }

        if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'blockquote'].includes(tag)) {
          if (el.querySelector('table')) {
            Array.from(el.childNodes).forEach(processNode);
          } else {
            const text = (el.textContent || '').trim();
            if (text) {
              blocks.push(text);
            }
          }
          return;
        }

        Array.from(el.childNodes).forEach(processNode);
      } else if (node.nodeType === Node.TEXT_NODE) {
        const text = (node.textContent || '').trim();
        if (text && (!node.parentElement || node.parentElement === doc.body)) {
          blocks.push(text);
        }
      }
    };

    Array.from(doc.body.childNodes).forEach(processNode);
    return blocks.join('\n\n').trim();
  } catch (e) {
    console.warn('Failed to parse HTML tables into markdown text:', e);
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

/**
 * Parses a .docx File or Blob or ArrayBuffer using mammoth in browser
 */
export async function parseDocx(fileOrBlob: File | Blob): Promise<ParsedDocxResult> {
  const fileName = (fileOrBlob as File).name || 'template.docx';
  const fileSize = fileOrBlob.size || 0;
  const arrayBuffer = await fileOrBlob.arrayBuffer();

  try {
    const htmlResult = await mammoth.convertToHtml({ arrayBuffer });
    const textResult = await mammoth.extractRawText({ arrayBuffer });

    const html = htmlResult.value || '';
    let text = textResult.value || '';

    // If the DOCX contains tables, preserve them in clean Markdown table syntax (| Col 1 | Col 2 |)
    if (html.includes('<table')) {
      const textWithTables = htmlToTextWithMarkdownTables(html);
      if (textWithTables && textWithTables.includes('|')) {
        text = textWithTables;
      }
    }

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

export function cleanClinicalProfileText(text: string): string {
  let inner = text.replace(/^BOLD::/i, '').trim();
  inner = inner.replace(/^[*_\s]+/, '');
  inner = inner.replace(/[*_\s]+$/, '');
  inner = inner.replace(/\.\*+$/, '.');
  inner = inner.replace(/[*_]+$/, '').trim();
  inner = inner.replace(/^Clinical\s*(Profile|History)\s*:?\s*/i, 'Clinical Profile: ');
  inner = inner.replace(/^Clinical Profile:\s*\*+/i, 'Clinical Profile: ');
  // Always strip any remaining trailing or leading asterisks/underscores
  inner = inner.replace(/[*_\s]+$/, '').trim();
  inner = inner.replace(/^[*_\s]+/, '').trim();
  return inner.trim();
}

export function parseTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length > 2) {
    trimmed = trimmed.slice(1, -1);
  }
  return trimmed.split('|').map(c => c.trim());
}

export function isTableRowFinding(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  const clean = text.replace(/^BOLD::/i, '').trim();
  if (!clean) return false;
  if (/^(clinical\s*(profile|history):|c\.t\.|mri|x-ray|usg)/i.test(clean)) return false;
  if (clean.includes('<table') || clean.includes('</table>')) return true;
  if (clean.includes('|')) {
    if (clean.includes('###')) {
      const rows = clean.split('###').map(r => r.trim()).filter(Boolean);
      return rows.length >= 1 && rows.some(r => r.includes('|'));
    }
    const cells = parseTableRow(clean);
    return cells.length >= 2;
  }
  return false;
}

/**
 * Converts table row lines into clean tab-separated text (TSV) for clipboard/pasting.
 */
export function tableToPlainText(lines: string[]): string {
  const tableRows: string[][] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.includes('|')) continue;
    if (/^\|?(\s*:?-+:?\s*\|)+\s*$/.test(trimmed)) continue;
    tableRows.push(parseTableRow(trimmed));
  }
  return tableRows.map(row => row.join('\t')).join('\n');
}

/**
 * Parses consecutive markdown table lines (e.g. "| Col 1 | Col 2 |" or "Size | cm | cm") into semantic styled HTML table.
 */
export function parseMarkdownTable(lines: string[]): string {
  const tableRows: string[][] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.includes('|')) continue;
    // Skip separator line |---|---|
    if (/^\|?(\s*:?-+:?\s*\|)+\s*$/.test(trimmed)) continue;

    const cells = parseTableRow(trimmed);
    if (cells.length > 0) {
      tableRows.push(cells);
    }
  }

  if (tableRows.length === 0) return '';

  // Standardize column count across all rows
  const maxCols = Math.max(...tableRows.map(r => r.length));
  for (const r of tableRows) {
    while (r.length < maxCols) {
      r.push('');
    }
  }

  const headerCells = tableRows[0];
  const bodyRows = tableRows.slice(1);

  let html = `<table style="width: 100%; border-collapse: collapse; margin: 16px 0; border: 1px solid #cbd5e1; font-size: 13.5px;">\n`;
  html += `  <thead>\n    <tr style="background-color: #f1f5f9;">\n`;
  for (const h of headerCells) {
    const isBold = h.startsWith('BOLD::');
    const cleanH = h.replace(/^BOLD::/, '');
    html += `      <th style="border: 1px solid #cbd5e1; padding: 8px 12px; text-align: left; font-weight: bold; color: #0f172a;">${isBold ? `<strong>${escapeHtml(cleanH)}</strong>` : escapeHtml(cleanH)}</th>\n`;
  }
  html += `    </tr>\n  </thead>\n`;

  if (bodyRows.length > 0) {
    html += `  <tbody>\n`;
    for (let rIdx = 0; rIdx < bodyRows.length; rIdx++) {
      const row = bodyRows[rIdx];
      const bg = rIdx % 2 === 1 ? ' background-color: #f8fafc;' : '';
      html += `    <tr style="${bg}">\n`;
      for (let cIdx = 0; cIdx < maxCols; cIdx++) {
        const val = row[cIdx] || '';
        const isBold = val.startsWith('BOLD::');
        const cleanVal = val.replace(/^BOLD::/, '');
        html += `      <td style="border: 1px solid #cbd5e1; padding: 8px 12px; text-align: left; color: #334155;">${isBold ? `<strong>${escapeHtml(cleanVal)}</strong>` : escapeHtml(cleanVal)}</td>\n`;
      }
      html += `    </tr>\n`;
    }
    html += `  </tbody>\n`;
  }
  html += `</table>`;
  return html;
}

/**
 * Converts findings array into clean HTML suitable for rich text editor and Word/RTF.
 * Strictly guarantees that exam heading contains ONLY the scan title without "Clinical profile".
 */
export function findingsToRichHtml(findings: string[]): string {
  if (!findings || findings.length === 0) return '';

  const htmlParts: string[] = [];
  let isFirst = true;

  for (let idx = 0; idx < findings.length; idx++) {
    const finding = findings[idx];
    const trimmed = finding.trim();
    if (!trimmed) continue;

    // Check if line 0 or early line has "Clinical profile:" glued to the scan title
    if (idx === 0 || isFirst) {
      const matchGlued = trimmed.match(/^(.*?)(?:Clinical\s*profile:?|Clinical\s*history:?)\s*(.*)$/i);
      if (matchGlued && matchGlued[1].trim().length > 0) {
        const titleText = matchGlued[1].trim().replace(/^BOLD::/i, '').replace(/[*_]+$/g, '').trim();
        let profText = matchGlued[2].trim().replace(/^BOLD::/i, '').trim();
        profText = profText ? cleanClinicalProfileText(`Clinical Profile: ${profText}`) : '';
        htmlParts.push(`<h1 style="margin-bottom: 14px; font-size: 20px; font-weight: bold; text-align: center; text-decoration: underline; color: #0f172a; text-transform: uppercase;">${escapeHtml(titleText)}</h1>`);
        if (profText) {
          htmlParts.push(`<p class="clinical-profile" style="margin-bottom: 14px; font-style: italic; color: #334155;"><em><strong>${escapeHtml(profText)}</strong></em></p>`);
        } else {
          htmlParts.push(`<p class="clinical-profile" style="margin-bottom: 14px; font-style: italic; color: #334155;"><em><strong>Clinical Profile: Routine evaluation.</strong></em></p>`);
        }
        isFirst = false;
        continue;
      }
    }

    // 1. Clinical profile line
    if (/^\*?\s*Clinical\s*(Profile|History):/i.test(trimmed)) {
      const inner = cleanClinicalProfileText(trimmed);
      htmlParts.push(`<p class="clinical-profile" style="margin-bottom: 14px; font-style: italic; color: #334155;"><em><strong>${escapeHtml(inner)}</strong></em></p>`);
      isFirst = false;
      continue;
    }

    // 2. Raw HTML Table
    if (trimmed.startsWith('<table') || trimmed.includes('<table')) {
      htmlParts.push(trimmed);
      isFirst = false;
      continue;
    }

    // 3. Multi-line Markdown Table encoded with ###
    if (trimmed.includes('|') && trimmed.includes('###')) {
      const lines = trimmed.split('###').map(l => l.trim()).filter(Boolean);
      if (lines.length > 0 && lines.every(l => l.includes('|'))) {
        const tableHtml = parseMarkdownTable(lines);
        if (tableHtml) {
          htmlParts.push(tableHtml);
          isFirst = false;
          continue;
        }
      }
    }

    // 4. Consecutive Table rows
    if (isTableRowFinding(trimmed)) {
      const tableLines: string[] = [trimmed];
      while (idx + 1 < findings.length && isTableRowFinding(findings[idx + 1])) {
        idx++;
        tableLines.push(findings[idx].trim());
      }
      const tableHtml = parseMarkdownTable(tableLines);
      if (tableHtml) {
        htmlParts.push(tableHtml);
        isFirst = false;
        continue;
      }
    }

    // 5. Impression section (starts with IMPRESSION:### or IMPRESSION:)
    if (trimmed.startsWith('IMPRESSION:')) {
      const parts = trimmed.replace('IMPRESSION:', '').split('###').map(p => p.trim()).filter(Boolean);
      let impressionHtml = `<div class="impression-section" style="margin-top: 20px; margin-bottom: 16px;">`;
      impressionHtml += `<h3 style="margin: 0 0 8px 0; font-size: 16px; font-weight: bold; text-decoration: underline; text-transform: uppercase; color: #0f172a;">IMPRESSION:</h3>`;
      if (parts.length > 0) {
        impressionHtml += `<ul style="margin: 0; padding-left: 24px; color: #0f172a;">`;
        for (const pt of parts) {
          impressionHtml += `<li style="margin-bottom: 6px; font-weight: bold; line-height: 1.5;">${escapeHtml(pt)}</li>`;
        }
        impressionHtml += `</ul>`;
      }
      impressionHtml += `</div>`;
      htmlParts.push(impressionHtml);
      isFirst = false;
      continue;
    }

    // 6. Patient separator
    if (trimmed.startsWith('BOLD::--- PATIENT') || trimmed.startsWith('--- PATIENT')) {
      const cleanTitle = trimmed.replace('BOLD::', '').trim();
      htmlParts.push(`<h2 style="margin-top: 24px; margin-bottom: 12px; font-size: 18px; font-weight: bold; border-bottom: 2px solid #3b82f6; padding-bottom: 4px; color: #1d4ed8;">${escapeHtml(cleanTitle)}</h2>`);
      isFirst = false;
      continue;
    }

    // 7. Report title (index 0 or all-caps header)
    if (isFirst && (idx === 0 || (trimmed === trimmed.toUpperCase() && trimmed.length < 100 && !trimmed.startsWith('BOLD::')))) {
      const cleanTitle = trimmed
        .replace(/^BOLD::/i, '')
        .replace(/\s*clinical\s*(profile|history)\s*:?.*$/i, '')
        .trim();
      htmlParts.push(`<h1 style="margin-bottom: 14px; font-size: 20px; font-weight: bold; text-align: center; text-decoration: underline; color: #0f172a; text-transform: uppercase;">${escapeHtml(cleanTitle)}</h1>`);
      isFirst = false;
      continue;
    }

    // 8. Findings with BOLD:: (dictated modifications/abnormalities)
    if (trimmed.startsWith('BOLD::')) {
      const content = trimmed.replace(/^BOLD::/, '');
      htmlParts.push(`<p style="margin-bottom: 10px; line-height: 1.6; color: #0f172a;"><strong>${escapeHtml(content)}</strong></p>`);
    } else {
      // Normal template finding
      htmlParts.push(`<p style="margin-bottom: 10px; line-height: 1.6; color: #334155;">${escapeHtml(trimmed)}</p>`);
    }
    isFirst = false;
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
 * Escapes special RTF characters and encodes unicode characters as \uN?
 */
export function escapeRtf(text: string): string {
  if (!text) return '';
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const code = text.charCodeAt(i);
    if (c === '\\') {
      out += '\\\\';
    } else if (c === '{') {
      out += '\\{';
    } else if (c === '}') {
      out += '\\}';
    } else if (c === '\n' || c === '\r') {
      out += ' ';
    } else if (code < 128) {
      out += c;
    } else {
      out += `\\u${code}?`;
    }
  }
  return out;
}

/**
 * Generates a clean, professional RTF 1.5 document matching PACS/RIS standards:
 * - 1-inch margins
 * - Calibri 11pt default font
 * - Centered bold underlined exam title (guaranteed NO "Clinical profile" in heading)
 * - Clean italic clinical profile paragraph
 * - Bold abnormal findings and section headings
 * - Indented bullet points for impression
 * - NO unwanted watermarks or promotional text
 */
export function generateRtfDocument(htmlOrText: string, title = 'Radiology Report'): string {
  const cleanTitle = (title || 'Radiology Report')
    .replace(/^BOLD::/i, '')
    .replace(/\s*clinical\s*(profile|history)\s*:?.*$/i, '')
    .trim();

  const paragraphs: string[] = [];

  if (typeof document !== 'undefined') {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = htmlOrText;

    const processInlineRuns = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) {
        return escapeRtf(node.textContent || '');
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement;
        const tag = el.tagName.toUpperCase();
        let inner = '';
        for (let i = 0; i < el.childNodes.length; i++) {
          inner += processInlineRuns(el.childNodes[i]);
        }
        if (tag === 'STRONG' || tag === 'B') {
          return `\\b ${inner.trim()}\\b0 `;
        }
        if (tag === 'EM' || tag === 'I') {
          return `\\i ${inner.trim()}\\i0 `;
        }
        if (tag === 'U') {
          return `\\ul ${inner.trim()}\\ul0 `;
        }
        return inner;
      }
      return '';
    };

    let seenH1 = false;

    const processBlock = (node: Node) => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement;
        const tag = el.tagName.toUpperCase();

        if (tag === 'H1') {
          seenH1 = true;
          const text = (el.innerText || el.textContent || '')
            .replace(/^BOLD::/i, '')
            .replace(/\s*clinical\s*(profile|history)\s*:?.*$/i, '')
            .trim();
          paragraphs.push(`\\pard\\qc\\sa180\\sb60\\b\\ul\\fs28 ${escapeRtf(text)}\\ul0\\b0\\par`);
          return;
        }

        if (tag === 'H2' || tag === 'H3') {
          const text = (el.innerText || el.textContent || '').trim();
          paragraphs.push(`\\pard\\sa60\\sb140\\sl276\\slmult1\\b\\fs24 ${escapeRtf(text)}\\b0\\par`);
          return;
        }

        if (el.classList.contains('clinical-profile')) {
          const text = (el.innerText || el.textContent || '').trim();
          paragraphs.push(`\\pard\\sa120\\sl276\\slmult1\\i\\fs22 ${escapeRtf(text)}\\i0\\par`);
          return;
        }

        if (tag === 'UL' || tag === 'OL') {
          const lis = el.querySelectorAll('li');
          lis.forEach(li => {
            let liRuns = '';
            for (let i = 0; i < li.childNodes.length; i++) {
              liRuns += processInlineRuns(li.childNodes[i]);
            }
            paragraphs.push(`\\pard\\fi-360\\li720\\sa80\\sl276\\slmult1\\fs22\\b\\bullet  ${liRuns.trim()}\\b0\\par`);
          });
          return;
        }

        if (el.classList.contains('impression-section')) {
          paragraphs.push(`\\pard\\sa80\\sb160\\b\\ul\\fs24 IMPRESSION:\\ul0\\b0\\par`);
          const lis = el.querySelectorAll('li');
          if (lis.length > 0) {
            lis.forEach(li => {
              let liRuns = '';
              for (let i = 0; i < li.childNodes.length; i++) {
                liRuns += processInlineRuns(li.childNodes[i]);
              }
              paragraphs.push(`\\pard\\fi-360\\li720\\sa80\\sl276\\slmult1\\fs22\\b\\bullet  ${liRuns.trim()}\\b0\\par`);
            });
          }
          return;
        }

        if (tag === 'TABLE') {
          const rows = el.querySelectorAll('tr');
          if (rows.length > 0) {
            let maxCols = 1;
            rows.forEach(r => {
              const cellCount = r.querySelectorAll('th, td').length;
              if (cellCount > maxCols) maxCols = cellCount;
            });

            // Standard printable width in RTF twips (~9360 twips = 6.5 in)
            const totalTwips = 9360;
            const colTwips = Math.floor(totalTwips / maxCols);

            rows.forEach(r => {
              const cells = r.querySelectorAll('th, td');
              if (cells.length === 0) return;

              // 1. Table row definition with borders for each cell
              let rowDef = `\\trowd\\trgaph108\\trleft0`;
              let currentRight = 0;
              cells.forEach(() => {
                currentRight += colTwips;
                rowDef += `\\clbrdrt\\brdrs\\brdrw10\\clbrdrl\\brdrs\\brdrw10\\clbrdrb\\brdrs\\brdrw10\\clbrdrr\\brdrs\\brdrw10\\cellx${currentRight}`;
              });
              paragraphs.push(rowDef);

              // 2. Row cells content
              let rowCells = '';
              cells.forEach(c => {
                const isHeader = c.tagName.toUpperCase() === 'TH';
                let cellRuns = '';
                for (let i = 0; i < c.childNodes.length; i++) {
                  cellRuns += processInlineRuns(c.childNodes[i]);
                }
                const content = cellRuns.trim();
                const formatted = isHeader ? `\\b ${content}\\b0 ` : content;
                rowCells += `\\pard\\intbl\\sl276\\slmult1\\fs22 ${formatted || ' '}\\cell `;
              });
              rowCells += `\\row`;
              paragraphs.push(rowCells);
            });
          }
          return;
        }

        if (tag === 'P') {
          const rawText = (el.innerText || el.textContent || '').trim();
          if (/^clinical\s*(profile|history):/i.test(rawText)) {
            paragraphs.push(`\\pard\\sa120\\sl276\\slmult1\\i\\fs22 ${escapeRtf(rawText)}\\i0\\par`);
          } else {
            let pRuns = '';
            for (let i = 0; i < el.childNodes.length; i++) {
              pRuns += processInlineRuns(el.childNodes[i]);
            }
            if (pRuns.trim()) {
              paragraphs.push(`\\pard\\sa120\\sl276\\slmult1\\fs22 ${pRuns.trim()}\\par`);
            }
          }
          return;
        }

        // For other container elements (e.g. div)
        for (let i = 0; i < el.childNodes.length; i++) {
          processBlock(el.childNodes[i]);
        }
      } else if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
        paragraphs.push(`\\pard\\sa120\\sl276\\slmult1\\fs22 ${escapeRtf(node.textContent.trim())}\\par`);
      }
    };

    for (let i = 0; i < tempDiv.childNodes.length; i++) {
      processBlock(tempDiv.childNodes[i]);
    }

    if (!seenH1 && cleanTitle) {
      paragraphs.unshift(`\\pard\\qc\\sa180\\sb60\\b\\ul\\fs28 ${escapeRtf(cleanTitle)}\\ul0\\b0\\par`);
    }
  } else {
    // Non-DOM fallback
    const lines = htmlOrText.replace(/<[^>]+>/g, '\n').split('\n').map(l => l.trim()).filter(Boolean);
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      if (idx === 0) {
        const cleanH1 = line.replace(/\s*clinical\s*(profile|history)\s*:?.*$/i, '').trim();
        paragraphs.push(`\\pard\\qc\\sa180\\sb60\\b\\ul\\fs28 ${escapeRtf(cleanH1)}\\ul0\\b0\\par`);
      } else if (/^\*?\s*clinical\s*(profile|history):/i.test(line)) {
        const cleanProf = cleanClinicalProfileText(line);
        paragraphs.push(`\\pard\\sa120\\sl276\\slmult1\\i\\fs22 ${escapeRtf(cleanProf)}\\i0\\par`);
      } else if (line.toUpperCase() === 'IMPRESSION:' || line.startsWith('IMPRESSION:')) {
        paragraphs.push(`\\pard\\sa80\\sb160\\b\\ul\\fs24 IMPRESSION:\\ul0\\b0\\par`);
      } else {
        paragraphs.push(`\\pard\\sa120\\sl276\\slmult1\\fs22 ${escapeRtf(line)}\\par`);
      }
    }
  }

  const rtfBody = paragraphs.join('\n');

  return `{\\rtf1\\ansi\\ansicpg1252\\deff0\\nouicompat\\deflang1033
{\\fonttbl{\\f0\\froman\\fcharset0 Times New Roman;}{\\f1\\fswiss\\fcharset0 Calibri;}{\\f2\\fnil\\fcharset2 Symbol;}}
{\\colortbl ;\\red0\\green0\\blue0;\\red30\\green64\\blue175;\\red15\\green23\\blue42;}
\\viewkind4\\uc1
\\paperw12240\\paperh15840\\margl1440\\margr1440\\margt1440\\margb1440
\\f1\\fs22\\lang1033
${rtfBody}
}`;
}

/**
 * Generates a full Microsoft Word-compatible HTML (.doc) document
 */
export function generateWordHtmlDoc(bodyHtml: string, title = 'Radiology Report'): string {
  const cleanTitle = (title || 'Radiology Report')
    .replace(/^BOLD::/i, '')
    .replace(/\s*clinical\s*(profile|history)\s*:?.*$/i, '')
    .trim();

  return `<!DOCTYPE html>
<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
<head>
<meta charset='utf-8'>
<title>${escapeHtml(cleanTitle)}</title>
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
  table { width: 100%; border-collapse: collapse; margin: 12pt 0; border: 1pt solid #cbd5e1; }
  th, td { border: 1pt solid #cbd5e1; padding: 6pt 8pt; text-align: left; }
  th { background-color: #f1f5f9; font-weight: bold; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

/**
 * Triggers download of a string or blob as a file.
 * Handles Android mobile browsers, Android APK WebViews, and desktop browsers safely.
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
    try {
      if (document.body.contains(a)) {
        document.body.removeChild(a);
      }
      window.URL.revokeObjectURL(url);
    } catch {
      // Ignore cleanup error
    }
  }, 60000);
}

/**
 * Helper to download a docx blob cleanly
 */
export function downloadDocxBlob(blob: Blob, filename: string): void {
  downloadFile(blob, filename, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
}

/**
 * Tokenizes markdown inline styles (**bold**, *italics*) into docx TextRuns
 */
function parseMarkdownRuns(text: string): TextRun[] {
  const runs: TextRun[] = [];
  const parts = text.split(/(\*\*.*?\*\*|\*.*?\*)/g);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
      runs.push(
        new TextRun({
          text: part.slice(2, -2),
          bold: true,
          font: 'Calibri',
          size: 22,
          color: '0F172A',
        })
      );
    } else if (part.startsWith('*') && part.endsWith('*') && part.length >= 2) {
      runs.push(
        new TextRun({
          text: part.slice(1, -1),
          italics: true,
          font: 'Calibri',
          size: 22,
          color: '334155',
        })
      );
    } else {
      runs.push(
        new TextRun({
          text: part,
          font: 'Calibri',
          size: 22,
          color: '334155',
        })
      );
    }
  }
  return runs.length > 0 ? runs : [new TextRun({ text, font: 'Calibri', size: 22 })];
}

/**
 * Generates an authentic binary Microsoft Word (.docx) file from Markdown text.
 */
export async function generateDocxFromMarkdown(markdown: string, title = 'Expert Notes'): Promise<Blob> {
  const lines = markdown.split('\n');
  const paragraphs: (Paragraph | Table)[] = [];

  const cleanTitle = (title || 'Expert Notes')
    .replace(/^BOLD::/i, '')
    .replace(/\s*clinical\s*(profile|history)\s*:?.*$/i, '')
    .trim();

  if (cleanTitle) {
    paragraphs.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        alignment: AlignmentType.CENTER,
        spacing: { before: 200, after: 160 },
        children: [
          new TextRun({
            text: cleanTitle,
            bold: true,
            size: 32,
            font: 'Calibri',
            color: '0F172A',
          }),
        ],
      })
    );
  }

  for (let idx = 0; idx < lines.length; idx++) {
    const trimmed = lines[idx].trim();
    if (!trimmed) continue;

    // Handle Markdown Table Rows
    if (isTableRowFinding(trimmed)) {
      const tableLines: string[] = [trimmed];
      while (idx + 1 < lines.length && isTableRowFinding(lines[idx + 1])) {
        idx++;
        tableLines.push(lines[idx].trim());
      }

      const tableRows: TableRow[] = [];
      tableLines.forEach((tLine, rIdx) => {
        const cells = parseTableRow(tLine);
        const isHeader = rIdx === 0;
        const tableCells = cells.map(c => {
          const isBold = c.startsWith('BOLD::');
          const clean = c.replace(/^BOLD::/, '');
          return new TableCell({
            children: [
              new Paragraph({
                spacing: { before: 80, after: 80 },
                children: [
                  new TextRun({
                    text: clean,
                    bold: isHeader || isBold,
                    font: 'Calibri',
                    size: 22,
                    color: isHeader ? '0F172A' : '334155',
                  }),
                ],
              }),
            ],
            shading: isHeader ? { fill: 'F1F5F9' } : undefined,
          });
        });
        tableRows.push(new TableRow({ children: tableCells }));
      });

      if (tableRows.length > 0) {
        paragraphs.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: tableRows,
          })
        );
      }
      continue;
    }

    if (trimmed.startsWith('# ')) {
      paragraphs.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 240, after: 120 },
          children: parseMarkdownRuns(trimmed.slice(2)),
        })
      );
    } else if (trimmed.startsWith('## ')) {
      paragraphs.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 200, after: 100 },
          children: parseMarkdownRuns(trimmed.slice(3)),
        })
      );
    } else if (trimmed.startsWith('### ')) {
      paragraphs.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_3,
          spacing: { before: 160, after: 80 },
          children: parseMarkdownRuns(trimmed.slice(4)),
        })
      );
    } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      paragraphs.push(
        new Paragraph({
          bullet: { level: 0 },
          spacing: { after: 80, line: 276 },
          children: parseMarkdownRuns(trimmed.slice(2)),
        })
      );
    } else {
      paragraphs.push(
        new Paragraph({
          spacing: { after: 120, line: 276 },
          children: parseMarkdownRuns(trimmed),
        })
      );
    }
  }

  const documentDoc = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: 1440,
              right: 1440,
              bottom: 1440,
              left: 1440,
            },
          },
        },
        children: paragraphs,
      },
    ],
  });

  return await Packer.toBlob(documentDoc);
}

/**
 * Generates an authentic binary Microsoft Word (.docx) file from HTML content.
 */
export async function generateDocxFromHtml(html: string, title = 'Radiology Report'): Promise<Blob> {
  const paragraphs: (Paragraph | Table)[] = [];

  const cleanTitle = (title || 'Radiology Report')
    .replace(/^BOLD::/i, '')
    .replace(/\s*clinical\s*(profile|history)\s*:?.*$/i, '')
    .trim();

  if (typeof document === 'undefined') {
    return generateDocxFromMarkdown(html.replace(/<[^>]+>/g, '\n'), cleanTitle);
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const body = doc.body;

  const hasH1 = !!body.querySelector('h1');
  if (cleanTitle && !hasH1) {
    paragraphs.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        alignment: AlignmentType.CENTER,
        spacing: { before: 200, after: 140 },
        children: [
          new TextRun({
            text: cleanTitle,
            bold: true,
            size: 32,
            font: 'Calibri',
            color: '0F172A',
          }),
        ],
      })
    );
  }

  function parseInlineRuns(
    node: Node,
    inheritedStyles: { bold?: boolean; italics?: boolean; underline?: boolean; color?: string } = {}
  ): TextRun[] {
    const runs: TextRun[] = [];

    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || '';
      if (!text) return runs;

      if (text.includes('BOLD::')) {
        const parts = text.split(/(BOLD::[^\n]*)/g);
        for (const part of parts) {
          if (part.startsWith('BOLD::')) {
            runs.push(
              new TextRun({
                text: part.replace(/^BOLD::/, ''),
                bold: true,
                italics: inheritedStyles.italics,
                underline: inheritedStyles.underline ? {} : undefined,
                font: 'Calibri',
                size: 22,
                color: inheritedStyles.color || '0F172A',
              })
            );
          } else if (part) {
            runs.push(
              new TextRun({
                text: part,
                bold: inheritedStyles.bold,
                italics: inheritedStyles.italics,
                underline: inheritedStyles.underline ? {} : undefined,
                font: 'Calibri',
                size: 22,
                color: inheritedStyles.color || '334155',
              })
            );
          }
        }
      } else {
        runs.push(
          new TextRun({
            text,
            bold: inheritedStyles.bold,
            italics: inheritedStyles.italics,
            underline: inheritedStyles.underline ? {} : undefined,
            font: 'Calibri',
            size: 22,
            color: inheritedStyles.color || '334155',
          })
        );
      }
      return runs;
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      const tag = el.tagName.toLowerCase();

      const newStyles = { ...inheritedStyles };
      if (tag === 'strong' || tag === 'b') newStyles.bold = true;
      if (tag === 'em' || tag === 'i') newStyles.italics = true;
      if (tag === 'u') newStyles.underline = true;

      if (tag === 'br') {
        runs.push(new TextRun({ break: 1 }));
        return runs;
      }

      for (let i = 0; i < el.childNodes.length; i++) {
        runs.push(...parseInlineRuns(el.childNodes[i], newStyles));
      }
    }

    return runs;
  }

  function processBlockNode(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent || '').trim();
      if (text) {
        paragraphs.push(
          new Paragraph({
            spacing: { after: 120, line: 276 },
            children: [new TextRun({ text, font: 'Calibri', size: 22, color: '334155' })],
          })
        );
      }
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();

    // Headings
    if (tag === 'h1') {
      const rawText = (el.innerText || el.textContent || '')
        .replace(/^BOLD::/i, '')
        .replace(/\s*clinical\s*(profile|history)\s*:?.*$/i, '')
        .trim();
      paragraphs.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          alignment: AlignmentType.CENTER,
          spacing: { before: 240, after: 120 },
          children: [
            new TextRun({
              text: rawText,
              bold: true,
              size: 32,
              font: 'Calibri',
              color: '0F172A',
            }),
          ],
        })
      );
      return;
    }

    if (tag === 'h2') {
      const runs = parseInlineRuns(el, { bold: true, color: '1D4ED8' });
      paragraphs.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 220, after: 100 },
          children: runs,
        })
      );
      return;
    }

    if (tag === 'h3') {
      const runs = parseInlineRuns(el, { bold: true, color: '1E3A8A' });
      paragraphs.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_3,
          spacing: { before: 180, after: 80 },
          children: runs,
        })
      );
      return;
    }

    // Lists
    if (tag === 'ul' || tag === 'ol') {
      const lis = el.querySelectorAll('li');
      lis.forEach((li) => {
        const runs = parseInlineRuns(li);
        paragraphs.push(
          new Paragraph({
            bullet: { level: 0 },
            spacing: { after: 80, line: 276 },
            children: runs,
          })
        );
      });
      return;
    }

    // Clinical profile box
    if (el.classList.contains('clinical-profile')) {
      const runs = parseInlineRuns(el, { italics: true, bold: true, color: '334155' });
      paragraphs.push(
        new Paragraph({
          spacing: { before: 120, after: 120 },
          children: runs,
        })
      );
      return;
    }

    // Impression section container
    if (el.classList.contains('impression-section')) {
      paragraphs.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_3,
          spacing: { before: 200, after: 100 },
          children: [
            new TextRun({
              text: 'IMPRESSION:',
              bold: true,
              color: '0F172A',
              font: 'Calibri',
              size: 24,
            }),
          ],
        })
      );
      for (let i = 0; i < el.childNodes.length; i++) {
        processBlockNode(el.childNodes[i]);
      }
      return;
    }

    // Tables
    if (tag === 'table') {
      const rows = el.querySelectorAll('tr');
      if (rows.length > 0) {
        const tableRows: TableRow[] = [];
        rows.forEach((r) => {
          const cells = r.querySelectorAll('th, td');
          if (cells.length === 0) return;
          const tableCells: TableCell[] = [];
          cells.forEach((c) => {
            const isHeader = c.tagName.toLowerCase() === 'th';
            const runs = parseInlineRuns(c, isHeader ? { bold: true, color: '0F172A' } : { color: '334155' });
            tableCells.push(
              new TableCell({
                children: [
                  new Paragraph({
                    spacing: { before: 80, after: 80 },
                    children: runs.length > 0 ? runs : [new TextRun({ text: ' ', font: 'Calibri' })],
                  }),
                ],
                shading: isHeader ? { fill: 'F1F5F9' } : undefined,
              })
            );
          });
          tableRows.push(new TableRow({ children: tableCells }));
        });
        if (tableRows.length > 0) {
          paragraphs.push(
            new Table({
              width: { size: 100, type: WidthType.PERCENTAGE },
              rows: tableRows,
            })
          );
        }
      }
      return;
    }

    const hasBlockChildren = Array.from(el.children).some((c) =>
      ['p', 'div', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'section', 'article'].includes(c.tagName.toLowerCase())
    );

    if (hasBlockChildren) {
      for (let i = 0; i < el.childNodes.length; i++) {
        processBlockNode(el.childNodes[i]);
      }
    } else {
      const runs = parseInlineRuns(el);
      if (runs.length > 0) {
        paragraphs.push(
          new Paragraph({
            spacing: { after: 120, line: 276 },
            children: runs,
          })
        );
      }
    }
  }

  for (let i = 0; i < body.childNodes.length; i++) {
    processBlockNode(body.childNodes[i]);
  }

  if (paragraphs.length === 0) {
    paragraphs.push(
      new Paragraph({
        children: [new TextRun({ text: 'No report content', font: 'Calibri' })],
      })
    );
  }

  const documentDoc = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: 1440,
              right: 1440,
              bottom: 1440,
              left: 1440,
            },
          },
        },
        children: paragraphs,
      },
    ],
  });

  return await Packer.toBlob(documentDoc);
}

/**
 * Generates an authentic binary Microsoft Word (.docx) file from an array of findings.
 * Includes proper OpenXML structure with 1-inch margins, centered bold underlined title,
 * clean italic clinical profile, bold abnormal findings, and bulleted impression.
 */
export async function generateDocxFromFindings(findings: string[], title = 'Radiology Report'): Promise<Blob> {
  const paragraphs: Paragraph[] = [];

  const cleanTitle = (title || 'Radiology Report')
    .replace(/^BOLD::/i, '')
    .replace(/\s*clinical\s*(profile|history)\s*:?.*$/i, '')
    .trim();

  let hasEmittedTitle = false;

  for (let idx = 0; idx < findings.length; idx++) {
    const raw = (findings[idx] || '').trim();
    if (!raw) continue;

    // Check if line 0 has clinical profile attached
    if (idx === 0) {
      const matchGlued = raw.match(/^(.*?)(?:Clinical\s*profile:?|Clinical\s*history:?)\s*(.*)$/i);
      if (matchGlued && matchGlued[1].trim().length > 0) {
        const scanTitle = matchGlued[1].trim().replace(/^BOLD::/i, '').trim();
        const prof = matchGlued[2].trim().replace(/^BOLD::/i, '').trim();

        paragraphs.push(
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            alignment: AlignmentType.CENTER,
            spacing: { before: 200, after: 140 },
            children: [
              new TextRun({
                text: scanTitle,
                bold: true,
                underline: {},
                size: 32,
                font: 'Calibri',
                color: '0F172A',
              }),
            ],
          })
        );
        hasEmittedTitle = true;

        if (prof) {
          paragraphs.push(
            new Paragraph({
              spacing: { before: 100, after: 120 },
              children: [
                new TextRun({
                  text: `Clinical Profile: ${prof}`,
                  italics: true,
                  font: 'Calibri',
                  size: 22,
                  color: '334155',
                }),
              ],
            })
          );
        }
        continue;
      }
    }

    // Title line at index 0
    if (idx === 0 && !hasEmittedTitle) {
      const examName = raw
        .replace(/^BOLD::/i, '')
        .replace(/\s*clinical\s*(profile|history)\s*:?.*$/i, '')
        .trim();
      paragraphs.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          alignment: AlignmentType.CENTER,
          spacing: { before: 200, after: 140 },
          children: [
            new TextRun({
              text: examName,
              bold: true,
              underline: {},
              size: 32,
              font: 'Calibri',
              color: '0F172A',
            }),
          ],
        })
      );
      hasEmittedTitle = true;
      continue;
    }

    // Clinical profile
    if (/^\*?\s*Clinical\s*(Profile|History):/i.test(raw)) {
      const inner = cleanClinicalProfileText(raw);
      paragraphs.push(
        new Paragraph({
          spacing: { before: 100, after: 120 },
          children: [
            new TextRun({
              text: inner,
              italics: true,
              font: 'Calibri',
              size: 22,
              color: '334155',
            }),
          ],
        })
      );
      continue;
    }

    // Impression
    if (raw.startsWith('IMPRESSION:')) {
      paragraphs.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_3,
          spacing: { before: 200, after: 100 },
          children: [
            new TextRun({
              text: 'IMPRESSION:',
              bold: true,
              underline: {},
              font: 'Calibri',
              size: 24,
              color: '0F172A',
            }),
          ],
        })
      );
      const parts = raw.replace('IMPRESSION:', '').split('###').map((p) => p.trim()).filter(Boolean);
      for (const pt of parts) {
        paragraphs.push(
          new Paragraph({
            bullet: { level: 0 },
            spacing: { after: 80, line: 276 },
            children: [
              new TextRun({
                text: pt,
                bold: true,
                font: 'Calibri',
                size: 22,
                color: '0F172A',
              }),
            ],
          })
        );
      }
      continue;
    }

    // Patient separator
    if (raw.startsWith('BOLD::--- PATIENT') || raw.startsWith('--- PATIENT')) {
      const cleanPatient = raw.replace('BOLD::', '').trim();
      paragraphs.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 240, after: 120 },
          children: [
            new TextRun({
              text: cleanPatient,
              bold: true,
              font: 'Calibri',
              size: 26,
              color: '1D4ED8',
            }),
          ],
        })
      );
      continue;
    }

    // Findings with BOLD:: (dictated abnormality modifications)
    if (raw.startsWith('BOLD::')) {
      const content = raw.replace(/^BOLD::/, '');
      paragraphs.push(
        new Paragraph({
          spacing: { after: 120, line: 276 },
          children: [
            new TextRun({
              text: content,
              bold: true,
              font: 'Calibri',
              size: 22,
              color: '0F172A',
            }),
          ],
        })
      );
    } else {
      paragraphs.push(
        new Paragraph({
          spacing: { after: 120, line: 276 },
          children: [
            new TextRun({
              text: raw,
              font: 'Calibri',
              size: 22,
              color: '334155',
            }),
          ],
        })
      );
    }
  }

  const documentDoc = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: 1440,
              right: 1440,
              bottom: 1440,
              left: 1440,
            },
          },
        },
        children: paragraphs,
      },
    ],
  });

  return await Packer.toBlob(documentDoc);
}
