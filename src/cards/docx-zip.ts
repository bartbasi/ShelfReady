// Reads the parts of a .docx (a zip) with fflate, which docx already depends on.
import { strFromU8, unzipSync } from 'fflate';

export function readDocxParts(buf: Uint8Array): Map<string, string> {
  const files = unzipSync(buf);
  const out = new Map<string, string>();
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith('/')) continue;
    out.set(name, strFromU8(data));
  }
  return out;
}

export function readDocumentXml(buf: Uint8Array): string {
  const xml = readDocxParts(buf).get('word/document.xml');
  if (xml === undefined) throw new Error('Not a .docx: word/document.xml is missing');
  return xml;
}
