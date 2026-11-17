// The 4-digit scale code at the very end of a Square item name ("Smoked Swiss 1234"). One
// function for matching and pricing, so the two always read a name the same way. Whether the
// number really is a scale code (a wine named for its year ends in 4 digits too) is decided by
// the matching step's catalog index, not here.

/** Longest name looked at. Real names are far shorter. */
const MAX_NAME = 300;

export interface CodeSplit {
  /** The name without the number, trimmed. */
  base: string;
  /** The 4 digits at the very end of the name, or null. */
  trailing: string | null;
}

/**
 * Splits off the 4-digit number a name ends with, as its own word: after a space, a hyphen, an
 * en or em dash, or a comma ("Brie - 8oz - 1234"). Digits inside a longer word or number
 * ("ABC1234", "12345") do not count.
 */
export function splitTrailingCode(name: string): CodeSplit {
  const text = name.slice(0, MAX_NAME);
  const m = /(^|[\s\-\u2013\u2014,])(\d{4})\s*$/.exec(text);
  if (!m) return { base: text.trim(), trailing: null };
  const base = text
    .slice(0, m.index + m[1]!.length)
    .replace(/[\s\-\u2013\u2014,]+$/, '')
    .trim();
  return { base, trailing: m[2]! };
}

/** The 4 digits a name ends with, or null. */
export function trailingScaleCode(name: string): string | null {
  return splitTrailingCode(name).trailing;
}
