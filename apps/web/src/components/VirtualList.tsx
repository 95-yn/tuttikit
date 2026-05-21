'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

interface Props<T> {
  items: T[];
  /** 每条固定高度（px）。变高的情况自己另写。 */
  itemHeight: number;
  /** 可见区外多渲染几条防滚动闪烁，默认 5 */
  overscan?: number;
  /** className 给外层 scroll 容器 */
  className?: string;
  /** 渲染单条；返回的元素**必须**高度 = itemHeight，否则滚动会错位 */
  renderItem: (item: T, index: number) => React.ReactNode;
  /** 提供稳定 key，按 item 而不是 index */
  keyOf?: (item: T, index: number) => string | number;
  /** 滚动到指定 index（外部触发，比如"选中 X 滚动到 X"） */
  scrollToIndex?: number;
  /** 空数据时显示 */
  empty?: React.ReactNode;
}

/**
 * 极简虚拟滚动：固定行高，只渲染可视区 + overscan。
 * 适合 50-50000 条等高行；变高的需要扩展为「测量 + 偏移表」，本组件不处理。
 *
 * 实现思路：
 *   - 外层 scroll 容器
 *   - 内层撑高 div height = items.length * itemHeight
 *   - 真实内容用 transform: translateY(startIdx * itemHeight) 定位到可视区起点
 *   - onScroll 节流到 requestAnimationFrame，避免每次滚动事件都重渲染
 */
export function VirtualList<T>({
  items, itemHeight, overscan = 5, className,
  renderItem, keyOf, scrollToIndex, empty,
}: Props<T>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerHeight, setContainerHeight] = useState(400);
  const [scrollTop, setScrollTop] = useState(0);
  const rafId = useRef<number | null>(null);

  // 测量容器高度（响应窗口 resize / 父容器变化）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setContainerHeight(e.contentRect.height);
    });
    ro.observe(el);
    setContainerHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const onScroll = useCallback(() => {
    if (rafId.current !== null) return;
    rafId.current = requestAnimationFrame(() => {
      rafId.current = null;
      if (containerRef.current) setScrollTop(containerRef.current.scrollTop);
    });
  }, []);

  // 外部触发滚动到指定 index
  useEffect(() => {
    if (scrollToIndex === undefined || !containerRef.current) return;
    const top = scrollToIndex * itemHeight;
    // 已经在可视区就不动
    const visibleTop = containerRef.current.scrollTop;
    const visibleBottom = visibleTop + containerRef.current.clientHeight;
    if (top < visibleTop || top + itemHeight > visibleBottom) {
      containerRef.current.scrollTo({ top, behavior: 'smooth' });
    }
  }, [scrollToIndex, itemHeight]);

  if (items.length === 0) {
    return <div ref={containerRef} className={className}>{empty}</div>;
  }

  const totalHeight = items.length * itemHeight;
  const startIdx = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
  const endIdx = Math.min(
    items.length,
    Math.ceil((scrollTop + containerHeight) / itemHeight) + overscan,
  );
  const visible = items.slice(startIdx, endIdx);
  const offsetY = startIdx * itemHeight;

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ overflowY: 'auto', position: 'relative' }}
      onScroll={onScroll}
    >
      <div style={{ height: totalHeight, position: 'relative' }}>
        <div style={{ transform: `translateY(${offsetY}px)` }}>
          {visible.map((item, i) => {
            const realIdx = startIdx + i;
            const key = keyOf ? keyOf(item, realIdx) : realIdx;
            return (
              <div key={key} style={{ height: itemHeight }}>
                {renderItem(item, realIdx)}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
