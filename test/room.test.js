import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Room } from '../server/room.js';
import { Store } from '../server/store.js';
import { config as baseConfig } from '../server/config.js';

let dir;
let room;
let sent;

function makeRoom(overrides = {}) {
  sent = [];
  const store = new Store(path.join(dir, 'db.json'));
  return new Room({
    config: { ...baseConfig, ...overrides },
    store,
    transport: {
      send: (id, event, data) => sent.push({ id, event, data }),
      kick: (id, message) => sent.push({ id, event: 'kicked', data: message }),
    },
  });
}
const view = (name) => room.viewFor(name);
// 分小步推进时间，让回调里新排的计时器也能按时触发
const wait = (ms) => {
  for (let t = 0; t < ms; t += 100) mock.timers.tick(Math.min(100, ms - t));
};
// 让当前该行动的人做一个动作
const actNow = (type, amount) => {
  const seat = room.game.hand.toAct;
  room.act(room.seats[seat].name, type, amount);
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poker-test-'));
  mock.timers.enable({ apis: ['setTimeout'] });
  room = makeRoom();
});
afterEach(() => {
  mock.timers.reset();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('进入：第一个人是房主；同名在线时拒绝；凭证可以接回', () => {
  const a = room.join('s1', { name: '  阿明 ' });
  assert.equal(a.name, '阿明');
  assert.equal(room.host, '阿明');
  room.join('s2', { name: '小红' });
  assert.throws(() => room.join('s3', { name: '阿明' }), /正在使用中/);
  room.disconnect('s1');
  const again = room.join('s4', { token: a.token });
  assert.equal(again.name, '阿明');
  assert.equal(room.users.get('阿明').socketId, 's4');
  assert.throws(() => room.join('s5', { name: '   ' }), /请输入昵称/);
});

test('完整一场：买入 → 打牌 → 离座带走筹码 → 补码 → 结算写入计分板', () => {
  room.join('s1', { name: 'A' });
  room.join('s2', { name: 'B' });
  room.sit('A', 0);
  room.sit('B', 4);
  assert.throws(() => room.startSession('B', { buyIn: 1000, sb: 10, bb: 20 }), /只有房主/);
  room.startSession('A', { buyIn: 1000, sb: 10, bb: 20 });
  wait(3000);
  assert.equal(room.game.inHand, false, '开场后不应自动发牌，要等房主开局');
  assert.throws(() => room.deal('B'), /只有房主/);
  room.deal('A');
  assert.equal(room.seats[0].chips, 1000);

  wait(2000);
  assert.ok(room.game.inHand, '开场后应该自动发牌');

  // A、B 都推 all-in，一定有人输光（或平分）
  actNow('allin');
  actNow('call');
  wait(10_000); // 等发完公共牌
  assert.equal(room.game.hand.phase, 'done');
  const ledger = room.session.ledger;
  assert.equal(ledger.A.stack + ledger.B.stack, 2000);
  assert.equal(ledger.A.hands, 1);

  const loser = room.seats.find((s) => s && s.chips === 0);
  if (loser) {
    assert.equal(view(loser.name).me.canRebuy, true);
    room.rebuy(loser.name);
    assert.equal(ledger[loser.name].buyIn, 2000);
    assert.equal(loser.chips, 1000);
  }

  // 离座再坐回，拿回原来的筹码，不会重新买入
  wait(10_000);
  if (room.game.inHand) {
    room.stand('B');
    wait(20_000);
  } else room.stand('B');
  const bStack = ledger.B.stack;
  assert.equal(room.seatOf('B'), -1);
  room.sit('B', 7);
  assert.equal(room.seats[7].chips, bStack);

  if (room.game.inHand) {
    room.endSession('A');
    assert.equal(room.ending, true);
    while (room.game.inHand) {
      const h = room.game.hand;
      if (h.phase === 'betting') actNow('fold');
      else wait(2000);
    }
  } else room.endSession('A');

  assert.equal(room.session, null);
  const board = room.store.scoreboard();
  assert.equal(board.sessions.length, 1);
  const results = board.sessions[0].results;
  assert.equal(results.reduce((s, r) => s + r.net, 0), 0, '一场下来所有人盈亏之和应该为 0');
  assert.ok(sent.some((m) => m.event === 'sessionEnded'));

  // 数据真的写进了文件
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
  assert.equal(onDisk.sessions[0].results.length, 2);
});

test('只能看到自己的底牌', () => {
  room.join('s1', { name: 'A' });
  room.join('s2', { name: 'B' });
  room.join('s3', { name: '观众' });
  room.sit('A', 0);
  room.sit('B', 1);
  room.startSession('A', { buyIn: 1000, sb: 10, bb: 20 });
  room.deal('A');
  wait(2000);
  const va = view('A');
  assert.notEqual(va.seats[0].cards[0], '??');
  assert.deepEqual(va.seats[1].cards, ['??', '??']);
  const vs = view('观众');
  assert.deepEqual(vs.seats[0].cards, ['??', '??']);
  assert.deepEqual(vs.seats[1].cards, ['??', '??']);
  assert.equal(vs.actions, null);
});

test('超时：自动弃牌并标记暂离，暂离的人下一手不发牌', () => {
  room.join('s1', { name: 'A' });
  room.join('s2', { name: 'B' });
  room.join('s3', { name: 'C' });
  room.sit('A', 0);
  room.sit('B', 1);
  room.sit('C', 2);
  room.startSession('A', { buyIn: 1000, sb: 10, bb: 20 });
  room.deal('A');
  wait(2000);
  const h = room.game.hand;
  const slow = h.toAct;
  wait(baseConfig.actionTimeoutMs + 10);
  assert.equal(h.players.get(slow).folded, true);
  assert.equal(room.seats[slow].away, true);
  // 打完这手
  while (room.game.hand === h && h.phase !== 'done') {
    if (h.phase === 'betting') actNow('fold');
    else wait(2000);
  }
  wait(10_000);
  assert.ok(room.game.inHand);
  assert.equal(room.game.hand.players.has(slow), false);
  room.back(room.seats[slow].name);
  assert.equal(room.seats[slow].away, false);
});

test('房主断线超过宽限期才移交', () => {
  room.join('s1', { name: 'A' });
  room.join('s2', { name: 'B' });
  room.disconnect('s1');
  wait(baseConfig.hostGraceMs - 1000);
  assert.equal(room.host, 'A');
  wait(2000);
  assert.equal(room.host, 'B');
});

test('服务器重启后恢复未结束的场次，坐回去拿回筹码', () => {
  room.join('s1', { name: 'A' });
  room.join('s2', { name: 'B' });
  room.sit('A', 0);
  room.sit('B', 1);
  room.startSession('A', { buyIn: 500, sb: 5, bb: 10 });
  room.deal('A');
  wait(2000);
  actNow('fold'); // 单挑：庄家弃牌，大盲赢 15
  const stacks = { A: room.session.ledger.A.stack, B: room.session.ledger.B.stack };
  assert.equal(stacks.A + stacks.B, 1000);

  room = makeRoom(); // 模拟重启
  assert.equal(room.session.id, 1);
  room.join('t1', { name: 'B' });
  room.sit('B', 3);
  assert.equal(room.seats[3].chips, stacks.B);
});

test('进门口令：错的进不来；凭证接回不用再输口令', () => {
  room = makeRoom({ roomPassword: 'pk2026' });
  assert.throws(() => room.join('s1', { name: 'A' }), /口令不对/);
  assert.throws(() => room.join('s1', { name: 'A', password: 'pk2025' }), (e) => e.code === 'BAD_PASSWORD');
  const a = room.join('s1', { name: 'A', password: 'pk2026' });
  room.disconnect('s1');
  assert.equal(room.join('s2', { token: a.token }).name, 'A');
  // IP 被锁定时：口令对了也进不来，但已有凭证的人照样能重连
  assert.throws(() => room.join('s3', { name: 'B', password: 'pk2026', locked: true }), /错太多次/);
  room.disconnect('s2');
  assert.equal(room.join('s4', { token: a.token, locked: true }).name, 'A');
});

test('聊天：广播给所有在线的人、限制长度、防刷屏', () => {
  room.join('s1', { name: 'A' });
  room.join('s2', { name: 'B' });
  sent = [];
  room.chat('A', '  好牌！\n\n ');
  const got = sent.filter((m) => m.event === 'chat');
  assert.deepEqual(got.map((m) => m.id).sort(), ['s1', 's2']);
  assert.equal(got[0].data.text, '好牌！');
  assert.throws(() => room.chat('A', '   '), /说点什么/);
  room.chat('B', '哈'.repeat(500));
  assert.equal([...room.chats.at(-1).text].length, baseConfig.chatMaxLength);
  for (let i = 0; i < 4; i++) room.chat('A', `${i}`);
  assert.throws(() => room.chat('A', '刷屏'), /太快/);
  // 新进来的人能拿到最近的聊天
  assert.ok(room.join('s3', { name: 'C' }).chats.some((c) => c.text === '好牌！'));
});

test('手牌历史：只看得到自己的牌和摊牌亮出的牌，弃牌的人底牌不外泄', () => {
  room.join('s1', { name: 'A' });
  room.join('s2', { name: 'B' });
  room.join('s3', { name: 'C' });
  room.join('s4', { name: '观众' });
  room.sit('A', 0);
  room.sit('B', 1);
  room.sit('C', 2);
  room.startSession('A', { buyIn: 1000, sb: 10, bb: 20 });
  room.deal('A');
  wait(2000);
  const h = room.game.hand;
  const folder = room.seats[h.toAct].name;
  actNow('fold'); // 第一个人弃牌
  while (h.phase !== 'done') {
    if (h.phase === 'betting') actNow(room.game.legalActions(h.toAct).canCheck ? 'check' : 'call');
    else wait(2000);
  }
  const showdown = h.result.type === 'showdown';
  assert.ok(showdown, '剩下两人一路过牌/跟注，应该摊牌');

  const forFolder = room.historyFor(folder)[0];
  const forViewer = room.historyFor('观众')[0];
  assert.equal(forViewer.no, h.no);
  assert.equal(forViewer.pot, 40);
  for (const p of forViewer.players) {
    if (p.name === folder) assert.equal(p.hole, null, '观众不应看到弃牌者的底牌');
    else assert.equal(p.hole.length, 2, '摊牌的人底牌应该公开');
  }
  assert.equal(forFolder.players.find((p) => p.name === folder).hole.length, 2, '自己的底牌自己能看');
  assert.equal(forViewer.players.reduce((s, p) => s + p.net, 0), 0);
  assert.ok(forViewer.log.some((l) => l.includes('亮牌')));
});

test('开局：开场后等人坐齐，房主点开局才发牌；人不够 2 个不能开局', () => {
  room.join('s1', { name: 'A' });
  room.join('s2', { name: 'B' });
  room.join('s3', { name: 'C' });
  room.sit('A', 0);
  room.startSession('A', { buyIn: 1000, sb: 10, bb: 20 });
  assert.equal(view('A').session.started, false);
  assert.throws(() => room.togglePause('A'), /还没开局/);
  assert.throws(() => room.deal('A'), /至少要 2 个人/);
  room.sit('B', 3);
  wait(5000);
  assert.equal(room.game.inHand, false, '人够了也要等房主点开局');
  room.deal('A');
  assert.throws(() => room.deal('A'), /已经开局/);
  wait(1000);
  assert.ok(room.game.inHand);
  // 开局后才来的人，从下一手开始参与
  room.sit('C', 6);
  assert.equal(room.game.hand.players.has(6), false);
  // 结束本场后回到"未开局"
  while (room.game.inHand) {
    const h = room.game.hand;
    if (h.phase === 'betting') actNow('fold');
    else wait(2000);
  }
  room.endSession('A');
  room.startSession('A', { buyIn: 1000, sb: 10, bb: 20 });
  assert.equal(view('A').session.started, false);
});

test('借筹码：两手之间立刻到账；手牌进行中申请的等这手结束才到账；额度 0~上限，0 表示取消', () => {
  room.join('s1', { name: 'A' });
  room.join('s2', { name: 'B' });
  room.sit('A', 0);
  room.sit('B', 1);
  assert.throws(() => room.borrow('A', 100), /还没开场/);
  room.startSession('A', { buyIn: 1000, sb: 10, bb: 20 });

  // 还没开局（不在手牌中）：立刻到账，不必输光
  room.borrow('A', 300);
  assert.equal(room.seats[0].chips, 1300);
  assert.equal(room.session.ledger.A.buyIn, 1300);
  assert.throws(() => room.borrow('A', 1001), /0 ~ 1000/);
  assert.throws(() => room.borrow('A', -5), /0 ~ 1000/);
  assert.throws(() => room.borrow('A', 'abc'), /0 ~ 1000/);

  room.deal('A');
  wait(1000);
  const h = room.game.hand;
  assert.ok(room.game.inHand);
  // 手牌进行中：只登记，不到账（防止看了底牌再加码）
  const before = room.seats[1].chips;
  room.borrow('B', 500);
  assert.equal(room.seats[1].chips, before);
  assert.equal(view('B').me.pendingBorrow, 500);
  room.borrow('B', 0); // 取消
  assert.equal(view('B').me.pendingBorrow, 0);
  room.borrow('B', 200);
  while (room.game.hand === h && h.phase !== 'done') {
    if (h.phase === 'betting') actNow('fold');
    else wait(2000);
  }
  // 这手结束：到账
  assert.equal(view('B').me.pendingBorrow, 0);
  assert.equal(room.session.ledger.B.buyIn, 1200);
  assert.equal(room.session.ledger.B.stack, room.seats[1].chips);
  // 盈亏 = 筹码 − 借入，两人加起来仍然是 0
  const net = Object.values(room.session.ledger).reduce((sum, e) => sum + e.stack - e.buyIn, 0);
  assert.equal(net, 0);
});

test('角色：进门时选的角色会显示在座位上，可以随时换，不认识的角色被拒绝', () => {
  room.join('s1', { name: 'A', avatar: 'panda' });
  room.join('s2', { name: 'B', avatar: '<script>' }); // 不认识的就用默认
  room.sit('A', 0);
  room.sit('B', 1);
  assert.equal(view('B').seats[0].avatar, 'panda');
  assert.ok(view('B').seats[1].avatar && view('B').seats[1].avatar !== '<script>');
  room.setAvatar('A', 'dragon');
  assert.equal(view('B').seats[0].avatar, 'dragon');
  assert.throws(() => room.setAvatar('A', 'hacker'), /没有这个角色/);
});
