/**
 * `feast index` — build the catalog from the publishers' public APIs.
 *
 * Metadata and audio URLs only. No audio is fetched here or anywhere downstream.
 */
import {
  ByuSpeechesAdapter,
  GeneralConferenceAdapter,
  PoliteClient,
  RequestCeilingError,
  withRetry,
} from '@feast/sources';
import { allTalks, loadIndex, mergeTalks, saveIndex } from '../sourceIndex.ts';

/**
 * §8: honest and identifying, with a contact address.
 *
 * ⚠️ Do not make this look like a browser. A publisher who objects to this traffic
 * should be able to reach a person rather than having to block an IP range — that is
 * the difference between polite automation and the kind §20.1 warns about.
 */
const USER_AGENT = 'Feast/0.1 (personal gospel-audio archive; samu.heslop@gmail.com)';

interface Args {
  source: 'gc' | 'byu' | 'all';
  since?: number;
  limit?: number;
  refresh: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { source: 'all', refresh: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--source' && value) {
      args.source = value as Args['source'];
      i += 1;
    } else if (flag === '--since' && value) {
      args.since = Number.parseInt(value, 10);
      i += 1;
    } else if (flag === '--limit' && value) {
      args.limit = Number.parseInt(value, 10);
      i += 1;
    } else if (flag === '--refresh') {
      args.refresh = true;
    }
  }
  return args;
}

export async function indexCommand(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const index = await loadIndex();

  const client = new PoliteClient({
    userAgent: USER_AGENT,
    minIntervalMs: 1_000,
    // A ceiling per run, so a bug in paging cannot turn into a crawl of the whole site.
    // Raised from 4,000: a full archive pass is ~3,900 requests and the missing years
    // push it past that. Still a hard stop against a paging bug becoming a crawl.
    dailyRequestLimit: 6_000,
  });

  console.log('Building the catalog. No audio is downloaded — metadata and URLs only.');
  console.log('One request per second, so this is slow by design.\n');

  if (args.source === 'gc' || args.source === 'all') {
    await indexGeneralConference(client, index, args);
  }
  if (args.source === 'byu' || args.source === 'all') {
    await indexByu(client, index, args);
  }

  await saveIndex(index);

  const total = allTalks(index).length;
  const bytes = Buffer.byteLength(JSON.stringify(allTalks(index)));
  console.log(`\n✓ ${total} talks indexed (${(bytes / 1024 / 1024).toFixed(1)} MB of metadata)`);
  console.log(`  ${client.requestsMade} requests made`);
  console.log('  Run `feast push` to publish this to the shared catalog.');
}

async function indexGeneralConference(
  client: PoliteClient,
  index: Awaited<ReturnType<typeof loadIndex>>,
  args: Args,
): Promise<void> {
  const adapter = new GeneralConferenceAdapter({ client });
  const thisYear = new Date().getUTCFullYear();

  // --refresh only walks back to the newest conference already seen; a first build
  // walks the whole archive.
  const startYear = args.since ?? (args.refresh ? lastYearSeen(index.gc.lastConference) : 1971);

  console.log(`General Conference: ${startYear} → ${thisYear}`);

  for (let year = thisYear; year >= startYear; year -= 1) {
    for (const month of ['10', '04']) {
      const node = `${year}/${month}`;
      if (args.refresh && index.gc.lastConference && node <= index.gc.lastConference) continue;

      try {
        const found = await withRetry(() =>
          adapter.discover(node, args.limit ? { limit: args.limit } : {}),
        );
        if (!found.length) continue;

        index.gc.talks = mergeTalks(index.gc.talks, found);
        if (!index.gc.lastConference || node > index.gc.lastConference) {
          index.gc.lastConference = node;
        }
        console.log(`  ${node}  +${found.length}  (${index.gc.talks.length} total)`);

        // Save as we go: a crawl this long must survive being interrupted.
        await saveIndex(index);
      } catch (e) {
        if (e instanceof RequestCeilingError) {
          console.log(`\n  ${e.message}`);
          return;
        }
        console.warn(`  ${node}  skipped: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  index.gc.builtAt = new Date().toISOString();
}

async function indexByu(
  client: PoliteClient,
  index: Awaited<ReturnType<typeof loadIndex>>,
  args: Args,
): Promise<void> {
  const adapter = new ByuSpeechesAdapter({ client });
  console.log('\nBYU Speeches');

  try {
    const node = args.refresh ? 'recent' : 'all';
    // Persist each page rather than only at the end — see the note in the adapter. A full
    // pass is 40+ minutes, and losing it costs BYU the same 4,000 requests again.
    const found = await withRetry(() =>
      adapter.discover(node, {
        ...(args.limit ? { limit: args.limit } : {}),
        onPage: async (page) => {
          index.byu.talks = mergeTalks(index.byu.talks, page);
          console.log(`  +${page.length}  (${index.byu.talks.length} total)`);
          await saveIndex(index);
        },
      }),
    );
    index.byu.talks = mergeTalks(index.byu.talks, found);
    index.byu.builtAt = new Date().toISOString();
    await saveIndex(index);
  } catch (e) {
    if (e instanceof RequestCeilingError) {
      console.log(`  ${e.message}`);
      return;
    }
    console.warn(`  skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function lastYearSeen(lastConference: string | null): number {
  if (!lastConference) return 1971;
  const year = Number.parseInt(lastConference.split('/')[0] ?? '', 10);
  return Number.isFinite(year) ? year : 1971;
}
