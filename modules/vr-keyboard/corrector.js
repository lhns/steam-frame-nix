// corrector.js: suggestions for tap-typed words -- corrections of a finished
// word that isn't in the dictionary, completions of the word being typed.
// Evaluates to { VERSION, create }.
//
// Words are compared by their folded form (lowercase, no ' or -, ä ö ü ß as
// ae oe ue ss), so umlaut spellings and missing apostrophes are free.
// Corrections: weighted Damerau-Levenshtein <= maxDistance (neighbouring keys
// and swapped letters 0.5, other edits 1) against all words of similar
// length, prefiltered by letter counts (an edit changes them by at most 2);
// ranked by distance - 0.1 * zipf. A valid word still gets suggestions if a
// same-folded variant is >= 1 zipf more frequent ("cant" -> "can't").
// Memory: one folded string + 26 bytes per word.
(() => {
  const VERSION = 3;
  const fold = (w) => w.toLowerCase().replace(/['’-]/g, '')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
  const VARIANT_GAP = 1.0;

  function create(dict) {
    const n = dict.words.length;
    const folded = dict.words.map(fold);
    const lower = new Map(), byFold = new Map(), byLen = [];
    const bags = new Uint8Array(n * 26);
    for (let i = 0; i < n; i++) {
      const f = folded[i], l = dict.words[i].toLowerCase();
      if (!lower.has(l) || dict.freq[i] > dict.freq[lower.get(l)]) lower.set(l, i);
      (byFold.get(f) ?? byFold.set(f, []).get(f)).push(i);
      (byLen[f.length] ??= []).push(i);
      for (let j = 0; j < f.length; j++) { const c = f.charCodeAt(j) - 97; if (c >= 0 && c < 26) bags[i * 26 + c]++; }
    }
    const sorted = Int32Array.from({ length: n }, (_, i) => i).sort((a, b) => (folded[a] < folded[b] ? -1 : folded[a] > folded[b] ? 1 : 0));

    // Substitution costs: 0.5 between keys closer than 1.3 key widths.
    const sub = new Float64Array(128 * 128).fill(1);
    function setLayout(centres) {
      sub.fill(1);
      const ks = Object.keys(centres || {}).filter((k) => k.charCodeAt(0) < 128);
      for (const a of ks) for (const b of ks) {
        if (a !== b && Math.hypot(centres[a][0] - centres[b][0], centres[a][1] - centres[b][1]) < 1.3) sub[a.charCodeAt(0) * 128 + b.charCodeAt(0)] = 0.5;
      }
    }

    // Weighted optimal-string-alignment distance; Infinity once a row exceeds max.
    const R0 = new Float64Array(64), R1 = new Float64Array(64), R2 = new Float64Array(64);
    function distance(s, t, max) {
      const m = s.length, k = t.length;
      if (Math.abs(m - k) > max || m > 62 || k > 62) return Infinity;
      let prev2 = R2, prev = R0, cur = R1;
      for (let j = 0; j <= k; j++) prev[j] = j;
      for (let i = 1; i <= m; i++) {
        cur[0] = i;
        let rowMin = i;
        for (let j = 1; j <= k; j++) {
          const a = s.charCodeAt(i - 1), b = t.charCodeAt(j - 1);
          let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a === b ? 0 : sub[(a & 127) * 128 + (b & 127)]));
          if (i > 1 && j > 1 && a === t.charCodeAt(j - 2) && s.charCodeAt(i - 2) === b) v = Math.min(v, prev2[j - 2] + 0.5);
          cur[j] = v;
          if (v < rowMin) rowMin = v;
        }
        if (rowMin > max) return Infinity;
        [prev2, prev, cur] = [prev, cur, prev2];
      }
      return prev[k];
    }

    // Casing as typed: ALL CAPS, Capitalised, else the dictionary's ("haus" -> "Haus").
    function shapeLike(typed, w) {
      if (typed.length > 1 && typed === typed.toUpperCase() && typed !== typed.toLowerCase()) return w.toUpperCase();
      if (typed[0] !== typed[0].toLowerCase()) return w[0].toUpperCase() + w.slice(1);
      return w;
    }
    // Up to max distinct words (as shaped), in the given order, without typed.
    function pickWords(typed, indices, max) {
      const out = [], seen = new Set([typed.toLowerCase()]);
      for (const i of indices) {
        if (out.length >= max) break;
        const w = shapeLike(typed, dict.words[i]);
        if (!seen.has(w.toLowerCase())) { seen.add(w.toLowerCase()); out.push(w); }
      }
      return out;
    }

    function corrections(typed, { maxDistance = 2, max = 4 } = {}) {
      const f = fold(typed);
      if (max <= 0 || f.length < 2 || !/^[a-z]+$/.test(f)) return [];
      const own = lower.get(typed.toLowerCase());
      const cost = new Map();                     // word index -> distance
      for (const i of byFold.get(f) || []) if (own === undefined || dict.freq[i] >= dict.freq[own] + VARIANT_GAP) cost.set(i, 0.1);
      if (own === undefined) {
        const bag = new Int16Array(26);
        for (let j = 0; j < f.length; j++) bag[f.charCodeAt(j) - 97]++;
        for (let len = Math.max(1, f.length - maxDistance); len <= f.length + maxDistance; len++) {
          for (const i of byLen[len] || []) {
            if (cost.has(i)) continue;
            let diff = 0;
            for (let c = 0, o = i * 26; c < 26 && diff <= 2 * maxDistance; c++) diff += Math.abs(bags[o + c] - bag[c]);
            if (diff > 2 * maxDistance) continue;
            const d = distance(f, folded[i], maxDistance);
            if (d <= maxDistance) cost.set(i, d);
          }
        }
      }
      const score = (i) => cost.get(i) - 0.1 * dict.freq[i];
      return pickWords(typed, [...cost.keys()].sort((a, b) => score(a) - score(b)), max);
    }

    function completions(prefix, { max = 5 } = {}) {
      const f = fold(prefix);
      if (max <= 0 || !/^[a-z]+$/.test(f)) return [];
      let lo = 0, hi = n;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (folded[sorted[mid]] < f) lo = mid + 1; else hi = mid; }
      const hits = [];
      for (let j = lo; j < n && folded[sorted[j]].startsWith(f); j++) hits.push(sorted[j]);
      return pickWords(prefix, hits.sort((a, b) => dict.freq[b] - dict.freq[a]), max);
    }

    return { corrections, completions, setLayout };
  }

  return { VERSION, create };
})()
