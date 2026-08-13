import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';

/**
 * PlayerService — SPEC §11.1, §11.4. The swap boundary.
 *
 * Kept deliberately narrow so `@rntp/player` remains a ONE-FILE replacement if
 * Android Auto ever forces the issue (§4.9). Nothing outside `src/player/` may import
 * `expo-audio`.
 *
 * FOUR expo-audio facts this design is built around (§4.2, verified from shipped
 * typings — do not substitute training-data assumptions):
 *
 *   1. NO remote-command events reach JS. `AudioEvents` is exactly
 *      `{ playbackStatusUpdate, audioSampleUpdate }`. There is no `RemoteNext` or
 *      `RemoteSeek` listener. ⇒ The JS queue advances on `onEnded` ONLY, and the
 *      lock screen shows seek buttons rather than next/previous (acceptance #4).
 *   2. `AudioPlaylist` has no lock-screen API — only `AudioPlayer` does. ⇒ ONE
 *      AudioPlayer, queue managed in JS (`queue.ts`). Do NOT use `useAudioPlaylist`.
 *   3. No persistent disk cache. `downloadFirst: true` uses tmp and "the system will
 *      purge the file at its discretion." We build the cache ourselves (§11.3).
 *   4. Android: without `setActiveForLockScreen`, audio STOPS after ~3 minutes in the
 *      background. It is not optional polish.
 */

export interface NowPlayingMeta {
  title: string;
  artist: string;
  /** Local file path or remote URL for lock-screen artwork. */
  artworkUri?: string;
  durationSec?: number;
}

export interface PlayerProgress {
  position: number;
  duration: number;
  buffering: boolean;
}

export type PlayerErrorKind = 'expired-url' | 'network' | 'decode' | 'unknown';

export interface PlayerError {
  kind: PlayerErrorKind;
  message: string;
}

export type Unsub = () => void;

export interface PlayerSource {
  uri: string;
  /** True when `uri` is a `file://` path — used to classify errors correctly. */
  local?: boolean;
}

export interface PlayerService {
  load(source: PlayerSource, meta: NowPlayingMeta, startPositionSec?: number): Promise<void>;
  play(): void;
  pause(): void;
  togglePlay(): void;
  seekTo(sec: number): Promise<void>;
  /** ±15 / ±30 (§11.5). */
  seekRelative(delta: number): Promise<void>;
  /** 0.8 … 3.0, with pitch correction. */
  setRate(rate: number): void;
  setNowPlaying(meta: NowPlayingMeta): void;
  /** Re-point at a freshly minted URL and restore position — the §11.4 recovery. */
  replaceAndRestore(uri: string, positionSec: number, resume: boolean): Promise<void>;
  getPosition(): number;
  getDuration(): number;
  isPlaying(): boolean;
  onProgress(cb: (p: PlayerProgress) => void): Unsub;
  onEnded(cb: () => void): Unsub;
  onError(cb: (e: PlayerError) => void): Unsub;
  release(): void;
}

/**
 * ✅ §4.3 — required exactly once at app start. `interruptionMode: 'doNotMix'` is not
 * a preference: lock-screen controls do not bind without it.
 */
export async function configureAudioSession(): Promise<void> {
  await setAudioModeAsync({
    playsInSilentMode: true, // iOS ringer switch off must not silence a talk
    shouldPlayInBackground: true,
    interruptionMode: 'doNotMix',
  });
}

class ExpoAudioPlayerService implements PlayerService {
  #player: AudioPlayer;
  #progressSubs = new Set<(p: PlayerProgress) => void>();
  #endedSubs = new Set<() => void>();
  #errorSubs = new Set<(e: PlayerError) => void>();
  #meta: NowPlayingMeta | null = null;
  #currentIsLocal = false;
  /** `didJustFinish` can fire more than once for one track; collapse the duplicates. */
  #endedFor: string | null = null;
  #statusSub: { remove(): void } | null = null;

  constructor() {
    this.#player = createAudioPlayer(null, { updateInterval: 500 });
    this.#statusSub = this.#player.addListener('playbackStatusUpdate', (status) => {
      for (const cb of this.#progressSubs) {
        cb({
          position: status.currentTime ?? 0,
          duration: status.duration ?? 0,
          buffering: status.isBuffering ?? false,
        });
      }

      if (status.didJustFinish) {
        const key = String(status.duration ?? 0);
        if (this.#endedFor !== key) {
          this.#endedFor = key;
          for (const cb of this.#endedSubs) cb();
        }
      }

      if (status.error) {
        const error = this.#classify(String(status.error));
        for (const cb of this.#errorSubs) cb(error);
      }
    });
  }

