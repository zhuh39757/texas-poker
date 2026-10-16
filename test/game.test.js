import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { Game } from '../server/game.js';

// stacks: { 座位号: [名字, 筹码] }
function table(stacks) {
  const seats = Array(9).fill(null);
  for (const [i, [name, chips]] of Object.entries(stacks)) seats[i] = { name, chips };
  return { seats, game: new Game(seats) };
}
const chips = (seats) => seats.map((s) => s?.chips ?? null);

test('单挑：庄家下小盲且翻牌前先说话，翻牌后大盲先说话', () => {
  const { game } = table({ 0: ['A', 1000], 1: ['B', 1000] });
  const h = game.startHand({ participants: [0, 1], sb: 10, bb: 20, rig: { button: 0 } });
  assert.equal(h.sbSeat, 0);
  assert.equal(h.bbSeat, 1);
  assert.equal(h.toAct, 0);
  game.act(0, 'call');
  assert.equal(h.toAct, 1); // 大盲的选择权
  assert.equal(game.legalActions(1).canCheck, true);
  game.act(1, 'check');
  assert.equal(h.street, 'flop');
  assert.equal(h.board.length, 3);
  assert.equal(h.toAct, 1);
});

test('三人：庄位左边小盲、再左大盲，枪口位先说话；第二手庄位轮转', () => {
  const { game } = table({ 0: ['A', 1000], 2: ['B', 1000], 5: ['C', 1000] });
  let h = game.startHand({ participants: [0, 2, 5], sb: 10, bb: 20, rig: { button: 0 } });
  assert.deepEqual([h.buttonSeat, h.sbSeat, h.bbSeat, h.toAct], [0, 2, 5, 0]);
  game.act(0, 'fold');
  game.act(2, 'fold');
  assert.equal(h.phase, 'done');
  h = game.startHand({ participants: [0, 2, 5], sb: 10, bb: 20 });
  assert.deepEqual([h.buttonSeat, h.sbSeat, h.bbSeat, h.toAct], [2, 5, 0, 2]);
});

test('翻牌后每条街都从庄家左边第一个还在局中的人先说话，和上一轮最后过牌/跟注的是谁无关', () => {
  const { game } = table({ 0: ['庄', 1000], 1: ['小盲', 1000], 2: ['大盲', 1000], 3: ['枪口', 1000] });
  const h = game.startHand({ participants: [0, 1, 2, 3], sb: 10, bb: 20, rig: { button: 0 } });
  // 翻牌前：枪口先说话
  assert.equal(h.toAct, 3);
  game.act(3, 'call');
  game.act(0, 'call');
  game.act(1, 'fold'); // 小盲弃牌
  game.act(2, 'check'); // 这一轮最后是大盲过牌
  assert.equal(h.street, 'flop');
  // 庄家左边：小盲已弃牌 → 顺延到大盲；不是"最后过牌者（大盲）的下家枪口"
  assert.equal(h.toAct, 2);
  game.act(2, 'raise', 40);
  game.act(3, 'call');
  game.act(0, 'call'); // 这一轮最后是庄跟注
  assert.equal(h.street, 'turn');
  // 转牌照样从庄家左边第一个在局的人开始，不是"最后跟注者（庄）的下家"
  assert.equal(h.toAct, 2);
});

test('摊牌亮牌顺序：河牌有人下注则最后下注者先亮，否则从庄家左边开始', () => {
  const play = (riverBet) => {
    const { game } = table({ 0: ['A', 1000], 1: ['B', 1000], 2: ['C', 1000] });
    const h = game.startHand({ participants: [0, 1, 2], sb: 10, bb: 20, rig: { button: 0 } });
    game.act(0, 'call');
    game.act(1, 'call');
    game.act(2, 'check');
    for (let i = 0; i < 2; i++) for (const s of [1, 2, 0]) game.act(s, 'check'); // 翻牌、转牌都过牌
    if (riverBet) {
      game.act(1, 'check');
      game.act(2, 'raise', 40); // C 在河牌下注
      game.act(0, 'call');
      game.act(1, 'call');
    } else for (const s of [1, 2, 0]) game.act(s, 'check');
    assert.equal(h.phase, 'done');
    return h.showOrder;
  };
  assert.deepEqual(play(true), [2, 0, 1]);
  assert.deepEqual(play(false), [1, 2, 0]);
});

test('最小加注额 = 上一次加注的增量', () => {
  const { game } = table({ 0: ['A', 1000], 1: ['B', 1000], 2: ['C', 1000] });
  game.startHand({ participants: [0, 1, 2], sb: 10, bb: 20, rig: { button: 0 } });
  assert.throws(() => game.act(0, 'raise', 30), /最少要加到 40/);
  game.act(0, 'raise', 60); // 增量 40
  assert.equal(game.legalActions(1).minRaiseTo, 100);
  assert.throws(() => game.act(1, 'raise', 90), /最少要加到 100/);
  game.act(1, 'raise', 100);
  assert.throws(() => game.act(2, 'raise', 5000), /最多只能加到 1000/);
});

