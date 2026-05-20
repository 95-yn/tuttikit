import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { extractByKind } from './parsers.js';
import type { UploadMeta } from '../types.js';

const ROOT = path.resolve(process.cwd(), 'data/uploads');

export const ALLOWED_IMAGE = /^image\/(png|jpe?g|webp|gif|heic|heif)$/i;
export const ALLOWED_PDF = /^application\/pdf$/i;
export const MAX_BYTES = 25 * 1024 * 1024;

export type AttachmentKind = 'image' | 'pdf';

function extFromMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m === 'image/png') return '.png';
  if (m === 'image/jpeg' || m === 'image/jpg') return '.jpg';
  if (m === 'image/webp') return '.webp';
  if (m === 'image/gif') return '.gif';
  if (m === 'image/heic') return '.heic';
  if (m === 'image/heif') return '.heif';
  if (m === 'application/pdf') return '.pdf';
  return '';
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(ROOT, { recursive: true });
}

export function classify(mediaType: string): AttachmentKind | null {
  if (ALLOWED_IMAGE.test(mediaType)) return 'image';
  if (ALLOWED_PDF.test(mediaType)) return 'pdf';
  return null;
}

export interface SaveInput {
  buffer: Buffer;
  mimetype: string;
  originalname?: string;
  size: number;
}

export async function saveUpload({ buffer, mimetype, originalname, size }: SaveInput): Promise<UploadMeta> {
  const kind = classify(mimetype);
  if (!kind) throw new Error(`unsupported media type: ${mimetype}`);
  if (size > MAX_BYTES) throw new Error(`file too large: ${size} > ${MAX_BYTES}`);

  await ensureDir();
  const id = crypto.randomBytes(12).toString('hex');
  const ext = extFromMime(mimetype);
  const filename = `${id}${ext}`;
  const fullPath = path.join(ROOT, filename);
  const metaPath = path.join(ROOT, `${id}.json`);

  await fs.writeFile(fullPath, buffer);

  const extracted = await extractByKind(kind, buffer);

  const entry: UploadMeta = {
    id,
    kind,
    mediaType: mimetype,
    filename: originalname || filename,
    sizeBytes: size,
    storedAs: filename,
    createdAt: new Date().toISOString(),
    extractedText: extracted.text || '',
    extractedChars: (extracted.text || '').length,
    extractError: extracted.error || null,
    ...(extracted.pages !== undefined ? { pages: extracted.pages } : {}),
    ...(extracted.confidence !== undefined ? { ocrConfidence: extracted.confidence } : {}),
  };
  await fs.writeFile(metaPath, JSON.stringify(entry, null, 2));
  return entry;
}

export interface UploadMetaWithPath extends UploadMeta {
  fullPath: string;
}

export async function getUpload(id: string): Promise<UploadMetaWithPath | null> {
  if (!/^[a-f0-9]{24}$/i.test(id)) return null;
  const metaPath = path.join(ROOT, `${id}.json`);
  try {
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as UploadMeta;
    return { ...meta, fullPath: path.join(ROOT, meta.storedAs) };
  } catch {
    return null;
  }
}

export interface UploadMetaWithBuffer extends UploadMetaWithPath {
  buffer: Buffer;
}

export async function readUploadBuffer(id: string): Promise<UploadMetaWithBuffer | null> {
  const meta = await getUpload(id);
  if (!meta) return null;
  return { ...meta, buffer: await fs.readFile(meta.fullPath) };
}
