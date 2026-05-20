'use client';
import { useCallback, useState } from 'react';
import * as api from '@/lib/api';
import { showToast } from '@/components/ToastModalHost';
import type { Attachment } from '@/lib/types';

export interface UseAttachments {
  items: Attachment[];
  uploading: number;                                // 当前正在上传的数量
  addFiles: (files: FileList | File[]) => Promise<void>;
  remove: (id: string) => void;
  clear: () => void;
}

const ACCEPT_RE = /^(image\/(png|jpe?g|webp|gif|heic|heif)|application\/pdf)$/i;

export function useAttachments(): UseAttachments {
  const [items, setItems] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const arr = Array.from(files);
    for (const f of arr) {
      if (!ACCEPT_RE.test(f.type)) {
        showToast(`不支持的文件类型：${f.type || f.name}`, { type: 'warn' });
        continue;
      }
      setUploading((n) => n + 1);
      try {
        const a = await api.uploadFile(f);
        setItems((cur) => [...cur, a]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        showToast(`上传失败：${msg}`, { type: 'error', duration: 4000 });
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }, []);

  const remove = useCallback((id: string) => {
    setItems((cur) => cur.filter((a) => a.id !== id));
  }, []);

  const clear = useCallback(() => setItems([]), []);

  return { items, uploading, addFiles, remove, clear };
}