test('不足额 all-in 不重新开放加注', () => {
  const { game } = table({ 0: ['A', 1000], 1: ['B', 1000], 2: ['C', 130] });
  const h = game.startHand({ participants: [0, 1, 2], sb: 10, bb: 20, rig: { button: 0 } });
  game.act(0, 'raise', 100); // 增量 80
  game.act(1, 'call');
  game.act(2, 'allin'); // 加到 130，增量只有 30
  assert.equal(h.currentBet, 130);
  assert.equal(h.toAct, 0);
  const la = game.legalActions(0);
  assert.equal(la.canRaise, false);
  assert.equal(la.callAmount, 30);
  game.act(0, 'call');
  assert.equal(game.legalActions(1).canRaise, false);
  game.act(1, 'call');
  assert.equal(h.street, 'flop');
});

test('完整加注后，已行动过的人可以再加注', () => {
  const { game } = table({ 0: ['A', 1000], 1: ['B', 1000], 2: ['C', 1000] });
  game.startHand({ participants: [0, 1, 2], sb: 10, bb: 20, rig: { button: 0 } });
  game.act(0, 'call');
  game.act(1, 'call');
  game.act(2, 'raise', 80);
  assert.equal(game.legalActions(0).canRaise, true);
  assert.equal(game.legalActions(0).minRaiseTo, 140);
});

test('大家都平跟时，大盲有过牌或加注的选择权', () => {
  const { game } = table({ 0: ['A', 1000], 1: ['B', 1000], 2: ['C', 1000] });
  const h = game.startHand({ participants: [0, 1, 2], sb: 10, bb: 20, rig: { button: 0 } });
  game.act(0, 'call');
  game.act(1, 'call');
  assert.equal(h.street, 'preflop');
  assert.equal(h.toAct, 2);
  const la = game.legalActions(2);
  assert.equal(la.canCheck, true);
  assert.equal(la.canRaise, true);
});

test('都弃牌给大盲：大盲赢得盲注，不亮牌', () => {
  const { seats, game } = table({ 0: ['A', 1000], 1: ['B', 1000], 2: ['C', 1000] });
  const h = game.startHand({ participants: [0, 1, 2], sb: 10, bb: 20, rig: { button: 0 } });
  game.act(0, 'fold');
  game.act(1, 'fold');
  assert.equal(h.phase, 'done');
  assert.equal(h.result.type, 'uncontested');
  assert.equal(h.revealed, false);
  assert.deepEqual(chips(seats).slice(0, 3), [1000, 990, 1010]);
});

test('边池结算：短码赢主池，大码之间争边池', () => {
  const { seats, game } = table({ 0: ['A', 100], 1: ['B', 1000], 2: ['C', 1000] });
  const h = game.startHand({
    participants: [0, 1, 2], sb: 10, bb: 20,
    rig: { button: 0, holes: { 0: ['As', 'Ah'], 1: ['Ks', 'Kh'], 2: ['Qs', 'Qh'] }, board: ['2c', '7d', '9s', 'Jc', '3h'] },
  });
  game.act(0, 'allin');
  game.act(1, 'call');
  game.act(2, 'call');
  assert.equal(h.street, 'flop');
  assert.equal(h.toAct, 1);
  game.act(1, 'raise', 200);
  game.act(2, 'call');
  game.act(1, 'check');
  game.act(2, 'check');
  game.act(1, 'check');
  game.act(2, 'check');
  assert.equal(h.phase, 'done');
  assert.deepEqual(h.result.pots.map((p) => [p.amount, p.winners]), [[300, [0]], [400, [1]]]);
  assert.deepEqual(chips(seats).slice(0, 3), [300, 1100, 700]);
});

test('全员 all-in：进入 runout，一条街一条街发完再摊牌', () => {
  const { seats, game } = table({ 0: ['A', 500], 1: ['B', 800] });
  const h = game.startHand({
    participants: [0, 1], sb: 10, bb: 20,
    rig: { button: 0, holes: { 0: ['As', 'Ah'], 1: ['Ks', 'Kh'] }, board: ['2c', '7d', '9s', 'Jc', 'Kd'] },
  });
  game.act(0, 'call');
  game.act(1, 'allin'); // B 推 800
  game.act(0, 'call'); // A 只有 500，all-in 跟注
  assert.equal(h.phase, 'runout');
  assert.equal(h.revealed, true);
  game.runoutStep();
  assert.equal(h.board.length, 3);
  game.runoutStep();
  game.runoutStep();
  assert.equal(h.phase, 'done');
  // B 河牌中三条 K，赢 1000；A 剩 0，B 多出的 300 原数退回
  assert.deepEqual(h.result.pots.map((p) => [p.amount, p.winners, p.returned]), [[1000, [1], false], [300, [1], true]]);
  assert.deepEqual(chips(seats).slice(0, 2), [0, 1300]);
});

