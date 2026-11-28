import test from 'node:test';
import assert from 'node:assert/strict';
import { processAudio } from '../services/geminiService';
import {
  findBuiltinTemplates,
  detectAndExtractTemplate,
  extractSpokenTemplateDirective,
  normalizeTemplateTagId,
  extractTemplateTagIds,
  canonicalizeTemplateIdToken,
  mergeTemplateImages,
  buildCombinedTemplateBundle,
  findTemplateByIdOrNumber,
  getTemplateDisplayId,
  getBuiltInTemplateNumber,
  resolveBuiltInTemplateByNumber,
  splitMultiPatientFindings,
  joinMultiPatientFindings,
} from '../services/templateHandling';
import { findingsToRichHtml, generateRtfDocument, isReportTitle } from '../services/docxService';
import { executeAutonomousPlan } from '../services/autonomousAgentService';
import { resetApiKeyHealthState, setUserApiKeys } from '../services/apiKeyService';
import { REPORT_TEMPLATES } from '../constants';

test('normalizeTemplateTagId and extractTemplateTagIds handle built-in and custom IDs uniformly', () => {
  assert.equal(normalizeTemplateTagId({ id: 'tpl_001', name: 'A' }), 'tpl_001');
  assert.equal(normalizeTemplateTagId({ id: 'builtin_tpl_012', templateId: '12', name: 'B' }), 'tpl_012');
  assert.equal(normalizeTemplateTagId({ id: 'custom_1700', templateId: 'c1', isCustom: true, name: 'C' }), 'C1');

  assert.deepEqual(
    extractTemplateTagIds('[TEMPLATE_ID: 1, tpl_015, c2, C2, builtin_tpl_003] Use combined'),
    ['tpl_001', 'tpl_015', 'C2', 'tpl_003']
  );
  assert.deepEqual(extractTemplateTagIds('No template tag here'), []);
});

test('mergeTemplateImages deduplicates identical image payloads while preserving order', () => {
  const merged = mergeTemplateImages(
    [{ data: 'aaa', mimeType: 'image/png' }, { data: 'bbb', mimeType: 'image/jpeg' }],
    [{ data: 'bbb', mimeType: 'image/jpeg' }, { data: 'ccc', mimeType: 'image/png' }]
  );
  assert.deepEqual(merged, [
    { data: 'aaa', mimeType: 'image/png' },
    { data: 'bbb', mimeType: 'image/jpeg' },
    { data: 'ccc', mimeType: 'image/png' },
  ]);
});

test('findBuiltinTemplates resolves both padded tpl_XXX and bare numeric IDs', () => {
  const firstTwo = REPORT_TEMPLATES.slice(0, 2);
  const firstNum = String(parseInt(firstTwo[0].id.replace('tpl_', ''), 10));
  const secondNum = String(parseInt(firstTwo[1].id.replace('tpl_', ''), 10));

  const byBareNumbers = findBuiltinTemplates(`[TEMPLATE_ID: ${firstNum}, ${secondNum}] Use combined report templates`);
  assert.equal(byBareNumbers.length, 2);
  assert.equal(byBareNumbers[0].id, firstTwo[0].id);
  assert.equal(byBareNumbers[1].id, firstTwo[1].id);

  const byMixed = findBuiltinTemplates(`[TEMPLATE_ID: C1, ${firstTwo[1].id}] Use combined`);
  assert.equal(byMixed.length, 1);
  assert.equal(byMixed[0].id, firstTwo[1].id);
});

test('buildCombinedTemplateBundle constructs combined bundle with custom images & section blocks', async () => {
  const customA = {
    id: 'custom_101',
    templateId: 'C1',
    name: 'Custom Pelvis Layout',
    isCustom: true,
    lines: ['PELVIS MRI', 'Uterus unremarkable.', 'IMPRESSION:###Normal pelvis.'],
    images: [{ data: 'imgA', mimeType: 'image/png' }],
  };
  const customB = {
    id: 'custom_102',
    templateId: 'C2',
    name: 'Custom Hip Supplement',
    isCustom: true,
    lines: ['RIGHT HIP MRI', 'No labral tear.', 'IMPRESSION:###Normal right hip.'],
    images: [{ data: 'imgB', mimeType: 'image/png' }, { data: 'imgA', mimeType: 'image/png' }],
  };

  const bundle = await buildCombinedTemplateBundle([customA, customB]);
  assert.equal(bundle.name, 'Custom Pelvis Layout + Custom Hip Supplement');
  assert.match(bundle.promptText, /^\[TEMPLATE_ID: C1, C2\]/);
  assert.match(bundle.promptText, /Use combined report templates:/i);
  assert.ok(bundle.docxData?.extractedText.includes('=== TEMPLATE: Custom Pelvis Layout ==='));
  assert.ok(bundle.docxData?.extractedText.includes('=== TEMPLATE: Custom Hip Supplement ==='));
  assert.equal(bundle.images.length, 2);
});

