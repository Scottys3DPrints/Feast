/**
 * The Microsoft Graph wire shapes we actually consume.
 *
 * ⚠️ These types may not be imported anywhere outside `packages/storage/`
 * (§7.2 rule 1, acceptance criterion 18). They are deliberately hand-written and
 * minimal rather than pulled from `@microsoft/microsoft-graph-types` — a dependency
 * that big, in a package this boundary-sensitive, invites exactly the leak the rule
 * exists to prevent.
 */

export interface GraphAudioFacet {
  album?: string;
  albumArtist?: string;
  artist?: string;
  bitrate?: number;
  composers?: string;
  copyright?: string;
  disc?: number;
  duration?: number;
  genre?: string;
  hasDrm?: boolean;
  isVariableBitrate?: boolean;
  title?: string;
  track?: number;
  year?: number;
}

export interface GraphDriveItem {
  id: string;
  name?: string;
  size?: number;
  lastModifiedDateTime?: string;
  file?: {
    mimeType?: string;
    hashes?: { quickXorHash?: string; sha1Hash?: string; sha256Hash?: string };
  };
  folder?: { childCount?: number };
  audio?: GraphAudioFacet;
  deleted?: { state?: string };
  parentReference?: {
    id?: string;
    driveId?: string;
    /** ⚠️ §4.4: OMITTED in delta responses. Never rely on it there. */
    path?: string;
  };
  /** Present only when explicitly `$select`ed. Never persist it (§11.4). */
  '@microsoft.graph.downloadUrl'?: string;
  '@microsoft.graph.conflictBehavior'?: string;
  eTag?: string;
  cTag?: string;
}

export interface GraphCollection<T> {
  value: T[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

/** `$select` for delta and list: everything the catalog needs, nothing it doesn't. */
export const ITEM_SELECT = [
  'id',
  'name',
  'size',
  'lastModifiedDateTime',
  'file',
  'folder',
  'audio',
  'parentReference',
  'deleted',
].join(',');

/** `$select` for the playback hot path — one call yields the id AND the signed URL. */
export const STREAM_SELECT = 'id,@microsoft.graph.downloadUrl,size,name,file,lastModifiedDateTime';
