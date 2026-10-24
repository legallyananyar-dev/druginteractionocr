'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { checkInteractions, cleanNames, findMention, classifySeverity } = require('../lib/engine');

// Fake network: RxNorm + OpenFDA
const LABELS = {
  warfarin: 'Aspirin and other NSAIDs may increase the risk of serious bleeding. Avoid concomitant use unless directed.',
  aspirin: 'Warfarin: monitor INR closely because of an increased risk of bleeding when taken with aspirin.',
  metformin: 'Cationic drugs may reduce metformin elimination. Monitor glucose.',
};
function fakeFetch(url) {
  const u = new URL(url);
  const ok = (json) => Promise.resolve({ ok: true, status: 200, json: async () => json });
  const miss = () => Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  if (u.hostname === 'rxnav.nlm.nih.gov') {
    if (u.pathname.endsWith('/rxcui.json')) {
      const name = u.searchParams.get('name');
      return name === 'notadrug' ? ok({ idGroup: {} }) : ok({ idGroup: { rxnormId: [String(name.length * 111)] } });
    }
    return ok({ properties: { name: 'preferred' } });
  }
  const m = /openfda\.(generic_name|brand_name):"([^"]+)"/.exec(u.searchParams.get('search'));
  if (m && m[1] === 'generic_name' && LABELS[m[2]]) return ok({ results: [{ drug_interactions: [LABELS[m[2]]] }] });
  return miss();
}

test('finds a MAJOR pair via class alias and merges both directions', async () => {
  const r = await checkInteractions(['Warfarin', 'aspirin'], { fetch: fakeFetch });
  assert.deepStrictEqual(r.drugs, ['warfarin', 'aspirin']);
  assert.strictEqual(r.interactions.length, 1);
  assert.strictEqual(r.interactions[0].severity, 'MAJOR');
  assert.strictEqual(r.interactions[0].evidence.length, 2);
  assert.strictEqual(r.summary.highest, 'MAJOR');
  assert.strictEqual(r.noMention.length, 0);
});

test('pairs with no cross-mention are listed, not hidden', async () => {
  const r = await checkInteractions(['warfarin', 'aspirin', 'metformin'], { fetch: fakeFetch });
  assert.strictEqual(r.summary.pairsChecked, 3);
  assert.strictEqual(r.interactions.length, 1);
  assert.strictEqual(r.noMention.length, 2);
});

test('rejects fewer than two valid names and strips unsafe input', async () => {
  await assert.rejects(() => checkInteractions(['warfarin'], { fetch: fakeFetch }), { statusCode: 400 });
  assert.deepStrictEqual(cleanNames(['warfarin" OR 1:1', 'a', 'aspirin', 'ASPIRIN', '  Vitamin  D ']), ['aspirin', 'vitamin d']);
});

test('API failures become notes instead of crashing', async () => {
  const boom = () => Promise.reject(new Error('network down'));
  const r = await checkInteractions(['warfarin', 'aspirin'], { fetch: boom });
  assert.strictEqual(r.interactions.length, 0);
  assert.strictEqual(r.summary.highest, 'NONE');
  assert.ok(r.notes.length >= 2);
});

test('unknown drug is flagged', async () => {
  const r = await checkInteractions(['warfarin', 'notadrug'], { fetch: fakeFetch });
  assert.ok(r.notes.some((n) => n.includes('notadrug') && n.includes('RxNorm')));
});

test('whole-word matching: "ppi" must not match inside "mapping"', () => {
  assert.strictEqual(findMention('Genome mapping study', ['ppi']), null);
  assert.ok(findMention('Avoid PPIs with this drug', ['ppi']));
});

test('severity keywords', () => {
  assert.strictEqual(classifySeverity('Contraindicated with X'), 'MAJOR');
  assert.strictEqual(classifySeverity('Monitor levels'), 'MODERATE');
  assert.strictEqual(classifySeverity('Mild effect'), 'MINOR');
  assert.strictEqual(classifySeverity('Some text'), 'UNKNOWN');
});