test('detectAndExtractTemplate handles mixed custom + built-in combinations and custom image templates', () => {
  const builtin = REPORT_TEMPLATES[0];
  const promptMixed = `[TEMPLATE_ID: C1, ${builtin.id}] Use combined report templates: "Custom Neck" and "${builtin.name}". Merge cleanly.`;
  const docxMixed = {
    name: `Custom Neck + ${builtin.name}.docx`,
    size: 1200,
    extractedText: `=== TEMPLATE: Custom Neck ===\nThyroid normal.\n\n=== TEMPLATE: ${builtin.name} ===\n${builtin.content}`,
  };

  const detectedMixed = detectAndExtractTemplate(promptMixed, null, docxMixed);
  assert.equal(detectedMixed.isTemplateMode, true);
  assert.equal(detectedMixed.templateName, `Custom Neck + ${builtin.name}`);
  assert.ok(detectedMixed.templateContextPrompt.includes('ACTIVE COMBINED RADIOLOGY REPORT TEMPLATES (2 TEMPLATES COMBINED)'));

  const singleCustomImg = detectAndExtractTemplate(
    '[TEMPLATE_ID: C1] Merged with template: My Custom Ultrasound.',
    [{ data: 'base64img', mimeType: 'image/png' }],
    null
  );
  assert.equal(singleCustomImg.isTemplateMode, true);
  assert.equal(singleCustomImg.templateName, 'My Custom Ultrasound');
  assert.equal(singleCustomImg.templateType, 'image');
});

test('extractSpokenTemplateDirective parses single, multi-ID, spoken-word, C-ID, and avoids clinical false positives', () => {
  // Single braced
  const single = extractSpokenTemplateDirective(['{template id 5}', 'Liver is enlarged.']);
  assert.deepEqual(single.templateIds, ['5']);
  assert.equal(single.templateId, '5');
  assert.deepEqual(single.cleanedFindings, ['Liver is enlarged.']);

  // Multiple braced on same or separate lines
  const multiBraced = extractSpokenTemplateDirective(['{template id 5, 15}', '{add template id C1}', 'Mild hepatomegaly.']);
  assert.deepEqual(multiBraced.templateIds, ['5', '15', 'C1']);
  assert.deepEqual(multiBraced.cleanedFindings, ['Mild hepatomegaly.']);

  // Multiple unbraced inline with clinical observation preserved
  const multiUnbraced = extractSpokenTemplateDirective([
    'add template id 5 and template id 15 liver shows a simple cyst',
  ]);
  assert.deepEqual(multiUnbraced.templateIds, ['5', '15']);
  assert.equal(multiUnbraced.mode, 'add');
  assert.deepEqual(multiUnbraced.cleanedFindings, ['liver shows a simple cyst']);

  // Spoken words + C-code + phonetic see
  const spokenMix = extractSpokenTemplateDirective([
    'combine template id see two, twelve and forty two',
    'Unremarkable pancreas.',
  ]);
  assert.deepEqual(spokenMix.templateIds, ['C2', 'twelve', 'forty two']);
  assert.deepEqual(spokenMix.cleanedFindings, ['Unremarkable pancreas.']);

  // Replace mode command
  const replaceDir = extractSpokenTemplateDirective(['switch to template id 8 instead']);
  assert.equal(replaceDir.mode, 'replace');
  assert.deepEqual(replaceDir.templateIds, ['8']);

  // Negative checks (no false positives on vertebral levels, measurements, vague template names)
  const noMatch = extractSpokenTemplateDirective([
    'C5-C6 disc osteophyte complex causing spinal canal narrowing.',
    '15 mm simple cortical cyst in the right kidney.',
    'Please add ct brain normal report without id.',
    'Please add 128 ml of intravenous contrast.',
  ]);
  assert.deepEqual(noMatch.templateIds, []);
  assert.equal(noMatch.templateId, null);
  assert.equal(noMatch.cleanedFindings.length, 4);
});

