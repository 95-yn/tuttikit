'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { showToast } from '@/components/ToastModalHost';

/**
 * 浏览器原生 Voice API 简版封装。
 *   - 语音识别：window.SpeechRecognition / webkitSpeechRecognition
 *   - 语音合成：window.speechSynthesis
 * 零新依赖；不支持时各自的 supported / speaking 自然落到 false。
 */

// ───── 最小手写类型（lib.dom 没带 SpeechRecognition） ─────
interface SpeechRecognitionResultLite {
  isFinal: boolean;
  0: { transcript: string };
}
interface SpeechRecognitionEventLite {
  results: ArrayLike<SpeechRecognitionResultLite>;
}
interface SpeechRecognitionErrorEventLite {
  error: string;
}
interface SpeechRecognitionLite {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((e: SpeechRecognitionEventLite) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEventLite) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLite;

function getSR(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const ERR_MAP: Record<string, string> = {
  'not-allowed':         '麦克风权限被拒绝，请在浏览器地址栏检查权限',
  'no-speech':           '没有检测到语音',
  'audio-capture':       '找不到麦克风设备',
  'network':             '语音服务网络错误',
  'service-not-allowed': '当前页面不允许使用语音服务（iOS 需 HTTPS 或 localhost）',
};

const LS_AUTOSPEAK_KEY = 'tuttikit:voice:autoSpeak';

function readAutoSpeak(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(LS_AUTOSPEAK_KEY) === '1';
  } catch { return false; }
}

function writeAutoSpeak(v: boolean): void {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(LS_AUTOSPEAK_KEY, v ? '1' : '0');
  } catch { /* ignore quota / private mode */ }
}

export interface UseVoiceState {
  // 录音相关
  listening: boolean;
  /** 调用方传一个回调；hook 每次产出 final / interim 段都会回调一次。
   *  返回 promise 仅表示 start() 调用完成（不是录音结束）。
   *  text 为本次累计的完整 transcript（不含之前已 commit 的）。 */
  startListening: (onTranscript: (text: string, isFinal: boolean) => void) => Promise<void>;
  stopListening: () => void;
  supported: boolean;
  // 朗读相关
  speak: (text: string) => void;
  speaking: boolean;
  stopSpeaking: () => void;
  // 用户偏好（localStorage 持久化）
  autoSpeak: boolean;
  setAutoSpeak: (v: boolean) => void;
}

export function useVoice(): UseVoiceState {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [autoSpeak, setAutoSpeakState] = useState(false);

  const recRef = useRef<SpeechRecognitionLite | null>(null);
  const ttsVoiceRef = useRef<SpeechSynthesisVoice | null>(null);

  // Boot：探测 SR 支持、读 autoSpeak、预加载 TTS voices（异步）
  useEffect(() => {
    setSupported(getSR() != null);
    setAutoSpeakState(readAutoSpeak());

    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const pickVoice = () => {
      const voices = window.speechSynthesis.getVoices();
      // 优先中文；找不到就用 default；都没有就 null（用浏览器兜底）
      ttsVoiceRef.current =
        voices.find((v) => v.lang?.toLowerCase().startsWith('zh')) ??
        voices.find((v) => v.default) ??
        voices[0] ??
        null;
    };
    pickVoice();
    // Chrome 首次 voices 是空的，需要监听一次性事件
    window.speechSynthesis.onvoiceschanged = pickVoice;
    return () => {
      try { window.speechSynthesis.onvoiceschanged = null; } catch { /* ignore */ }
    };
  }, []);

  // ───── Recognition ─────
  const stopListening = useCallback(() => {
    try { recRef.current?.stop(); } catch { /* ignore */ }
  }, []);

  const startListening = useCallback(async (
    onTranscript: (text: string, isFinal: boolean) => void,
  ): Promise<void> => {
    const SR = getSR();
    if (!SR) return;
    // 已经在跑就别重复 start（webkit 会抛 InvalidStateError）
    if (recRef.current) return;

    const rec = new SR();
    rec.lang = 'zh-CN';
    rec.continuous = false;
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
      // final 优先回调，再回调 interim；调用方据 isFinal 决定塞 input 还是显示提示
      if (finalT) onTranscript(finalT, true);
      if (interimT) onTranscript(interimT, false);
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
      recRef.current = null;
    };

    try {
      rec.start();
      recRef.current = rec;
    } catch { /* already running, ignore */ }
  }, []);

  // 卸载时停掉录音 & 朗读
  useEffect(() => () => {
    try { recRef.current?.stop(); } catch { /* ignore */ }
    try {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    } catch { /* ignore */ }
  }, []);

  // ───── Synthesis ─────
  const speak = useCallback((text: string) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const trimmed = text?.trim();
    if (!trimmed) return;
    try {
      // 替换正在朗读的内容（防多条堆叠）
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(trimmed);
      u.lang = 'zh-CN';
      if (ttsVoiceRef.current) u.voice = ttsVoiceRef.current;
      u.onstart = () => setSpeaking(true);
      u.onend = () => setSpeaking(false);
      u.onerror = () => setSpeaking(false);
      window.speechSynthesis.speak(u);
    } catch { /* ignore */ }
  }, []);

  const stopSpeaking = useCallback(() => {
    try {
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
      window.speechSynthesis.cancel();
      setSpeaking(false);
    } catch { /* ignore */ }
  }, []);

  const setAutoSpeak = useCallback((v: boolean) => {
    setAutoSpeakState(v);
    writeAutoSpeak(v);
  }, []);

  return {
    listening, startListening, stopListening, supported,
    speak, speaking, stopSpeaking,
    autoSpeak, setAutoSpeak,
  };
}

/**
 * 把 markdown 文本剥成适合朗读的纯文本。
 * 只覆盖最常见标记：代码块/行内代码、粗体/斜体、标题、列表、链接、图片、引用、HR。
 * 设计目标：足够好就行，不追求 100% 兼容（朗读时几个奇怪字符没关系）。
 */
export function stripMarkdownForSpeech(md: string): string {
  if (!md) return '';
  return md
    .replace(/```[\s\S]*?```/g, ' 代码块略过 ')         // fenced code
    .replace(/`([^`]+)`/g, '$1')                          // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' 图片 ')          // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')              // links → keep text
    .replace(/^\s{0,3}>+\s?/gm, '')                       // blockquote markers
    .replace(/^\s*[-*+]\s+/gm, '')                        // ul bullets
    .replace(/^\s*\d+\.\s+/gm, '')                        // ol bullets
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')                   // headings
    .replace(/^\s*[-*_]{3,}\s*$/gm, '')                   // hr
    .replace(/(\*\*|__)(.*?)\1/g, '$2')                   // bold
    .replace(/(\*|_)(.*?)\1/g, '$2')                      // italic
    .replace(/~~(.*?)~~/g, '$1')                          // strikethrough
    .replace(/<[^>]+>/g, '')                              // raw html tags
    .replace(/\s{2,}/g, ' ')
    .trim();
}
