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
  mergeTemplateImages,
  buildCombinedTemplateBundle,
} from '../services/upcomingTemplateService';
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
  ]);
  assert.deepEqual(noMatch.templateIds, []);
  assert.equal(noMatch.templateId, null);
  assert.equal(noMatch.cleanedFindings.length, 3);
});
