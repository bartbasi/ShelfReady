// Reading a file the config names, safely. Used for fonts and the branding file.
// The real path (symlinks resolved) must sit inside an allowed folder. The file is opened without
// following a link and without blocking (so a FIFO cannot hang start), must be a regular file of
// a sane size, and is read through that one descriptor to its full length.

import { closeSync, constants as fsc, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { sep } from 'node:path';

export type FileProblem = 'unreadable' | 'outside' | 'not-a-file' | 'size' | 'changed';

export class SafeFileError extends Error {
  readonly problem: FileProblem;
  constructor(problem: FileProblem) {
    super(problem);
    this.problem = problem;
  }
}

export function readFileUnder(path: string, allowedDirs: readonly string[], limits: { min: number; max: number }): { bytes: Buffer; realPath: string } {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw new SafeFileError('unreadable');
  }
  const roots = allowedDirs.flatMap((d) => {
    try {
      return [realpathSync(d) + sep];
    } catch {
      return [];
    }
  });
  if (!roots.some((r) => real.startsWith(r))) throw new SafeFileError('outside');
  let fd: number;
  try {
    fd = openSync(real, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
  } catch {
    throw new SafeFileError('unreadable');
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new SafeFileError('not-a-file');
    if (st.size < limits.min || st.size > limits.max) throw new SafeFileError('size');
    const bytes = Buffer.alloc(st.size);
    let got = 0;
    while (got < st.size) {
      const n = readSync(fd, bytes, got, st.size - got, got);
      if (n === 0) break;
      got += n;
    }
    if (got !== st.size) throw new SafeFileError('changed');
    return { bytes, realPath: real };
  } finally {
    closeSync(fd);
  }
}
