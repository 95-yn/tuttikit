'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { showToast } from '@/components/ToastModalHost';

// Web Speech API 在 TS lib 里没有完整类型，按需声明最小集合
interface SpeechRecognitionAlt {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((e: SpeechRecognitionEventAlt) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEventAlt) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}
interface SpeechRecognitionEventAlt {
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}
interface SpeechRecognitionErrorEventAlt {
  error: string;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionAlt;

function getSR(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const ERR_MAP: Record<string, string> = {
  'not-allowed':   '麦克风权限被拒绝，请在浏览器地址栏检查权限',
  'no-speech':     '没有检测到语音',
  'audio-capture': '找不到麦克风设备',
  'network':       '语音服务网络错误',
  'service-not-allowed': '当前页面不允许使用语音服务（iOS 需 HTTPS 或 localhost）',
};

export interface UseVoiceInput {
  supported: boolean;
  listening: boolean;
  interim: string;
  toggle: () => void;
}

/**
 * 把已识别的 final 段追加到 `value`，interim 段独立显示。
 *   - 调用方传入受控输入框的 value/setValue
 *   - 开始录音时记录 baseText（已有内容），final 段拼接其后
 *   - iOS Safari 14.5+ 支持 webkitSpeechRecognition；不支持则 supported=false，按钮不渲染
 */
export function useVoiceInput(opts: {
  value: string;
  setValue: (v: string) => void;
  lang?: string;
}): UseVoiceInput {
  const { value, setValue, lang = 'zh-CN' } = opts;
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const recRef = useRef<SpeechRecognitionAlt | null>(null);
  const baseTextRef = useRef('');
  const valueRef = useRef(value);
  useEffect(() => { valueRef.current = value; }, [value]);

  useEffect(() => {
    setSupported(getSR() != null);
  }, []);

  const stop = useCallback(() => {
    try { recRef.current?.stop(); } catch {/* ignore */}
  }, []);

  const start = useCallback(() => {
    const SR = getSR();
    if (!SR) return;
    baseTextRef.current = valueRef.current;
    const rec = new SR();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;

    rec.onstart = () => setListening(true);

    rec.onresult = (e) => {
      let finalT = '', interimT = '';
      const results = e.results;
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.isFinal) finalT += r[0].transcript;
        else interimT += r[0].transcript;
      }
      const base = baseTextRef.current;
      const merged = (base + (base && finalT ? ' ' : '') + finalT).trim();
      setValue(merged);
      setInterim(interimT);
    };

    rec.onerror = (e) => {
      const msg = ERR_MAP[e.error] ?? e.error;
      if (e.error === 'not-allowed' || e.error === 'audio-capture' || e.error === 'service-not-allowed') {
        showToast(msg, { type: 'error', duration: 5000 });
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
        showToast(`语音错误：${msg}`, { type: 'warn', duration: 4000 });
      }
    };

    rec.onend = () => {
      setListening(false);
      setInterim('');
      recRef.current = null;
    };

    try {
      rec.start();
      recRef.current = rec;
    } catch {/* 已在跑则忽略 */}
  }, [lang, setValue]);

  // 卸载或切走时停掉
  useEffect(() => () => stop(), [stop]);

  const toggle = useCallback(() => {
    if (listening) stop(); else start();
  }, [listening, start, stop]);

  return { supported, listening, interim, toggle };
}
