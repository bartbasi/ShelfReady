// Image preparation with synthetic pictures made by sharp. No real invoice photos.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { estimatePdfPages, findRepeatedUploads, fitSize, prepareImage, preparePdf, sniffUpload, thumbnailDiff } from '../src/invoice/images.ts';
import { DEFAULT_INVOICE_SETTINGS } from '../src/invoice/settings.ts';
import { testImage } from './invoice-fixtures.ts';

const imageSettings = DEFAULT_INVOICE_SETTINGS.image;

test('fitSize keeps the aspect ratio under both limits', () => {
  assert.deepEqual(fitSize(3000, 4000, 2576, 3_660_000), { width: 1656, height: 2209 });
  assert.deepEqual(fitSize(800, 600, 2576, 3_660_000), { width: 800, height: 600 });
  assert.deepEqual(fitSize(1000, 5000, 2576, 100_000_000), { width: 515, height: 2576 });
  const s = fitSize(3000, 4000, 2576, 3_660_000);
  assert.ok(s.width * s.height <= 3_660_000);
});

test('file types are judged by their first bytes', async () => {
  assert.equal(sniffUpload(await testImage(1)), 'jpeg');
  const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
  assert.equal(sniffUpload(png), 'png');
  const webp = await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 0, g: 0, b: 0 } } }).webp().toBuffer();
  assert.equal(sniffUpload(webp), 'webp');
  assert.equal(sniffUpload(Buffer.from('%PDF-1.4 and more bytes')), 'pdf');
  assert.equal(sniffUpload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.equal(sniffUpload(Buffer.from('GIF89a\u0001\u0000\u0001\u0000\u0000\u0000\u0000')), null);
  assert.equal(sniffUpload(Buffer.from([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0, 0, 0, 0, 0])), null);
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(12)]);
  assert.equal(sniffUpload(heic), 'heif');
});

test('a phone photo stored sideways is turned upright before sizing', async () => {
  const landscape = await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const p = await prepareImage(landscape, 'sideways.jpg', 1, imageSettings);
  assert.deepEqual([p.originalWidth, p.originalHeight], [300, 400]);
  assert.deepEqual([p.width, p.height], [300, 400]);
  const meta = await sharp(p.data).metadata();
  assert.deepEqual([meta.width, meta.height, meta.format], [300, 400, 'jpeg']);
});

test('large photos are resized to the measured limits', async () => {
  const big = await testImage(1, 3000, 4000);
  const p = await prepareImage(big, 'big.jpg', 1, imageSettings);
  assert.ok(p.width * p.height <= imageSettings.maxPixels);
  assert.ok(Math.max(p.width, p.height) <= imageSettings.maxLongEdge);
  assert.equal(p.mediaType, 'image/jpeg');
});

test('pictures over the input pixel limit are refused before decoding', async () => {
  await assert.rejects(prepareImage(await testImage(1), 'big.jpg', 1, { ...imageSettings, maxInputPixels: 10_000 }));
});

test('PNG stays PNG; WebP becomes JPEG; anything unreadable is refused', async () => {
  const png = await sharp({ create: { width: 50, height: 60, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer();
  assert.equal((await prepareImage(png, 'shot.png', 1, imageSettings)).mediaType, 'image/png');
  const webp = await sharp({ create: { width: 50, height: 60, channels: 3, background: { r: 9, g: 9, b: 9 } } }).webp().toBuffer();
  assert.equal((await prepareImage(webp, 'shot.webp', 1, imageSettings)).mediaType, 'image/jpeg');
  await assert.rejects(prepareImage(Buffer.from('not an image at all'), 'x.jpg', 1, imageSettings));
  const truncated = (await testImage(2)).subarray(0, 400);
  await assert.rejects(prepareImage(truncated, 'cut.jpg', 1, imageSettings));
});

test('the same picture uploaded twice is found; a different picture is not', async () => {
  const a = await testImage(1);
  const b = await testImage(2);
  const aAgain = await sharp(a).jpeg({ quality: 70 }).toBuffer();
  const imgs = await Promise.all([a, b, a, aAgain].map(async (bytes, i) => prepareImage(bytes, `p${i + 1}.jpg`, i + 1, imageSettings)));
  const repeats = findRepeatedUploads(imgs, imageSettings.sameImageMaxDiff);
  assert.deepEqual(repeats, [
    { index: 3, sameAs: 1, exact: true },
    { index: 4, sameAs: 1, exact: false },
  ]);
  assert.ok(thumbnailDiff(imgs[0]!.thumb, imgs[1]!.thumb) > imageSettings.sameImageMaxDiff);
});

test('PDF input is checked and its pages estimated', () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Pages /Count 2 >>\n2 0 obj << /Type /Page >>\n3 0 obj << /Type /Page >>\n');
  assert.equal(estimatePdfPages(pdf), 2);
  assert.equal(preparePdf(pdf, 'inv.pdf').pagesEstimate, 2);
  assert.throws(() => preparePdf(Buffer.from('hello there, not a pdf'), 'inv.pdf'), /not a PDF/);
});
