// Prepares invoice pages for the model: check the file type by its content, auto-orient,
// resize to fit what the model reads at full detail, and spot repeated uploads before anything
// is sent.
//
// Resolution matters for faded dot-matrix print. The limits in settings.image were measured
// with scripts/invoice/measure-images.ts against the token counting endpoint: an image at or
// under them is read as sent, never shrunk again by the server. Requests also set
// oversized_image to "error", so a size change on the server side fails loudly instead of
// silently lowering the resolution.
//
// Uploads are untrusted. Only JPEG, PNG, WebP and HEIF are decoded, judged by their first bytes,
// never by name. Decoding refuses pictures over settings.image.maxInputPixels and files with
// warnings, and each picture is decoded once.

import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { ImageSettings } from './settings.ts';

export interface PreparedImage {
  /** 1-based, in upload order. */
  index: number;
  /** Original file name, for logs and the review screen. */
  name: string;
  mediaType: 'image/jpeg' | 'image/png';
  data: Buffer;
  width: number;
  height: number;
  /** Size after orientation, before resizing. */
  originalWidth: number;
  originalHeight: number;
  /** SHA-256 of the uploaded bytes. */
  sha256: string;
  /** 64x64 greyscale thumbnail of the resized picture, to spot the same picture uploaded twice. */
  thumb: Buffer;
}

export interface PdfInput {
  name: string;
  data: Buffer;
  sha256: string;
  /** Pages found by a quick scan of the file, for limits and labels only, never for cost. */
  pagesEstimate: number;
}

export type UploadKind = 'jpeg' | 'png' | 'webp' | 'heif' | 'pdf';

/** The API's limit for one base64 image. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Side of the greyscale thumbnail used to spot the same picture uploaded twice. */
const THUMB = 64;

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'avif']);

/** What a file is, from its first bytes. Null for anything not accepted (SVG, TIFF, GIF and others). */
export function sniffUpload(bytes: Buffer): UploadKind | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (bytes.subarray(4, 8).toString('latin1') === 'ftyp' && HEIF_BRANDS.has(bytes.subarray(8, 12).toString('latin1'))) return 'heif';
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  return null;
}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Width and height that fit both the longest-side and the pixel limits, keeping the aspect ratio. */
export function fitSize(width: number, height: number, maxLongEdge: number, maxPixels: number): { width: number; height: number } {
  const scale = Math.min(1, maxLongEdge / Math.max(width, height), Math.sqrt(maxPixels / (width * height)));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

/**
 * Mean absolute difference between two thumbnails, in grey levels (0 to 255).
 * Measured on the test invoices, November 6, 2026: the same photo re-encoded differs by about
 * 1; two photos of the same page taken a second apart differ by 11; different pages of one
 * invoice by 7 or more.
 */
export function thumbnailDiff(a: Buffer, b: Buffer): number {
  if (a.length !== b.length || a.length === 0) return 255;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / a.length;
}

/** Orients, resizes and encodes one uploaded page, decoding it once. */
export async function prepareImage(bytes: Buffer, name: string, index: number, opts: ImageSettings): Promise<PreparedImage> {
  const kind = sniffUpload(bytes);
  if (kind === null || kind === 'pdf') throw new Error('not a JPEG, PNG, WebP or HEIF picture');
  const input = { failOn: 'warning' as const, limitInputPixels: opts.maxInputPixels };
  const meta = await sharp(bytes, input).metadata();
  if (!meta.width || !meta.height) throw new Error('no picture size could be read');
  if (meta.width * meta.height > opts.maxInputPixels) throw new Error('the picture is too large');
  const swap = (meta.orientation ?? 1) >= 5;
  const originalWidth = swap ? meta.height : meta.width;
  const originalHeight = swap ? meta.width : meta.height;
  const size = fitSize(originalWidth, originalHeight, opts.maxLongEdge, opts.maxPixels);
  // The one full decode: orient, drop any transparency onto white, resize, keep raw pixels.
  const { data: pixels, info } = await sharp(bytes, input)
    .autoOrient()
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .resize(size.width, size.height, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const raw = { raw: { width: info.width, height: info.height, channels: info.channels } };
  const asPng = kind === 'png';
  let quality = opts.jpegQuality;
  let data: Buffer;
  for (;;) {
    data = asPng
      ? await sharp(pixels, raw).png({ compressionLevel: 9 }).toBuffer()
      : await sharp(pixels, raw).jpeg({ quality, chromaSubsampling: '4:4:4' }).toBuffer();
    if (data.length <= MAX_IMAGE_BYTES || asPng || quality <= 60) break;
    quality -= 10;
  }
  if (data.length > MAX_IMAGE_BYTES) throw new Error('still over 5 MB after resizing');
  const thumb = await sharp(pixels, raw).greyscale().resize(THUMB, THUMB, { fit: 'fill' }).raw().toBuffer();
  return {
    index,
    name,
    mediaType: asPng ? 'image/png' : 'image/jpeg',
    data,
    width: info.width,
    height: info.height,
    originalWidth,
    originalHeight,
    sha256: sha256(bytes),
    thumb,
  };
}

export interface RepeatedUpload {
  index: number;
  sameAs: number;
  exact: boolean;
}

/**
 * Uploads that are the same picture: identical bytes, or thumbnails within maxDiff grey levels
 * (the same photo re-encoded). Two different photos of one page are not dropped here, because a
 * coarse picture test could also drop a real page that looks alike. The model and the page
 * numbers catch those.
 */
export function findRepeatedUploads(images: Array<Pick<PreparedImage, 'index' | 'sha256' | 'thumb'>>, maxDiff: number): RepeatedUpload[] {
  const out: RepeatedUpload[] = [];
  const kept: typeof images = [];
  for (const img of images) {
    const same = kept.find((k) => k.sha256 === img.sha256) ?? kept.find((k) => thumbnailDiff(k.thumb, img.thumb) <= maxDiff);
    if (same) out.push({ index: img.index, sameAs: same.index, exact: same.sha256 === img.sha256 });
    else kept.push(img);
  }
  return out;
}

/**
 * Counts pages in a PDF by its page objects. It misses pages kept in compressed object streams,
 * so it is used only to refuse obviously long files and to label pages, never to estimate cost.
 */
export function estimatePdfPages(bytes: Buffer): number {
  const text = bytes.toString('latin1');
  const n = text.match(/\/Type\s{0,4}\/Page(?!s)/g)?.length ?? 0;
  return Math.max(1, n);
}

export function preparePdf(bytes: Buffer, name: string): PdfInput {
  if (sniffUpload(bytes) !== 'pdf') throw new Error(`${name}: not a PDF`);
  return { name, data: bytes, sha256: sha256(bytes), pagesEstimate: estimatePdfPages(bytes) };
}
