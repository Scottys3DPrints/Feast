/**
 * `@feast/sources` — pluggable acquisition (SPEC §8).
 *
 * Adapters discover metadata and the publisher's own audio URL. They never download
 * audio, and nothing downstream ever hosts it.
 */
export * from './types.ts';
export * from './http.ts';
export {
  GeneralConferenceAdapter,
  parseConferenceIndex,
  parseDurationMs,
  cleanSpeaker,
  htmlToText,
} from './generalConference.ts';
export { ByuSpeechesAdapter, speakerFromLink, stripTags } from './byuSpeeches.ts';
