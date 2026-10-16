// 机器人：自动进入、坐下、打牌，一个人也能测多人局
// 用法：npm run bots -- 3                     （3 个机器人连本机）
//       npm run bots -- 3 http://192.168.1.5:3000
//       npm run bots -- 3 http://1.2.3.4:3000 房间口令
import { io } from 'socket.io-client';

const count = Number(process.argv[2]) || 3;
const url = process.argv[3] || 'http://localhost:3000';
const password = process.argv[4] || process.env.POKER_PASSWORD;
for (let i = 1; i <= count; i++) startBot(`机器人${i}`);
console.log(`${count} 个机器人连接到 ${url}，按 Ctrl+C 让它们离开`);

function startBot(name) {
  const socket = io(url);
  let token = null;
  let state = null;
  let busy = false;

  const emit = (event, payload = {}) => new Promise((resolve) => socket.emit(event, payload, resolve));

  socket.on('connect', async () => {
    const avatars = ['fox', 'panda', 'tiger', 'frog', 'cat', 'dog', 'monkey', 'lion', 'pig', 'rabbit', 'dragon', 'unicorn'];
    const res = await emit('join', { name, token, password, avatar: avatars[Math.floor(Math.random() * avatars.length)] });
    if (!res.ok) {
      console.log(`${name}: ${res.error}`);
      socket.close();
      return;
    }
    token = res.token;
  });
  let cheeredHand = 0;
  socket.on('state', (s) => {
    state = s;
    // 赢了偶尔得意一下，顺便测聊天气泡
    const h = s.hand;
    if (h?.result && h.no !== cheeredHand && h.result.winners.includes(s.me.seat)) {
      cheeredHand = h.no;
      if (Math.random() < 0.3) emit('chat', { text: ['好牌！👍', '运气不错 😏', '😎', '💰', '🔥'][Math.floor(Math.random() * 5)] });
    }
    tick();
  });

  async function tick() {
    if (busy || !state) return;
    busy = true;
    try {
      const { me, actions } = state;
      if (me.seat === -1) {
        // 随机挑空位，几个机器人同时抢同一个座位时失败了就稍后重试
        const free = state.seats.map((x, i) => (x ? -1 : i)).filter((i) => i >= 0);
        if (free.length) {
          const res = await emit('sit', { seat: free[Math.floor(Math.random() * free.length)] });
          if (!res.ok) setTimeout(tick, 300 + Math.random() * 500);
        }
      } else if (me.canRebuy) {
        await emit('rebuy');
      } else if (me.away) {
        await emit('back');
      } else if (actions) {
        await sleep(500 + Math.random() * 1200);
        if (state.actions) await emit('action', decide(state.actions, state));
      }
    } finally {
      busy = false;
    }
    if (state.actions) setTimeout(tick, 50);
  }
}

// 很随便的打法：大多跟注/过牌，偶尔加注，面对大注时常弃牌
function decide(a, state) {
  const bb = state.session?.bb || 20;
  const r = Math.random();
  const raiseTo = () => Math.min(a.maxRaiseTo, a.minRaiseTo + Math.floor(Math.random() * 3) * bb);
  if (a.canCheck) {
    if (a.canRaise && r < 0.2) return { type: 'raise', amount: raiseTo() };
    return { type: 'check' };
  }
  if (a.toCall > bb * 6 && r < 0.45) return { type: 'fold' };
  if (a.canRaise && r < 0.12) return { type: 'raise', amount: raiseTo() };
  if (r < 0.85) return { type: 'call' };
  return { type: 'fold' };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
