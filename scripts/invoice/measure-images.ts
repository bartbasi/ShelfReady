// Measures how the model counts an invoice photo at several sizes, using the token counting
// endpoint (free). Images are sent with oversized_image "error", so a size the server would
// shrink is reported instead of silently downsized. The largest size that is accepted and
// costs no more tokens than the next size down is what settings.image should allow.
//
// Usage: node scripts/invoice/measure-images.ts [image path] [model ...]
// With no image path it uses the first image of the first ground truth file.

import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyError } from '../../src/invoice/extract.ts';
import { prepareImage } from '../../src/invoice/images.ts';
import { DEFAULT_INVOICE_SETTINGS } from '../../src/invoice/settings.ts';
import { devAnthropicClient } from './dev-env.ts';
import { loadExpected } from './validate-expected.ts';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const first = process.argv[2] ? null : (await loadExpected())[0]?.images[0];
if (!process.argv[2] && !first) throw new Error('Give an image path, or add ground truth files to test-invoices/expected/.');
const file = process.argv[2] ?? join(repo, 'test-invoices', first!);
const models = process.argv.slice(3).length ? process.argv.slice(3) : ['claude-sonnet-5-5', 'claude-opus-5-5'];
const sizes: Array<[number, number]> = [
  [1568, 10_000_000],
  [2000, 10_000_000],
  [2576, 3_600_000],
  [2576, 3_669_708],
  [2576, 3_700_000],
  [2576, 10_000_000],
];

const client = devAnthropicClient();
const bytes = await readFile(file);
console.log(`Image: ${basename(file)}`);
for (const [edge, pixels] of sizes) {
  const img = await prepareImage(bytes, basename(file), 1, { ...DEFAULT_INVOICE_SETTINGS.image, maxLongEdge: edge, maxPixels: pixels });
  const row: string[] = [`${img.width}x${img.height} (${(img.width * img.height / 1e6).toFixed(2)} MP, ${(img.data.length / 1024).toFixed(0)} KB)`];
  for (const model of models) {
    try {
      const r = await client.messages.countTokens({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data.toString('base64') }, transformations: { oversized_image: 'error' } },
              { type: 'text', text: 'x' },
            ],
          },
        ],
      });
      row.push(`${model}: ${r.input_tokens} tokens`);
    } catch (err) {
      const e = classifyError(err);
      row.push(`${model}: ${e.kind} ${e.message.slice(0, 600)}`);
    }
  }
  console.log(row.join(' | '));
}
