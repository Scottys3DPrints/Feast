import { create } from 'zustand';
import NetInfo from '@react-native-community/netinfo';
import { StorageError } from '@feast/storage';
import { getStorage } from '../storage/provider';
import { downloadTalk, touch as touchCache } from '../cache/CacheManager';
import { sqlite } from '../db/client';
import {
  configureAudioSession,
  getPlayerService,
  type NowPlayingMeta,
  type PlayerError,
} from './PlayerService';
import {
  flushPosition,
  readPositionFast,
  shouldMarkPlayed,
  writePositionFast,
} from './positionStore';

/**
 * Playback orchestration — SPEC §11.2 (source resolution) and §11.4 (expiry recovery).
 *
 * This is where a logical path becomes audio. The queue lives here too, in JS, because
 * `AudioPlaylist` has no lock-screen API (§4.2 limit 2).
 */

export interface NowPlayingTalk {
  id: string;
  title: string;
  speakerName: string;
  archivePath: string;
  streamPath?: string | null;
  artworkPath?: string | null;
  artworkColor?: string | null;
  durationSec?: number | null;
  eventName?: string | null;
  sessionName?: string | null;
}

export type PlaybackStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

interface PlayerState {
  talk: NowPlayingTalk | null;
  status: PlaybackStatus;
  position: number;
  duration: number;
  buffering: boolean;
  rate: number;
  /** Honest, actionable text for the UI (§16). Never a bare "Playback failed". */
  error: string | null;
  /** JS-managed queue (§11.1). */
  queue: NowPlayingTalk[];
  queueIndex: number;

  playTalk(talk: NowPlayingTalk, opts?: { queue?: NowPlayingTalk[]; index?: number }): Promise<void>;
  toggle(): void;
  seekTo(sec: number): Promise<void>;
  seekRelative(delta: number): Promise<void>;
  setRate(rate: number): void;
  next(): Promise<void>;
  previous(): Promise<void>;
  stop(): void;
  retry(): Promise<void>;
}

/** §15.13 Downloads settings. Defaults per §2: Wi-Fi-only downloads on, streaming allowed. */
export const playbackSettings = {
  wifiOnlyDownloads: true,
  streamOnCellular: true,
  /** §11.5 — configurable skip intervals. */
  skipBackSec: 15,
  skipForwardSec: 30,
};

let wired = false;
/** Guards the §11.4 recovery against firing once per status tick. */
let recovering = false;
let recoveryAttempts = 0;
let lastPositionWrite = 0;

export const usePlayer = create<PlayerState>((set, get) => ({
  talk: null,
  status: 'idle',
  position: 0,
  duration: 0,
  buffering: false,
  rate: 1,
  error: null,
  queue: [],
  queueIndex: -1,

  async playTalk(talk, opts) {
    const player = getPlayerService();
    await ensureWired();

    set({
      talk,
      status: 'loading',
      error: null,
      position: 0,
      duration: talk.durationSec ?? 0,
      ...(opts?.queue ? { queue: opts.queue, queueIndex: opts.index ?? 0 } : {}),
    });

    try {
      const resolved = await resolveSource(talk);
      const start = readPositionFast(talk.id) ?? readPositionFromDb(talk.id);

      await player.load(resolved, metaFor(talk), start);
      recoveryAttempts = 0;
      player.play();
      set({ status: 'playing' });
      // LRU ordering has to reflect actual listening, or eviction (§11.3) throws away
      // the wrong things — a talk you replay weekly would look as stale as one you
      // downloaded and never opened.
      touchCache(talk.id);
    } catch (error) {
      set({ status: 'error', error: describe(error) });
    }
  },

  toggle() {
    const player = getPlayerService();
    player.togglePlay();
    set({ status: player.isPlaying() ? 'playing' : 'paused' });
    const { talk } = get();
    // Pause is one of the four durable flush points (§12.3).
    if (talk && !player.isPlaying()) flushPosition(talk.id, player.getPosition());
  },

  async seekTo(sec) {
    await getPlayerService().seekTo(sec);
    set({ position: sec });
  },

  async seekRelative(delta) {
    const player = getPlayerService();
    await player.seekRelative(delta);
    set({ position: player.getPosition() });
  },

  setRate(rate) {
    getPlayerService().setRate(rate);
    set({ rate });
  },

  async next() {
    const { queue, queueIndex, talk } = get();
    if (talk) flushPosition(talk.id, getPlayerService().getPosition());
    const nextIndex = queueIndex + 1;
    if (nextIndex >= queue.length) {
      get().stop();
      return;
    }
    await get().playTalk(queue[nextIndex]!, { queue, index: nextIndex });
  },

  async previous() {
    const { queue, queueIndex } = get();
    const player = getPlayerService();
    // Podcast convention: "previous" restarts the current talk unless you are already
    // near the start. Jumping tracks from three seconds in is almost never intended.
    if (player.getPosition() > 5 || queueIndex <= 0) {
      await get().seekTo(0);
      return;
    }
    await get().playTalk(queue[queueIndex - 1]!, { queue, index: queueIndex - 1 });
  },

  stop() {
    const { talk } = get();
    const player = getPlayerService();
    if (talk) flushPosition(talk.id, player.getPosition());
    player.pause();
    set({ status: 'idle', talk: null, position: 0, duration: 0, queueIndex: -1 });
  },

  async retry() {
    const { talk } = get();
    if (!talk) return;
    recoveryAttempts = 0;
    await get().playTalk(talk);
  },
}));

