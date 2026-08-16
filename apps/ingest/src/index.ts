#!/usr/bin/env node
/**
 * `feast` — the desktop catalog builder.
 *
 * ⚠️ THE ONE RULE: this tool downloads NO AUDIO, and nothing it writes hosts audio.
 * It reads public APIs, records what each talk is and where the publisher already
 * serves it, and writes ~700 bytes per talk to Firestore. ~6,000 talks is ~5 MB; the
 * same talks as audio would be ~90 GB. Storing bytes we do not own, to re-serve files
 * their publishers already serve for free, would be the one decision that makes this
 * architecture both expensive and indefensible.
 *
 * Commands:
 *   feast index   crawl the public APIs into ~/.feast/source-index.json  (no audio)
 *   feast push    write that index to the shared Firestore catalog
 *   feast status  what is indexed, what is pushed
 */
import { indexCommand } from './commands/index-cmd.ts';
import { pushCommand } from './commands/push.ts';
import { statusCommand } from './commands/status.ts';

const HELP = `
feast — build the shared talk catalog

  feast index [--source gc|byu|all] [--since YYYY] [--limit N] [--refresh]
      Crawl the publishers' public APIs for metadata and audio URLs.
      Downloads no audio. Polite by construction: serial, >=1s between
      requests, identifying User-Agent, conditional requests.

  feast push [--dry-run]
      Write the local index to Firestore as the shared catalog.
      Requires FEAST_EMAIL and FEAST_PASSWORD for the maintainer account.

  feast status
      What is indexed locally and when it was last pushed.

Flags:
  --help    this text
`;

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;

  if (!command || command === '--help' || command === '-h') {
    console.log(HELP);
    return;
  }

  switch (command) {
    case 'index':
      await indexCommand(rest);
      return;
    case 'push':
      await pushCommand(rest);
      return;
    case 'status':
      await statusCommand();
      return;
    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error('\n✗', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
