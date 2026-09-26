import { parseMarkdownTable, cleanClinicalProfileText, isTableRowFinding } from './docxService';

// A batch type used for report generation
interface ReportBatch {
    id: string;
    name: string;
    findings: string[] | null;
}

const getEmbeddedScript = () => `
// Embedded script for standalone HTML report functionality
(function() {
    function initReport() {
        // --- STATE ---
        let multiSelectMode = false;
        const selections = {}; // { [batchId]: Set<number> }
        let notificationTimeout = null;

        let reorderBatchId = null;
        let mergeBatchId = null;
        const lastMerges = {}; // { [batchId]: { containerHTML: string } }
        let dragStartInfo = null; // { batchId, index, element }

        // --- DOM ELEMENTS ---
        const notificationEl = document.getElementById('notification');
        const multiSelectToggle = document.getElementById('multi-select-toggle');
        
        // --- HELPER FUNCTIONS ---
        const showNotification = (text) => {
            if (!notificationEl) return;
            if (notificationTimeout) clearTimeout(notificationTimeout);
            notificationEl.textContent = text;
            notificationEl.classList.remove('opacity-0');
            notificationTimeout = setTimeout(() => {
                notificationEl.classList.add('opacity-0');
            }, 2000);
        };

        const copyToClipboard = async (plainText, htmlText) => {
            try {
                if (navigator.clipboard && window.ClipboardItem && window.isSecureContext) {
                    const htmlBlob = new Blob([htmlText], { type: 'text/html' });
                    const textBlob = new Blob([plainText], { type: 'text/plain' });
                    const clipboardItem = new ClipboardItem({
                        'text/html': htmlBlob,
                        'text/plain': textBlob,
                    });
                    await navigator.clipboard.write([clipboardItem]);
                    return true;
                }
            } catch (err) {
                console.warn('Rich text copy failed, falling back.', err);
            }

            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(plainText);
                    return true;
                }
            } catch (fallbackErr) {
                console.warn('writeText failed, falling back to execCommand.', fallbackErr);
            }

            try {
                const tempTextArea = document.createElement('textarea');
                tempTextArea.value = plainText;
                tempTextArea.style.position = 'fixed';
                tempTextArea.style.left = '-9999px';
                tempTextArea.style.top = '-9999px';
                tempTextArea.setAttribute('readonly', '');
                document.body.appendChild(tempTextArea);
                tempTextArea.select();
                const successful = document.execCommand('copy');
                document.body.removeChild(tempTextArea);
                return successful;
            } catch (execErr) {
                console.error('Copy execution failed entirely.', execErr);
                return false;
            }
        };
        
        const isClinicalProfileFinding = (text) => {
            const clean = text.replace(/^BOLD::/i, '').replace(/^[*_\\s]+|[*_\\s]+$/g, '').trim();
            return /^clinical\\s*(profile|history):/i.test(clean);
        };

        const cleanClinicalProfileText = (text) => {
            let inner = text.replace(/^BOLD::/i, '').trim();
            inner = inner.replace(/^[*_\\s]+/, '');
            inner = inner.replace(/[*_\\s]+$/, '');
            inner = inner.replace(/\\.\\*+$/, '.');
            inner = inner.replace(/[*_\\s]+$/, '').trim();
            inner = inner.replace(/^Clinical\\s*(Profile|History)\\s*:?\\s*/i, 'Clinical Profile: ');
            inner = inner.replace(/^Clinical Profile:\\s*\\*+/i, 'Clinical Profile: ');
            inner = inner.replace(/[*_\\s]+$/, '').trim();
            inner = inner.replace(/^[*_\\s]+/, '').trim();
            return inner.trim();
        };

        const getCopyContent = (findingEl) => {
            const rawFinding = decodeURIComponent(findingEl.dataset.findingRaw || '');
            const tableEl = findingEl.querySelector('table');
            if (tableEl) {
                const plainText = tableEl.innerText || tableEl.textContent || rawFinding;
                const htmlText = tableEl.outerHTML;
                return { plainText, htmlText };
            }

            const isBold = rawFinding.includes('BOLD::');
            const cleanFinding = rawFinding.replace(/BOLD::/g, '');
            const isTitle = cleanFinding.trim() === 'C.T.SCAN OF BRAIN (PLAIN)';
            const isClinicalProfile = isClinicalProfileFinding(cleanFinding);
            const parts = cleanFinding.split('###');
            const isStructured = parts.length > 1;
            const isImpression = isStructured && parts[0].trim().toUpperCase() === 'IMPRESSION:';
            const isItalic = isClinicalProfile || (!isStructured && cleanFinding.startsWith('*') && cleanFinding.endsWith('*'));

            let plainText, htmlText;

            if (isTitle) {
                plainText = cleanFinding;
                htmlText = \`<p style="text-align:center;"><strong><u>\${cleanFinding}</u></strong></p>\`;
            } else if (isClinicalProfile) {
                plainText = cleanClinicalProfileText(cleanFinding);
                htmlText = \`<p><em>\${plainText}</em></p>\`;
            } else if (isImpression) {
                const title = parts[0];
                const points = parts.slice(1);
                plainText = \`\${title.toUpperCase()}\\n\${points.map(p => \`• \${p}\`).join('\\n')}\`;
                htmlText = \`<p><strong style="text-decoration: underline;">\${title.toUpperCase()}</strong></p><ul>\${points.map(p => \`<li><strong>\${p}</strong></li>\`).join('')}</ul>\`;
            } else if (isStructured) {
                plainText = parts.join('\\n');
                let htmlContent = isBold ? \`<p><strong>\${parts[0]}</strong></p>\` : \`<p>\${parts[0]}</p>\`;
                htmlContent += parts.slice(1).map(p => isBold ? \`<p><strong>\${p}</strong></p>\` : \`<p>\${p}</p>\`).join('');
                htmlText = htmlContent;
            } else {
                if (isItalic) {
                    plainText = cleanFinding.slice(1, -1);
                    htmlText = \`<p><em>\${plainText}</em></p>\`;
                } else {
                    plainText = cleanFinding;
                    htmlText = isBold ? \`<p><strong>\${cleanFinding}</strong></p>\` : \`<p>\${cleanFinding}</p>\`;
                }
            }
            return { plainText, htmlText };
        };
        
        const reIndexFindings = (batchId) => {
            const findings = document.querySelectorAll(\`.finding-item[data-batch-id="\${batchId}"]\`);
            findings.forEach((finding, index) => {
                finding.dataset.findingIndex = index.toString();
            });
        };

        const updateFindingSelection = (batchId, index, shouldSelect) => {
            if (!selections[batchId]) {
                selections[batchId] = new Set();
            }
            const findingEl = document.querySelector(\`.finding-item[data-batch-id="\${batchId}"][data-finding-index="\${index}"]\`);
            if (!findingEl) return;
            const checkboxEl = findingEl.querySelector('[role="checkbox"] > div');
            
            if (shouldSelect) {
                selections[batchId].add(index);
                findingEl.classList.add('selected');
                if (checkboxEl) {
                    checkboxEl.classList.add('bg-blue-600', 'border-blue-600');
                    checkboxEl.classList.remove('border-slate-400', 'bg-white');
                    checkboxEl.textContent = '✓';
                    checkboxEl.style.color = '#ffffff';
                    checkboxEl.style.fontSize = '11px';
                    checkboxEl.style.fontWeight = 'bold';
                    checkboxEl.style.display = 'flex';
                    checkboxEl.style.alignItems = 'center';
                    checkboxEl.style.justifyContent = 'center';
                }
            } else {
                selections[batchId].delete(index);
                findingEl.classList.remove('selected');
                if (checkboxEl) {
                    checkboxEl.classList.remove('bg-blue-600', 'border-blue-600');
                    checkboxEl.classList.add('border-slate-400', 'bg-white');
                    checkboxEl.textContent = '';
                }
            }
        };

        const copyBatchSelection = async (batchId) => {
            const selection = selections[batchId];
            if (!selection || selection.size === 0) {
                showNotification('Selection cleared.');
                return;
            }

            const sortedIndices = Array.from(selection).sort((a, b) => a - b);
            
            let plainTexts = [];
            let htmlTexts = [];

            sortedIndices.forEach(i => {
                const findingEl = document.querySelector(\`.finding-item[data-batch-id="\${batchId}"][data-finding-index="\${i}"]\`);
                if (findingEl) {
                    const { plainText, htmlText } = getCopyContent(findingEl);
                    plainTexts.push(plainText);
                    htmlTexts.push(htmlText);
                }
            });
            
            const plainText = plainTexts.join('\\n\\n');
            const htmlText = htmlTexts.join('');

            const success = await copyToClipboard(plainText, htmlText);
            const notificationText = success
                ? \`Copied \${selection.size} finding\${selection.size > 1 ? 's' : ''}!\`
                : 'Copy failed!';
            showNotification(notificationText);
        };

        const toggleMultiSelectMode = (enabled) => {
            multiSelectMode = enabled;
            if (multiSelectToggle) {
                multiSelectToggle.checked = enabled;
            }
            if (enabled) {
                if (reorderBatchId || mergeBatchId) {
                    reorderBatchId = null;
                    mergeBatchId = null;
                    updateUIForModes();
                }
            } else {
                Object.keys(selections).forEach(batchId => {
                    if (selections[batchId]) {
                        selections[batchId].forEach(index => {
                            updateFindingSelection(batchId, index, false);
                        });
                        selections[batchId].clear();
                    }
                });
                showNotification('Selection cleared.');
            }
        };

        // --- EDITING LOGIC ---
        let currentEditing = null; // { batchId, index, originalHTML }
        
        const cancelAllEdits = () => {
            if (!currentEditing) return;
            const { batchId, index, originalHTML } = currentEditing;
            const findingEl = document.querySelector(\`.finding-item[data-batch-id="\${batchId}"][data-finding-index="\${index}"]\`);
            if (findingEl) {
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = originalHTML;
                while (findingEl.firstChild) { findingEl.removeChild(findingEl.firstChild); }
                while (tempDiv.firstChild) { findingEl.appendChild(tempDiv.firstChild); }
                addFindingEventListeners(findingEl, batchId);
            }
            currentEditing = null;
        };

        const startEditing = (findingEl, batchId, index) => {
            cancelAllEdits();

            const originalHTML = findingEl.innerHTML;
            currentEditing = { batchId, index, originalHTML: originalHTML };
            
            const { plainText } = getCopyContent(findingEl);

            findingEl.innerHTML = \`
                <div class="flex flex-col gap-2">
                    <textarea class="w-full p-2 border rounded-md font-semibold text-slate-700 focus:ring-2 focus:ring-blue-500 focus:outline-none" rows="3"></textarea>
                    <div class="flex justify-end gap-2">
                        <button class="edit-cancel text-sm font-semibold py-1 px-3 rounded-lg bg-slate-200 text-slate-700 hover:bg-slate-300">Cancel</button>
                        <button class="edit-save text-sm font-semibold py-1 px-3 rounded-lg bg-blue-600 text-white hover:bg-blue-700">Save</button>
                    </div>
                </div>
            \`;
            const textarea = findingEl.querySelector('textarea');
            textarea.value = plainText;
            textarea.rows = Math.max(3, plainText.split('\\n').length);
            textarea.focus();

            findingEl.querySelector('.edit-save').addEventListener('click', () => {
                const newText = findingEl.querySelector('textarea').value;
                const oldRawFinding = decodeURIComponent(findingEl.dataset.findingRaw || '');
                const isBold = oldRawFinding.startsWith('BOLD::');
                
                const newClean = newText.split('\\n').filter(Boolean).join('###');
                const newRawFinding = (isBold ? 'BOLD::' : '') + newClean;
                
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = originalHTML;
                while (findingEl.firstChild) { findingEl.removeChild(findingEl.firstChild); }
                while (tempDiv.firstChild) { findingEl.appendChild(tempDiv.firstChild); }

                findingEl.dataset.findingRaw = encodeURIComponent(newRawFinding);
                
                const newParts = newClean.split('###');
                const textEl = findingEl.querySelector('.finding-text');
                const isTitle = newClean.trim() === 'C.T.SCAN OF BRAIN (PLAIN)';
                const isClinicalProfile = isClinicalProfileFinding(newClean);
                const isImpression = newParts.length > 1 && newParts[0].trim().toUpperCase() === 'IMPRESSION:';
                const isItalic = isClinicalProfile || (newParts.length === 1 && newClean.startsWith('*') && newClean.endsWith('*'));

                if (isTitle) {
                    textEl.className = 'finding-text text-slate-700 cursor-pointer text-center font-bold underline';
                    textEl.innerHTML = newClean;
                } else if (isClinicalProfile) {
                    const profText = cleanClinicalProfileText(newClean);
                    textEl.className = 'finding-text text-slate-700 cursor-pointer italic';
                    textEl.innerHTML = profText;
                    findingEl.dataset.findingRaw = encodeURIComponent((isBold ? 'BOLD::' : '') + profText);
                } else if (isImpression) {
                    textEl.className = 'finding-text text-slate-700 cursor-pointer';
                    textEl.innerHTML = \`<strong class="underline uppercase">\${newParts[0]}</strong><ul class="list-disc list-inside pl-4 mt-1">\${newParts.slice(1).map(p => \`<li class="font-bold">\${p}</li>\`).join('')}</ul>\`;
                } else if (newParts.length > 1) {
                    textEl.className = 'finding-text text-slate-700 cursor-pointer';
                    textEl.innerHTML = \`<strong class="font-bold">\${newParts[0]}</strong>\${newParts.slice(1).map(p => \`<span class="block font-semibold">\${p}</span>\`).join('')}\`;
                } else {
                    textEl.className = \`finding-text text-slate-700 cursor-pointer \${isItalic ? 'italic' : isBold ? 'font-bold' : ''}\`;
                    textEl.innerHTML = isItalic ? newClean.slice(1, -1) : newClean;
                }
                
                addFindingEventListeners(findingEl, batchId);
                currentEditing = null;
            });

            findingEl.querySelector('.edit-cancel').addEventListener('click', () => {
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = originalHTML;
                while (findingEl.firstChild) { findingEl.removeChild(findingEl.firstChild); }
                while (tempDiv.firstChild) { findingEl.appendChild(tempDiv.firstChild); }
                addFindingEventListeners(findingEl, batchId);
                currentEditing = null;
            });
        };

        // --- REORDER/MERGE LOGIC ---
        const updateUIForModes = () => {
            document.querySelectorAll('[data-batch-findings-container-id]').forEach(container => {
                const batchId = container.dataset.batchFindingsContainerId;
                const reorderBtn = document.querySelector(\`.reorder-toggle-btn[data-batch-id="\${batchId}"]\`);
                const mergeBtn = document.querySelector(\`.merge-toggle-btn[data-batch-id="\${batchId}"]\`);

                if (batchId === reorderBatchId) {
                    container.classList.add('reorder-mode');
                    container.classList.remove('merge-mode');
                    if (reorderBtn) reorderBtn.textContent = 'Done';
                    if (mergeBtn) mergeBtn.textContent = 'Merge';
                } else if (batchId === mergeBatchId) {
                    container.classList.add('merge-mode');
                    container.classList.remove('reorder-mode');
                    if (mergeBtn) mergeBtn.textContent = 'Done';
                    if (reorderBtn) reorderBtn.textContent = 'Reorder';
                } else {
                    container.classList.remove('reorder-mode', 'merge-mode');
                    if (reorderBtn) reorderBtn.textContent = 'Reorder';
                    if (mergeBtn) mergeBtn.textContent = 'Merge';
                }
            });
        };
        
        const hideUndoButton = (batchId) => {
            const undoBtn = document.querySelector(\`.undo-merge-btn[data-batch-id="\${batchId}"]\`);
            if (undoBtn) undoBtn.classList.add('hidden');
            delete lastMerges[batchId];
        };

        const toggleReorderMode = (batchId) => {
            if (multiSelectMode) toggleMultiSelectMode(false);
            cancelAllEdits();
            hideUndoButton(batchId);
            mergeBatchId = null;
            reorderBatchId = reorderBatchId === batchId ? null : batchId;
            updateUIForModes();
        };

        const toggleMergeMode = (batchId) => {
            if (multiSelectMode) toggleMultiSelectMode(false);
            cancelAllEdits();
            hideUndoButton(batchId);
            reorderBatchId = null;
            mergeBatchId = mergeBatchId === batchId ? null : batchId;
            updateUIForModes();
        };

        const undoMerge = (batchId) => {
            const undoState = lastMerges[batchId];
            if (!undoState) return;
            const container = document.querySelector(\`[data-batch-findings-container-id="\${batchId}"]\`);
            if (!container) return;
            container.innerHTML = undoState.containerHTML;
            reIndexFindings(batchId);
            container.querySelectorAll('.finding-item').forEach(findingEl => {
                const id = findingEl.dataset.batchId;
                addFindingEventListeners(findingEl, id);
            });
            hideUndoButton(batchId);
        };

        // --- EVENT LISTENER ATTACHMENT ---
        const addFindingEventListeners = (findingEl, batchId) => {
            const textEl = findingEl.querySelector('.finding-text');
            const selectionHandle = findingEl.querySelector('.selection-handle');
            const editBtn = findingEl.querySelector('.edit-btn');
            
            if (textEl) {
                textEl.addEventListener('click', async () => {
                    if (currentEditing || reorderBatchId || mergeBatchId) return;
                    const currentIndex = parseInt(findingEl.dataset.findingIndex, 10);
                    
                    if (multiSelectMode) {
                        const selection = selections[batchId] || new Set();
                        const isSelected = selection.has(currentIndex);
                        updateFindingSelection(batchId, currentIndex, !isSelected);
                        copyBatchSelection(batchId);
                        return;
                    }

                    const { plainText, htmlText } = getCopyContent(findingEl);
                    const success = await copyToClipboard(plainText, htmlText);
                    
                    if (success) {
                        updateFindingSelection(batchId, currentIndex, true);
                        setTimeout(() => updateFindingSelection(batchId, currentIndex, false), 500);
                        showNotification('Copied!');
                    } else {
                        showNotification('Copy failed!');
                    }
                });
            }

            if (selectionHandle) {
                selectionHandle.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (currentEditing || reorderBatchId || mergeBatchId) return;
                    if (!multiSelectMode) {
                        toggleMultiSelectMode(true);
                    }
                    const currentIndex = parseInt(findingEl.dataset.findingIndex, 10);
                    const selection = selections[batchId] || new Set();
                    const isSelected = selection.has(currentIndex);
                    updateFindingSelection(batchId, currentIndex, !isSelected);
                    copyBatchSelection(batchId);
                });
            }

            if (editBtn) {
                editBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (reorderBatchId || mergeBatchId) return;
                    const currentIndex = parseInt(findingEl.dataset.findingIndex, 10);
                    startEditing(findingEl, batchId, currentIndex);
                });
            }

            // Drag and Drop Listeners
            findingEl.addEventListener('dragstart', (e) => {
                if (reorderBatchId !== batchId && mergeBatchId !== batchId) {
                    e.preventDefault();
                    return;
                }
                const currentIndex = parseInt(findingEl.dataset.findingIndex, 10);
                dragStartInfo = { batchId, index: currentIndex, element: findingEl };
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', JSON.stringify({ batchId, index: currentIndex }));
                setTimeout(() => findingEl.classList.add('dragging'), 0);
            });

            findingEl.addEventListener('dragend', () => {
                findingEl.classList.remove('dragging');
                dragStartInfo = null;
            });

            findingEl.addEventListener('dragover', (e) => {
                e.preventDefault();
            });

            findingEl.addEventListener('dragenter', (e) => {
                e.preventDefault();
                const currentIndex = parseInt(findingEl.dataset.findingIndex, 10);
                if (mergeBatchId === batchId && dragStartInfo && dragStartInfo.index !== currentIndex) {
                    findingEl.classList.add('drag-over');
                }
            });

            findingEl.addEventListener('dragleave', () => {
                findingEl.classList.remove('drag-over');
            });

            findingEl.addEventListener('drop', (e) => {
                e.preventDefault();
                findingEl.classList.remove('drag-over');
                if (!dragStartInfo || dragStartInfo.batchId !== batchId) return;
                const sourceIndex = dragStartInfo.index;
                const targetIndex = parseInt(findingEl.dataset.findingIndex, 10);
                if (sourceIndex === targetIndex) return;

                // Reorder
                if (reorderBatchId === batchId) {
                    const container = findingEl.parentNode;
                    const sourceEl = dragStartInfo.element;
                    const targetEl = findingEl;
                    if (sourceIndex < targetIndex) {
                        container.insertBefore(sourceEl, targetEl.nextSibling);
                    } else {
                        container.insertBefore(sourceEl, targetEl);
                    }
                    reIndexFindings(batchId);
                }

                // Merge
                if (mergeBatchId === batchId) {
                    const container = findingEl.parentNode;
                    lastMerges[batchId] = { containerHTML: container.innerHTML };

                    const sourceEl = dragStartInfo.element;
                    const targetEl = findingEl;
                    const sourceData = getCopyContent(sourceEl);
                    const targetData = getCopyContent(targetEl);
                    
                    const mergedRaw = targetData.plainText + ' ' + sourceData.plainText;
                    targetEl.dataset.findingRaw = encodeURIComponent(mergedRaw);
                    const targetTextEl = targetEl.querySelector('.finding-text');
                    const sourceTextEl = sourceEl.querySelector('.finding-text');
                    if (targetTextEl && sourceTextEl) {
                        targetTextEl.innerHTML += ' ' + sourceTextEl.innerHTML;
                    }
                    
                    sourceEl.remove();
                    reIndexFindings(batchId);
                    const undoBtn = document.querySelector(\`.undo-merge-btn[data-batch-id="\${batchId}"]\`);
                    if (undoBtn) undoBtn.classList.remove('hidden');
                }
            });
        };

        // --- INITIALIZATION ---
        if (multiSelectToggle) {
            multiSelectToggle.addEventListener('change', () => toggleMultiSelectMode(multiSelectToggle.checked));
        }
        
        document.querySelectorAll('.finding-item').forEach(findingEl => {
            const batchId = findingEl.dataset.batchId;
            addFindingEventListeners(findingEl, batchId);
        });

        document.querySelectorAll('.copy-all-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const batchId = e.currentTarget.dataset.batchId;
                const findingElements = document.querySelectorAll('.finding-item[data-batch-id="' + batchId + '"]');
                
                if (findingElements.length === 0) return;

                let plainTexts = [];
                let htmlTexts = [];

                findingElements.forEach(el => {
                    const { plainText, htmlText } = getCopyContent(el);
                    plainTexts.push(plainText);
                    htmlTexts.push(htmlText);
                });

                const plainText = plainTexts.join('\\n\\n');
                const htmlText = htmlTexts.join('');
                const success = await copyToClipboard(plainText, htmlText);

                if (success) {
                    e.currentTarget.textContent = 'Copied!';
                    setTimeout(() => { e.currentTarget.textContent = 'Copy All'; }, 2000);
                }
            });
        });

        const copyAllTranscriptsBtn = document.getElementById('copy-all-transcripts');
        if (copyAllTranscriptsBtn) {
            copyAllTranscriptsBtn.addEventListener('click', async () => {
                const batches = Array.from(document.querySelectorAll('[data-batch-container-id]'));
                let plainText = '';
                let htmlText = '';

                batches.forEach(batchEl => {
                    const batchId = batchEl.dataset.batchContainerId;
                    const headingEl = batchEl.querySelector('h3');
                    const batchName = headingEl ? headingEl.textContent : 'Batch';
                    const findingElements = document.querySelectorAll('.finding-item[data-batch-id="' + batchId + '"]');
                    
                    if (findingElements.length > 0) {
                        let batchPlainText = [];
                        let batchHtmlText = '';

                        findingElements.forEach(el => {
                            const { plainText: findingPlainText, htmlText: findingHtmlText } = getCopyContent(el);
                            batchPlainText.push(findingPlainText);
                            batchHtmlText += findingHtmlText;
                        });

                        plainText += \`[\${batchName}]\\n\${batchPlainText.join('\\n')}\\n\\n\`;
                        htmlText += \`<h3>\${batchName}</h3>\` + batchHtmlText;
                    }
                });

                if (plainText.length === 0) return;

                const success = await copyToClipboard(plainText.trim(), htmlText.trim());
                if (success) {
                    copyAllTranscriptsBtn.textContent = 'Copied!';
                    setTimeout(() => { copyAllTranscriptsBtn.textContent = 'Copy All Transcripts'; }, 2000);
                }
            });
        }

        document.querySelectorAll('.reorder-toggle-btn').forEach(btn => {
            btn.addEventListener('click', () => toggleReorderMode(btn.dataset.batchId));
        });
        document.querySelectorAll('.merge-toggle-btn').forEach(btn => {
            btn.addEventListener('click', () => toggleMergeMode(btn.dataset.batchId));
        });
        document.querySelectorAll('.undo-merge-btn').forEach(btn => {
            btn.addEventListener('click', () => undoMerge(btn.dataset.batchId));
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initReport);
    } else {
        initReport();
    }
})();
`;

