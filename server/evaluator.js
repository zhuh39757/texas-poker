import { rankValue, suitOf } from './cards.js';

export const CATEGORY_NAMES = ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺'];

// 评估恰好 5 张牌，返回 { cat, ranks }；ranks 是比较用的点数序列（重要的在前）
function eval5(cards) {
  const vals = cards.map(rankValue).sort((a, b) => b - a);
  const flush = cards.every((c) => suitOf(c) === suitOf(cards[0]));

  let straightHigh = 0;
  const uniq = [...new Set(vals)];
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    else if (uniq[0] === 14 && uniq[1] === 5) straightHigh = 5; // A-2-3-4-5，A 当 1 用
  }

  // 按"张数多的在前，同张数点数大的在前"分组
  const counts = new Map();
  for (const v of vals) counts.set(v, (counts.get(v) || 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const byGroup = groups.map((g) => g[0]);
  const [c1, c2] = [groups[0][1], groups[1]?.[1]];

  if (straightHigh && flush) return { cat: 8, ranks: [straightHigh] };
  if (c1 === 4) return { cat: 7, ranks: byGroup };
  if (c1 === 3 && c2 === 2) return { cat: 6, ranks: byGroup };
  if (flush) return { cat: 5, ranks: vals };
  if (straightHigh) return { cat: 4, ranks: [straightHigh] };
  if (c1 === 3) return { cat: 3, ranks: byGroup };
  if (c1 === 2 && c2 === 2) return { cat: 2, ranks: byGroup };
  if (c1 === 2) return { cat: 1, ranks: byGroup };
  return { cat: 0, ranks: vals };
}

// 把 { cat, ranks } 编码成一个整数，数字大的牌大
function encode({ cat, ranks }) {
  let score = cat;
  for (let i = 0; i < 5; i++) score = score * 15 + (ranks[i] || 0);
  return score;
}

function* combinations(arr, k, start = 0, picked = []) {
  if (picked.length === k) {
    yield picked.slice();
    return;
  }
  for (let i = start; i <= arr.length - (k - picked.length); i++) {
    picked.push(arr[i]);
    yield* combinations(arr, k, i + 1, picked);
    picked.pop();
  }
}

// 从 5~7 张牌里选出最好的 5 张
export function evaluate(cards) {
  if (cards.length < 5) throw new Error('至少需要 5 张牌');
  let best = null;
  for (const five of combinations(cards, 5)) {
    const r = eval5(five);
    const score = encode(r);
    if (!best || score > best.score) best = { score, cat: r.cat, ranks: r.ranks, best5: five };
  }
  best.name = best.cat === 8 && best.ranks[0] === 14 ? '皇家同花顺' : CATEGORY_NAMES[best.cat];
  return best;
}
