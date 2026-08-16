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
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { doc, getFirestore, writeBatch } from 'firebase/firestore';
import type { DiscoveredTalk } from '@feast/sources';
import { allTalks, loadIndex, saveIndex } from '../sourceIndex.ts';

const FIREBASE = {
  apiKey: process.env['FEAST_FIREBASE_API_KEY'] ?? '',
  authDomain: process.env['FEAST_FIREBASE_AUTH_DOMAIN'] ?? '',
  projectId: process.env['FEAST_FIREBASE_PROJECT_ID'] ?? '',
  storageBucket: process.env['FEAST_FIREBASE_STORAGE_BUCKET'] ?? '',
  messagingSenderId: process.env['FEAST_FIREBASE_MESSAGING_SENDER_ID'] ?? '',
  appId: process.env['FEAST_FIREBASE_APP_ID'] ?? '',
};

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

export async function pushCommand(argv: string[]): Promise<void> {
  const dryRun = argv.includes('--dry-run');
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
    `Transcripts: ${transcripts.length}, ${(transcriptBytes / 1024 / 1024).toFixed(1)} MB (separate collection)`,
  );
  console.log('Audio:       0 bytes — streamed from the publishers.\n');

  if (dryRun) {
    console.log('--dry-run: nothing written.');
    return;
  }

  const email = process.env['FEAST_EMAIL'];
  const password = process.env['FEAST_PASSWORD'];
  if (!email || !password) {
    throw new Error(
      'Set FEAST_EMAIL and FEAST_PASSWORD for the maintainer account.\n' +
        '  Firestore rules only allow catalog writes from that verified address.',
    );
  }
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
      if (talk.transcript) {
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