const getHTMLTemplate = (title: string, content: string): string => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
      /* Standalone & Offline-Safe Stylesheet (Works 100% without internet or CDNs) */
      *, *::before, *::after {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
      }

      body {
        background-color: #f1f5f9;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        color: #1e293b;
        line-height: 1.5;
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
      }

      .max-w-3xl {
        max-width: 52rem;
        margin-left: auto;
        margin-right: auto;
        padding: 1.5rem 1rem;
      }
      @media (min-width: 640px) {
        .max-w-3xl {
          padding: 2.5rem 1.5rem;
        }
      }

      /* Header */
      header {
        text-align: center;
        margin-bottom: 2rem;
      }
      header h1, .text-4xl {
        font-size: 1.875rem;
        line-height: 2.25rem;
        font-weight: 700;
        color: #0f172a;
      }
      @media (min-width: 640px) {
        header h1, .text-4xl {
          font-size: 2.25rem;
          line-height: 2.5rem;
        }
      }
      header p, .text-slate-600 {
        color: #475569;
        font-size: 0.95rem;
        margin-top: 0.5rem;
      }

      /* Main Container Card */
      main {
        background-color: #ffffff;
        border-radius: 1rem;
        box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.06), 0 8px 10px -6px rgba(0, 0, 0, 0.04);
        border: 1px solid #e2e8f0;
        padding: 1.5rem;
      }
      @media (min-width: 640px) {
        main {
          padding: 2rem;
        }
      }

      /* Flex and Grid Utilities */
      .flex { display: flex; }
      .justify-between { justify-content: space-between; }
      .items-center { align-items: center; }
      .justify-end { justify-content: flex-end; }
      .flex-col { flex-direction: column; }
      .gap-1 { gap: 0.25rem; }
      .gap-2 { gap: 0.5rem; }
      .gap-4 { gap: 1rem; }
      .mb-4 { margin-bottom: 1rem; }
      .mb-6 { margin-bottom: 1.5rem; }
      .mb-8 { margin-bottom: 2rem; }
      .mt-0\.5, .mt-0_5 { margin-top: 0.125rem; }
      .mt-1 { margin-top: 0.25rem; }
      .mt-2 { margin-top: 0.5rem; }
      .mt-8 { margin-top: 2rem; }
      .text-center { text-align: center; }

      /* Typography */
      h2, .text-2xl {
        font-size: 1.35rem;
        font-weight: 700;
        color: #1e293b;
      }
      h3 {
        font-size: 1.1rem;
        font-weight: 600;
        color: #1e293b;
      }
      .text-xs { font-size: 0.75rem; }
      .text-sm { font-size: 0.875rem; }
      .text-slate-400 { color: #94a3b8; }
      .text-slate-500 { color: #64748b; }
      .text-slate-600 { color: #475569; }
      .text-slate-700 { color: #334155; }
      .text-slate-800 { color: #1e293b; }
      .font-medium { font-weight: 500; }
      .font-semibold { font-weight: 600; }
      .font-bold { font-weight: 700; }
      .underline { text-decoration: underline; }
      .uppercase { text-transform: uppercase; }
      .italic { font-style: italic; }

      /* Action Buttons */
      button {
        font-family: inherit;
        outline: none;
      }
      .undo-merge-btn {
        display: inline-flex;
        align-items: center;
        font-size: 0.8125rem;
        font-weight: 600;
        padding: 0.35rem 0.85rem;
        border-radius: 0.5rem;
        border: none;
        background-color: #facc15;
        color: #713f12;
        cursor: pointer;
        transition: background-color 0.2s;
      }
      .undo-merge-btn:hover {
        background-color: #eab308;
      }
      .merge-toggle-btn, .reorder-toggle-btn, .copy-all-btn, #copy-all-transcripts {
        display: inline-flex;
        align-items: center;
        font-size: 0.8125rem;
        font-weight: 600;
        padding: 0.35rem 0.85rem;
        border-radius: 0.5rem;
        border: none;
        background-color: #e2e8f0;
        color: #334155;
        cursor: pointer;
        transition: all 0.2s;
      }
      .merge-toggle-btn:hover, .reorder-toggle-btn:hover, .copy-all-btn:hover, #copy-all-transcripts:hover {
        background-color: #cbd5e1;
        color: #0f172a;
      }
      .hidden {
        display: none !important;
      }

      /* Findings List & Items */
      .space-y-3 > * + * {
        margin-top: 0.75rem;
      }
      .space-y-4 > * + * {
        margin-top: 1rem;
      }

      .finding-item {
        position: relative;
        padding: 0.85rem 2.75rem 0.85rem 2.75rem;
        background-color: #f8fafc;
        border-left: 4px solid #3b82f6;
        border-top: 1px solid #f1f5f9;
        border-right: 1px solid #f1f5f9;
        border-bottom: 1px solid #f1f5f9;
        border-radius: 0 0.6rem 0.6rem 0;
        transition: all 0.2s ease-in-out;
        cursor: pointer;
        user-select: text;
      }
      .finding-item:hover {
        background-color: #f1f5f9;
        border-left-color: #2563eb;
      }
      .finding-item.selected {
        background-color: #dbeafe !important;
        border-left-color: #2563eb !important;
        box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.08), 0 2px 4px -2px rgba(0, 0, 0, 0.06);
      }

      /* Selection Checkbox Handle */
      .finding-item .selection-handle {
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        width: 2.5rem;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
      }
      .finding-item .selection-handle div {
        width: 1.15rem;
        height: 1.15rem;
        border-radius: 9999px;
        border: 2px solid #94a3b8;
        background-color: #ffffff;
        transition: all 0.2s ease-in-out;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .finding-item:hover .selection-handle div {
        border-color: #3b82f6;
      }
      .finding-item.selected .selection-handle div,
      .selection-handle div.bg-blue-600 {
        background-color: #2563eb !important;
        border-color: #2563eb !important;
      }
      .finding-item.selected .selection-handle div::after,
      .selection-handle div.bg-blue-600::after {
        content: '✓';
        color: #ffffff;
        font-size: 10px;
        font-weight: 700;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      /* Drag handle / Reorder & Merge */
      .finding-item .drag-handle-container {
        display: none;
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        width: 2.5rem;
        align-items: center;
        justify-content: center;
      }
      .reorder-mode .finding-item .selection-handle,
      .merge-mode .finding-item .selection-handle,
      .reorder-mode .finding-item .edit-btn-container,
      .merge-mode .finding-item .edit-btn-container {
        display: none !important;
      }
      .reorder-mode .finding-item .drag-handle-container,
      .merge-mode .finding-item .drag-handle-container {
        display: flex !important;
      }
      .reorder-handle, .merge-handle {
        display: none;
        width: 1.25rem;
        height: 1.25rem;
      }
      .reorder-mode .reorder-handle {
        display: block;
        color: #94a3b8;
      }
      .merge-mode .merge-handle {
        display: block;
        color: #64748b;
      }
      .reorder-mode .finding-item { cursor: grab; }
      .merge-mode .finding-item { cursor: copy; }
      .finding-item.dragging { opacity: 0.5; background: #e2e8f0; }
      .finding-item.drag-over { border: 2px dashed #22c55e !important; }

      /* Finding Text Content */
      .finding-text {
        font-size: 0.95rem;
        color: #334155;
        line-height: 1.6;
        word-break: break-word;
      }
      .finding-text ul {
        list-style-type: disc;
        margin-top: 0.35rem;
        padding-left: 1.25rem;
      }
      .finding-text li {
        margin-bottom: 0.25rem;
      }
      .finding-text span.block {
        display: block;
        margin-top: 0.2rem;
      }

      /* Edit Button Container */
      .edit-btn-container {
        position: absolute;
        right: 0.5rem;
        top: 50%;
        transform: translateY(-50%);
        display: flex;
        align-items: center;
        gap: 0.25rem;
        opacity: 0;
        transition: opacity 0.2s ease-in-out;
        background-color: #f1f5f9;
        padding: 0.25rem;
        border-radius: 0.375rem;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
      }
      .finding-item:hover .edit-btn-container {
        opacity: 1;
      }
      .edit-btn {
        background: none;
        border: none;
        padding: 0.25rem;
        color: #64748b;
        border-radius: 9999px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.15s;
      }
      .edit-btn:hover {
        color: #2563eb;
        background-color: #e2e8f0;
      }
      .edit-btn svg {
        width: 1.25rem;
        height: 1.25rem;
      }

      /* Textarea & Editing */
      textarea {
        width: 100%;
        padding: 0.5rem 0.75rem;
        border: 1px solid #cbd5e1;
        border-radius: 0.5rem;
        font-family: inherit;
        font-size: 0.95rem;
        font-weight: 600;
        color: #334155;
        line-height: 1.5;
        resize: vertical;
        outline: none;
        transition: border-color 0.2s, box-shadow 0.2s;
      }
      textarea:focus {
        border-color: #2563eb;
        box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.2);
      }
      .edit-cancel {
        font-size: 0.8125rem;
        font-weight: 600;
        padding: 0.35rem 0.85rem;
        border-radius: 0.5rem;
        border: none;
        background-color: #e2e8f0;
        color: #334155;
        cursor: pointer;
      }
      .edit-cancel:hover {
        background-color: #cbd5e1;
      }
      .edit-save {
        font-size: 0.8125rem;
        font-weight: 600;
        padding: 0.35rem 0.85rem;
        border-radius: 0.5rem;
        border: none;
        background-color: #2563eb;
        color: #ffffff;
        cursor: pointer;
      }
      .edit-save:hover {
        background-color: #1d4ed8;
      }

      /* Notification Toast */
      #notification {
        position: fixed;
        bottom: 1.25rem;
        right: 1.25rem;
        background-color: #0f172a;
        color: #ffffff;
        font-size: 0.875rem;
        font-weight: 600;
        padding: 0.65rem 1.15rem;
        border-radius: 0.5rem;
        box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.2);
        z-index: 9999;
        transition: all 0.3s ease-in-out;
        pointer-events: none;
      }
      .opacity-0 {
        opacity: 0;
        transform: translateY(0.5rem);
      }

      /* Multi-select bottom floating banner */
      #multi-select-banner {
        position: fixed;
        bottom: 1.25rem;
        left: 50%;
        transform: translateX(-50%);
        z-index: 9000;
        background-color: #1e293b;
        color: #ffffff;
        border-radius: 9999px;
        box-shadow: 0 10px 25px rgba(0, 0, 0, 0.3);
        display: flex;
        align-items: center;
        gap: 1rem;
        padding: 0.5rem 1.25rem;
        transition: all 0.3s ease-in-out;
      }
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border-width: 0;
      }
      .relative { position: relative; }
      .toggle-track {
        width: 3rem;
        height: 1.5rem;
        background-color: #475569;
        border-radius: 9999px;
        transition: background-color 0.2s;
        cursor: pointer;
      }
      .toggle-thumb {
        position: absolute;
        left: 0.25rem;
        top: 0.25rem;
        background-color: #ffffff;
        width: 1rem;
        height: 1rem;
        border-radius: 9999px;
        transition: transform 0.2s;
        cursor: pointer;
      }
      #multi-select-toggle:checked ~ .toggle-track {
        background-color: #2563eb !important;
      }
      #multi-select-toggle:checked ~ .toggle-thumb {
        transform: translateX(1.5rem) !important;
      }

      /* Batch cards */
      .border {
        border: 1px solid #e2e8f0;
      }
      .rounded-lg {
        border-radius: 0.75rem;
      }
      .p-4 {
        padding: 1rem;
      }
      .bg-slate-100 {
        background-color: #f8fafc;
      }
      .bg-white {
        background-color: #ffffff;
      }

      /* Tables */
      table {
        width: 100%;
        border-collapse: collapse;
        margin: 1rem 0;
        font-size: 0.875rem;
      }
      th, td {
        border: 1px solid #cbd5e1;
        padding: 0.5rem 0.75rem;
        text-align: left;
        vertical-align: top;
      }
      th {
        background-color: #f1f5f9;
        font-weight: 700;
        color: #0f172a;
      }
      tr:nth-child(even) td {
        background-color: #f8fafc;
      }

      /* Footer */
      footer {
        text-align: center;
        margin-top: 2rem;
        font-size: 0.875rem;
        color: #64748b;
      }
    </style>
