import { z } from 'zod';
import { UrlSchema } from './common.js';

export const SubtitleSchema = z.object({
  /** Tells subtitles in one language apart. */
  id: z.string().min(1),
  /** SRT, WebVTT or ASS. ASS keeps its styling only when the address ends in `.ass` or `.ssa`. */
  url: UrlSchema,
  /** An ISO 639-2 code; any other text is shown as it is. */
  lang: z.string().min(1),
  /** The release the subtitle was timed for. */
  label: z.string().nullish(),
  fonts: z.array(UrlSchema).nullish(),
  /** Only the foreign-language lines. */
  forced: z.boolean().nullish(),
  /** SDH or closed captions. */
  hearingImpaired: z.boolean().nullish(),
});

export type Subtitle = z.input<typeof SubtitleSchema>;
