/**
 * Reciprocal Rank Fusion：把多个 ranker 的排名合并，比加权求和更鲁棒（不同 ranker 分数尺度不同也无所谓）。
 *   score(item) = Σᵢ 1 / (rrfK + rank_i)
 * rrfK = 60 是 Cormack et al. 2009 的经验值。
 */

export interface RankedItem<T> {
  item: T;
  /** 越大越好 */
  score: number;
}

/** 合并多个 ranker 的结果，返回 RRF top-k。 */
export function rrfMerge<T>(
  rankings: RankedItem<T>[][],
  k: number,
  idOf: (item: T) => string,
  rrfK = 60,
): T[] {
  const accum = new Map<string, { item: T; score: number }>();
  for (const ranking of rankings) {
    // 排序（不破坏入参）
    const sorted = [...ranking].sort((a, b) => b.score - a.score);
    sorted.forEach((r, idx) => {
      const id = idOf(r.item);
      const cur = accum.get(id) ?? { item: r.item, score: 0 };
      cur.score += 1 / (rrfK + idx + 1);
      accum.set(id, cur);
    });
  }
  return [...accum.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.item);
}
