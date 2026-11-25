import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findBuiltinTemplates,
  detectAndExtractTemplate,
  extractSpokenTemplateDirective,
} from '../services/geminiService';
import {
  normalizeTemplateTagId,
  extractTemplateTagIds,
  canonicalizeTemplateIdToken,
  mergeTemplateImages,
  buildCombinedTemplateBundle,
} from '../services/upcomingTemplateService';
import { findTemplateByIdOrNumber, getTemplateDisplayId } from '../services/templateStorage';
import { getBuiltInTemplateNumber, resolveBuiltInTemplateByNumber } from '../services/builtInTemplates';
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