// ─── §11.2 source resolution ────────────────────────────────────────────────────

/**
 * The decision every play() makes, in the spec's exact order. Steps 1–2 are why a
 * downloaded talk sidesteps every signed-URL problem there is.
 */
async function resolveSource(talk: NowPlayingTalk): Promise<{ uri: string; local?: boolean }> {
  // 1 & 2 — a complete cache entry whose bytes match contentLength. The size check is
  // not paranoia: on Android a failed download leaves a partial file behind (§4.7),
  // and a truncated MP3 plays happily right up to the point where it stops.
  const cached = sqlite.getFirstSync<{ local_path: string }>(
    `SELECT local_path FROM cache_entries
     WHERE talk_id = ? AND state = 'complete' AND bytes = content_length AND content_length > 0
     ORDER BY CASE rendition WHEN 'stream' THEN 0 ELSE 1 END
     LIMIT 1`,
    [talk.id],
  );
  if (cached) return { uri: toFileUri(cached.local_path), local: true };

  const net = await NetInfo.fetch();

  // 3 — offline and not downloaded.
  if (!net.isConnected) {
    throw new StorageError('offline', talk.title, {
      message: `"${talk.title}" isn't downloaded and you're offline. Pin it for next time.`,
    });
  }

  // 4 — cellular with streaming disabled. Separate switch from downloads, by design.
  if (net.type === 'cellular' && !playbackSettings.streamOnCellular) {
    throw new StorageError('offline', talk.title, {
      message: `Streaming on cellular is off. Connect to Wi-Fi, or download "${talk.title}" for later.`,
    });
  }

  // 5 — prefer the compact stream rendition when one exists (§2, §11.2).
  const path = talk.streamPath ?? talk.archivePath;
  const { url } = await getStorage().getStreamUrl({ path });

  /*
   * §11.2's parallel cache write — "stream now, cache in parallel".
   *
   * ⚠️ This obeys `wifiOnlyDownloads` INDEPENDENTLY of the cellular check above. They
   * are separate switches by design (§2): cellular *streaming* is permitted while
   * cellular *downloads* default to off. Gating this on the streaming check instead
   * would double cellular data usage on every play — the exact opposite of what both
   * settings mean.
   *
   * Fire-and-forget: a failed background cache must never break playback, which is
   * already happily reading the remote URL.
   */
  if (!playbackSettings.wifiOnlyDownloads || net.type === 'wifi') {
    void downloadTalk(talk.id, path).catch(() => undefined);
  }

  return { uri: url };
}

