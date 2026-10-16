// 命令行参数：node server/index.js --port 3001 --data data/test.json
const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
};

// 可调参数集中在这里，改完重启服务器生效
export const config = {
  port: Number(arg('--port') || process.env.PORT) || 3000,
  maxSeats: 9,

  // 默认值，房主开新场时可以改
  defaultBuyIn: 1000,
  defaultSmallBlind: 10,
  defaultBigBlind: 20,

  // 计时（毫秒）
  actionTimeoutMs: 30_000,      // 每次行动限时
  nextHandDelayMs: 3_000,       // 无人摊牌时两手之间的间隔
  showdownDelayMs: 6_000,       // 摊牌后两手之间的间隔
  runoutStreetDelayMs: 1_500,   // 全员 all-in 后每条街的发牌间隔
  hostGraceMs: 20_000,          // 房主断线多久后移交

  nameMaxLength: 12,
  dataFile: arg('--data') || process.env.POKER_DATA || 'data/db.json',

  // 进门口令：放到公网时务必设置；留空表示不需要口令（局域网用）
  roomPassword: arg('--password') || process.env.POKER_PASSWORD || '',
  passwordMaxFailures: 8, // 同一个 IP 口令连错这么多次……
  passwordLockMs: 10 * 60_000, // ……就锁定这么久

  chatMaxLength: 120,
  chatKeep: 100, // 服务器保留最近多少条聊天，新进来的人能看到
  historyKeep: 50, // 保留最近多少手牌历史（只在内存里，重启清空）
};