</head>
<body class="bg-slate-100 font-sans">
    <div class="max-w-3xl mx-auto p-4 sm:p-8">
        <header class="text-center mb-8">
            <h1 class="text-4xl font-bold text-slate-800">${title}</h1>
            <p class="text-slate-600 mt-2">This is a standalone report. AI and audio features are not available.</p>
        </header>
        <main class="bg-white rounded-2xl shadow-xl p-4 sm:p-8">
            ${content}
        </main>
        <footer class="text-center mt-8 text-sm text-slate-500">
          <p>Generated from ☯️RADDOC's Dictation app</p>
        </footer>
    </div>
    
    <div id="notification" class="fixed bottom-4 right-4 bg-slate-800 text-white text-sm font-bold py-2 px-4 rounded-lg shadow-lg z-50 transition-all duration-300 ease-in-out opacity-0" role="alert"></div>

    <div id="multi-select-banner" class="fixed bottom-5 left-1/2 -translate-x-1/2 z-40 bg-slate-800 text-white rounded-full shadow-lg flex items-center gap-4 px-5 py-2 transition-all duration-300 ease-in-out">
        <p class="text-sm font-semibold">Multi-select Mode</p>
        <label for="multi-select-toggle" class="flex items-center cursor-pointer select-none">
            <span class="mr-2 text-sm font-medium text-slate-300">OFF</span>
            <div class="relative">
                <input 
                    type="checkbox" 
                    id="multi-select-toggle" 
                    class="sr-only peer"
                />
                <div class="toggle-track w-12 h-6 bg-slate-600 rounded-full peer-checked:bg-blue-600 transition-colors cursor-pointer"></div>
                <div class="toggle-thumb absolute left-1 top-1 bg-white w-4 h-4 rounded-full transition-transform peer-checked:translate-x-6 cursor-pointer"></div>
            </div>
            <span class="ml-2 text-sm font-medium">ON</span>
        </label>
    </div>

    <script type="text/javascript">
      ${getEmbeddedScript()}
    </script>