function toFileUri(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`;
}

function metaFor(talk: NowPlayingTalk): NowPlayingMeta {
  return {
    title: talk.title,
    artist: talk.speakerName,
    ...(talk.artworkPath ? { artworkUri: toFileUri(talk.artworkPath) } : {}),
    ...(talk.durationSec ? { durationSec: talk.durationSec } : {}),
  };
}

function readPositionFromDb(talkId: string): number {
  const row = sqlite.getFirstSync<{ position_sec: number }>(
    'SELECT position_sec FROM listen_state WHERE talk_id = ?',
    [talkId],
  );
  return row?.position_sec ?? 0;
}

function describe(error: unknown): string {
  if (StorageError.is(error)) return error.message;
  return error instanceof Error ? error.message : 'Something went wrong starting playback.';
}

// ─── §11.4 expiry recovery ──────────────────────────────────────────────────────

/**
 * Wire the player's callbacks once. Kept out of module scope so `configureAudioSession`
 * runs before any listener can fire.
 */
async function ensureWired(): Promise<void> {
  if (wired) return;
  wired = true;

  await configureAudioSession();
  const player = getPlayerService();

  player.onProgress(({ position, duration, buffering }) => {
    usePlayer.setState({ position, duration, buffering });

    // §12.3 — MMKV at 1 Hz. The status callback fires at 2 Hz, so gate it.
    const talk = usePlayer.getState().talk;
    if (talk && player.isPlaying() && Date.now() - lastPositionWrite >= 1000) {
      lastPositionWrite = Date.now();
      writePositionFast(talk.id, position);
    }
  });

  player.onEnded(() => {
    const { talk } = usePlayer.getState();
    if (talk) {
      flushPosition(talk.id, player.getDuration(), { played: true, incrementPlayCount: true });
    }
    // §4.2 limit 1: this is the ONLY way the queue advances. There are no remote
    // next/previous events to listen for.
    void usePlayer.getState().next();
  });

  player.onError((error) => {
    void handlePlaybackError(error);
  });
}

/**
 * §11.4, implemented as written. Treat 403 as normal, not exceptional.
 *
 * Order matters: check the network BEFORE re-minting, so being offline doesn't burn a
 * Graph call and doesn't get misreported as an expiry.
 */
async function handlePlaybackError(error: PlayerError): Promise<void> {
  const state = usePlayer.getState();
  const talk = state.talk;
  if (!talk || recovering) return;

  if (error.kind !== 'expired-url' && error.kind !== 'network') {
    usePlayer.setState({ status: 'error', error: honestMessage(error, talk.title) });
    return;
  }

  const net = await NetInfo.fetch();
  if (!net.isConnected) {
    usePlayer.setState({
      status: 'error',
      error: `Lost your connection. "${talk.title}" isn't downloaded — reconnect and tap retry.`,
    });
    return;
  }

  if (recoveryAttempts >= 3) {
    usePlayer.setState({
      status: 'error',
      error: `Couldn't reach OneDrive after three tries. Tap retry, or pin "${talk.title}" for offline.`,
    });
    return;
  }

  recovering = true;
  recoveryAttempts++;
  const player = getPlayerService();
  const position = player.getPosition();
  const wasPlaying = state.status === 'playing';

  try {
    usePlayer.setState({ status: 'loading', error: null });
    const path = talk.streamPath ?? talk.archivePath;
    // Re-resolve. NEVER reuse a URL, and never persist one (§11.4 policy).
    const { url } = await getStorage().getStreamUrl({ path });
    await player.replaceAndRestore(url, position, wasPlaying);
    usePlayer.setState({ status: wasPlaying ? 'playing' : 'paused', position });
    recoveryAttempts = 0;
  } catch (e) {
    usePlayer.setState({ status: 'error', error: describe(e) });
  } finally {
    recovering = false;
  }
}

/** §16 — errors are honest and actionable, and always offer a way forward. */
function honestMessage(error: PlayerError, title: string): string {
  switch (error.kind) {
    case 'decode':
      return `"${title}" is in a format this phone can't play. Run \`feast transcode\` on your PC to convert it.`;
    case 'network':
      return `Couldn't reach OneDrive. Try again on Wi-Fi, or pin "${title}" for later.`;
    default:
      return `Playback stopped unexpectedly. Tap retry.`;
  }
}

/** Called from AppState 'background' — one of §12.3's four durable flush points. */
export function flushOnBackground(): void {
  const { talk } = usePlayer.getState();
  if (!talk) return;
  const player = getPlayerService();
  const position = player.getPosition();
  const duration = player.getDuration();
  flushPosition(talk.id, position, { played: shouldMarkPlayed(position, duration) });
}
