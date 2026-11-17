// Keeps secrets out of anything shown or logged: review reasons, audit records, saved results.
// An error can carry a key. For example, a key with a line break makes fetch throw an error that
// quotes the header value, and the SDK builds headers outside its own error handling.
//
// A key can contain a break or end anywhere, so trimming the key out of a message could leave
// part of it behind. A message that mentions anything key-like is dropped whole instead.
//
// The text is normalized (NFKC, so full-width letters become plain ones) and every control or
// invisible character is removed before matching, so a key split by NUL, a line break or a
// zero-width space is still found.

// Key syntax and header syntax only. Plain words such as "API key" are fine and stay readable.
const KEY_HINTS = /sk-ant|bearer\s|x-api-key|authorization\s*:|api[-_]key\s*[:=]/i;

/**
 * Characters that show nothing: C0 and C1 controls with DEL, the soft hyphen, the Arabic letter
 * mark, the Mongolian vowel separator, zero-width space and joiners, direction marks and
 * overrides, line and paragraph separators, invisible operators, and the byte order mark.
 * Written as numbers, so no editor or tool can turn an escape into the character itself.
 */
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x206f],
  [0xfeff, 0xfeff],
];

function isInvisible(codePoint: number): boolean {
  return INVISIBLE_RANGES.some(([lo, hi]) => codePoint >= lo && codePoint <= hi);
}

/** Removes every invisible character. Tab, line feed and carriage return become a space first. */
export function stripInvisible(text: string, keepBreaksAsSpaces = false): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (keepBreaksAsSpaces && (cp === 0x09 || cp === 0x0a || cp === 0x0d)) out += ' ';
    else if (!isInvisible(cp)) out += ch;
  }
  return out;
}

export const REMOVED = '[details removed because they may contain a key]';

/** Makes text safe for screens and logs: nothing key-like, one line, capped length. */
export function redactSecrets(text: string, maxLength = 500): string {
  const normalized = String(text).normalize('NFKC');
  // For matching, every invisible character goes, so nothing can split the key syntax. A key
  // prefix split by spaces is caught too.
  const visible = stripInvisible(normalized);
  if (KEY_HINTS.test(visible) || /sk-ant/i.test(visible.replace(/\s+/g, ''))) return REMOVED;
  const clean = stripInvisible(normalized, true).replace(/ {2,}/g, ' ');
  return clean.length > maxLength ? `${clean.slice(0, maxLength)}...` : clean;
}
