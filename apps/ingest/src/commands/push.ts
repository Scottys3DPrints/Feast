/**
 * `feast push` — publish the local index to the shared Firestore catalog.
 *
 * What actually goes over the wire, per talk: title, speaker, date, session, duration,
 * the publisher's audio URL, and the canonical page. About 700 bytes. Transcripts go to
 * a SEPARATE subcollection so the phone's initial sync stays small and only pays for a
 * transcript when someone opens that talk.
 *
 * ⚠️ NO AUDIO. Not here, not anywhere. The catalog is a card index pointing at files
 * the publishers already serve.
 */
import { readFileSync } from 'node:fs';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { doc, getFirestore, writeBatch } from 'firebase/firestore';
import type { DiscoveredTalk } from '@feast/sources';
import { allTalks, loadIndex, saveIndex } from '../sourceIndex.ts';

/**
 * Firebase config, from the environment or — failing that — the app's own `.env.local`.
 *
 * Reusing the app's file means one place to keep these in step, and no ceremony of
 * exporting six variables before a push. They are not secrets: a Firebase web config
 * ships inside every client. Access is controlled by firestore.rules, which pins
 * catalog writes to a single account UID.
 */
function readFirebaseConfig(): Record<string, string> {
  const fromEnv = {
    apiKey: process.env['FEAST_FIREBASE_API_KEY'] ?? '',
    authDomain: process.env['FEAST_FIREBASE_AUTH_DOMAIN'] ?? '',
    projectId: process.env['FEAST_FIREBASE_PROJECT_ID'] ?? '',
    storageBucket: process.env['FEAST_FIREBASE_STORAGE_BUCKET'] ?? '',
    messagingSenderId: process.env['FEAST_FIREBASE_MESSAGING_SENDER_ID'] ?? '',
    appId: process.env['FEAST_FIREBASE_APP_ID'] ?? '',
  };
  if (fromEnv.apiKey && fromEnv.projectId) return fromEnv;

  try {
    const path = new URL('../../../mobile/.env.local', import.meta.url);
    const text = readFileSync(path, 'utf8');
    const get = (key: string): string =>
      new RegExp(`^${key}=(.*)$`, 'm').exec(text)?.[1]?.trim() ?? '';
    return {
      apiKey: get('EXPO_PUBLIC_FIREBASE_API_KEY'),
      authDomain: get('EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN'),
      projectId: get('EXPO_PUBLIC_FIREBASE_PROJECT_ID'),
      storageBucket: get('EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET'),
      messagingSenderId: get('EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID'),
      appId: get('EXPO_PUBLIC_FIREBASE_APP_ID'),
    };
  } catch {
    return fromEnv;
  }
}

const FIREBASE = readFirebaseConfig();

/** Firestore ids may not contain '/', and externalIds are URI-shaped. */
function docId(externalId: string): string {
  return externalId.replace(/[/#?[\]*]/g, '_');
}

/** The shape stored in `catalog/talks`. Deliberately flat and small. */
function toCatalogDoc(talk: DiscoveredTalk, now: number): Record<string, unknown> {
  const out: Record<string, unknown> = {
    externalId: talk.externalId,
    title: talk.title,
    speaker: talk.speaker,
    audioUrl: talk.audioUrl,
    sourceUrl: talk.sourceUrl,
    tags: talk.suggestedTags,
    updatedAt: now,
    // Which adapter produced this, so a later fix can target one source.
    source: talk.externalId.startsWith('gc:') ? 'general-conference' : 'byu-speeches',
  };
  // Firestore rejects undefined outright, so optionals are added only when present.
  if (talk.durationSec !== undefined) out['durationSec'] = talk.durationSec;
  if (talk.sizeBytes !== undefined) out['sizeBytes'] = talk.sizeBytes;
  if (talk.publishedAt) out['publishedAt'] = talk.publishedAt;
  if (talk.eventName) out['eventName'] = talk.eventName;
  if (talk.sessionName) out['sessionName'] = talk.sessionName;
  if (talk.speakerRole) out['speakerRole'] = talk.speakerRole;
  return out;
}

/**
 * Ask for the password without echoing it, and without it landing in shell history or
 * an environment variable. `FEAST_PASSWORD` stays supported for unattended runs.
 */
async function promptPassword(prompt: string): Promise<string> {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });

  return new Promise((resolve) => {
    const stdout = process.stdout as NodeJS.WriteStream & { muted?: boolean };
    stdout.muted = false;
    // Swallow the echoed characters while muted, but keep the prompt itself visible.
    const write = stdout.write.bind(stdout);
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (stdout.muted) write('');
      else write(s);
    };
    rl.question(prompt, (answer) => {
      stdout.muted = false;
      write('\n');
      rl.close();
      resolve(answer);
    });
    stdout.muted = true;
  });
}