test('supplemental add_XXX template IDs (e.g. add_128) resolve across canonicalization, spoken extraction, lookup, and prompt tags', async () => {
  // 1. Canonicalization & [TEMPLATE_ID: ...] parsing
  assert.equal(canonicalizeTemplateIdToken('add_128'), 'tpl_add_128');
  assert.equal(canonicalizeTemplateIdToken('add 128'), 'tpl_add_128');
  assert.equal(canonicalizeTemplateIdToken('add underscore 5'), 'tpl_add_005');
  assert.deepEqual(
    extractTemplateTagIds('[TEMPLATE_ID: 1, add_128, add 45] Use combined'),
    ['tpl_001', 'tpl_add_128', 'tpl_add_045']
  );

  // 2. findBuiltinTemplates with add_128 and spaced [TEMPLATE_ID: add 128]
  const builtinMatches = findBuiltinTemplates('[TEMPLATE_ID: tpl_001, add_128] Use combined');
  assert.equal(builtinMatches.length, 2);
  assert.equal(builtinMatches[0].id, 'tpl_001');
  assert.equal(builtinMatches[1].id, 'tpl_add_128');

  const spacedTagMatch = findBuiltinTemplates('[TEMPLATE_ID: add 128]');
  assert.equal(spacedTagMatch.length, 1);
  assert.equal(spacedTagMatch[0].id, 'tpl_add_128');

  // 3. findTemplateByIdOrNumber across spoken and typed forms of add_128 and add_005
  for (const variant of [
    'add_128',
    'add 128',
    'add underscore 128',
    'tpl_add_128',
    'add one twenty eight',
    'add one hundred and twenty eight',
  ]) {
    const resolved = await findTemplateByIdOrNumber(variant);
    assert.ok(resolved, `Expected findTemplateByIdOrNumber("${variant}") to resolve`);
    assert.equal(resolved!.id, 'tpl_add_128');
  }
  const addFive = await findTemplateByIdOrNumber('add 5');
  assert.ok(addFive);
  assert.equal(addFive!.id, 'tpl_add_005');

  // 4. extractSpokenTemplateDirective for spoken & braced add_128 variants
  assert.deepEqual(
    extractSpokenTemplateDirective(['{template id add_128}', 'Normal study.']).templateIds,
    ['add_128']
  );
  assert.deepEqual(
    extractSpokenTemplateDirective(['{add_128}', 'Normal study.']).templateIds,
    ['add_128']
  );
  assert.deepEqual(
    extractSpokenTemplateDirective(['add template id add 128', 'Normal study.']).templateIds,
    ['add_128']
  );
  assert.deepEqual(
    extractSpokenTemplateDirective(['template id add underscore 128 liver is normal']).templateIds,
    ['add_128']
  );
  assert.deepEqual(
    extractSpokenTemplateDirective(['template id add one twenty eight']).templateIds,
    ['add_128']
  );
  const combinedSpoken = extractSpokenTemplateDirective([
    'use add_128 and template id 1 mild fatty liver',
  ]);
  assert.deepEqual(combinedSpoken.templateIds, ['add_128', '1']);
  assert.deepEqual(combinedSpoken.cleanedFindings, ['mild fatty liver']);
});

