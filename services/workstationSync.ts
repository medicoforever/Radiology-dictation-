/**
 * Hospital Workstation Auto-Sync Service
 *
 * Security Requirement:
 * - ZERO hardcoded API tokens, Gist IDs, or sensitive keys in the source code.
 * - All sync credentials are loaded dynamically from the device's localStorage:
 *   const syncToken = localStorage.getItem("workstation_sync_token");
 *   const gistId = localStorage.getItem("workstation_gist_id");
 *
 * Report Format Requirement:
 * - Sends pure standalone HTML report (same as Download HTML and Google Drive auto-save),
 *   instead of capturing the entire application web page DOM.
 */

import { generateSingleDictationHTML, generateBatchDictationHTML } from './htmlGenerator';

export interface WorkstationSyncOptions {
  htmlContent?: string;
  findings?: string[];
  batches?: Array<{ id: string; name: string; findings: string[] | null }>;
  timestamp?: number | Date;
}

export async function autoSyncReport(
  token: string, 
  id: string,
  options?: WorkstationSyncOptions
): Promise<void> {
  try {
    let reportHtml = options?.htmlContent;

    // 1. If findings provided, generate pure single report HTML
    if (!reportHtml && options?.findings && options.findings.length > 0) {
      reportHtml = generateSingleDictationHTML(options.findings, options.timestamp || Date.now());
    }

    // 2. If batches provided, generate pure batch report HTML
    if (!reportHtml && options?.batches && options.batches.length > 0) {
      reportHtml = generateBatchDictationHTML(options.batches, options.timestamp || Date.now());
    }

    // 3. Fallback: Check local storage for active single dictation findings
    if (!reportHtml) {
      try {
        const savedSingle = localStorage.getItem('radiologyDictationSingleMode');
        if (savedSingle) {
          const parsed = JSON.parse(savedSingle);
          if (Array.isArray(parsed.findings) && parsed.findings.length > 0) {
            reportHtml = generateSingleDictationHTML(parsed.findings, parsed.timestamp || Date.now());
          }
        }
      } catch (e) {
        console.warn('Error reading single mode state for workstation sync:', e);
      }
    }

    // 4. Fallback: Check local storage for completed batch dictation findings
    if (!reportHtml) {
      try {
        const savedBatch = localStorage.getItem('radiologyDictationBatchMode');
        if (savedBatch) {
          const parsedBatches = JSON.parse(savedBatch);
          if (Array.isArray(parsedBatches)) {
            const completed = parsedBatches.filter((b: any) => b.findings && b.findings.length > 0);
            if (completed.length > 0) {
              const sessionTs = localStorage.getItem('radiologyDictationBatchSessionTimestamp');
              reportHtml = generateBatchDictationHTML(
                completed,
                sessionTs ? Number(sessionTs) : Date.now()
              );
            }
          }
        }
      } catch (e) {
        console.warn('Error reading batch mode state for workstation sync:', e);
      }
    }

    // If there are no findings available yet, skip sync
    if (!reportHtml) {
      console.log('Workstation sync skipped: No findings available yet.');
      return;
    }

    const now = new Date();
    const timeStr = now.getHours().toString().padStart(2, '0') + '-' + 
                    now.getMinutes().toString().padStart(2, '0') + '-' + 
                    now.getSeconds().toString().padStart(2, '0');
    const filename = `Radiology_Report_${timeStr}.html`;

    await fetch(`https://api.github.com/gists/${id}`, {
      method: "PATCH",
      headers: {
        "Authorization": `token ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        files: {
          "latest_report.html": { content: reportHtml },
          "meta.json": { content: JSON.stringify({ filename: filename, timestamp: now.getTime() }) }
        }
      })
    });
    console.log("Pure radiology report HTML auto-synced to hospital workstation.");
  } catch (err) {
    console.warn("Silent sync attempt failed:", err);
  }
}

let syncDebounceTimer: ReturnType<typeof setTimeout> | null = null;

export function checkAndAutoSyncReport(
  delayMs: number = 300,
  options?: WorkstationSyncOptions
): void {
  const isEnabled = localStorage.getItem("workstation_sync_enabled") === "true";
  const token = localStorage.getItem("workstation_sync_token");
  const id = localStorage.getItem("workstation_gist_id");
  
  if (isEnabled && token && id) {
    if (syncDebounceTimer) {
      clearTimeout(syncDebounceTimer);
    }
    syncDebounceTimer = setTimeout(() => {
      autoSyncReport(token, id, options);
    }, delayMs);
  }
}