export async function pushCommand(argv: string[]): Promise<void> {
  const dryRun = argv.includes('--dry-run');
  /**
   * Transcripts are OPT-IN, deliberately.
   *
   * Metadata is a list of public recordings and public links — publishing it shares
   * nothing that isn't already public. A transcript is the publisher's text, and
   * `catalog/` is world-readable, so including them publishes a searchable copy of
   * every General Conference transcript to anyone with the app. That is a materially
   * bigger step, it is far harder to walk back than to delay, and neither publisher has
   * been asked. So the flag defaults to off and has to be typed on purpose.
   */
  const withTranscripts = argv.includes('--with-transcripts');
  const index = await loadIndex();
  const talks = allTalks(index);

  if (!talks.length) {
    console.log('Nothing to push. Run `feast index` first.');
    return;
  }

  const now = Date.now();
  const docs = talks.map((t) => toCatalogDoc(t, now));
  const metaBytes = Buffer.byteLength(JSON.stringify(docs));
  const transcripts = talks.filter((t) => t.transcript);
  const transcriptBytes = transcripts.reduce(
    (n, t) => n + Buffer.byteLength(t.transcript ?? ''),
    0,
  );

  console.log(`Catalog:     ${talks.length} talks, ${(metaBytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(
    withTranscripts
      ? `Transcripts: ${transcripts.length}, ${(transcriptBytes / 1024 / 1024).toFixed(1)} MB — PUBLISHED (world-readable)`
      : `Transcripts: ${transcripts.length} held back locally (${(transcriptBytes / 1024 / 1024).toFixed(1)} MB). Pass --with-transcripts to publish.`,
  );
  console.log('Audio:       0 bytes — streamed from the publishers.\n');

  if (dryRun) {
    console.log('--dry-run: nothing written.');
    return;
  }

  const email = process.env['FEAST_EMAIL'];
  if (!email) {
    throw new Error('Set FEAST_EMAIL to the maintainer account address.');
  }
  const password = process.env['FEAST_PASSWORD'] ?? (await promptPassword(`Password for ${email}: `));
  if (!password) throw new Error('No password given.');
  if (!FIREBASE.apiKey || !FIREBASE.projectId) {
    throw new Error('Set FEAST_FIREBASE_* environment variables (see apps/ingest/README.md).');
  }

  const app = initializeApp(FIREBASE);
  const auth = getAuth(app);
  const db = getFirestore(app);

  await signInWithEmailAndPassword(auth, email, password);
  console.log(`Signed in as ${email}\n`);

  // Firestore caps a batch at 500 writes.
  let written = 0;
  for (let i = 0; i < talks.length; i += 400) {
    const chunk = talks.slice(i, i + 400);
    const batch = writeBatch(db);

    for (const talk of chunk) {
      const id = docId(talk.externalId);
      batch.set(doc(db, 'catalog', 'v1', 'talks', id), toCatalogDoc(talk, now), { merge: true });
      if (withTranscripts && talk.transcript) {
        batch.set(
          doc(db, 'catalog', 'v1', 'transcripts', id),
          { talkId: talk.externalId, text: talk.transcript, updatedAt: now },
          { merge: true },
        );
      }
    }

    await batch.commit();
    written += chunk.length;
    process.stdout.write(`\r  pushed ${written}/${talks.length}`);
  }

  index.lastPushedAt = new Date().toISOString();
  await saveIndex(index);

  console.log(`\n\n✓ Catalog published. ${written} talks are now visible to every account.`);
}
