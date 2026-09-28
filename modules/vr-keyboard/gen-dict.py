# Builds the dictionary at build time: the most frequent words per language
# (wordfreq), kept if Hunspell accepts them, in Hunspell's spelling and casing
# (wordfreq lowercases and folds ß: "strasse" is tried as "straße"; lowercase
# only if accepted without compounding, else Capitalised; "essen"/"Essen"
# both, the second slightly less frequent). Contractions Hunspell rejects
# ("geht's") are kept by frequency, other rejected words if their zipf is
# >= keepFrequentAbove (3+ letters, or zipf >= 5: "ok").
# usage: python3 gen-dict.py <out.js> <hunspell> <config.json>
#   config: { languages: [{ lang, words, offset (zipf), dict (path or null),
#                           keepFrequentAbove (zipf or null) }],
#             extra: [[word, zipf]], extraFiles: [path], extraZipf, exclude: [word],
#             contractions: bool }
# Output: a JS string literal "word<TAB>zipf*10\n..." (most frequent first).
import itertools, json, re, shutil, subprocess, sys
import wordfreq

out, hunspell, config = sys.argv[1:]
cfg = json.load(open(config))
# Word letters: German/English a-z ä ö ü ß; other languages any lowercase
# letter (accents). Contractions ("couldn't", "geht's"): letters around
# apostrophes (wordfreq splits words at hyphens: no hyphenated words).
def word_patterns(lang):
    L = "a-zäöüß" if lang in ("de", "en") else r"^\W\d_A-Z"
    return re.compile(rf"^[{L}]{{2,24}}$"), re.compile(rf"^[{L}]+(?:'[{L}]+)+$")
SECONDARY = 5                       # frequency penalty (zipf/10) of the other casing
cap = lambda w: w[0].upper() + w[1:]


def spellings(w):
    """w, then the variants with some "ss" written as "ß" (wordfreq folds ß)."""
    idx = [m.start() for m in re.finditer("ss", w)][:3]
    out = [w]
    for r in range(1, len(idx) + 1):
        for combo in itertools.combinations(idx, r):
            s = w
            for i in sorted(combo, reverse=True):
                s = s[:i] + "ß" + s[i + 2:]
            out.append(s)
    return out


def check(dic, words):
    """The words Hunspell accepts (-G) with dictionary dic."""
    res = subprocess.run([hunspell, "-i", "utf-8", "-d", dic, "-G"],
                         input="\n".join(words) + "\n", capture_output=True, text=True, check=True)
    return set(res.stdout.split("\n"))


def strict_dict(dic, tmp):
    """dic without compounding: German .dic files also list nouns in lowercase
    as compound parts ("wetter" for "Regenwetter"), which Hunspell then accepts
    on their own; the strict copy decides the casing. Also returns the
    capitalised stems (nouns, names)."""
    aff = open(dic + ".aff", encoding="latin-1").read()
    aff = "\n".join(l for l in aff.split("\n") if not l.startswith("COMPOUND"))
    open(tmp + ".aff", "w", encoding="latin-1").write(aff)   # latin-1: bytes unchanged
    shutil.copyfile(dic + ".dic", tmp + ".dic")
    enc = re.search(r"^SET\s+(\S+)", aff, re.M)
    text = open(dic + ".dic", "rb").read().decode(enc.group(1) if enc else "latin-1", "replace")
    caps = {l.split("/")[0].strip() for l in text.split("\n")[1:] if l[:1].isupper()}
    return tmp, caps


best = {}
frequent_all = set()                # kept by frequency only (keepFrequentAbove)
verified = set()                    # accepted by some language's Hunspell
unverified = set()                  # contractions Hunspell rejects ("geht's"), kept by frequency
def add(form, z):
    if z > best.get(form, -1):
        best[form] = z

contractions = cfg.get("contractions", True)
def top_words(lang, n):
    """The n most frequent plain words, plus the contractions among them."""
    LETTERS, CONTRACTION = word_patterns(lang)
    out, plain = [], 0
    for w in wordfreq.iter_wordlist(lang):
        w = w.replace("\u2019", "'")
        if LETTERS.match(w):
            out.append(w); plain += 1
            if plain >= n:
                break
        elif contractions and CONTRACTION.match(w) and len(w) <= 24:
            out.append(w)
    return out

