/* Finds drug names in free text (OCR output). Runs in the browser and in Node (for tests). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DrugExtract = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function levenshtein(a, b) {
    if (a === b) return 0;
    const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let diag = prev[0];
      prev[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = prev[j];
        prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
        diag = tmp;
      }
    }
    return prev[b.length];
  }

  function similarity(a, b) {
    const longest = Math.max(a.length, b.length) || 1;
    return 1 - levenshtein(a, b) / longest;
  }

  /**
   * @param {string} text  OCR text
   * @param {{vocab:string[], brands:Object}} data  contents of drugs.json
   * @returns {string[]} generic drug names, in order of first appearance
   */
  function extractDrugs(text, data, opts) {
    const cutoff = (opts && opts.cutoff) || 0.85;
    const vocab = data.vocab;
    const vocabSet = new Set(vocab);
    const found = [];
    const add = (g) => { if (!found.includes(g)) found.push(g); };

    const tokens = String(text || '').toLowerCase().match(/[a-z]{3,}/g) || [];
    for (const raw of new Set(tokens)) {
      // OCR often reads "m" as "rn" ("metforrnin"), so try that fix as a variant too
      const variants = raw.includes('rn') ? [raw, raw.replace(/rn/g, 'm')] : [raw];
      for (const t of variants) {
        if (Object.prototype.hasOwnProperty.call(data.brands, t)) {
          [].concat(data.brands[t]).forEach(add);
          break;
        }
        if (vocabSet.has(t)) { add(t); break; }
        if (t.length < 6) continue;
        // tolerate other slips like "simvastatn"
        let best = null;
        let bestScore = 0;
        for (const v of vocab) {
          if (Math.abs(v.length - t.length) > 2) continue;
          const s = similarity(t, v);
          if (s > bestScore) { bestScore = s; best = v; }
        }
        if (best && bestScore >= cutoff) { add(best); break; }
      }
    }
    return found;
  }

  return { extractDrugs, levenshtein, similarity };
});
