import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ChevronLeft, Folder, Music } from 'lucide-react-native';
import { formatBytes, isAudioPath, parseFilename } from '@feast/core';
import type { StorageItem as Item } from '@feast/storage';
import { getStorage } from '../src/storage/provider';
import { isSignedIn, signIn } from '../src/auth/msAuth';
import { Button, Text } from '../src/ui/primitives';
import { useColors } from '../src/ui/theme';
import { radius, space, type as typeScale } from '../src/ui/tokens';
import { usePlayer } from '../src/player/store';

/**
 * PHASE 1 HARNESS — SPEC §18 Phase 1: "A single hardcoded list of talks from the drive;
 * tap to stream."
 *
 * This screen exists to validate the four Phase 1 exit criteria on a real device before
 * `feast-ingest` exists:
 *   (a) play from OneDrive on a locked iPhone AND Android with working lock-screen seek
 *   (b) seek to the middle of a 130 MB file in under 3 s
 *   (c) resolve a logical path to playing audio in ONE Graph round trip on a warm cache
 *   (d) survive a forced URL expiry without losing position
 *
 * ⚠️ This is NOT the in-app first scan that §15.1 forbids. That prohibition is about
 * building the *catalog* on-device — delta enumeration, filename parsing, and the §9.4
 * mapping table — which would trigger exactly the throttling §4.4 warns about. This
 * lists ONE folder non-recursively: a single `children` call, well inside the rules.
 * It writes nothing to the database.
 */
export default function DevBrowseScreen() {
  const colors = useColors();
  const router = useRouter();
  const playTalk = usePlayer((s) => s.playTalk);

  const [path, setPath] = useState('Talks');
  const [draft, setDraft] = useState('Talks');
  const [items, setItems] = useState<Item[]>([]);
  const [status, setStatus] = useState<'signed-out' | 'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (target: string) => {
    setStatus('loading');
    setError(null);
    try {
      if (!(await isSignedIn())) {
        setStatus('signed-out');
        return;
      }
      const page = await getStorage().list({ prefix: target, pageSize: 200 });
      setItems(page.items);
      setStatus('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    void load(path);
  }, [load, path]);

  const connect = async () => {
    try {
      const ok = await signIn();
      if (ok) void load(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  };

  const folders = items.filter((i) => i.isFolder);
  const audio = items.filter((i) => !i.isFolder && isAudioPath(i.name));

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', height: 46, paddingHorizontal: space.gutter }}>
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back">
          <ChevronLeft size={22} color={colors.textDim} strokeWidth={1.75} />
        </Pressable>
        <Text variant="title3" style={{ marginLeft: space.xs }}>
          Browse OneDrive
        </Text>
      </View>

      <View style={{ paddingHorizontal: space.gutter, gap: space.xs }}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={() => setPath(draft.trim())}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="Talks/By Speaker/Prophets"
          placeholderTextColor={colors.textFaint}
          accessibilityLabel="Folder path"
          style={[
            typeScale.mono,
            {
              color: colors.text,
              backgroundColor: colors.surface,
              borderColor: colors.border,
              borderWidth: 1,
              borderRadius: radius.sm,
              padding: space.xs,
            },
          ]}
        />
        <Text variant="caption" color="faint">
          Phase 1 harness — one `children` call, nothing written to the database.
        </Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: space.gutter, paddingBottom: space.xxl }}>
        {status === 'signed-out' ? (
          <View style={{ gap: space.sm }}>
            <Text variant="title2">Connect OneDrive</Text>
            <Text variant="body" color="dim">
              Feast reads your Talks folder and stores its own settings in a private app folder. It
              never writes to the rest of your drive.
            </Text>
            <Button title="Sign in with Microsoft" onPress={() => void connect()} />
          </View>
        ) : null}

        {status === 'loading' ? (
          <Text variant="body" color="dim">
            Loading {path}…
          </Text>
        ) : null}

        {status === 'error' ? (
          <View style={{ gap: space.xs }}>
            <Text variant="title3" color="warning">
              Couldn't list that folder
            </Text>
            <Text variant="mono" color="faint">
              {error}
            </Text>
            <Button title="Retry" kind="ghost" onPress={() => void load(path)} />
          </View>
        ) : null}

        {status === 'ready' ? (
          <>
            {folders.map((folder) => (
              <Pressable
                key={folder.id}
                onPress={() => {
                  const next = `${path}/${folder.name}`;
                  setDraft(next);
                  setPath(next);
                }}
                accessibilityRole="button"
                style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingVertical: space.xs }}
              >
                <Folder size={18} color={colors.textDim} strokeWidth={1.75} />
                <Text variant="title3" numberOfLines={1} style={{ flex: 1 }}>
                  {folder.name}
                </Text>
              </Pressable>
            ))}

            {audio.map((file) => (
              <AudioRow key={file.id} file={file} path={path} onPlay={playTalk} />
            ))}

            {!folders.length && !audio.length ? (
              <Text variant="body" color="dim">
                Nothing playable in {path}.
              </Text>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function AudioRow({
  file,
  path,
  onPlay,
}: {
  file: Item;
  path: string;
  onPlay: ReturnType<typeof usePlayer.getState>['playTalk'];
}) {
  const colors = useColors();
  // The same §9.5 parser the desktop tool uses, so this harness previews exactly what
  // the real import will make of these filenames.
  const parsed = parseFilename(file.name);

  return (
    <Pressable
      onPress={() =>
        void onPlay({
          // A synthetic id: this screen never touches the database, so nothing persists
          // against it. Real ids are UUIDv7 assigned at import (§9.2).
          id: `dev:${file.id}`,
          title: parsed.title,
          speakerName: parsed.speaker ?? file.audio?.artist ?? 'Unknown',
          // The logical path is the address — §7.1. Never the driveItem id.
          archivePath: `${path}/${file.name}`,
          durationSec: file.audio?.duration ? file.audio.duration / 1000 : null,
        })
      }
      accessibilityRole="button"
      accessibilityLabel={`Play ${parsed.title}`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingVertical: space.xs }}
    >
      <Music size={18} color={colors.accent} strokeWidth={1.75} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="title2" numberOfLines={1}>
          {parsed.title}
        </Text>
        <Text variant="caption" color="faint" numberOfLines={1}>
          {[parsed.speaker ?? file.audio?.artist, formatBytes(file.size)].filter(Boolean).join(' · ')}
        </Text>
      </View>
    </Pressable>
  );
}
