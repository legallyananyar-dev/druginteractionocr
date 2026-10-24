'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { extractDrugs } = require('../public/extract.js');
const data = require('../public/drugs.json');

test('exact, brand and fuzzy matches', () => {
  const text = 'Rx: Tab. Ecosprin 75mg OD; Tab WARFARIN 5mg HS; Simvastatn 20 mg; Combiflam SOS';
  const found = extractDrugs(text, data);
  for (const d of ['aspirin', 'warfarin', 'simvastatin', 'ibuprofen', 'paracetamol']) assert.ok(found.includes(d), d);
});

test('OCR slips are tolerated', () => {
  assert.ok(extractDrugs('Metforrnin 500', data).includes('metformin'));
});

test('ordinary clinical prose yields no drugs', () => {
  const prose = 'Patient presented with fever and cough for three days. Advised rest, fluids and follow up after one week. Blood pressure normal.';
  assert.deepStrictEqual(extractDrugs(prose, data), []);
});

test('empty input is safe', () => {
  assert.deepStrictEqual(extractDrugs('', data), []);
  assert.deepStrictEqual(extractDrugs(null, data), []);
});
