/** `feast status` — what is indexed locally, and when it was last published. */
import { allTalks, INDEX_PATH, loadIndex } from '../sourceIndex.ts';

export async function statusCommand(): Promise<void> {
  const index = await loadIndex();
  const talks = allTalks(index);

  if (!talks.length) {
    console.log('No catalog yet. Run `feast index` to build one.');
    return;
  }

  const bytes = Buffer.byteLength(JSON.stringify(talks));
  const withTranscript = talks.filter((t) => t.transcript).length;

  console.log(`Index:   ${INDEX_PATH}`);
  console.log(`Talks:   ${talks.length}  (${(bytes / 1024 / 1024).toFixed(1)} MB metadata)`);
  console.log(`  General Conference  ${index.gc.talks.length}  (through ${index.gc.lastConference ?? '—'})`);
  console.log(`  BYU Speeches        ${index.byu.talks.length}`);
  console.log(`Transcripts: ${withTranscript}`);
  console.log(`Last pushed: ${index.lastPushedAt ?? 'never'}`);
  console.log('\nAudio stored: 0 bytes — every talk streams from its publisher.');
}
