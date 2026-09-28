// textmodel.js: what the VR keyboard itself typed recently (it can't read the
// text field). Fed with every key the keyboard emits, in order (observe):
// single characters, "Backspace"; anything else resets it. Evaluates to
// { VERSION, create }.
//
// Buffer: the last `size` code points as emitted; empty = unknown.
// Anchors: a slice of buffer entries; intact while exactly those entries (by
// identity) end the buffer and no freeze() / reset() happened since. Every
// replacement (swipe candidates, corrections, completions) goes through an
// intact anchor, so it deletes exactly what it typed or nothing.
(() => {
  const VERSION = 5;
  const TERMINATORS = new Set([...' .,!?;:']);
  const OPENING = new Set([...'([{<"\'„“‚‘«‹¿¡/@#-_']);   // no auto-space after these
  const isWordChar = (c) => /[\p{L}\p{N}'’-]/u.test(c);

  function create({ size = 64 } = {}) {
    let buf = [];                                 // [{ c }]
    let epoch = 0;                                // bumped by reset/freeze: older anchors are void
    const chars = (from = 0, to = buf.length) => buf.slice(from, to).map((e) => e.c).join('');
    const m = {
      version: 0,                                 // bumped on every change (for caching suggestions)
      startKnown: false,                          // the buffer starts at a word boundary (Enter, field opened)
      get text() { return chars(); },
      reset(why, { boundary = false } = {}) {
        buf = [];
        m.startKnown = boundary;
        m.version++;
        epoch++;
        m.lastReset = why;
      },
      freeze() { epoch++; },
      // Returns false if the key reset the model.
      observe(key) {
        m.version++;
        if (key === 'Backspace') {
          if (!buf.length) m.startKnown = false;  // deleting text the model never saw
          buf.pop();
        } else if (typeof key === 'string' && [...key].length === 1) {
          buf.push({ c: key });
          if (buf.length > size) { buf.splice(0, buf.length - size); m.startKnown = false; }
        } else {
          m.reset(`key ${key}`, { boundary: key === 'Enter' });
          return false;
        }
        return true;
      },

      anchor(n) { return n > 0 && n <= buf.length ? { entries: buf.slice(-n), epoch } : null; },
      anchorIntact(a) {
        if (!a || a.epoch !== epoch || a.entries.length > buf.length) return false;
        const o = buf.length - a.entries.length;
        return a.entries.every((e, i) => buf[o + i] === e);
      },
      // Replace the anchored characters by text; returns the new anchor
      // (over text), or null if the anchor isn't intact. emit(key) sends one
      // key to the keyboard's output, which calls observe() synchronously; it
      // may return a promise (a pause after asynchronously typed characters).
      async replaceAnchored(a, emit, text) {
        if (!m.anchorIntact(a)) return null;
        for (let i = 0; i < a.entries.length; i++) await emit('Backspace');
        for (const c of text) await emit(c);
        return m.anchor([...text].length);
      },

      // ---- swipe --------------------------------------------------------------
      // Auto-space only after a known character that isn't whitespace or
      // opening punctuation. Returns { anchor (the word, not its space), space }.
      async commitWord(emit, word) {
        const e = buf[buf.length - 1];
        const space = !!e && !/\s/u.test(e.c) && !OPENING.has(e.c);
        if (space) await emit(' ');
        for (const c of word) await emit(c);
        return { anchor: m.anchor([...word].length), space };
      },

      // ---- tap-typed words ----------------------------------------------------
      // The word at the end, if known whole (a known non-word character or a
      // boundary before it): { text, n }.
      currentWord() {
        let i = buf.length;
        while (i > 0 && isWordChar(buf[i - 1].c)) i--;
        if (i === buf.length || (i === 0 && !m.startKnown)) return null;
        return { text: chars(i), n: buf.length - i };
      },
      // A word just finished by one terminator: { word, term, n (incl. term) }.
      endedWord() {
        const e = buf[buf.length - 1];
        if (!e || !TERMINATORS.has(e.c)) return null;
        let i = buf.length - 1;
        while (i > 0 && isWordChar(buf[i - 1].c)) i--;
        if (i === buf.length - 1 || (i === 0 && !m.startKnown)) return null;
        return { word: chars(i, -1), term: e.c, n: buf.length - i };
      },

      // ---- Backspace drag -----------------------------------------------------
      // borders[k-1]: deleting the k-th character from the end crosses a word
      // border (the word at the cursor is gone, its space/punctuation would
      // be next): "Hallo wie geht" sticks at "Hallo wie ". Whitespace and
      // punctuation at the cursor go first, without a border. Known text only.
      wordBorders() {
        const out = [];
        let state = 'tail';
        for (let i = buf.length - 1; i >= 0; i--) {
          const w = isWordChar(buf[i].c);
          out.push(state === 'word' && !w);
          if (state === 'tail' ? w : state === 'word' ? !w : w) state = state === 'word' ? 'gap' : 'word';
        }
        return out;
      },
      // A drag gesture: snapshot at the press. borders also marks the start
      // of the known text (or of the line after Enter): deleting past it
      // needs the extra travel too. target(travel): characters to be deleted
      // at that leftward travel (px each, a detent of detentPx before a border).
      // Restoring retypes this gesture's deletes in reverse, only while the
      // buffer is exactly the snapshot minus what is still deleted and the
      // gesture deleted nothing beyond the known text; else it stops for good.
      dragStart({ px, detentPx }) {
        const snap = buf.map((e) => e.c), borders = m.wordBorders();
        borders[snap.length] = snap.length > 0 || m.startKnown;
        return {
          snap, borders, applied: 0, restorable: true,
          stats: { deleted: 0, restored: 0, borders: 0, unknown: 0, stop: '' },
          target(travel) {
            let k = 0;
            for (let need = px + (borders[0] ? detentPx : 0); need <= travel; need += px + (borders[k] ? detentPx : 0)) k++;
            return k;
          },
        };
      },
      async dragDelete(g, emit) {
        const border = !!g.borders[g.applied];
        await emit('Backspace');
        g.applied++;
        g.stats.deleted++;
        if (border) g.stats.borders++;
        if (g.applied > g.snap.length) g.stats.unknown++;
        return { border };
      },
      // { border } or null (restoring stopped).
      async dragRestore(g, emit) {
        const L = g.snap.length, n = g.applied;
        if (!g.restorable || n <= 0) return null;
        const border = !!g.borders[n - 1];
        if (g.stats.unknown) {                    // strict: never a partial, wrong-looking retype
          g.restorable = false;
          g.stats.stop = 'unknown deleted';
          return null;
        }
        if (buf.length !== L - n || buf.some((e, i) => e.c !== g.snap[i])) {
          g.restorable = false;
          g.stats.stop = 'text changed';
          return null;
        }
        await emit(g.snap[L - n]);
        g.applied--;
        g.stats.restored++;
        return { border };
      },
    };
    return m;
  }

  return { VERSION, create };
})()
