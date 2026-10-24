'use strict';

const data = require('../public/drugs.json');

const OPENFDA_BASE = 'https://api.fda.gov/drug/label.json';
const RXNORM_BASE = 'https://rxnav.nlm.nih.gov/REST';
const TIMEOUT_MS = 9000;
const MAX_DRUGS = 8;
const LEVELS = ['MAJOR', 'MODERATE', 'MINOR', 'UNKNOWN'];

// Matched against the snippet around the other drug's name, NOT the whole label section.
// ("interaction" / "enzyme" are deliberately absent: every section contains them.)
const SEVERITY_KEYWORDS = {
  major: [
    'contraindicated', 'life-threatening', 'fatal', 'severe', 'avoid', 'do not use',
    'dangerous', 'serious', 'cardiac arrest', 'qt prolongation', 'torsades',
    'serotonin syndrome', 'bleeding',
  ],
  moderate: [
    'caution', 'monitor', 'dose adjustment', 'reduce dose', 'increased risk',
    'may increase', 'may decrease', 'inhibits', 'induces', 'cyp',
  ],
  minor: ['minimal', 'unlikely', 'rarely', 'mild', 'slight', 'not clinically significant'],
};

function classifySeverity(text) {
  if (!text) return 'UNKNOWN';
  const low = text.toLowerCase();
  for (const level of ['major', 'moderate', 'minor']) {
    if (SEVERITY_KEYWORDS[level].some((k) => low.includes(k))) return level.toUpperCase();
  }
  return 'UNKNOWN';
}

function worst(levels) {
  return LEVELS.find((l) => levels.includes(l)) || 'UNKNOWN';
}

// Only plain drug-name characters get through: nothing reaches the OpenFDA query syntax unescaped.
function cleanNames(list, max = MAX_DRUGS) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const n = String(raw == null ? '' : raw).trim().toLowerCase().replace(/\s+/g, ' ');
    if (/^[a-z0-9][a-z0-9 -]{0,38}[a-z0-9]$/.test(n) && !out.includes(n)) out.push(n);
  }
  return out.slice(0, max);
}

async function getJson(url, f) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await f(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (res.status === 404) return { status: 404, json: null };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { status: res.status, json: await res.json() };
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'timed out' : e.message);
  } finally {
    clearTimeout(timer);
  }
}

async function resolveRxcui(name, f) {
  try {
    const { json } = await getJson(`${RXNORM_BASE}/rxcui.json?name=${encodeURIComponent(name)}&search=1`, f);
    const id = json && json.idGroup && json.idGroup.rxnormId && json.idGroup.rxnormId[0];
    if (!id) return { input: name, rxcui: null, name, status: 'not_found' };
    let preferred = name;
    try {
      const p = await getJson(`${RXNORM_BASE}/rxcui/${id}/properties.json`, f);
      preferred = (p.json && p.json.properties && p.json.properties.name) || name;
    } catch (_) { /* keep the typed name */ }
    return { input: name, rxcui: id, name: preferred, status: 'found' };
  } catch (e) {
    return { input: name, rxcui: null, name, status: `error: ${e.message}` };
  }
}

async function fetchLabels(name, f, apiKey) {
  const searchName = data.labelNames[name] || name;
  const url = (field) => {
    const p = new URLSearchParams({ search: `openfda.${field}:"${searchName}"`, limit: '3' });
    if (apiKey) p.set('api_key', apiKey);
    return `${OPENFDA_BASE}?${p}`;
  };
  let r = await getJson(url('generic_name'), f);
  if (r.status === 404) r = await getJson(url('brand_name'), f);
  if (!r.json) return [];
  const sections = [];
  for (const result of r.json.results || []) {
    for (const text of result.drug_interactions || []) {
      if (text && text.trim()) sections.push(text);
    }
  }
  return sections;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Whole-word match (optional plural) so "ppi" doesn't match inside "mapping".
function findMention(text, terms, window = 250) {
  for (const term of terms) {
    const m = new RegExp(`\\b${escapeRe(term)}(?:s|es)?\\b`, 'i').exec(text);
    if (m) {
      const start = Math.max(0, m.index - window);
      const end = Math.min(text.length, m.index + m[0].length + window);
      return { snippet: text.slice(start, end).trim(), term };
    }
  }
  return null;
}

const termsFor = (name) => data.aliases[name] || [name];

async function checkInteractions(rawDrugs, deps = {}) {
  const f = deps.fetch || globalThis.fetch;
  const drugs = cleanNames(rawDrugs);
  if (drugs.length < 2) {
    const err = new Error('Provide at least two valid drug names.');
    err.statusCode = 400;
    throw err;
  }

  const notes = [];
  const [resolved, labelSets] = await Promise.all([
    Promise.all(drugs.map((d) => resolveRxcui(d, f))),
    Promise.all(drugs.map(async (d) => {
      try {
        return await fetchLabels(d, f, deps.apiKey);
      } catch (e) {
        notes.push(`Could not fetch the FDA label for ${d} (${e.message}).`);
        return [];
      }
    })),
  ]);

  resolved.forEach((r) => {
    if (r.status === 'not_found') notes.push(`${r.input} was not found in RxNorm. Check the spelling.`);
  });
  labelSets.forEach((sections, i) => {
    if (!sections.length && !notes.some((n) => n.includes(drugs[i]))) {
      notes.push(`No FDA label interaction text found for ${drugs[i]}.`);
    }
  });

  // Look for each drug inside the OTHER drug's label text, then merge both directions per pair.
  const pairMap = new Map();
  drugs.forEach((a, ai) => {
    drugs.forEach((b) => {
      if (a === b) return;
      for (const text of labelSets[ai]) {
        const hit = findMention(text, termsFor(b));
        if (!hit) continue;
        const key = [a, b].sort().join('|');
        if (!pairMap.has(key)) pairMap.set(key, { drugs: [a, b].sort(), evidence: [] });
        pairMap.get(key).evidence.push({
          from: a,
          mentions: b,
          matchedTerm: hit.term,
          severity: classifySeverity(hit.snippet),
          text: hit.snippet,
        });
        break; // one hit per direction is enough
      }
    });
  });

  const interactions = [...pairMap.values()]
    .map((p) => ({ ...p, severity: worst(p.evidence.map((e) => e.severity)) }))
    .sort((x, y) => LEVELS.indexOf(x.severity) - LEVELS.indexOf(y.severity));

  const noMention = [];
  for (let i = 0; i < drugs.length; i++) {
    for (let j = i + 1; j < drugs.length; j++) {
      const key = [drugs[i], drugs[j]].sort().join('|');
      if (!pairMap.has(key)) noMention.push([drugs[i], drugs[j]]);
    }
  }

  const bySeverity = Object.fromEntries(LEVELS.map((l) => [l, interactions.filter((p) => p.severity === l).length]));

  return {
    drugs,
    resolved,
    interactions,
    noMention,
    labels: drugs.map((d, i) => ({
      drug: d,
      sections: labelSets[i].length,
      excerpt: labelSets[i][0] ? labelSets[i][0].slice(0, 800) : '',
    })),
    notes,
    summary: {
      pairsChecked: (drugs.length * (drugs.length - 1)) / 2,
      pairsWithMention: interactions.length,
      highest: interactions.length ? interactions[0].severity : 'NONE',
      bySeverity,
      checkedAt: new Date().toISOString(),
    },
  };
}

module.exports = { checkInteractions, classifySeverity, cleanNames, findMention, MAX_DRUGS };
