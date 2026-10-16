#!/usr/bin/env node
import process from "node:process";

import {
  parseArgs,
  startStdioServer,
  USAGE,
  type CliOptions,
} from "./stdio-session.js";
import { writeDescriptor } from "./io.js";

/**
 * The `glasspane-mcp` bin: read the command line, then run the stdio session.
 *
 * The whole wiring lives in `./stdio-session.js`, which imports cleanly. This file
 * is the part that may not — it is a program, and a program takes over the stdio it
 * is handed. Keeping the two apart is what lets a host or a test reach the wiring
 * without being replaced by it, and it does that without an `argv[1]`/`require.main`
 * self-exec guard here: that guard is the shape that once made the bin resolve to a
 * module nobody ran and 0-byte'd the published package across 19 versions. There is
 * no branch to get wrong in `main()` — it always runs — and the bin is proven by
 * `test/published-artifact.test.mjs`, which drives the installed symlink.
 */
function main(): void {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    // Synchronous, and the whole message: this is the path an operator who
    // misspelled a flag lands on, and a truncated one reads as "the shell printed
    // nothing and exited 2".
    writeDescriptor(2, String(error) + "\n\n" + USAGE);
    process.exit(2);
  }

  if (options.help) {
    writeDescriptor(1, USAGE);
    process.exit(0);
  }

  startStdioServer(options);
}

main();
