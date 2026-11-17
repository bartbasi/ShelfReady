// Reads a line from the terminal. With hidden set, nothing typed is shown.
// Passwords only ever come from here, never from arguments or the environment.

import { stdin, stdout } from 'node:process';

export function requireTerminal(): void {
  if (!stdin.isTTY) {
    throw new Error('Run this in a terminal. Passwords are typed in, never piped or passed as arguments.');
  }
}

export function ask(question: string, hidden: boolean): Promise<string> {
  requireTerminal();
  return new Promise((resolve, reject) => {
    let input = '';
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (err?: Error): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdout.write('\n');
      if (err) reject(err);
      else resolve(input);
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new Error('Cancelled.'));
        if (ch === '\u0004') return done();
        if (ch === '\u007f' || ch === '\b') {
          if (input.length > 0) {
            input = input.slice(0, -1);
            if (!hidden) stdout.write('\b \b');
          }
          continue;
        }
        if (ch < ' ') continue;
        input += ch;
        if (!hidden) stdout.write(ch);
      }
    };
    stdin.on('data', onData);
  });
}

/** Asks twice and checks both match. */
export async function askNewPassword(): Promise<string> {
  const a = await ask('New password: ', true);
  const b = await ask('Same password again: ', true);
  if (a !== b) throw new Error('The two passwords do not match.');
  return a;
}

export function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}
