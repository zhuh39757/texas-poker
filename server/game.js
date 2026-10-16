import { randomInt } from 'node:crypto';
import { newDeck, shuffle } from './cards.js';
import { evaluate } from './evaluator.js';
import { buildPots } from './pots.js';
import { UserError } from './errors.js';

const STREETS = ['preflop', 'flop', 'turn', 'river'];
export const STREET_NAMES = { preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌', showdown: '摊牌' };

// 单手牌状态机。只管规则和筹码，不管网络、计时和计分。
// seats 与 Room 共享：seats[i] = { name, chips, ... } | null，下注和派奖直接改 seats[i].chips
export class Game {
  constructor(seats) {
    this.seats = seats;
    this.button = -1;
    this.handNo = 0;
    this.hand = null;
  }

  get inHand() {
    return !!this.hand && this.hand.phase !== 'done';
  }

  isParticipant(seat) {
    return this.inHand && this.hand.players.has(seat);
  }

  // participants: 参与本手的座位号；rig 仅供测试指定手牌和公共牌
  startHand({ participants, sb, bb, rig = null }) {
    if (this.inHand) throw new UserError('上一手还没结束');
    const order = [...participants].sort((a, b) => a - b);
    if (order.length < 2) throw new UserError('至少需要 2 名玩家');
    for (const s of order) {
      if (!this.seats[s] || this.seats[s].chips <= 0) throw new UserError(`座位 ${s} 无法参与`);
    }

    let deck = shuffle(newDeck());
    if (rig) {
      const used = new Set([...Object.values(rig.holes || {}).flat(), ...(rig.board || [])]);
      deck = deck.filter((c) => !used.has(c));
    }

    this.button = this.button === -1 || rig?.button !== undefined
      ? (rig?.button ?? order[randomInt(order.length)])
      : nextIn(order, this.button);
    const headsUp = order.length === 2;
    const sbSeat = headsUp ? this.button : nextIn(order, this.button);
    const bbSeat = nextIn(order, sbSeat);

    const players = new Map();
    for (const s of order) {
      players.set(s, {
        seat: s,
        name: this.seats[s].name,
        startChips: this.seats[s].chips,
        hole: null,
        folded: false,
        allIn: false,
        streetBet: 0,
        total: 0,
        won: 0,
        acted: false,
        actedAtRaise: -1,
        lastAction: '',
      });
    }

    this.handNo++;
    this.hand = {
      no: this.handNo,
      order,
      players,
      deck,
      rigBoard: rig?.board ? [...rig.board] : [],
      board: [],
      street: 'preflop',
      phase: 'betting', // betting | runout | done
      buttonSeat: this.button,
      sbSeat,
      bbSeat,
      sb,
      bb,
      currentBet: 0,
      minRaise: bb,
      raiseCount: 0, // 本轮完整加注次数，用来判断是否重新开放加注
      toAct: null,
      actionCount: 0, // 每次有人行动 +1，Room 用它判断要不要重置计时器
      lastAggressor: null, // 本条街最后一个下注/加注的人，决定摊牌谁先亮
      revealed: false,
      result: null,
      log: [],
    };
    const h = this.hand;

    // 从小盲开始发牌
    for (const s of [sbSeat, ...this._after(sbSeat).slice(0, -1)]) {
      players.get(s).hole = rig?.holes?.[s] ? [...rig.holes[s]] : [deck.pop(), deck.pop()];
    }

    this._post(sbSeat, sb, '小盲');
    this._post(bbSeat, bb, '大盲');
    h.currentBet = bb;

    this._progress(bbSeat);
    return h;
  }

  _post(seat, amount, label) {
    const p = this.hand.players.get(seat);
    const paid = this._pay(p, amount);
    p.lastAction = label;
    this._log(`${p.name} 下${label} ${paid}${p.allIn ? '（All-in）' : ''}`);
  }

  // 从座位里拿出筹码放到本轮下注里
  _pay(p, amount) {
    const seat = this.seats[p.seat];
    const paid = Math.min(amount, seat.chips);
    seat.chips -= paid;
    p.streetBet += paid;
    p.total += paid;
    if (seat.chips === 0) p.allIn = true;
    return paid;
  }

  _log(text) {
    this.hand.log.push(text);
  }

  // 座位号按顺时针排列，从 seat 的下一位开始，seat 自己（若在局中）排在最后
  _after(seat) {
    const o = this.hand.order;
    const i = o.findIndex((s) => s > seat);
    const start = i === -1 ? 0 : i;
    return [...o.slice(start), ...o.slice(0, start)];
  }

  _live() {
    return [...this.hand.players.values()].filter((p) => !p.folded);
  }

  legalActions(seat) {
    const h = this.hand;
    if (!this.inHand || h.phase !== 'betting' || h.toAct !== seat) return null;
    const p = h.players.get(seat);
    const chips = this.seats[seat].chips;
    const toCall = h.currentBet - p.streetBet;
    const othersCanAct = this._live().some((o) => o.seat !== seat && !o.allIn);
    const reopened = !p.acted || p.actedAtRaise < h.raiseCount;
    const canRaise = chips > toCall && othersCanAct && reopened;
    const maxRaiseTo = p.streetBet + chips;
    const minRaiseTo = Math.min(h.currentBet + h.minRaise, maxRaiseTo);
    return {
      toCall,
      canCheck: toCall === 0,
      callAmount: Math.min(toCall, chips),
      canRaise,
      minRaiseTo,
      maxRaiseTo,
      isBet: h.currentBet === 0, // 本轮还没人下注时叫"下注"，否则叫"加注"
    };
  }

  // type: fold | check | call | raise | allin；raise 的 amount 是"加注到"的本轮总额
  act(seat, type, amount) {
    const h = this.hand;
    const la = this.legalActions(seat);
    if (!la) throw new UserError('还没轮到你');
    const p = h.players.get(seat);

    if (type === 'allin') {
      if (la.maxRaiseTo <= h.currentBet) type = 'call';
      else if (la.canRaise) {
        type = 'raise';
        amount = la.maxRaiseTo;
      } else throw new UserError('现在不能再加注，只能跟注或弃牌');
    }

    switch (type) {
      case 'fold':
        p.folded = true;
        p.lastAction = '弃牌';
        this._log(`${p.name} 弃牌`);
        break;
      case 'check':
        if (!la.canCheck) throw new UserError('需要跟注，不能过牌');
        p.lastAction = '过牌';
        this._log(`${p.name} 过牌`);
        break;
      case 'call': {
        if (la.canCheck) throw new UserError('没有需要跟的注，请选择过牌');
        const paid = this._pay(p, la.toCall);
        p.lastAction = p.allIn ? 'All-in' : '跟注';
        this._log(`${p.name} 跟注 ${paid}${p.allIn ? '（All-in）' : ''}`);
        break;
      }
      case 'raise': {
        if (!la.canRaise) throw new UserError('现在不能加注');
        amount = Math.floor(Number(amount));
        if (!Number.isFinite(amount)) throw new UserError('加注金额无效');
        if (amount > la.maxRaiseTo) throw new UserError(`最多只能加到 ${la.maxRaiseTo}`);
        if (amount < la.minRaiseTo) throw new UserError(`最少要加到 ${la.minRaiseTo}`);
        const increment = amount - h.currentBet;
        if (increment >= h.minRaise) {
          // 完整加注：更新最小加注额，并重新开放加注
          h.minRaise = increment;
          h.raiseCount++;
        }
        h.currentBet = amount;
        h.lastAggressor = seat;
        this._pay(p, amount - p.streetBet);
        const word = la.isBet ? '下注' : '加注到';
        p.lastAction = p.allIn ? 'All-in' : `${la.isBet ? '下注' : '加注'}`;
        this._log(`${p.name} ${word} ${amount}${p.allIn ? '（All-in）' : ''}`);
        break;
      }
      default:
        throw new UserError('未知操作');
    }

    p.acted = true;
    p.actedAtRaise = h.raiseCount;
    h.actionCount++;
    this._progress(seat);
  }

  // 超时：能过牌就过牌，否则弃牌
  autoAct(seat) {
    const la = this.legalActions(seat);
    if (!la) return;
    this.act(seat, la.canCheck ? 'check' : 'fold');
  }

  // 不在自己回合时弃牌（离座时用）。All-in 的人已经没有决定可做，不处理
  foldOutOfTurn(seat) {
    const h = this.hand;
    if (!this.inHand) return;
    const p = h.players.get(seat);
    if (!p || p.folded || p.allIn) return;
    if (h.phase === 'betting' && h.toAct === seat) return this.act(seat, 'fold');
    p.folded = true;
    p.lastAction = '弃牌';
    this._log(`${p.name} 弃牌`);
    const live = this._live();
    if (live.length === 1) return this._winUncontested(live[0]);
    if (h.phase === 'betting' && this._roundComplete()) this._closeStreet();
  }

  _progress(fromSeat) {
    const h = this.hand;
    const live = this._live();
    if (live.length === 1) return this._winUncontested(live[0]);
    if (this._roundComplete()) return this._closeStreet();
    h.toAct = this._nextToAct(fromSeat);
  }

  _roundComplete() {
    const h = this.hand;
    const canAct = this._live().filter((p) => !p.allIn);
    if (canAct.length === 0) return true;
    if (canAct.length === 1 && canAct[0].streetBet >= h.currentBet) return true;
    return canAct.every((p) => p.acted && p.streetBet === h.currentBet);
  }

  _nextToAct(fromSeat) {
    const h = this.hand;
    for (const s of this._after(fromSeat)) {
      const p = h.players.get(s);
      if (!p.folded && !p.allIn && (!p.acted || p.streetBet < h.currentBet)) return s;
    }
    return null;
  }

  _closeStreet() {
    const h = this.hand;
    for (const p of h.players.values()) {
      p.streetBet = 0;
      p.acted = false;
      p.actedAtRaise = -1;
    }
    const riverAggressor = h.street === 'river' ? h.lastAggressor : null;
    h.currentBet = 0;
    h.minRaise = h.bb;
    h.raiseCount = 0;
    h.lastAggressor = null;
    h.toAct = null;

    if (h.street === 'river') return this._showdown(riverAggressor);

    if (this._live().filter((p) => !p.allIn).length <= 1) {
      // 没人能再下注了：亮牌，由 Room 定时调用 runoutStep 一条街一条街地发完
      h.phase = 'runout';
      h.revealed = true;
      this._log('无需继续下注，亮牌发完公共牌');
      return;
    }

    this._dealStreet();
    h.toAct = this._nextToAct(h.buttonSeat);
  }

  _dealStreet() {
    const h = this.hand;
    const next = STREETS[STREETS.indexOf(h.street) + 1];
    const n = next === 'flop' ? 3 : 1;
    h.deck.pop(); // 烧一张
    for (let i = 0; i < n; i++) h.board.push(h.rigBoard.length ? h.rigBoard.shift() : h.deck.pop());
    h.street = next;
    for (const p of h.players.values()) {
      if (!p.folded && !p.allIn) p.lastAction = '';
    }
    this._log(`—— ${STREET_NAMES[next]}：${h.board.join(' ')}`);
  }

  // 全员 all-in 后由 Room 定时调用，每次发一条街，发完就摊牌
  runoutStep() {
    const h = this.hand;
    if (!this.inHand || h.phase !== 'runout') return;
    this._dealStreet();
    if (h.street === 'river') this._showdown();
  }

  _award(p, amount) {
    this.seats[p.seat].chips += amount;
    p.won += amount;
  }

  _winUncontested(p) {
    const h = this.hand;
    const amount = [...h.players.values()].reduce((sum, x) => sum + x.total, 0);
    this._award(p, amount);
    h.toAct = null;
    h.phase = 'done';
    h.result = {
      type: 'uncontested',
      pots: [{ amount, eligible: [p.seat], winners: [p.seat], handName: null }],
      winners: [p.seat],
    };
    this._log(`${p.name} 赢得 ${amount}（其他人都弃牌）`);
  }

  // 亮牌顺序：河牌圈最后下注/加注的人先亮；没人下注就从庄家左边第一个还在局中的人开始
  // （全员 all-in 发完牌时没有河牌圈下注，同样从庄家左边开始）
  showdownOrder(aggressor = null) {
    const h = this.hand;
    const live = new Set(this._live().map((p) => p.seat));
    const from = aggressor != null && live.has(aggressor) ? aggressor : null;
    const order = from != null ? [from, ...this._after(from).slice(0, -1)] : this._after(h.buttonSeat);
    return order.filter((s) => live.has(s));
  }

  _showdown(aggressor = null) {
    const h = this.hand;
    h.street = 'showdown';
    h.toAct = null;
    h.revealed = true;

    const evals = new Map();
    h.showOrder = this.showdownOrder(aggressor);
    for (const s of h.showOrder) {
      const p = h.players.get(s);
      const e = evaluate([...p.hole, ...h.board]);
      evals.set(p.seat, e);
      this._log(`${p.name} 亮牌 ${p.hole.join(' ')}：${e.name}`);
    }

    const pots = buildPots([...h.players.values()].map((p) => ({ id: p.seat, contributed: p.total, folded: p.folded })));
    const resultPots = [];
    const winnersAll = new Set();
    for (const pot of pots) {
      let best = -1;
      let winners = [];
      for (const s of pot.eligible) {
        const sc = evals.get(s).score;
        if (sc > best) {
          best = sc;
          winners = [s];
        } else if (sc === best) winners.push(s);
      }
      // 除不尽的零头从庄位左边开始依次分
      const ordered = this._after(h.buttonSeat).filter((s) => winners.includes(s));
      const share = Math.floor(pot.amount / ordered.length);
      let rem = pot.amount - share * ordered.length;
      for (const s of ordered) {
        this._award(h.players.get(s), share + (rem > 0 ? 1 : 0));
        if (rem > 0) rem--;
      }
      const returned = pot.eligible.length === 1;
      if (!returned) ordered.forEach((s) => winnersAll.add(s));
      resultPots.push({ amount: pot.amount, eligible: pot.eligible, winners: ordered, handName: returned ? null : evals.get(ordered[0]).name, returned });
      const names = ordered.map((s) => h.players.get(s).name).join('、');
      this._log(returned ? `退还 ${names} 未被跟注的 ${pot.amount}` : `${names} 赢得 ${pot.amount}（${evals.get(ordered[0]).name}）`);
    }

    h.phase = 'done';
    h.result = {
      type: 'showdown',
      pots: resultPots,
      winners: [...winnersAll],
      hands: Object.fromEntries([...evals].map(([s, e]) => [s, { name: e.name, best5: e.best5 }])),
    };
  }

  // 显示用：已结束的各轮下注组成的底池（不含本轮还摆在玩家面前的注）
  displayPots() {
    const h = this.hand;
    if (!h) return [];
    if (h.result) return h.result.pots.map((p) => ({ amount: p.amount, eligible: p.eligible }));
    return buildPots([...h.players.values()].map((p) => ({ id: p.seat, contributed: p.total - p.streetBet, folded: p.folded })));
  }
}

function nextIn(sortedSeats, seat) {
  return sortedSeats.find((s) => s > seat) ?? sortedSeats[0];
}
