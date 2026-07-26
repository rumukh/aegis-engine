#!/usr/bin/env node
/**
 * The `aegis` executable entry point. Adapts Node's `process` to the {@link CliIO} seam and
 * exits with the dispatcher's return code. Kept minimal and free of logic so it needs no tests.
 * @packageDocumentation
 */
import { main } from './cli.js';
import type { CliIO } from './io.js';

const io: CliIO = {
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
};

main(io)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`fatal: ${String(error)}\n`);
    process.exitCode = 1;
  });
