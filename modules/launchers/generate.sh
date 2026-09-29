# steam-frame-nix-launchers (lib.nix prepends spec, awk_script, runtime,
# apps, exports): writes the Flatpak/file launchers of steamFrame.launchers
# to <runtime>/steam-frame-nix/applications (tmpfs), where the links in
# ~/.local/share/applications point.
# - one spec file per launcher (desktop ID = file name): rewrite.awk's
#   environment, SFN_FILE for a host file;
# - an entry is replaced (temp file + rename) only when its content changed;
#   entries without a source (app not installed) or of launchers no longer
#   configured are removed; with an unknown Exec format the launcher is
#   skipped: the entry is a copy of the original (a missing file behind the
#   link would hide the original from the menus);
# - .<id>.desktop.sum holds the hash of what was written last: a mismatch
#   means someone edited the entry (KDE's "Edit Application"), which is
#   overwritten with a warning;
# - if anything changed, the mtime of ~/.local/share/applications is updated
#   (a running Steam rescans the "+" menu).
out=$runtime/steam-frame-nix/applications
log() { echo "steam-frame-nix-launchers: $*" >&2; }

if [[ ! -d $runtime ]]; then
  log "$runtime doesn't exist (outer session not running?); skipped"
  exit 0
fi
ids=()
for f in "$spec"/*; do [[ -e $f ]] && ids+=("${f##*/}"); done
if (( ${#ids[@]} == 0 )) && [[ ! -d $out ]]; then exit 0; fi
mkdir -p "$out"
exec 9>"$out/.lock"
flock 9
rm -f "$out"/.*.tmp.*
IFS=: read -ra export_dirs <<< "$exports"
changed=0

remove() { # id why
  if [[ -e $out/$1.desktop ]]; then
    rm -f "$out/$1.desktop"
    changed=1
    log "$1: entry removed ($2)"
  fi
  rm -f "$out/.$1.desktop.sum"
}

# The link in ~/.local/share/applications is ours unless something replaced it.
check_link() { # id
  local l=$apps/$1.desktop
  if [[ -e $l || -L $l ]] && [[ $(readlink -m "$l") != "$(readlink -m "$out/$1.desktop")" ]]; then
    log "warning: $l no longer leads to $out/$1.desktop (edited, e.g. with KDE's \"Edit Application\"?); set steamFrame.launchers.\"$1\".settings instead and remove it"
  fi
}

generate() { # id
  local id=$1 dst=$out/$1.desktop sum=$out/.$1.desktop.sum src='' d tmp rc
  unset "${!SFN_@}"
  # shellcheck source=/dev/null
  source "$spec/$id"
  if [[ -n $SFN_FILE ]]; then
    [[ -f $SFN_FILE ]] && src=$SFN_FILE
  else
    for d in "${export_dirs[@]}"; do
      if [[ -f $d/$SFN_FLATPAK_ID.desktop ]]; then src=$d/$SFN_FLATPAK_ID.desktop; break; fi
    done
  fi
  if [[ -z $src ]]; then
    remove "$id" "no source entry: ${SFN_FILE:-Flatpak $SFN_FLATPAK_ID not installed}"
    return 0
  fi
  export "${!SFN_@}"
  export SFN_SOURCE=$src
  tmp=$(mktemp "$out/.$id.desktop.tmp.XXXXXX")
  rc=0
  LC_ALL=C gawk -f "$awk_script" "$src" "$src" > "$tmp" 2> "$tmp.err" || rc=$?
  if (( rc == 3 )); then
    log "warning: $id: $(tr -s "\n" " " < "$tmp.err"); launcher not applied, the original entry is used"
    cat "$src" > "$tmp"
  elif (( rc != 0 )); then
    log "error: $id: rewriting $src failed (status $rc): $(tr -s "\n" " " < "$tmp.err")"
    rm -f "$tmp" "$tmp.err"
    return 0
  fi
  rm -f "$tmp.err"
  if [[ -f $dst && -f $sum ]] && [[ $(sha256sum < "$dst") != "$(cat "$sum")" ]]; then
    log "warning: $dst was edited (e.g. with KDE's \"Edit Application\"); overwritten, set steamFrame.launchers.\"$id\".settings instead"
  fi
  if [[ -f $dst ]] && cmp -s "$tmp" "$dst"; then
    rm -f "$tmp"
  else
    chmod 644 "$tmp"
    mv -f "$tmp" "$dst"
    changed=1
    log "$id: entry written from $src"
  fi
  sha256sum < "$dst" > "$sum.tmp.$$"
  mv -f "$sum.tmp.$$" "$sum"
  check_link "$id"
}

for id in "${ids[@]}"; do generate "$id"; done

# Launchers no longer configured.
for f in "$out"/*.desktop "$out"/.*.desktop.sum; do
  [[ -e $f ]] || continue
  id=${f##*/}; id=${id#.}; id=${id%.sum}; id=${id%.desktop}
  [[ -e $spec/$id ]] || remove "$id" "launcher no longer configured"
done

if (( changed )) && [[ -d $apps ]]; then touch -c "$apps"; fi