test('平分底池，除不尽的零头从庄位左边开始给', () => {
  const { seats, game } = table({ 0: ['A', 1000], 1: ['B', 1000], 2: ['C', 1000] });
  const h = game.startHand({
    participants: [0, 1, 2], sb: 5, bb: 10,
    rig: { button: 0, holes: { 0: ['2c', '3d'], 1: ['6c', '7d'], 2: ['4c', '5d'] }, board: ['As', 'Ks', 'Qs', 'Js', 'Ts'] },
  });
  game.act(0, 'call');
  game.act(1, 'fold');
  game.act(2, 'check');
  for (let i = 0; i < 3; i++) {
    game.act(2, 'check');
    game.act(0, 'check');
  }
  assert.equal(h.phase, 'done');
  assert.deepEqual(h.result.pots[0].winners, [2, 0]);
  assert.deepEqual(chips(seats).slice(0, 3), [1002, 995, 1003]); // 25 = 13 + 12
});

test('盲注不够：直接 all-in，其他人仍需跟满大盲', () => {
  const { seats, game } = table({ 0: ['A', 1000], 1: ['B', 1000], 2: ['C', 15] });
  const h = game.startHand({ participants: [0, 1, 2], sb: 10, bb: 20, rig: { button: 0 } });
  assert.equal(seats[2].chips, 0);
  assert.equal(h.players.get(2).allIn, true);
  assert.equal(h.currentBet, 20);
  assert.equal(game.legalActions(0).callAmount, 20);
});

test('离座时不在回合内弃牌；只剩一人直接获胜', () => {
  const { game } = table({ 0: ['A', 1000], 1: ['B', 1000], 2: ['C', 1000] });
  const h = game.startHand({ participants: [0, 1, 2], sb: 10, bb: 20, rig: { button: 0 } });
  game.foldOutOfTurn(1);
  assert.equal(h.toAct, 0);
  game.foldOutOfTurn(2);
  assert.equal(h.phase, 'done');
  assert.deepEqual(h.result.winners, [0]);
});

test('非法操作会被拒绝', () => {
  const { game } = table({ 0: ['A', 1000], 1: ['B', 1000], 2: ['C', 1000] });
  game.startHand({ participants: [0, 1, 2], sb: 10, bb: 20, rig: { button: 0 } });
  assert.throws(() => game.act(1, 'call'), /还没轮到你/);
  assert.throws(() => game.act(0, 'check'), /需要跟注/);
  assert.throws(() => game.act(0, 'raise', 'abc'), /金额无效/);
  assert.throws(() => game.act(0, 'dance'), /未知操作/);
});

test('压力测试：随机打 3000 手，筹码总量始终守恒', () => {
  const N = 6;
  const stacks = {};
  for (let i = 0; i < N; i++) stacks[i * (9 / N) | 0] = [`P${i}`, 200 + randomInt(1800)];
  const { seats, game } = table(stacks);
  const total = () => seats.reduce((s, x) => s + (x?.chips ?? 0), 0);
  const TOTAL = total();

  for (let n = 0; n < 3000; n++) {
    let participants = seats.map((s, i) => (s && s.chips > 0 ? i : -1)).filter((i) => i >= 0);
    if (participants.length < 2) {
      for (const s of seats) if (s) s.chips = Math.floor(TOTAL / N);
      seats.find((s) => s).chips += TOTAL - total();
      participants = seats.map((s, i) => (s ? i : -1)).filter((i) => i >= 0);
    }
    const h = game.startHand({ participants, sb: 10, bb: 20 });

    let steps = 0;
    while (h.phase !== 'done') {
      assert.ok(++steps < 500, '一手牌没能结束');
      const inPot = [...h.players.values()].reduce((s, p) => s + p.total, 0);
      assert.equal(total() + inPot, TOTAL, '筹码在手牌中途不守恒');
      if (h.phase === 'runout') {
        game.runoutStep();
        continue;
      }
      const seat = h.toAct;
      const la = game.legalActions(seat);
      assert.ok(la, `phase=${h.phase} 却没人能行动`);
      const r = randomInt(100);
      if (r < 15) game.act(seat, 'fold');
      else if (r < 55) game.act(seat, la.canCheck ? 'check' : 'call');
      else if (r < 90 && la.canRaise) game.act(seat, 'raise', la.minRaiseTo + randomInt(la.maxRaiseTo - la.minRaiseTo + 1));
      else if (la.canRaise) game.act(seat, 'allin');
      else game.act(seat, la.canCheck ? 'check' : 'call');
      if (randomInt(200) === 0 && h.phase !== 'done') {
        const someone = [...h.players.keys()][randomInt(h.players.size)];
        game.foldOutOfTurn(someone);
      }
    }
    assert.equal(total(), TOTAL, `第 ${n} 手结束后筹码不守恒`);
    for (const s of seats) if (s) assert.ok(s.chips >= 0);
    assert.equal(h.result.pots.reduce((s, p) => s + p.amount, 0), [...h.players.values()].reduce((s, p) => s + p.total, 0));
  }
});
