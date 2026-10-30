import { z } from 'zod';
import { CountSchema, UrlSchema } from './common.js';
import { SubtitleSchema } from './subtitle.js';

export const SERVICE_IDS = [
  'realdebrid',
  'alldebrid',
  'premiumize',
  'debridlink',
  'torbox',
  'easydebrid',
  'debrider',
  'offcloud',
  'pikpak',
  'putio',
  'seedr',
  'torrin',
  'easynews',
  'nzbdav',
  'altmount',
  'stremio_nntp',
  'stremthru_newz',
  'aiostreams',
] as const;

export type ServiceId = (typeof SERVICE_IDS)[number];

export const StreamBehaviorHintsSchema = z.object({
  /** Needed for a `url` that is not https MP4, and with `proxyHeaders`. */
  notWebReady: z.boolean().nullish(),
  /** The next episode's stream in the same group is picked automatically. */
  bingeGroup: z.string().nullish(),
  /** ISO 3166-1 alpha-3 codes, lowercase. */
  countryWhitelist: z.array(z.string().length(3)).nullish(),
  proxyHeaders: z
    .object({
      request: z.record(z.string(), z.string()).nullish(),
      response: z.record(z.string(), z.string()).nullish(),
    })
    .nullish(),
  filename: z.string().nullish(),
  /** The OpenSubtitles hash of the video. */
  videoHash: z.string().nullish(),
  /** In bytes. */
  videoSize: CountSchema.nullish(),
  service: z.enum(SERVICE_IDS).nullish(),
  /** Whether the file is ready to play on `service` now. */
  cached: z.boolean().nullish(),
  seeders: CountSchema.nullish(),
  indexer: z.string().nullish(),
  publishDate: z.string().nullish(),
  /** In seconds. */
  duration: z.number().min(0).nullish(),
  /** The torrent or folder the file is in; its seasons mark a season pack. */
  folderName: z.string().nullish(),
  /** In bytes. */
  folderSize: CountSchema.nullish(),
});

const StreamFieldsSchema = z.object({
  name: z.string().nullish(),
  description: z.string().nullish(),
  /** @deprecated Use `description`. */
  title: z.string().nullish(),
  thumbnail: z.string().nullish(),
  subtitles: z.array(SubtitleSchema).nullish(),
  behaviorHints: StreamBehaviorHintsSchema.nullish(),
});

const InfoHashSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/i, 'expected 40 hexadecimal characters');

const FileIndexSchema = z.number().int().min(0).max(65535);

const fileSelection = {
  fileIdx: FileIndexSchema.nullish(),
  /** Regular expressions matched against file names. */
  fileMustInclude: z.array(z.string()).nullish(),
};

/** `[url, bytes]`: a stream whose parts are objects is dropped. */
export const ArchivePartSchema = z.tuple([UrlSchema, CountSchema.nullish()]);

export type ArchivePart = z.input<typeof ArchivePartSchema>;

const archiveParts = z.array(ArchivePartSchema).min(1);
export const RarSourceSchema = z.object({
  rarUrls: archiveParts,
  ...fileSelection,
});
export const ZipSourceSchema = z.object({
  zipUrls: archiveParts,
  ...fileSelection,
});
export const SevenZipSourceSchema = z.object({
  '7zipUrls': archiveParts,
  ...fileSelection,
});
export const TgzSourceSchema = z.object({
  tgzUrls: archiveParts,
  ...fileSelection,
});
export const TarSourceSchema = z.object({
  tarUrls: archiveParts,
  ...fileSelection,
});

export const UrlSourceSchema = z.object({
  url: UrlSchema,
  /** For a torrent served over http, so the same file is recognised elsewhere. */
  infoHash: InfoHashSchema.nullish(),
  fileIdx: FileIndexSchema.nullish(),
});

export const YouTubeSourceSchema = z.object({ ytId: z.string().min(1) });

export const TorrentSourceSchema = z.object({
  infoHash: InfoHashSchema,
  /** Trackers as `tracker:<url>` and DHT nodes as `dht:<id>`. */
  sources: z.array(z.string()).nullish(),
  ...fileSelection,
});

export const NzbSourceSchema = z
  .object({
    nzbUrl: UrlSchema.nullish(),
    nzbUrls: z.array(UrlSchema).nullish(),
    /** `nntps://user:pass@host:port/connections` */
    servers: z.array(UrlSchema).min(1),
    ...fileSelection,
  })
  .refine((source) => source.nzbUrl || source.nzbUrls?.length, {
    message: 'an NZB stream needs nzbUrl or nzbUrls',
  });

export const PlayerFrameSourceSchema = z.object({ playerFrameUrl: UrlSchema });

export const ExternalSourceSchema = z
  .object({
    externalUrl: UrlSchema.nullish(),
    androidTvUrl: UrlSchema.nullish(),
    tizenUrl: z.string().nullish(),
    webosUrl: z.string().nullish(),
  })
  .refine(
    (source) =>
      source.externalUrl ||
      source.androidTvUrl ||
      source.tizenUrl ||
      source.webosUrl,
    { message: 'an external stream needs at least one address' }
  );

const SOURCES = [
  ['url', UrlSourceSchema],
  ['ytId', YouTubeSourceSchema],
  ['infoHash', TorrentSourceSchema],
  ['nzbUrl', NzbSourceSchema],
  ['nzbUrls', NzbSourceSchema],
  ['rarUrls', RarSourceSchema],
  ['zipUrls', ZipSourceSchema],
  ['7zipUrls', SevenZipSourceSchema],
  ['tgzUrls', TgzSourceSchema],
  ['tarUrls', TarSourceSchema],
  ['playerFrameUrl', PlayerFrameSourceSchema],
  ['externalUrl', ExternalSourceSchema],
  ['androidTvUrl', ExternalSourceSchema],
  ['tizenUrl', ExternalSourceSchema],
  ['webosUrl', ExternalSourceSchema],
] as const;

export type StreamSource =
  | z.input<typeof UrlSourceSchema>
  | z.input<typeof YouTubeSourceSchema>
  | z.input<typeof TorrentSourceSchema>
  | z.input<typeof NzbSourceSchema>
  | z.input<typeof RarSourceSchema>
  | z.input<typeof ZipSourceSchema>
  | z.input<typeof SevenZipSourceSchema>
  | z.input<typeof TgzSourceSchema>
  | z.input<typeof TarSourceSchema>
  | z.input<typeof PlayerFrameSourceSchema>
  | z.input<typeof ExternalSourceSchema>;

/** Checked against the source its first source field names, so a mistake is reported on that field. */
const StreamSourceSchema = z
  .custom<StreamSource>()
  .superRefine((value, ctx) => {
    const entry =
      value && typeof value === 'object'
        ? SOURCES.find(
            ([key]) => (value as Record<string, unknown>)[key] != null
          )
        : undefined;
    if (!entry) {
      ctx.addIssue({
        code: 'custom',
        message: `a stream needs a source: one of ${[...new Set(SOURCES.map(([key]) => key))].join(', ')}`,
      });
      return;
    }
    const result = entry[1].safeParse(value);
    for (const issue of result.error?.issues ?? []) {
      ctx.addIssue({ ...issue, path: issue.path } as z.core.$ZodRawIssue);
    }
  });

export const StreamSchema = z.intersection(
  StreamFieldsSchema,
  StreamSourceSchema
);

export type Stream = z.input<typeof StreamFieldsSchema> & StreamSource;
