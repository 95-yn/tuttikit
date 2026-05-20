// 解析图片 / PDF → 文本。失败/超时不阻塞上传，只是 text='' + error 记录原因。

import { PDFParse } from 'pdf-parse';
import { createWorker, type Worker } from 'tesseract.js';

const EXTRACT_TIMEOUT_MS = 15_000;
const MAX_KEPT_CHARS = 50_000;

export interface ExtractResult {
  text: string;
  error?: string;
  pages?: number;
  confidence?: number;
}

let _ocrWorker: Worker | null = null;
let _ocrInitPromise: Promise<Worker> | null = null;
async function getOcrWorker(): Promise<Worker> {
  if (_ocrWorker) return _ocrWorker;
  if (_ocrInitPromise) return _ocrInitPromise;
  _ocrInitPromise = (async () => {
    const w = await createWorker(['eng', 'chi_sim']);
    _ocrWorker = w;
    return w;
  })().catch((err) => {
    _ocrInitPromise = null;
    throw err;
  });
  return _ocrInitPromise;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} 超时 (${ms}ms)`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

function clip(s: string): string {
  return s.length > MAX_KEPT_CHARS ? s.slice(0, MAX_KEPT_CHARS) + '\n…[已截断]' : s;
}

export async function extractPdfText(buffer: Buffer): Promise<ExtractResult> {
  try {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    const result = await withTimeout(parser.getText(), EXTRACT_TIMEOUT_MS, 'PDF 解析') as {
      text?: string; total?: number; pages?: unknown[];
    };
    return {
      text: clip((result.text || '').trim()),
      pages: result.total ?? result.pages?.length ?? 0,
    };
  } catch (err) {
    return { text: '', error: err instanceof Error ? err.message : String(err) };
  }
}

export async function extractImageText(buffer: Buffer): Promise<ExtractResult> {
  try {
    const worker = await getOcrWorker();
    const { data } = await withTimeout(worker.recognize(buffer), EXTRACT_TIMEOUT_MS, '图片 OCR');
    return {
      text: clip((data.text || '').trim()),
      confidence: Math.round(data.confidence || 0),
    };
  } catch (err) {
    return { text: '', error: err instanceof Error ? err.message : String(err) };
  }
}

export async function extractByKind(kind: 'image' | 'pdf' | string, buffer: Buffer): Promise<ExtractResult> {
  if (kind === 'pdf') return extractPdfText(buffer);
  if (kind === 'image') return extractImageText(buffer);
  return { text: '' };
}