</body>
</html>
`;

const renderFindingsList = (findings: string[], batchId: string): string => {
    const validFindings = (findings || []).filter(f => f && f.trim() !== '');
    if (!validFindings || validFindings.length === 0) {
        return '<p class="text-slate-500">No findings were transcribed.</p>';
    }
    return `
        <div class="space-y-3" data-batch-findings-container-id="${batchId}">
            ${validFindings.map((finding, index) => {
                const isBold = finding.includes('BOLD::');
                const cleanFinding = finding.replace(/BOLD::/g, '');
                const isTitle = cleanFinding.trim() === 'C.T.SCAN OF BRAIN (PLAIN)';

                const parts = cleanFinding.split('###');
                const isStructured = parts.length > 1;
                const title = parts[0];
                const points = parts.slice(1);
                
                const isClinicalProfile = /^clinical\s*(profile|history):/i.test(cleanFinding.replace(/^[*_\s]+/, ''));
                const isImpression = isStructured && title.trim().toUpperCase() === 'IMPRESSION:';
                const isItalic = isClinicalProfile || (!isStructured && cleanFinding.startsWith('*') && cleanFinding.endsWith('*'));
                const textToDisplay = isClinicalProfile 
                    ? cleanClinicalProfileText(cleanFinding) 
                    : isItalic 
                    ? cleanFinding.slice(1, -1) 
                    : title;
                const isTable = cleanFinding.includes('<table') || isTableRowFinding(cleanFinding) || parts.every(p => p.includes('|'));
                
                let findingContent;
                let textContainerClasses = '';

                if (isTable) {
                    if (cleanFinding.includes('<table')) {
                        findingContent = cleanFinding;
                    } else {
                        findingContent = parseMarkdownTable(parts) || cleanFinding;
                    }
                } else if (isTitle) {
                    findingContent = cleanFinding;
                    textContainerClasses = 'text-center font-bold underline';
                } else if (isClinicalProfile) {
                    findingContent = cleanClinicalProfileText(cleanFinding);
                    textContainerClasses = 'italic';
                } else if (isImpression) {
                    findingContent = `
                        <strong class="underline uppercase">${title}</strong>
                        <ul class="list-disc list-inside pl-4 mt-1">
                            ${points.map(p => `<li class="font-bold">${p}</li>`).join('')}
                        </ul>
                    `;
                } else if (isStructured) {
                    findingContent = `<strong class="font-bold">${title}</strong>${points.map(p => `<span class="block font-semibold">${p}</span>`).join('')}`;
                } else {
                    findingContent = textToDisplay;
                    textContainerClasses = isItalic ? 'italic' : isBold ? 'font-bold' : '';
                }

                return `
                <div
                    class="finding-item relative group p-3 pl-10 border-l-4 rounded-r-lg transition-all duration-200 bg-slate-50 border-blue-500"
                    data-batch-id="${batchId}"
                    data-finding-index="${index}"
                    data-finding-raw="${encodeURIComponent(finding)}"
                    draggable="true"
                >
                    <div
                        class="selection-handle absolute left-0 top-0 bottom-0 w-8 flex items-center justify-center cursor-pointer"
                        role="checkbox"
                        aria-label="Toggle selection for this finding"
                    >
                        <div class="w-4 h-4 rounded-full border-2 transition-colors border-slate-400 bg-white group-hover:border-blue-500"></div>
                    </div>

                    <div class="drag-handle-container absolute left-0 top-0 bottom-0 w-8 hidden items-center justify-center" aria-hidden="true">
                        <svg class="reorder-handle w-5 h-5 text-slate-400" viewBox="0 0 24 24" fill="currentColor">
                            <circle cx="10" cy="6" r="1.5" /><circle cx="14" cy="6" r="1.5" /><circle cx="10" cy="12" r="1.5" /><circle cx="14" cy="12" r="1.5" /><circle cx="10" cy="18" r="1.5" /><circle cx="14" cy="18" r="1.5" />
                        </svg>
                        <svg class="merge-handle w-5 h-5 text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M8 6h10a2 2 0 0 1 2 2v10" /><path d="M4 18V8a2 2 0 0 1 2-2h2" /><polyline points="12 18 8 14 12 10" />
                        </svg>
                    </div>

                    <div class="finding-text text-slate-700 cursor-pointer ${textContainerClasses}">${findingContent}</div>
                    <div class="edit-btn-container absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity bg-slate-100 p-1 rounded-md shadow-sm">
                        <button class="edit-btn p-1 text-slate-600 hover:text-blue-600 rounded-full hover:bg-slate-200 transition-colors" aria-label="Edit text">
                            <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" viewBox="0 0 20 20" fill="currentColor"><path d="M17.414 2.586a2 2 0 00-2.828 0L7 10.172V13h2.828l7.586-7.586a2 2 0 000-2.828z" /><path fill-rule="evenodd" d="M2 6a2 2 0 012-2h4a1 1 0 010 2H4v10h10v-4a1 1 0 112 0v4a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" clip-rule="evenodd" /></svg>
                        </button>
                    </div>
                </div>
            `}).join('')}
        </div>
    `;
};

export const generateSingleDictationHTML = (findings: string[], timestamp?: number | Date): string => {
    const formattedDate = timestamp 
        ? new Date(timestamp).toLocaleString(undefined, { 
            weekday: 'short', 
            year: 'numeric', 
            month: 'short', 
            day: 'numeric', 
            hour: '2-digit', 
            minute: '2-digit', 
            second: '2-digit' 
          })
        : null;

    const content = `
        <div class="flex justify-between items-center mb-4">
            <div>
                <h2 class="text-2xl font-bold text-slate-800">Corrected Findings</h2>
                ${formattedDate ? `<p class="text-xs text-slate-500 font-medium mt-0.5">Dictated: ${formattedDate}</p>` : ''}
            </div>
            ${findings.length > 0 ? `
            <div class="flex items-center gap-2">
                <button class="undo-merge-btn hidden text-sm font-semibold py-1 px-3 rounded-lg bg-yellow-400 text-yellow-900 hover:bg-yellow-500 transition-colors" data-batch-id="single">Undo Merge</button>
                <button class="merge-toggle-btn text-sm font-semibold py-1 px-3 rounded-lg transition-colors bg-slate-200 text-slate-700 hover:bg-slate-300" data-batch-id="single">Merge</button>
                <button class="reorder-toggle-btn text-sm font-semibold py-1 px-3 rounded-lg transition-colors bg-slate-200 text-slate-700 hover:bg-slate-300" data-batch-id="single">Reorder</button>
                <button class="copy-all-btn text-sm font-semibold py-1 px-3 rounded-lg transition-colors bg-slate-200 text-slate-700 hover:bg-slate-300" data-batch-id="single">Copy All</button>
            </div>
            ` : ''}
        </div>
        
        <p class="text-slate-600 mb-6">Click any finding to copy it. Use the buttons above for advanced editing, or use Multi-select Mode at the bottom to copy multiple findings.</p>

        ${renderFindingsList(findings, 'single')}
    `;
    return getHTMLTemplate('Radiology Dictation Report', content);
};

export const generateBatchDictationHTML = (batches: ReportBatch[], timestamp?: number | Date): string => {
    const processedBatches = batches.filter(b => b.findings && b.findings.length > 0);
    const formattedDate = timestamp 
        ? new Date(timestamp).toLocaleString(undefined, { 
            weekday: 'short', 
            year: 'numeric', 
            month: 'short', 
            day: 'numeric', 
            hour: '2-digit', 
            minute: '2-digit', 
            second: '2-digit' 
          })
        : null;

    const content = `
        <div class="flex justify-between items-center mb-4">
            <div>
                <h2 class="text-2xl font-bold text-slate-800">Processed Transcripts</h2>
                ${formattedDate ? `<p class="text-xs text-slate-500 font-medium mt-0.5">Batch Processed: ${formattedDate}</p>` : ''}
            </div>
            ${processedBatches.length > 0 ? `
            <button
                id="copy-all-transcripts"
                class="text-sm font-semibold py-1 px-3 rounded-lg transition-colors bg-slate-200 text-slate-700 hover:bg-slate-300"
            >
                Copy All Transcripts
            </button>
            ` : ''}
        </div>

        <div class="space-y-4">
        ${batches.map(batch => batch.findings ? `
            <div class="border rounded-lg" data-batch-container-id="${batch.id}">
                <div class="p-4 bg-slate-100">
                    <h3 class="font-semibold">${batch.name}</h3>
                </div>
                <div class="p-4 bg-white">
                    <div class="flex justify-end items-center mb-4 gap-2">
                         <button class="undo-merge-btn hidden text-sm font-semibold py-1 px-3 rounded-lg bg-yellow-400 text-yellow-900 hover:bg-yellow-500 transition-colors" data-batch-id="${batch.id}">Undo Merge</button>
                         <button class="merge-toggle-btn text-sm font-semibold py-1 px-3 rounded-lg transition-colors bg-slate-200 text-slate-700 hover:bg-slate-300" data-batch-id="${batch.id}">Merge</button>
                         <button class="reorder-toggle-btn text-sm font-semibold py-1 px-3 rounded-lg transition-colors bg-slate-200 text-slate-700 hover:bg-slate-300" data-batch-id="${batch.id}">Reorder</button>
                         <button class="copy-all-btn text-sm font-semibold py-1 px-3 rounded-lg transition-colors bg-slate-200 text-slate-700 hover:bg-slate-300" data-batch-id="${batch.id}">Copy All</button>
                    </div>
                    ${renderFindingsList(batch.findings, batch.id)}
                </div>
            </div>
        ` : '').join('')}
        </div>
    `;
    return getHTMLTemplate('Batch Dictation Report', content);
};