available = set(wordfreq.available_languages())
for spec in cfg["languages"]:
    lang, n, dic = spec["lang"], int(spec["words"]), spec.get("dict")
    keep_above = spec.get("keepFrequentAbove")
    frequent = []
    bias = round(float(spec.get("offset", 0)) * 10)
    if lang not in available:
        sys.exit(f"wordfreq has no language {lang!r}; available: {' '.join(sorted(available))}")
    words = top_words(lang, n)
    if not dic:
        for w in words:
            add(w, round(wordfreq.zipf_frequency(w, lang) * 10) + bias)
        print(f"{lang}: {len(words)} words (no Hunspell filter)", file=sys.stderr)
        continue
    variants = {w: spellings(w) for w in words}
    query = [f for vs in variants.values() for v in vs for f in (v, cap(v))]
    ok = check(dic, query)
    sdic, caps = strict_dict(dic, f"strict-{lang}")
    strict = check(sdic, [f for f in query if f in ok])
    kept = 0
    for w in words:
        z = round(wordfreq.zipf_frequency(w, lang) * 10) + bias
        if not any(v in ok or cap(v) in ok for v in variants[w]):
            zipf = wordfreq.zipf_frequency(w, lang)
            if "'" in w:                          # Hunspell splits "geht's": keep by frequency
                add(w, z)
                unverified.add(w)
                kept += 1
            elif keep_above is not None and zipf >= keep_above and (len(w) >= 3 or zipf >= 5):
                add(w, z)                         # frequent, but not in Hunspell ("ok", "lol", "colour")
                frequent.append(w)
                frequent_all.add(w)
            continue
        for v in variants[w]:
            lo, up = v in ok, cap(v) in ok
            if not (lo or up):
                continue
            kept += 1
            verified.update(f for f in (v, cap(v)) if f in ok)
            slo, sup = v in strict, cap(v) in strict
            if slo:
                add(v, z)
                if cap(v) in caps:                # "essen" / "Essen"
                    add(cap(v), z - SECONDARY)
            elif sup or not lo:                   # "Wetter", "Haus", "Weihnachtsmarkt"
                add(cap(v), z)
            else:
                add(v, z)
            break
    print(f"{lang}: {kept} of {len(words)} words kept, {len(frequent)} more by frequency: {' '.join(frequent[:30])}", file=sys.stderr)

# An unverified contraction that another language has in a checked casing
# ("i'm" from the German list, "I'm" from English): keep only the latter.
checked = {}
for w in best:
    if "'" in w and w not in unverified:
        checked.setdefault(w.lower(), w)
for w in [w for w in unverified if w in best and w.lower() in checked and checked[w.lower()] != w]:
    k = checked[w.lower()]
    best[k] = max(best[k], best.pop(w))
print(f"contractions: {sum(1 for w in best if chr(39) in w)} ({len(unverified)} not in Hunspell)", file=sys.stderr)

# A frequency-only word that is a contraction without its apostrophe ("dont",
# "thats") would only compete with the real one: dropped.
# Only words no Hunspell accepts ("is" stays although "i's" exists), and only
# if the contraction is more frequent.
contraction_freq = {}
for w, z in best.items():
    if "'" in w:
        k = w.replace("'", "").lower()
        contraction_freq[k] = max(contraction_freq.get(k, -1), z)
dropped = [w for w in frequent_all if w in best and w not in verified and best[w] < contraction_freq.get(w, -1)]
for w in dropped:
    del best[w]
print(f"frequency-only words dropped as contractions without apostrophe: {len(dropped)}", file=sys.stderr)

extra = [(w, z) for w, z in cfg.get("extra", [])]
for path in cfg.get("extraFiles", []):
    for line in open(path, encoding="utf-8"):
        parts = line.strip().split("\t")
        if parts[0]:
            extra.append((parts[0], float(parts[1]) if len(parts) > 1 else None))
for w, z in extra:
    z = cfg.get("extraZipf", 5.0) if z is None else z
    best[w] = max(best.get(w, -1), round(float(z) * 10))
exclude = {w.lower() for w in cfg.get("exclude", [])}
for w in [w for w in best if w.lower() in exclude]:
    del best[w]
print(f"extra: {len(extra)}, excluded: {len(exclude)}", file=sys.stderr)

items = sorted(best.items(), key=lambda kv: (-kv[1], kv[0]))
with open(out, "w", encoding="utf-8") as f:
    f.write(json.dumps("\n".join(f"{w}\t{z}" for w, z in items), ensure_ascii=False))
print(f"total: {len(items)} entries", file=sys.stderr)
