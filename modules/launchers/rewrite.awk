# Rewrites a desktop entry for steamFrame.launchers (launchers.nix): run as
#   LC_ALL=C gawk -f rewrite.awk FILE FILE     (two passes over the same file)
# with the launcher in the environment (ENVIRON, never -v: no escape
# processing):
#   SFN_MODE         flatpak | program
#   SFN_FLATPAK_ID   app ID, the anchor when the entry has no X-Flatpak=
#   SFN_PREFIX       Exec text before the command (env K=V..., wrappers)
#   SFN_FLATPAK_ARGS Exec text before the app ID (flatpak)
#   SFN_ARGS         Exec text after the app ID / program
#   SFN_MIME         MIME types to add to MimeType= ("a;b;")
#   SFN_SETTINGS     lines "Key=value" (set) or "Key" (remove)
#   SFN_SOURCE       path written as X-SteamFrameNix-Source=
# The SFN_*ARGS/PREFIX values are in Exec syntax (quoted, % doubled); the
# key-file escaping of the whole Exec value is done here.
#
# Line based: comments, unknown and localized keys stay as they are. Exec= of
# [Desktop Entry] and every [Desktop Action *] is rewritten:
#   flatpak: <prefix> <original up to the app ID> <flatpak args> <ID> <args> <rest>
#            (the first token equal to the ID after `run`, whose preceding
#            token's basename is `flatpak`)
#   program: <prefix> <original up to the program> <args> <rest>
#            (the first token after an optional leading `env A=B ...`)
# An Exec= without that anchor: nothing is printed, exit 3. No [Desktop
# Entry]: exit 4.

function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }

# Key of a "Key=value" line ("" for other lines), localized keys included.
function keyof(line,   k) {
  if (line ~ /^[ \t]*#/ || line !~ /=/) return ""
  k = line; sub(/=.*/, "", k); return trim(k)
}
function valueof(line,   v) { v = line; sub(/^[^=]*=[ \t]*/, "", v); return v }
function base(k) { sub(/\[.*/, "", k); return k }

# Key-file string escapes (GLib): \s \n \t \r \\.
function kf_unescape(s,   out, i, c, n) {
  out = ""
  for (i = 1; i <= length(s); i++) {
    c = substr(s, i, 1)
    if (c == "\\" && i < length(s)) {
      n = substr(s, ++i, 1)
      if (n == "s") c = " "; else if (n == "n") c = "\n"; else if (n == "t") c = "\t"
      else if (n == "r") c = "\r"; else if (n == "\\") c = "\\"; else c = "\\" n
    }
    out = out c
  }
  return out
}
function kf_escape(s) {
  gsub(/\\/, "\\\\", s); gsub(/\n/, "\\n", s); gsub(/\t/, "\\t", s); gsub(/\r/, "\\r", s)
  return s
}

# Splits an Exec value (Exec syntax) into tokens: TS/TE start/end offsets in
# s, TV the unquoted value. Returns the count, -1 on an unclosed quote.
function tokenize(s,   n, i, c, q, v, len) {
  delete TS; delete TE; delete TV
  n = 0; i = 1; len = length(s)
  while (i <= len) {
    c = substr(s, i, 1)
    if (c == " " || c == "\t") { i++; continue }
    TS[++n] = i; v = ""; q = 0
    while (i <= len) {
      c = substr(s, i, 1)
      if (!q && (c == " " || c == "\t")) break
      if (c == "\"") { q = !q; i++; continue }
      if (q && c == "\\" && i < len) { v = v substr(s, i + 1, 1); i += 2; continue }
      v = v c; i++
    }
    if (q) return -1
    TE[n] = i; TV[n] = v
  }
  return n
}

function join3(a, b, c,   r) {
  r = a
  if (b != "") r = (r == "" ? b : r " " b)
  if (c != "") r = (r == "" ? c : r " " c)
  return r
}

# The rewritten Exec value (raw key-file text), or "\001" without anchor.
function rewrite_exec(raw,   s, n, k, j, b, head, tail, pre, v) {
  s = kf_unescape(raw)
  n = tokenize(s)
  if (n <= 0) return "\001"
  k = 0
  if (ENVIRON["SFN_MODE"] == "flatpak") {
    for (j = 2; j < n && !k; j++) {
      b = TV[j - 1]; sub(/.*\//, "", b)
      if (b == "flatpak" && TV[j] == "run")
        for (v = j + 1; v <= n; v++) if (TV[v] == ANCHOR) { k = v; break }
    }
    if (!k) return "\001"
    head = trim(substr(s, 1, TS[k] - 1))
    pre = join3(ENVIRON["SFN_PREFIX"], head, ENVIRON["SFN_FLATPAK_ARGS"])
    pre = join3(pre, substr(s, TS[k], TE[k] - TS[k]), "")
  } else {
    k = 1
    if (TV[1] == "env") {
      for (k = 2; k <= n && TV[k] ~ /^[A-Za-z_][A-Za-z0-9_]*=/; k++) ;
      if (k > n || TV[k] ~ /^-/) return "\001"
    }
    pre = join3(ENVIRON["SFN_PREFIX"], trim(substr(s, 1, TE[k] - 1)), "")
  }
  tail = substr(s, TE[k])
  return kf_escape(join3(pre, ENVIRON["SFN_ARGS"], "") tail)
}

function in_entry() { return GROUP == "[Desktop Entry]" }

# Pass 1: the X-Flatpak= of [Desktop Entry].
FNR == NR {
  if ($0 ~ /^\[/) GROUP = trim($0)
  else if (in_entry() && keyof($0) == "X-Flatpak" && XFLATPAK == "") XFLATPAK = trim(valueof($0))
  next
}

FNR == 1 {
  ANCHOR = XFLATPAK != "" ? XFLATPAK : ENVIRON["SFN_FLATPAK_ID"]
  GROUP = ""; N = 0; ENTRY_END = 0; FAIL = ""
  # settings: SET[key] = value, DEL[key]
  ns = split(ENVIRON["SFN_SETTINGS"], sl, "\n")
  for (i = 1; i <= ns; i++) {
    if (sl[i] == "") continue
    if (index(sl[i], "=")) { k = substr(sl[i], 1, index(sl[i], "=") - 1); SET[k] = substr(sl[i], index(sl[i], "=") + 1); ORDER[++NSET] = k }
    else DEL[sl[i]] = 1
  }
  nm = split(ENVIRON["SFN_MIME"], ml, ";")
}

{
  line = $0
  if (line ~ /^\[/) {
    GROUP = trim(line); L[++N] = line
    if (in_entry()) { SEEN_ENTRY = 1; ENTRY_END = N }
    next
  }
  key = keyof(line)
  if (key != "" && (in_entry() || GROUP ~ /^\[Desktop Action /)) {
    if (key == "Exec" && !(in_entry() && (key in SET || key in DEL))) {
      v = rewrite_exec(valueof(line))
      if (v == "\001") { FAIL = FAIL "\n  " GROUP " Exec=" valueof(line); next }
      line = "Exec=" v
    }
  }
  if (key != "" && in_entry()) {
    b = base(key)
    if (b in SET || b in DEL) {
      if (key != b || b in DEL || b in DONE) next   # localized variant, removed, or duplicate
      line = b "=" SET[b]; DONE[b] = 1
    } else if (key == "DBusActivatable" && tolower(trim(valueof(line))) == "true") {
      line = "DBusActivatable=false"
    } else if (key == "X-SteamFrameNix-Source") {
      next
    } else if (key == "MimeType" && !MIMEDONE) {
      line = "MimeType=" merge_mime(valueof(line)); MIMEDONE = 1
    }
  }
  L[++N] = line
  if (in_entry() && trim(line) != "") ENTRY_END = N
}

function merge_mime(v,   have, cur, i, out) {
  out = v
  if (out != "" && out !~ /;$/) out = out ";"
  split(v, cur, ";")
  for (i in cur) if (cur[i] != "") have[trim(cur[i])] = 1
  for (i = 1; i <= nm; i++) if (ml[i] != "" && !(ml[i] in have)) { out = out ml[i] ";"; have[ml[i]] = 1 }
  return out
}

END {
  if (FAIL != "") {
    print "unknown Exec format (no " (ENVIRON["SFN_MODE"] == "flatpak" ? "`flatpak run ... " ANCHOR "`" : "program") "):" FAIL > "/dev/stderr"
    exit 3
  }
  if (!SEEN_ENTRY) { print "no [Desktop Entry] group" > "/dev/stderr"; exit 4 }
  for (i = 1; i <= N; i++) {
    print L[i]
    if (i == ENTRY_END) {
      for (j = 1; j <= NSET; j++) if (!(ORDER[j] in DONE)) print ORDER[j] "=" SET[ORDER[j]]
      if (!MIMEDONE && !("MimeType" in SET) && !("MimeType" in DEL) && nm > 0) {
        m = merge_mime("")
        if (m != "") print "MimeType=" m
      }
      print "X-SteamFrameNix-Source=" ENVIRON["SFN_SOURCE"]
    }
  }
}
