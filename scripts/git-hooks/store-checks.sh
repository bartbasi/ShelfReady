# ShelfReady git hooks: the store data checks pre-commit and commit-msg share. Sourced by them,
# never run on its own (git runs only files named after a hook, so this one is never run as a hook).
# Nothing here prints what matched: never a term, never the line that held it.

# Private lists outside the repo, read the same way: fixed strings, one per line, any case.
# store-terms.txt holds store data terms. store-net.txt holds the store's own network values
# (its host name, the PC's name, the tailnet prefix), so none of them sits in the repo.
STORE_TERMS_FILE="$HOME/.config/shelfready/store-terms.txt"
STORE_NET_FILE="$HOME/.config/shelfready/store-net.txt"

# The one network rule kept in the repo: the 192.168/16 prefix, written so this file never
# matches itself. Extended regex, any case.
STORE_NET_PATTERN='192\.168\.'

# store_list_load LIST OUT: LIST cleaned (no CR, no edge spaces, no blank or # lines) into OUT.
# OUT is empty when LIST is not there. Returns 1 when LIST is there but cannot be read.
store_list_load() {
  : > "$2"
  # Missing (and not a dangling link): nothing to check. Anything else that is not a readable
  # regular file (a directory, a dangling link, no read access) refuses, never fails open.
  if [ ! -e "$1" ] && [ ! -L "$1" ]; then return 0; fi
  [ -f "$1" ] && [ -r "$1" ] || return 1
  sed -e 's/\r$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$1" > "$2.raw" || return 1
  grep -vE '^(#|$)' "$2.raw" > "$2" || true
  rm -f "$2.raw"
}

# store_terms_load OUT: the store terms into OUT. Returns 1 when the file cannot be read.
store_terms_load() {
  store_list_load "$STORE_TERMS_FILE" "$1"
}

# store_net_load OUT: the private network values into OUT. Returns 1 when the file cannot be read.
store_net_load() {
  store_list_load "$STORE_NET_FILE" "$1"
}

# store_terms_match LIST FILE: true when FILE holds any fixed string in LIST, in any case.
store_terms_match() {
  [ -s "$1" ] && grep -iqFf "$1" "$2"
}

# store_net_match NETLIST FILE: true when FILE holds the 192.168/16 prefix or any value in NETLIST.
store_net_match() {
  grep -iqE "$STORE_NET_PATTERN" "$2" || store_terms_match "$1" "$2"
}

# store_net_note HOOK: the one-line note when there is no private network list.
store_net_note() {
  [ -e "$STORE_NET_FILE" ] || [ -L "$STORE_NET_FILE" ] || echo "$1: note: no $STORE_NET_FILE, so only the 192.168/16 prefix is checked for store network values." >&2
}