  /**
   * §11.4 hinges on telling an expired signature apart from being offline, because
   * only the former is worth spending a Graph call on. A local file can never fail
   * for signature reasons, which is the cheapest half of the distinction.
   */
  #classify(message: string): PlayerError {
    const lower = message.toLowerCase();
    if (!this.#currentIsLocal && (lower.includes('403') || lower.includes('forbidden'))) {
      return { kind: 'expired-url', message };
    }
    if (
      lower.includes('network') ||
      lower.includes('timed out') ||
      lower.includes('unable to resolve host') ||
      lower.includes('connection')
    ) {
      return { kind: 'network', message };
    }
    if (lower.includes('decode') || lower.includes('format') || lower.includes('unsupported')) {
      return { kind: 'decode', message };
    }
    // Unknown non-local failures are treated as expiry by the caller's retry policy:
    // re-minting a URL is one cheap Graph call, and expiry is by far the likeliest
    // cause of a mid-stream failure on a signed OneDrive URL (§11.4).
    return { kind: this.#currentIsLocal ? 'unknown' : 'expired-url', message };
  }

  async load(source: PlayerSource, meta: NowPlayingMeta, startPositionSec = 0): Promise<void> {
    this.#meta = meta;
    this.#currentIsLocal = source.local ?? source.uri.startsWith('file:');
    this.#endedFor = null;

    this.#player.replace({ uri: source.uri });
    await this.#waitUntilLoaded();

    if (startPositionSec > 0) await this.#player.seekTo(startPositionSec);

    this.setNowPlaying(meta);
  }

  /**
   * ⚠️ §11.4: `replace()` RESOLVING IS NOT THE SAME AS THE SOURCE BEING LOADED.
   * Seeking before the player reports a real duration is silently dropped and playback
   * restarts at 0:00 — which is exactly how "it lost my place" bugs happen.
   */
  async #waitUntilLoaded(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.#player.isLoaded && this.#player.duration > 0) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('Timed out waiting for the audio source to load.');
  }

  play(): void {
    this.#player.play();
  }

  pause(): void {
    this.#player.pause();
  }

  togglePlay(): void {
    if (this.#player.playing) this.#player.pause();
    else this.#player.play();
  }

  async seekTo(sec: number): Promise<void> {
    await this.#player.seekTo(Math.max(0, sec));
  }

  async seekRelative(delta: number): Promise<void> {
    const target = Math.max(0, Math.min(this.getDuration() || Infinity, this.getPosition() + delta));
    await this.seekTo(target);
  }

  setRate(rate: number): void {
    // `high` quality keeps pitch correction on — speech at 2× without it is unlistenable.
    this.#player.setPlaybackRate(Math.max(0.8, Math.min(3, rate)), 'high');
  }

  setNowPlaying(meta: NowPlayingMeta): void {
    this.#meta = meta;
    // §4.2 limit 1: only seek buttons are available, so we ask for both and let the
    // JS queue handle track advancement on `onEnded`.
    this.#player.setActiveForLockScreen(
      true,
      {
        title: meta.title,
        artist: meta.artist,
        ...(meta.artworkUri ? { artwork: meta.artworkUri } : {}),
      },
      { showSeekForward: true, showSeekBackward: true },
    );
  }

  /**
   * §11.4's recovery sequence, in the order that actually works:
   * replace → AWAIT LOADED → seek → resume. Every step matters.
   */
  async replaceAndRestore(uri: string, positionSec: number, resume: boolean): Promise<void> {
    this.#currentIsLocal = uri.startsWith('file:');
    this.#player.replace({ uri });
    await this.#waitUntilLoaded();
    await this.#player.seekTo(positionSec); // replace() does NOT preserve position
    if (this.#meta) this.setNowPlaying(this.#meta);
    if (resume) this.#player.play();
  }

  getPosition(): number {
    return this.#player.currentTime ?? 0;
  }

  getDuration(): number {
    return this.#player.duration ?? 0;
  }

  isPlaying(): boolean {
    return this.#player.playing ?? false;
  }

  onProgress(cb: (p: PlayerProgress) => void): Unsub {
    this.#progressSubs.add(cb);
    return () => this.#progressSubs.delete(cb);
  }

  onEnded(cb: () => void): Unsub {
    this.#endedSubs.add(cb);
    return () => this.#endedSubs.delete(cb);
  }

  onError(cb: (e: PlayerError) => void): Unsub {
    this.#errorSubs.add(cb);
    return () => this.#errorSubs.delete(cb);
  }

  release(): void {
    this.#statusSub?.remove();
    this.#statusSub = null;
    this.#player.remove();
  }
}

let singleton: PlayerService | null = null;

/** ONE AudioPlayer for the whole app (§4.2 limit 2). */
export function getPlayerService(): PlayerService {
  singleton ??= new ExpoAudioPlayerService();
  return singleton;
}
