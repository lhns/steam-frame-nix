// swipe-decoder.js: swipe path -> words. Evaluates to { VERSION, parseDict,
// layout, decode }. SHARK2-style template matching (Kristensson & Zhai 2004):
// each word's ideal path runs through its key centres; candidates starting
// and ending near the path's ends, with every key near the path, are scored
// by point distances of the resampled paths (proportional and DTW), how
// closely the path passes their keys in order, path length and frequency.
// Distances are in key widths. ' and - are typed, not swiped.
(() => {
  const VERSION = 4;
  const N = 32;                                   // resample points
  const SKIP = new Set(["'", '-', '\u2019']);
  // Cost weights and pruning limits (tuned with tests/swipe-decoder.test.mjs; distances in key widths).
  const W = {
    loc: 4.4,                                     // mean point distance, proportional alignment
    dtw: 2.0,                                     // mean point distance, dynamic time warping
    letters: 0.5,                                 // mean letter-to-path distance, in order
    extra: 1.0,                                   // mean path-to-template distance
    length: 0.5,                                  // |log(path length / template length)|
    freq: 0.3,                                    // zipf frequency (0..8)
    startSlack: 0.9, endSlack: 1.0,               // start/end keys: beyond the nearest key
    letterMax: 1.1,                               // max distance of any key from the path
    smooth: 2,                                    // path smoothing: +- samples of 0.1 key widths
    shortlist: 150,                               // candidates that get the costly terms (dtw, extra)
  };

  // "word\tzipf*10\n..." -> { words, freq }
  function parseDict(text) {
    const words = [], freq = [];
    for (const line of text.split('\n')) {
      const i = line.indexOf('\t');
      if (i <= 0) continue;
      words.push(line.slice(0, i));
      freq.push(+line.slice(i + 1) / 10);
    }
    return { words, freq };
  }

  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  function pathLength(pts) {
    let l = 0;
    for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i]);
    return l;
  }
  // n points equally spaced along the polyline pts (flat [x0,y0,x1,y1,...]).
  function resample(pts, n) {
    const out = new Float64Array(n * 2);
    if (pts.length === 1) { for (let i = 0; i < n; i++) { out[2 * i] = pts[0][0]; out[2 * i + 1] = pts[0][1]; } return out; }
    const total = pathLength(pts);
    if (total === 0) return resample([pts[0]], n);
    const step = total / (n - 1);
    let seg = 1, segStart = 0, segLen = dist(pts[0], pts[1]);
    for (let i = 0; i < n; i++) {
      const target = Math.min(i * step, total);
      while (segStart + segLen < target && seg < pts.length - 1) { segStart += segLen; seg++; segLen = dist(pts[seg - 1], pts[seg]); }
      const t = segLen > 0 ? (target - segStart) / segLen : 0;
      out[2 * i] = pts[seg - 1][0] + (pts[seg][0] - pts[seg - 1][0]) * t;
      out[2 * i + 1] = pts[seg - 1][1] + (pts[seg][1] - pts[seg - 1][1]) * t;
    }
    return out;
  }

  // Keyboard layout: keys = { char: [centreX, centreY] } in any unit, unit =
  // key width in that unit. A word's path uses its letters only (apostrophes
  // and hyphens are typed but not swiped: "couldn't" = c-o-u-l-d-n-t, next to
  // "couldnt" if the dictionary had it; both are separate candidates). Words
  // with another character the layout lacks are left out. Returns an object for decode() (templates are built lazily).
  function layout(dict, keys, unit) {
    const centre = {};
    for (const [c, p] of Object.entries(keys)) centre[c] = [p[0] / unit, p[1] / unit];
    const chars = Object.keys(centre);
    const buckets = new Map();                    // first key + last key -> word indices
    const seqs = new Array(dict.words.length);    // collapsed key sequence per word
    for (let i = 0; i < dict.words.length; i++) {
      const w = dict.words[i].toLowerCase();
      let seq = '', ok = true;
      for (const c of w) {
        if (SKIP.has(c)) continue;                // "couldn't" is swiped as "couldnt"
        if (!centre[c]) { ok = false; break; }
        if (seq[seq.length - 1] !== c) seq += c;
      }
      if (!ok || [...seq].length < 2) continue;
      seqs[i] = seq;
      const cs = [...seq], b = cs[0] + cs[cs.length - 1];
      let list = buckets.get(b);
      if (!list) buckets.set(b, list = []);
      list.push(i);
    }
    return { dict, centre, chars, buckets, seqs, templates: new Map() };
  }

  function template(lay, seq) {
    let t = lay.templates.get(seq);
    if (!t) {
      const pts = [...seq].map((c) => lay.centre[c]);
      t = { pts: resample(pts, N), length: pathLength(pts), keys: pts };
      lay.templates.set(seq, t);
    }
    return t;
  }

  // Distance of (x, y) to the polyline pts ([[x, y], ...]).
  function segDist(x, y, pts) {
    let m = Infinity;
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
      m = Math.min(m, Math.hypot(x - ax - t * dx, y - ay - t * dy));
    }
    return m;
  }
  // Mean point distance of the resampled paths a and b under dynamic time
  // warping (band of N/4), normalised by the warping path length.
  const dtwRow = new Float64Array((N + 1) * (N + 1)), dtwLen = new Float64Array((N + 1) * (N + 1));
  function dtw(a, b) {
    const band = N >> 2, S = N + 1;
    dtwRow.fill(Infinity); dtwRow[0] = 0; dtwLen[0] = 0;
    for (let i = 1; i <= N; i++) {
      for (let j = Math.max(1, i - band); j <= Math.min(N, i + band); j++) {
        const d = Math.hypot(a[2 * i - 2] - b[2 * j - 2], a[2 * i - 1] - b[2 * j - 1]);
        let k = (i - 1) * S + j - 1;                               // diagonal
        if (dtwRow[(i - 1) * S + j] < dtwRow[k]) k = (i - 1) * S + j;
        if (dtwRow[i * S + j - 1] < dtwRow[k]) k = i * S + j - 1;
        dtwRow[i * S + j] = dtwRow[k] + d; dtwLen[i * S + j] = dtwLen[k] + 1;
      }
    }
    return dtwRow[N * S + N] / dtwLen[N * S + N];
  }

  // Keys within `slack` key widths of the nearest key to p.
  function nearKeys(lay, p, slack) {
    const d = lay.chars.map((c) => [c, dist(lay.centre[c], p)]);
    const min = Math.min(...d.map((x) => x[1]));
    return d.filter((x) => x[1] <= min + slack).map((x) => x[0]);
  }

  const cost = (f) => W.loc * f.loc + W.dtw * f.dtw + W.letters * f.letters + W.extra * f.extra +
    W.length * f.length - W.freq * f.freq;
  // Laser shake adds length and wiggles: resample the path every 0.1 key
  // widths and average over +-W.smooth samples (ends kept).
  function smooth(path) {
    const k = W.smooth;
    if (!k || path.length < 3) return path;
    const n = Math.max(2, Math.ceil(pathLength(path) / 0.1) + 1);
    const r = resample(path, n), out = [];
    for (let i = 0; i < n; i++) {
      let x = 0, y = 0, c = 0;
      for (let j = Math.max(0, i - k); j <= Math.min(n - 1, i + k); j++) { x += r[2 * j]; y += r[2 * j + 1]; c++; }
      out.push(i === 0 || i === n - 1 ? [r[2 * i], r[2 * i + 1]] : [x / c, y / c]);
    }
    return out;
  }

  // rawPath in the layout's unit before division by `unit`; returns
  // [{ word, cost }] best first (opts.features: every candidate's cost terms).
  function decode(lay, rawPath, opts = {}) {
    const { max = 5, unit = 1 } = opts;
    const path = smooth(rawPath.map((p) => [p[0] / unit, p[1] / unit]));
    if (path.length < 2) return [];
    const plen = pathLength(path);
    const P = resample(path, N);
    const dense = resample(path, Math.max(N, Math.ceil(plen * 8)));   // ~8 points per key width
    const denseN = dense.length / 2;
    // Min distance from every key to the path (for pruning).
    const keyDist = {};
    for (const c of lay.chars) {
      const [x, y] = lay.centre[c];
      let m = Infinity;
      for (let i = 0; i < denseN; i++) m = Math.min(m, Math.hypot(dense[2 * i] - x, dense[2 * i + 1] - y));
      keyDist[c] = m;
    }
    const starts = nearKeys(lay, path[0], W.startSlack);
    const ends = nearKeys(lay, path[path.length - 1], W.endSlack);
    const out = [];
    for (const s of starts) for (const e of ends) {
      for (const i of lay.buckets.get(s + e) || []) {
        const seq = lay.seqs[i];
        let ok = true;
        for (const c of seq) if (keyDist[c] > W.letterMax) { ok = false; break; }
        if (!ok) continue;
        const t = template(lay, seq);
        let loc = 0;
        for (let k = 0; k < N; k++) loc += Math.hypot(P[2 * k] - t.pts[2 * k], P[2 * k + 1] - t.pts[2 * k + 1]);
        loc /= N;
        // Letters in order: each key's nearest dense point at or after the
        // previous letter's (greedy, monotone).
        let from = 0, lettersCost = 0;
        for (const [x, y] of t.keys) {
          let best = Infinity, bi = from;
          for (let j = from; j < denseN; j++) {
            const d = Math.hypot(dense[2 * j] - x, dense[2 * j + 1] - y);
            if (d < best) { best = d; bi = j; }
          }
          lettersCost += best; from = bi;
        }
        lettersCost /= t.keys.length;
        out.push({ i, t, f: {
          loc, letters: lettersCost, freq: lay.dict.freq[i],
          length: Math.abs(Math.log((plen + 0.5) / (t.length + 0.5))), dtw: 0, extra: 0,
        } });
      }
    }
    // The costly terms only for the best candidates by the cheap ones.
    let list = out;
    if (!opts.features && out.length > W.shortlist) {
      for (const c of out) c.cost = cost(c.f);
      list = out.sort((a, b) => a.cost - b.cost).slice(0, W.shortlist);
    }
    for (const c of list) {
      c.f.dtw = dtw(P, c.t.pts);
      for (let k = 0; k < N; k++) c.f.extra += segDist(P[2 * k], P[2 * k + 1], c.t.keys);
      c.f.extra /= N;
      c.cost = cost(c.f);
    }
    if (opts.features) return list.map((c) => ({ word: lay.dict.words[c.i], f: c.f }));
    list.sort((a, b) => a.cost - b.cost);
    const res = [], seen = new Set();
    for (const { i, cost } of list) {
      const w = lay.dict.words[i];
      if (seen.has(w)) continue;
      seen.add(w);
      res.push({ word: w, cost });
      if (res.length >= max) break;
    }
    return res;
  }

  return { VERSION, parseDict, layout, decode };
})()
