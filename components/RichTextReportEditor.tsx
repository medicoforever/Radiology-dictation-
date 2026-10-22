import React, { useState, useRef, useEffect } from 'react';
import { findingsToRichHtml, generateRtfDocument, generateWordHtmlDoc, generateDocxFromHtml, downloadFile } from '../services/docxService';
import CopyIcon from './icons/CopyIcon';
import DownloadIcon from './icons/DownloadIcon';
import SparklesIcon from './icons/SparklesIcon';
import QuickMacroInsertPopover from './QuickMacroInsertPopover';

interface RichTextReportEditorProps {
  findings: string[];
  templateName?: string | null;
  onUpdateFindings?: (newFindings: string[]) => void;
  onOpenMacrosModal?: () => void;
}

export const RichTextReportEditor: React.FC<RichTextReportEditorProps> = ({
  findings,
  templateName,
  onUpdateFindings,
  onOpenMacrosModal,
}) => {
  const editorRef = useRef<HTMLDivElement>(null);
  const [contentHtml, setContentHtml] = useState<string>('');
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [wordCount, setWordCount] = useState<number>(0);
  const [charCount, setCharCount] = useState<number>(0);
  const [isSynced, setIsSynced] = useState<boolean>(true);
  const lastInitialHtmlRef = useRef<string>('');

  // Convert initial findings to rich HTML when findings change from outside
  useEffect(() => {
    const richHtml = findingsToRichHtml(findings);
    setContentHtml(richHtml);
    lastInitialHtmlRef.current = richHtml;
    if (editorRef.current) {
      editorRef.current.innerHTML = richHtml;
      updateMetrics();
    }
  }, [findings]);

  const updateMetrics = () => {
    if (!editorRef.current) return;
    const text = editorRef.current.innerText || editorRef.current.textContent || '';
    setCharCount(text.length);
    const words = text.trim().split(/\s+/).filter(Boolean);
    setWordCount(words.length);
  };

  const handleInput = () => {
    if (!editorRef.current) return;
    setContentHtml(editorRef.current.innerHTML);
    setIsSynced(false);
    updateMetrics();
  };

  const executeCommand = (command: string, value: string | undefined = undefined) => {
    if (typeof document !== 'undefined') {
      document.execCommand(command, false, value);
      if (editorRef.current) {
        editorRef.current.focus();
        handleInput();
      }
    }
  };

  const handleInsertTable = () => {
    if (typeof document !== 'undefined' && editorRef.current) {
      editorRef.current.focus();
      const sampleTableHtml = `<table style="width: 100%; border-collapse: collapse; margin: 16px 0; border: 1px solid #cbd5e1; font-size: 13.5px;"><thead><tr style="background-color: #f1f5f9;"><th style="border: 1px solid #cbd5e1; padding: 8px 12px; text-align: left; font-weight: bold; color: #0f172a;">Parameter</th><th style="border: 1px solid #cbd5e1; padding: 8px 12px; text-align: left; font-weight: bold; color: #0f172a;">Measurement</th><th style="border: 1px solid #cbd5e1; padding: 8px 12px; text-align: left; font-weight: bold; color: #0f172a;">Reference / Status</th></tr></thead><tbody><tr><td style="border: 1px solid #cbd5e1; padding: 8px 12px; text-align: left; color: #334155;">Structure 1</td><td style="border: 1px solid #cbd5e1; padding: 8px 12px; text-align: left; color: #334155;">Normal</td><td style="border: 1px solid #cbd5e1; padding: 8px 12px; text-align: left; color: #334155;">Within normal limits</td></tr><tr style="background-color: #f8fafc;"><td style="border: 1px solid #cbd5e1; padding: 8px 12px; text-align: left; color: #334155;">Structure 2</td><td style="border: 1px solid #cbd5e1; padding: 8px 12px; text-align: left; color: #334155;">Normal</td><td style="border: 1px solid #cbd5e1; padding: 8px 12px; text-align: left; color: #334155;">Within normal limits</td></tr></tbody></table><p><br></p>`;
      document.execCommand('insertHTML', false, sampleTableHtml);
      handleInput();
    }
  };

  const handleCopyRichText = async () => {
    if (!editorRef.current) return;
    const html = editorRef.current.innerHTML;
    const plainText = editorRef.current.innerText || editorRef.current.textContent || '';

    try {
      if (typeof window !== 'undefined' && navigator.clipboard && window.ClipboardItem) {
        const textBlob = new Blob([plainText], { type: 'text/plain' });
        const htmlBlob = new Blob([html], { type: 'text/html' });
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/plain': textBlob,
            'text/html': htmlBlob,
          }),
        ]);
        setCopyStatus('Formatted Rich Text Copied!');
      } else {
        // Fallback
        await navigator.clipboard.writeText(plainText);
        setCopyStatus('Copied Text!');
      }
    } catch (err) {
      console.warn('Clipboard write error, falling back:', err);
      try {
        await navigator.clipboard.writeText(plainText);
        setCopyStatus('Copied Text!');
      } catch {
        setCopyStatus('Failed to copy');
      }
    }

    setTimeout(() => setCopyStatus(null), 3000);
  };

  const handleCopyHtml = async () => {
    if (!editorRef.current) return;
    const html = editorRef.current.innerHTML;
    try {
      await navigator.clipboard.writeText(html);
      setCopyStatus('Raw HTML Copied!');
    } catch (err) {
      console.warn('Copy HTML error:', err);
      setCopyStatus('Failed to copy HTML');
    }
    setTimeout(() => setCopyStatus(null), 3000);
  };

  const handleDownloadHtml = () => {
    if (!editorRef.current) return;
    const title = templateName ? `${templateName} Report` : 'Radiology Merged Report';
    const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; padding: 40px; color: #1e293b; line-height: 1.6; max-width: 850px; margin: 0 auto; background: #f8fafc; }
    .report-card { background: #ffffff; padding: 32px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); border: 1px solid #e2e8f0; }
    h1 { font-size: 20px; font-weight: 800; color: #0f172a; border-bottom: 2px solid #3b82f6; padding-bottom: 8px; margin-bottom: 20px; text-transform: uppercase; }
    h2 { font-size: 16px; font-weight: 700; color: #1e40af; margin-top: 24px; margin-bottom: 10px; border-bottom: 1px solid #cbd5e1; padding-bottom: 4px; }
    h3 { font-size: 14px; font-weight: 600; color: #334155; margin-top: 16px; }
    p { margin-bottom: 12px; font-size: 14px; }
    strong { font-weight: 700; color: #0f172a; }
    .impression-section { margin-top: 24px; padding: 16px; background: #eff6ff; border-left: 4px solid #2563eb; border-radius: 6px; }
    ul { padding-left: 24px; margin-bottom: 12px; }
    li { margin-bottom: 6px; font-size: 14px; }
    table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 13.5px; }
    th, td { border: 1px solid #cbd5e1; padding: 8px 12px; text-align: left; vertical-align: top; }
    th { background: #f1f5f9; font-weight: 700; color: #0f172a; }
    tr:nth-child(even) td { background: #f8fafc; }
  </style>
</head>
<body>
  <div class="report-card">
    ${editorRef.current.innerHTML}
  </div>
</body>
</html>`;
    const fileName = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${new Date().toISOString().slice(0, 10)}.html`;
    downloadFile(fullHtml, fileName, 'text/html');
  };

  const [isExportingDocx, setIsExportingDocx] = useState<boolean>(false);

  const handleDownloadWordDoc = async () => {
    if (!editorRef.current) return;
    const title = templateName ? `${templateName} Report` : 'Radiology Merged Report';
    setIsExportingDocx(true);
    try {
      // Generate genuine binary .docx file using OpenXML Packer
      const docxBlob = await generateDocxFromHtml(editorRef.current.innerHTML, title);
      const fileName = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${new Date().toISOString().slice(0, 10)}.docx`;
      downloadFile(docxBlob, fileName, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    } catch (err) {
      console.error('Failed to export genuine docx, falling back to legacy doc format:', err);
      const htmlDoc = generateWordHtmlDoc(editorRef.current.innerHTML, title);
      const fileName = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${new Date().toISOString().slice(0, 10)}.doc`;
      downloadFile(htmlDoc, fileName, 'application/msword');
    } finally {
      setIsExportingDocx(false);
    }
  };

  const handleDownloadRtf = () => {
    if (!editorRef.current) return;
    const title = templateName ? `${templateName} Report` : 'Radiology Merged Report';
    const rtfDoc = generateRtfDocument(editorRef.current.innerHTML, title);
    const fileName = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${new Date().toISOString().slice(0, 10)}.rtf`;
    downloadFile(rtfDoc, fileName, 'application/rtf');
  };

  const handlePrint = () => {
    if (!editorRef.current) return;
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      window.print();
      return;
    }
    const title = templateName ? `${templateName} Report` : 'Radiology Merged Report';
    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>${title}</title>
          <style>
            body { font-family: 'Calibri', Arial, sans-serif; padding: 40px; color: #111; line-height: 1.6; }
            h1 { font-size: 18pt; text-align: center; text-decoration: underline; margin-bottom: 20px; }
            h2 { font-size: 14pt; color: #1e3a8a; border-bottom: 1px solid #ccc; padding-bottom: 4px; margin-top: 20px; }
            h3 { font-size: 13pt; margin-top: 16px; }
            p { margin-bottom: 12px; }
            strong { font-weight: bold; }
            .clinical-profile { background: #f1f5f9; padding: 10px; border-left: 3px solid #0284c7; font-style: italic; }
            .impression-section { margin-top: 20px; padding: 12px; background: #eff6ff; border: 1px solid #bfdbfe; }
            ul { padding-left: 20px; }
            li { margin-bottom: 6px; }
            table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 10pt; }
            th, td { border: 1px solid #cbd5e1; padding: 6px 10px; text-align: left; }
            th { background: #f1f5f9; font-weight: bold; }
            tr:nth-child(even) td { background: #f8fafc; }
          </style>
        </head>
        <body>
          ${editorRef.current.innerHTML}
        </body>
      </html>
    `);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => {
      printWindow.print();
      printWindow.close();
    }, 250);
  };

  const handleSyncBackToFindings = () => {
    if (!editorRef.current || !onUpdateFindings) return;
    const text = editorRef.current.innerText || editorRef.current.textContent || '';
    const paragraphs = text
      .split(/\n\s*\n/)
      .map(p => p.trim())
      .filter(Boolean);
    
    if (paragraphs.length > 0) {
      const sanitized = paragraphs.map(p => {
        if (/^clinical\s*(profile|history):/i.test(p.replace(/^[*_\s]+/, ''))) {
          const inner = p
            .replace(/^[*_\s]+/, '')
            .replace(/[*_\s]+$/, '')
            .replace(/\.\*+$/, '.')
            .replace(/[*_\s]+$/, '')
            .replace(/^Clinical\s*(Profile|History)\s*:?\s*/i, 'Clinical Profile: ')
            .replace(/^Clinical Profile:\s*\*+/i, 'Clinical Profile: ')
            .replace(/[*_\s]+$/, '')
            .replace(/^[*_\s]+/, '')
            .trim();
          return inner;
        }
        return p;
      });
      onUpdateFindings(sanitized);
      setIsSynced(true);
    }
  };

  return (
    <div id="rich-text-format-editor" className="w-full mb-8 bg-white dark:bg-slate-900 rounded-2xl border border-blue-200 dark:border-blue-900/60 shadow-lg overflow-hidden transition-all">
      {/* Header Banner */}
      <div className="bg-gradient-to-r from-blue-700 via-blue-600 to-indigo-700 text-white px-5 py-4 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="bg-white/20 text-white text-[11px] font-bold px-2.5 py-0.5 rounded-full uppercase tracking-wider">
              Primary Editor
            </span>
            <span className="text-xs text-blue-100 font-medium">
              {templateName ? `Template: ${templateName}` : 'Merged Report'}
            </span>
          </div>
          <h2 className="text-lg sm:text-xl font-extrabold tracking-tight mt-1">
            Rich Text Format (RTF) Report Editor
          </h2>
          <p className="text-xs text-blue-100/90 mt-0.5">
            Full WYSIWYG editor with live formatting, abnormal findings bolding, and export to Word / RTF / RIS.
          </p>
        </div>

        {/* Top Header Actions */}
        <div className="flex flex-wrap items-center gap-1.5 self-stretch sm:self-auto justify-end">
          <button
            type="button"
            onClick={handleCopyRichText}
            className="flex items-center gap-1 px-2.5 py-1.5 bg-white text-blue-800 hover:bg-blue-50 font-bold text-xs rounded-lg shadow-sm transition-all cursor-pointer active:scale-95"
            title="Copy formatted rich text to paste into PACS, RIS, or MS Word with bolding intact"
          >
            <CopyIcon className="w-3.5 h-3.5 text-blue-700" />
            {copyStatus || 'Copy Rich Text'}
          </button>
          <button
            type="button"
            onClick={handleCopyHtml}
            className="flex items-center gap-1 px-2.5 py-1.5 bg-blue-100 hover:bg-white text-blue-900 font-bold text-xs rounded-lg shadow-sm transition-all cursor-pointer"
            title="Copy clean HTML markup of the merged template"
          >
            <CopyIcon className="w-3.5 h-3.5 text-blue-800" />
            Copy HTML
          </button>
          <button
            type="button"
            onClick={handleDownloadHtml}
            className="flex items-center gap-1 px-2.5 py-1.5 bg-emerald-700/90 hover:bg-emerald-800 text-white font-bold text-xs rounded-lg shadow-sm transition-all cursor-pointer"
            title="Download formatted report as standalone HTML (.html) file"
          >
            <DownloadIcon className="w-3.5 h-3.5" />
            HTML (.html)
          </button>
          <button
            type="button"
            onClick={handleDownloadWordDoc}
            disabled={isExportingDocx}
            className="flex items-center gap-1 px-2.5 py-1.5 bg-blue-800/80 hover:bg-blue-900 text-white font-bold text-xs rounded-lg shadow-sm transition-all cursor-pointer disabled:opacity-50"
            title="Download authentic Microsoft Word document (.docx) - opens cleanly without corruption on Android, iOS, Windows, and Mac"
          >
            <DownloadIcon className="w-3.5 h-3.5" />
            {isExportingDocx ? 'Generating...' : 'Word (.docx)'}
          </button>
          <button
            type="button"
            onClick={handleDownloadRtf}
            className="flex items-center gap-1 px-2.5 py-1.5 bg-indigo-800/80 hover:bg-indigo-900 text-white font-bold text-xs rounded-lg shadow-sm transition-all cursor-pointer"
            title="Download standard Rich Text Format (.rtf) file"
          >
            <DownloadIcon className="w-3.5 h-3.5" />
            RTF (.rtf)
          </button>
          <button
            type="button"
            onClick={handlePrint}
            className="px-2 py-1.5 bg-white/15 hover:bg-white/25 text-white font-semibold text-xs rounded-lg transition-all cursor-pointer"
            title="Print or Save as PDF"
          >
            🖨️ Print
          </button>
        </div>
      </div>

      {/* Formatting Toolbar */}
      <div className="bg-slate-50 dark:bg-slate-800/90 border-b border-slate-200 dark:border-slate-700 px-4 py-2.5 flex flex-wrap items-center gap-2 select-none">
        {/* Style selection */}
        <select
          onChange={(e) => executeCommand('formatBlock', e.target.value)}
          defaultValue="p"
          className="text-xs bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-md px-2 py-1 text-slate-700 dark:text-slate-200 font-medium focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer"
          title="Change text style"
        >
          <option value="p">Paragraph</option>
          <option value="h1">Heading 1 (Title)</option>
          <option value="h2">Heading 2 (Section)</option>
          <option value="h3">Heading 3 (Subheading)</option>
        </select>

        <div className="h-5 w-px bg-slate-300 dark:bg-slate-600 mx-1 hidden sm:block" />

        {/* Text formatting: Bold, Italic, Underline */}
        <div className="flex items-center rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 overflow-hidden shadow-xs">
          <button
            type="button"
            onClick={() => executeCommand('bold')}
            className="w-7 h-7 flex items-center justify-center font-bold text-sm text-slate-800 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-600 active:bg-blue-100"
            title="Bold (Ctrl+B)"
          >
            B
          </button>
          <button
            type="button"
            onClick={() => executeCommand('italic')}
            className="w-7 h-7 flex items-center justify-center italic text-sm text-slate-800 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-600 active:bg-blue-100 border-l border-slate-200 dark:border-slate-600"
            title="Italic (Ctrl+I)"
          >
            I
          </button>
          <button
            type="button"
            onClick={() => executeCommand('underline')}
            className="w-7 h-7 flex items-center justify-center underline text-sm text-slate-800 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-600 active:bg-blue-100 border-l border-slate-200 dark:border-slate-600"
            title="Underline (Ctrl+U)"
          >
            U
          </button>
        </div>

        <div className="h-5 w-px bg-slate-300 dark:bg-slate-600 mx-1 hidden sm:block" />

        {/* Alignment */}
        <div className="flex items-center rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 overflow-hidden shadow-xs">
          <button
            type="button"
            onClick={() => executeCommand('justifyLeft')}
            className="px-2 h-7 flex items-center justify-center text-xs text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-600"
            title="Align Left"
          >
            ⇤
          </button>
          <button
            type="button"
            onClick={() => executeCommand('justifyCenter')}
            className="px-2 h-7 flex items-center justify-center text-xs text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-600 border-l border-slate-200 dark:border-slate-600"
            title="Align Center"
          >
            ⇥⇤
          </button>
          <button
            type="button"
            onClick={() => executeCommand('justifyRight')}
            className="px-2 h-7 flex items-center justify-center text-xs text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-600 border-l border-slate-200 dark:border-slate-600"
            title="Align Right"
          >
            ⇥
          </button>
        </div>

        <div className="h-5 w-px bg-slate-300 dark:bg-slate-600 mx-1 hidden sm:block" />

        {/* Lists */}
        <div className="flex items-center rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 overflow-hidden shadow-xs">
          <button
            type="button"
            onClick={() => executeCommand('insertUnorderedList')}
            className="px-2.5 h-7 flex items-center justify-center text-xs text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-600"
            title="Bullet List"
          >
            • List
          </button>
          <button
            type="button"
            onClick={() => executeCommand('insertOrderedList')}
            className="px-2.5 h-7 flex items-center justify-center text-xs text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-600 border-l border-slate-200 dark:border-slate-600"
            title="Numbered List"
          >
            1. List
          </button>
        </div>

        {/* Table insert */}
        <div className="flex items-center rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 overflow-hidden shadow-xs">
          <button
            type="button"
            onClick={handleInsertTable}
            className="px-2.5 h-7 flex items-center justify-center gap-1 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-600"
            title="Insert Measurement/Report Table"
          >
            <span className="text-sm">⊞</span> Table
          </button>
        </div>

        <QuickMacroInsertPopover
          compact
          buttonLabel="Macro"
          onOpenManagerModal={onOpenMacrosModal}
          onInsertMacroFindings={(expandedLines) => {
            if (onUpdateFindings) {
              onUpdateFindings([...findings, ...expandedLines]);
            } else if (editorRef.current) {
              const htmlSnippet = expandedLines
                .map(line => `<p><strong>${line.replace(/^BOLD::/i, '')}</strong></p>`)
                .join('');
              editorRef.current.focus();
              document.execCommand('insertHTML', false, htmlSnippet);
              handleInput();
            }
          }}
        />

        <div className="h-5 w-px bg-slate-300 dark:bg-slate-600 mx-1 hidden sm:block" />

        {/* Undo / Redo & Clear */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => executeCommand('undo')}
            className="w-7 h-7 flex items-center justify-center text-xs text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-md hover:bg-slate-100 dark:hover:bg-slate-600"
            title="Undo (Ctrl+Z)"
          >
            ↶
          </button>
          <button
            type="button"
            onClick={() => executeCommand('redo')}
            className="w-7 h-7 flex items-center justify-center text-xs text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-md hover:bg-slate-100 dark:hover:bg-slate-600"
            title="Redo (Ctrl+Y)"
          >
            ↷
          </button>
          <button
            type="button"
            onClick={() => executeCommand('removeFormat')}
            className="px-2 h-7 flex items-center justify-center text-xs text-slate-500 dark:text-slate-400 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-md hover:bg-slate-100 dark:hover:bg-slate-600"
            title="Clear Formatting"
          >
            Tx
          </button>
        </div>

        {/* Sync status */}
        <div className="ml-auto flex items-center gap-2">
          {!isSynced && onUpdateFindings && (
            <button
              type="button"
              onClick={handleSyncBackToFindings}
              className="text-xs font-semibold px-2.5 py-1 bg-amber-100 hover:bg-amber-200 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200 rounded-md border border-amber-300 dark:border-amber-700 transition-colors"
              title="Apply edits back to the findings cards below"
            >
              Sync to Findings
            </button>
          )}
          <span className="text-[11px] text-slate-500 dark:text-slate-400">
            {wordCount} words • {charCount} chars
          </span>
        </div>
      </div>

      {/* Editable Document Canvas - Styled as bright mode document paper in both light and dark themes */}
      <div className="w-full p-4 sm:p-6 bg-slate-200/90 dark:bg-slate-950/90 min-h-[380px] max-h-[750px] overflow-y-auto overflow-x-hidden block">
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          onInput={handleInput}
          className="w-full max-w-4xl mx-auto bg-white text-slate-900 border border-slate-300 rounded-xl p-6 sm:p-10 shadow-lg focus:outline-none focus:ring-2 focus:ring-blue-500 font-sans leading-relaxed text-sm sm:text-base selection:bg-blue-200 selection:text-blue-900 break-words"
          style={{ 
            minHeight: '380px', 
            height: 'auto',
            backgroundColor: '#ffffff', 
            color: '#0f172a',
            boxSizing: 'border-box',
          }}
        />
      </div>

      {/* Footer Info */}
      <div className="bg-slate-100 dark:bg-slate-800/70 px-5 py-2.5 border-t border-slate-200 dark:border-slate-700/60 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
        <div className="flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
          <span>Rich Text Format Editor is active as the primary view for template merging.</span>
        </div>
        <div>
          <span>The standard structured HTML report & individual findings are available directly below.</span>
        </div>
      </div>
    </div>
  );
};

export default RichTextReportEditor;