test('all 300 built-in templates expose easy sequential IDs 1-300 (73-300 for supplemental) while preserving legacy add_XXX support', async () => {
  assert.equal(getBuiltInTemplateNumber('tpl_001'), 1);
  assert.equal(getBuiltInTemplateNumber('tpl_072'), 72);
  assert.equal(getBuiltInTemplateNumber('tpl_add_001'), 73);
  assert.equal(getBuiltInTemplateNumber('tpl_add_128'), 200);
  assert.equal(getBuiltInTemplateNumber('tpl_add_228'), 300);

  assert.equal(resolveBuiltInTemplateByNumber(1)?.id, 'tpl_001');
  assert.equal(resolveBuiltInTemplateByNumber(72)?.id, 'tpl_072');
  assert.equal(resolveBuiltInTemplateByNumber(73)?.id, 'tpl_add_001');
  assert.equal(resolveBuiltInTemplateByNumber(200)?.id, 'tpl_add_128');
  assert.equal(resolveBuiltInTemplateByNumber(300)?.id, 'tpl_add_228');

  // Display badge never exposes awkward "add_128"
  assert.equal(getTemplateDisplayId({ id: 'builtin_tpl_add_128', isBuiltIn: true }), '200');
  assert.equal(getTemplateDisplayId({ id: 'tpl_add_128', templateId: 'add_128' }), '200');
  assert.equal(getTemplateDisplayId({ id: 'cust_2', templateId: 'C2' }), 'C2');

  // Canonicalization & prompt tags map "200" cleanly to tpl_add_128
  assert.equal(canonicalizeTemplateIdToken('200'), 'tpl_add_128');
  assert.equal(canonicalizeTemplateIdToken('73'), 'tpl_add_001');
  assert.deepEqual(extractTemplateTagIds('[TEMPLATE_ID: 1, 200]'), ['tpl_001', 'tpl_add_128']);
  const bySimpleNum = findBuiltinTemplates('[TEMPLATE_ID: 200]');
  assert.equal(bySimpleNum.length, 1);
  assert.equal(bySimpleNum[0].id, 'tpl_add_128');

  // Lookup by simple number or spoken number words resolves exact supplemental template
  const r200 = await findTemplateByIdOrNumber('200');
  assert.equal(r200?.id, 'tpl_add_128');
  assert.equal(r200?.templateId, '200');
  const rWord200 = await findTemplateByIdOrNumber('two hundred');
  assert.equal(rWord200?.id, 'tpl_add_128');
  const r300 = await findTemplateByIdOrNumber('300');
  assert.equal(r300?.id, 'tpl_add_228');

  // Spoken directive extraction with simple sequential IDs
  const spoken200 = extractSpokenTemplateDirective(['add template id 1 and template id 200']);
  assert.deepEqual(spoken200.templateIds, ['1', '200']);
});

test('splitMultiPatientFindings, docxService multi-patient headers, and RTF output preserve every patient exam title', () => {
  const combined = [
    '{template id 1}',
    'C.T.SCAN OF BRAIN (PLAIN)',
    '*Clinical Profile: H/o RTA.*',
    'BOLD::Right temporal contusion.',
    'IMPRESSION:###Right temporal contusion.',
    'BOLD::--- PATIENT 2: Jane Doe ---',
    '{template id 200}',
    'CHEST PA VIEW',
    '*Clinical Profile: Cough.*',
    'BOLD::Right lower zone consolidation.',
    'IMPRESSION:###Right lower lobe pneumonia.',
  ];

  const segments = splitMultiPatientFindings(combined);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].label, 'Patient 1');
  assert.deepEqual(segments[0].templateIds, ['1']);
  assert.equal(segments[0].findings[0], 'C.T.SCAN OF BRAIN (PLAIN)');
  assert.equal(segments[1].patientName, 'Jane Doe');
  assert.equal(segments[1].label, 'Patient 2: Jane Doe');
  assert.deepEqual(segments[1].templateIds, ['200']);
  assert.equal(segments[1].findings[0], 'CHEST PA VIEW');

  const rejoined = joinMultiPatientFindings(segments);
  const resplit = splitMultiPatientFindings(rejoined);
  assert.equal(resplit.length, 2);
  assert.equal(resplit[1].patientName, 'Jane Doe');
  assert.equal(resplit[1].findings[0], 'CHEST PA VIEW');

  // Verify docxService recognizes BOTH Patient 1 and Patient 2 exam titles as <h1>
  const flatNoDirectives = rejoined;
  assert.equal(isReportTitle(flatNoDirectives[0], 0, flatNoDirectives), true);
  const p2HeaderIdx = flatNoDirectives.findIndex((l) => l.includes('PATIENT 2'));
  assert.ok(p2HeaderIdx > 0);
  assert.equal(isReportTitle(flatNoDirectives[p2HeaderIdx + 1], p2HeaderIdx + 1, flatNoDirectives), true);

  const richHtml = findingsToRichHtml(flatNoDirectives);
  const h1Matches = richHtml.match(/<h1\b/gi) || [];
  assert.equal(h1Matches.length, 2);
  assert.ok(richHtml.includes('C.T.SCAN OF BRAIN (PLAIN)'));
  assert.ok(richHtml.includes('CHEST PA VIEW'));

  const rtf = generateRtfDocument(richHtml, 'Multi Patient Report');
  assert.ok(rtf.includes('C.T.SCAN OF BRAIN (PLAIN)'));
  assert.ok(rtf.includes('CHEST PA VIEW'));
});

