import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { extractByKind } from './parsers.js';
import type { UploadMeta } from '../types.js';

const ROOT = path.resolve(process.cwd(), 'data/uploads');

export const ALLOWED_IMAGE = /^image\/(png|jpe?g|webp|gif|heic|heif)$/i;
export const ALLOWED_PDF = /^application\/pdf$/i;
export const MAX_BYTES = 25 * 1024 * 1024;
/**
 * 单个附件提取出来塞进 prompt 的最大字符数。
 * 防御 200 页 PDF 把 context window 占满 / 长 injection 嵌入；
 * 真要全文档问答应该走 RAG 检索而不是塞 prompt。
 */
export const MAX_EXTRACTED_CHARS = 60_000;

// ───── 内存缓存（LRU），避免一次对话里反复读盘 ─────
//   meta JSON 缓存上限：500 条
//   binary buffer 缓存上限：64MB（避免吃内存）
const META_CACHE_MAX = 500;
const BUF_CACHE_MAX_BYTES = 64 * 1024 * 1024;

const metaCache = new Map<string, UploadMetaWithPath>();
const bufCache = new Map<string, Buffer>();
let bufCacheSize = 0;

function lruGet<T>(map: Map<string, T>, key: string): T | undefined {
  const v = map.get(key);
  if (v !== undefined) {
    // 命中后重新插入到 Map 末尾（LRU）
    map.delete(key);
    map.set(key, v);
  }
  return v;
}
function lruSetMeta(key: string, v: UploadMetaWithPath): void {
  if (metaCache.has(key)) metaCache.delete(key);
  metaCache.set(key, v);
  while (metaCache.size > META_CACHE_MAX) {
    const oldest = metaCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    metaCache.delete(oldest);
  }
}
function lruSetBuf(key: string, buf: Buffer): void {
  if (bufCache.has(key)) {
    bufCacheSize -= bufCache.get(key)!.byteLength;
    bufCache.delete(key);
  }
  bufCache.set(key, buf);
  bufCacheSize += buf.byteLength;
  while (bufCacheSize > BUF_CACHE_MAX_BYTES) {
    const oldest = bufCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const dropped = bufCache.get(oldest)!;
    bufCache.delete(oldest);
    bufCacheSize -= dropped.byteLength;
  }
}

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
  const rawText = extracted.text || '';
  const truncated = rawText.length > MAX_EXTRACTED_CHARS;
  const finalText = truncated ? rawText.slice(0, MAX_EXTRACTED_CHARS) : rawText;

  const entry: UploadMeta = {
    id,
    kind,
    mediaType: mimetype,
    filename: originalname || filename,
    sizeBytes: size,
    storedAs: filename,
    createdAt: new Date().toISOString(),
    extractedText: finalText,
    extractedChars: finalText.length,
    extractError: extracted.error || null,
    ...(truncated ? { extractedTruncated: true as const, extractedOriginalChars: rawText.length } : {}),
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
  const cached = lruGet(metaCache, id);
  if (cached) return cached;
  const metaPath = path.join(ROOT, `${id}.json`);
  try {
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as UploadMeta;
    const withPath: UploadMetaWithPath = { ...meta, fullPath: path.join(ROOT, meta.storedAs) };
    lruSetMeta(id, withPath);
    return withPath;
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
  const cachedBuf = lruGet(bufCache, id);
  if (cachedBuf) return { ...meta, buffer: cachedBuf };
  const buf = await fs.readFile(meta.fullPath);
  lruSetBuf(id, buf);
  return { ...meta, buffer: buf };
}
