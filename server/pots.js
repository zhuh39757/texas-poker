// 按每人整手累计投入分层，算出主池和边池
// players: [{ id, contributed, folded }]
// 返回: [{ amount, eligible: [id, ...] }]，第一个是主池
export function buildPots(players) {
  const live = players.filter((p) => !p.folded && p.contributed > 0);
  const levels = [...new Set(live.map((p) => p.contributed))].sort((a, b) => a - b);

  const pots = [];
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    for (const p of players) {
      amount += Math.max(0, Math.min(p.contributed, level) - Math.min(p.contributed, prev));
    }
    const eligible = live.filter((p) => p.contributed >= level).map((p) => p.id);
    if (amount > 0) pots.push({ amount, eligible });
    prev = level;
  }

  // 弃牌玩家投入超过最高分层的部分（正常流程不会出现，兜底并入最后一个池）
  let extra = 0;
  for (const p of players) extra += Math.max(0, p.contributed - prev);
  if (extra > 0) {
    if (pots.length) pots[pots.length - 1].amount += extra;
    else pots.push({ amount: extra, eligible: players.filter((p) => !p.folded).map((p) => p.id) });
  }
  return pots;
}