test('processAudio splits 2+ patients, resolves per-patient spoken template IDs independently, and supports 1 manual template across 2 patients', async () => {
  const prevWindow = (globalThis as any).window;
  const prevFetch = globalThis.fetch;
  const localMap = new Map<string, string>();
  (globalThis as any).window = {
    localStorage: {
      getItem: (k: string) => localMap.get(k) ?? null,
      setItem: (k: string, v: string) => localMap.set(k, String(v)),
      removeItem: (k: string) => localMap.delete(k),
    },
    sessionStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    dispatchEvent: () => true,
  };

  try {
    resetApiKeyHealthState();
    setUserApiKeys(['AIzaSyMultiPatientTestKey01']);

    const mergePromptsSeen: string[] = [];
    let callIdx = 0;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      if (!String(_url).includes('generativelanguage.googleapis.com')) {
        return new Response('Not Found', { status: 404 });
      }
      callIdx++;
      const body = JSON.parse(String(init?.body || '{}'));
      const promptText = (body.contents?.[0]?.parts || []).map((p: any) => p.text || '').join('\n');

      // Initial audio pass returns 2 patients with distinct spoken template IDs
      if (callIdx === 1) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        findings: [
                          '{template id 1}',
                          'BOLD::Small right frontal contusion.',
                          'BOLD::--- PATIENT 2: Rahul ---',
                          '{template id 200}',
                          'BOLD::Bilateral maxillary sinusitis.',
                        ],
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 }
        );
      }

      mergePromptsSeen.push(promptText);
      const isPatient2 = promptText.includes('Bilateral maxillary sinusitis');
      const mergedFindings = isPatient2
        ? [
            REPORT_TEMPLATES[199].lines?.[0] || REPORT_TEMPLATES[199].name,
            '*Clinical Profile:*',
            'BOLD::Bilateral maxillary sinusitis.',
            'IMPRESSION:###Bilateral maxillary sinusitis.',
          ]
        : [
            REPORT_TEMPLATES[0].lines?.[0] || REPORT_TEMPLATES[0].name,
            '*Clinical Profile:*',
            'BOLD::Small right frontal contusion.',
            'IMPRESSION:###Right frontal contusion.',
          ];

      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ findings: mergedFindings }) }] } }],
        }),
        { status: 200 }
      );
    }) as any;

    const audioBlob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/ogg' });
    const result = await processAudio(audioBlob, 'gemini-4-hydrogen');

    assert.equal(Array.isArray(result), true);
    assert.equal(result.patientReports?.length, 2);
    assert.deepEqual(result.patientReports?.[0].templateIds, ['1']);
    assert.equal(result.patientReports?.[0].templateName, REPORT_TEMPLATES[0].name);
    assert.deepEqual(result.patientReports?.[1].templateIds, ['200']);
    assert.equal(result.patientReports?.[1].templateName, REPORT_TEMPLATES[199].name);
    assert.equal(result.patientReports?.[1].patientName, 'Rahul');
    assert.equal(result.some((l) => l.includes('{template id')), false);
    assert.equal(mergePromptsSeen.length, 2);

    // 2) Single manual template + 2 dictated patients merges each patient separately
    callIdx = 0;
    mergePromptsSeen.length = 0;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      if (!String(_url).includes('generativelanguage.googleapis.com')) {
        return new Response('Not Found', { status: 404 });
      }
      callIdx++;
      const body = JSON.parse(String(init?.body || '{}'));
      const promptText = (body.contents?.[0]?.parts || []).map((p: any) => p.text || '').join('\n');
      if (callIdx === 1) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        findings: [
                          REPORT_TEMPLATES[0].name,
                          'BOLD::Patient one normal brain.',
                          'BOLD::--- PATIENT 2 REPORT ---',
                          REPORT_TEMPLATES[0].name,
                          'BOLD::Patient two lacunar infarct.',
                        ],
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
      mergePromptsSeen.push(promptText);
      const isP2 = promptText.includes('lacunar infarct');
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      findings: [
                        REPORT_TEMPLATES[0].name,
                        '*Clinical Profile:*',
                        isP2 ? 'BOLD::Patient two lacunar infarct.' : 'Normal parenchyma.',
                        isP2 ? 'IMPRESSION:###Lacunar infarct.' : 'IMPRESSION:###Normal study.',
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 }
      );
    }) as any;

    const manualRes = await processAudio(
      audioBlob,
      'gemini-4-hydrogen',
      `[TEMPLATE_ID: ${REPORT_TEMPLATES[0].id}] Use "${REPORT_TEMPLATES[0].name}"`
    );
    assert.equal(manualRes.patientReports?.length, 2);
    assert.equal(mergePromptsSeen.length, 2);
    assert.ok(manualRes.patientReports?.[0].findings.some((l) => l.includes('Normal study')));
    assert.ok(manualRes.patientReports?.[1].findings.some((l) => l.includes('Lacunar infarct')));
  } finally {
    resetApiKeyHealthState();
    (globalThis as any).window = prevWindow;
    globalThis.fetch = prevFetch;
  }
});

