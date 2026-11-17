// Text from Mailchimp (or anywhere outside this PC), made safe to print on one line: control
// characters, terminal escapes included, and the bidi overrides and isolates that can reorder
// what a person reads become "?". max caps the length; pass Infinity for a whole printed line.

const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

export function clean(s: unknown, max = 200): string {
  return String(s ?? '').replace(UNSAFE, '?').slice(0, max);
}