test('executeAutonomousPlan resolves and strips per-patient spoken and structured templateIds independently', async () => {
  const prevWindow = (globalThis as any).window;
  const prevFetch = globalThis.fetch;
  const localMap = new Map<string, string>();
  (globalThis as any).window = {
    localStorage: {
      getItem: (k: string) => localMap.get(k) ?? null,
      setItem: (k: string, v: string) => localMap.set(k, String(v)),
      removeItem: (k: string) => localMap.delete(k),
    },
    sessionStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    dispatchEvent: () => true,
  };

  try {
    resetApiKeyHealthState();
    setUserApiKeys(['AIzaSyAutoPlanKey00001']);

    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}'));
      const promptText = (body.contents?.[0]?.parts || []).map((p: any) => p.text || '').join('\n');
      const isSecond = promptText.includes('Hepatic steatosis');
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      findings: [
                        isSecond ? REPORT_TEMPLATES[199].name : REPORT_TEMPLATES[0].name,
                        '*Clinical Profile:*',
                        isSecond ? 'BOLD::Hepatic steatosis.' : 'BOLD::Normal brain.',
                        isSecond ? 'IMPRESSION:###Fatty liver.' : 'IMPRESSION:###Normal brain.',
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 }
      );
    }) as any;

    let appliedBatches: any[] = [];
    const execRes = await executeAutonomousPlan(
      {
        summary: '2 patients with per-patient template IDs',
        totalPatientsDetected: 2,
        globalDirectives: { saveToDrive: false, downloadHtml: false, syncToWorkstation: false },
        patients: [
          {
            patientId: 'pt_1',
            patientName: 'Patient 1',
            targetMode: 'batch',
            templateIds: ['1'],
            findings: ['Normal brain.'],
          },
          {
            patientId: 'pt_2',
            patientName: 'Patient 2',
            targetMode: 'batch',
            findings: ['{template id 200}', 'Hepatic steatosis.'],
          },
        ],
      },
      {
        selectedModel: 'gemini-4-hydrogen',
        onApplyBatchReports: (batches) => {
          appliedBatches = batches;
        },
      }
    );

    assert.equal(execRes.success, true);
    assert.equal(execRes.batchPatients.length, 2);
    assert.equal(execRes.batchPatients[0].templateUsed, REPORT_TEMPLATES[0].name);
    assert.equal(execRes.batchPatients[1].templateUsed, REPORT_TEMPLATES[199].name);
    assert.equal(appliedBatches.length, 2);
    assert.equal(appliedBatches[1].findings.some((f: string) => f.includes('{template id')), false);
  } finally {
    resetApiKeyHealthState();
    (globalThis as any).window = prevWindow;
    globalThis.fetch = prevFetch;
  }
});
