import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Game, STREET_NAMES } from './game.js';
import { UserError } from './errors.js';

// 可选角色（只是外观，和前端 public/app.js 里的 AVATARS 保持一致）
export const AVATAR_IDS = ['fox', 'panda', 'tiger', 'frog', 'cat', 'dog', 'monkey', 'lion', 'pig', 'rabbit', 'dragon', 'unicorn'];

// 房间：管用户、座位、房主、场次和计分、各种计时器，并为每个人生成"各自视角"的画面
// transport: { send(socketId, event, data), kick(socketId, message) }
export class Room {
  constructor({ config, store, transport }) {
    this.cfg = config;
    this.store = store;
    this.transport = transport;
    this.users = new Map(); // 昵称 -> { name, token, socketId, joinedAt }
    this.tokens = new Map(); // 凭证 -> 昵称
    this.seats = Array(config.maxSeats).fill(null); // { name, chips, away, leaveAfterHand }
    this.game = new Game(this.seats);
    this.host = null;
    this.session = store.activeSession(); // 服务器重启后恢复未结束的场次
    this.paused = false;
    this.ending = false;
    this.started = false; // 本场是否已经由房主开局（重启后要重新开局）
    this.log = [];
    this.logCursor = { hand: 0, line: 0 };
    this.chats = [];
    this.chatSeq = 0;
    this.histories = [];
    this.handSettled = true;
    this.timers = { action: null, auto: null, runout: null, next: null, host: null };
    this.timerKey = null;
    this.deadline = null;
    if (this.session) this.addLog(`已恢复第 ${this.session.id} 场（上次没有结束），大家重新坐下后由房主点"开局"`);
  }

  // ---------- 用户 ----------

  join(socketId, { name, token, password, locked = false, avatar }) {
    let user = token && this.tokens.has(token) ? this.users.get(this.tokens.get(token)) : null;
    if (!user) {
      this.checkPassword(password, locked); // 凭证是口令验证通过后才发的，凭证接回不用再验
      name = cleanName(name, this.cfg.nameMaxLength);
      if (!name) throw new UserError('请输入昵称');
      user = this.users.get(name);
      if (user?.socketId) throw new UserError('这个昵称正在使用中，换一个吧');
      if (!user) {
        user = { name, token: null, socketId: null, joinedAt: Date.now() };
        this.users.set(name, user);
      }
      if (user.token) this.tokens.delete(user.token);
      user.token = randomBytes(16).toString('hex');
      this.tokens.set(user.token, name);
    }

    if (AVATAR_IDS.includes(avatar)) user.avatar = avatar;
    user.avatar ??= AVATAR_IDS[[...user.name].reduce((h, c) => h + c.codePointAt(0), 0) % AVATAR_IDS.length];

    const old = user.socketId;
    user.socketId = socketId;
    if (old && old !== socketId) this.transport.kick(old, '你在另一个页面重新进入了，这里已断开');

    const hostOnline = this.host && this.users.get(this.host)?.socketId;
    if (!hostOnline && !this.timers.host) this.host = user.name;
    if (this.host === user.name) this.clearTimer('host');

    this.addLog(`${user.name} 进入房间`);
    this.maybeStartHand();
    this.broadcast();
    return { token: user.token, name: user.name, avatar: user.avatar, chats: this.chats.slice(-50) };
  }

  setAvatar(name, avatar) {
    if (!AVATAR_IDS.includes(avatar)) throw new UserError('没有这个角色');
    this.users.get(name).avatar = avatar;
    this.broadcast();
  }

  checkPassword(password, locked) {
    if (!this.cfg.roomPassword) return;
    if (locked) throw new UserError('口令错太多次了，过 10 分钟再试');
    const a = Buffer.from(String(password ?? ''));
    const b = Buffer.from(this.cfg.roomPassword);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new UserError('房间口令不对', 'BAD_PASSWORD');
  }

  // ---------- 聊天 ----------

  chat(name, text) {
    const user = this.users.get(name);
    text = cleanText(text, this.cfg.chatMaxLength);
    if (!text) throw new UserError('说点什么吧');
    const now = Date.now();
    user.chatTimes = (user.chatTimes || []).filter((t) => now - t < 10_000);
    if (user.chatTimes.length >= 5) throw new UserError('说得太快了，歇一会儿');
    user.chatTimes.push(now);
    const msg = { id: ++this.chatSeq, t: now, name, text };
    this.chats.push(msg);
    if (this.chats.length > this.cfg.chatKeep) this.chats.shift();
    for (const u of this.users.values()) {
      if (u.socketId) this.transport.send(u.socketId, 'chat', msg);
    }
  }

  // ---------- 手牌历史 ----------

  recordHand(h) {
    this.histories.push({
      no: h.no,
      t: Date.now(),
      sessionId: this.session?.id ?? null,
      sb: h.sb,
      bb: h.bb,
      button: h.players.get(h.buttonSeat)?.name ?? null,
      board: [...h.board],
      pot: [...h.players.values()].reduce((sum, p) => sum + p.total, 0),
      players: [...h.players.values()].map((p) => ({
        name: p.name,
        start: p.startChips,
        net: p.won - p.total,
        hole: p.hole,
        shown: h.revealed && !p.folded, // 摊牌（或全员 all-in）时亮出来的牌
        folded: p.folded,
        handName: h.result?.hands?.[p.seat]?.name ?? null,
      })),
      log: [...h.log],
    });
    if (this.histories.length > this.cfg.historyKeep) this.histories.shift();
  }

  // 只给看亮过的牌和自己的牌；中途弃牌的人底牌永远不发出去
  historyFor(name) {
    return this.histories.slice().reverse().map((r) => ({
      ...r,
      players: r.players.map((p) => ({ ...p, hole: p.shown || p.name === name ? p.hole : null, me: p.name === name })),
    }));
  }

  disconnect(socketId) {
    const user = [...this.users.values()].find((u) => u.socketId === socketId);
    if (!user) return;
    user.socketId = null;
    this.addLog(`${user.name} 断开连接`);
    if (this.host === user.name && !this.timers.host) {
      this.timers.host = setTimeout(() => this.safe(() => {
        this.timers.host = null;
        if (this.users.get(this.host)?.socketId) return;
        const next = [...this.users.values()].filter((u) => u.socketId).sort((a, b) => a.joinedAt - b.joinedAt)[0];
        this.host = next?.name ?? null;
        if (next) this.addLog(`房主断线太久，房主移交给 ${next.name}`);
        this.broadcast();
      }), this.cfg.hostGraceMs);
    }
    this.broadcast();
  }

  seatOf(name) {
    return this.seats.findIndex((s) => s?.name === name);
  }

  mySeat(name) {
    const i = this.seatOf(name);
    if (i === -1) throw new UserError('你还没有坐下');
    return i;
  }

  // ---------- 座位 ----------

  sit(name, seat) {
    if (!Number.isInteger(seat) || seat < 0 || seat >= this.seats.length) throw new UserError('座位号不对');
    if (this.seats[seat]) throw new UserError('这个座位有人了');
    if (this.seatOf(name) !== -1) throw new UserError('你已经坐下了');
    const s = { name, chips: 0, away: false, leaveAfterHand: false };
    if (this.session) s.chips = this.ledgerEntry(name).stack;
    this.seats[seat] = s;
    this.addLog(`${name} 坐到 ${seat + 1} 号位${this.session ? `，筹码 ${s.chips}` : ''}`);
    this.store.save();
    this.maybeStartHand();
    this.broadcast();
  }

  stand(name) {
    const i = this.mySeat(name);
    if (this.game.isParticipant(i)) {
      this.seats[i].leaveAfterHand = true;
      this.addLog(`${name} 离座（这手牌结束后站起）`);
      this.game.foldOutOfTurn(i);
      this.afterGameChange();
      return;
    }
    this.removeSeat(i);
    this.maybeStartHand();
    this.broadcast();
  }

  removeSeat(i) {
    const s = this.seats[i];
    if (this.session) this.ledgerEntry(s.name).stack = s.chips;
    this.seats[i] = null;
    this.addLog(`${s.name} 站起离座${this.session ? `，带走筹码 ${s.chips}（本场再坐下会拿回）` : ''}`);
    this.store.save();
  }

  // 借筹码：任何时候都能申请，额度 1 ~ 单次上限（= 本场起始筹码）；传 0 表示取消还没到账的申请
  // 正在打的这手里不能加码（否则能看了底牌再借），所以手牌进行中申请的，等这手结束才到账
  borrow(name, amount) {
    if (!this.session) throw new UserError('还没开场');
    const i = this.mySeat(name);
    const s = this.seats[i];
    amount = Math.floor(Number(amount));
    const max = this.session.buyIn;
    if (!Number.isFinite(amount) || amount < 0 || amount > max) throw new UserError(`一次只能借 0 ~ ${max}`);

    if (amount === 0) {
      if (!s.pendingBorrow) throw new UserError('没有待到账的申请');
      s.pendingBorrow = 0;
      this.addLog(`${name} 取消了借筹码`);
    } else if (this.game.isParticipant(i)) {
      s.pendingBorrow = amount;
      this.addLog(`${name} 申请借 ${amount}（这手结束后到账）`);
    } else {
      this.applyBorrow(s, amount);
      this.store.save();
      this.maybeStartHand();
    }
    this.broadcast();
  }

  applyBorrow(s, amount) {
    const e = this.ledgerEntry(s.name);
    e.buyIn += amount;
    s.chips += amount;
    e.stack = s.chips;
    s.pendingBorrow = 0;
    this.addLog(`${s.name} 借了 ${amount}（本场累计借入 ${e.buyIn}）`);
  }

  // 旧接口：输光后借满一份
  rebuy(name) {
    if (!this.session) throw new UserError('还没开场');
    this.borrow(name, this.session.buyIn);
  }

  back(name) {
    const s = this.seats[this.mySeat(name)];
    s.away = false;
    this.addLog(`${name} 回来了`);
    this.maybeStartHand();
    this.broadcast();
  }

  act(name, type, amount) {
    const i = this.mySeat(name);
    this.game.act(i, type, amount);
    this.seats[i].away = false;
    this.afterGameChange();
  }

  // ---------- 房主 ----------

  requireHost(name) {
    if (name !== this.host) throw new UserError('只有房主可以这样做');
  }

  startSession(name, { buyIn, sb, bb }) {
    this.requireHost(name);
    if (this.session) throw new UserError('已经有一场在进行了');
    [buyIn, sb, bb] = [buyIn, sb, bb].map((x) => Math.floor(Number(x)));
    checkBlinds(sb, bb);
    if (!(buyIn >= bb * 2 && buyIn <= 10_000_000)) throw new UserError('买入至少要 2 个大盲');
    this.session = this.store.createSession({ buyIn, sb, bb });
    this.paused = false;
    this.ending = false;
    this.started = false; // 等人坐齐，由房主点"开局"才开始发牌
    for (const s of this.seats) {
      if (!s) continue;
      s.chips = this.ledgerEntry(s.name).stack;
      s.away = false;
    }
    this.addLog(`====== 第 ${this.session.id} 场：买入 ${buyIn}，盲注 ${sb}/${bb}，等大家坐好后房主点"开局" ======`);
    this.store.save();
    this.broadcast();
  }

  deal(name) {
    this.requireHost(name);
    if (!this.session) throw new UserError('还没开场');
    if (this.started) throw new UserError('已经开局了');
    const n = this.eligibleSeats().length;
    if (n < 2) throw new UserError('至少要 2 个人坐下（并且在线、有筹码）才能开局');
    this.started = true;
    this.paused = false;
    this.addLog(`房主开局，${n} 人参与`);
    this.maybeStartHand(800);
    this.broadcast();
  }

  togglePause(name) {
    this.requireHost(name);
    if (!this.session) throw new UserError('还没开场');
    if (!this.started) throw new UserError('还没开局');
    this.paused = !this.paused;
    this.addLog(this.paused ? '房主暂停了发牌（这手打完后不再开新的一手）' : '房主继续发牌');
    if (!this.paused) this.maybeStartHand();
    else this.clearTimer('next');
    this.broadcast();
  }

  setBlinds(name, { sb, bb }) {
    this.requireHost(name);
    if (!this.session) throw new UserError('还没开场');
    [sb, bb] = [sb, bb].map((x) => Math.floor(Number(x)));
    checkBlinds(sb, bb);
    this.session.sb = sb;
    this.session.bb = bb;
    this.store.save();
    this.addLog(`盲注改为 ${sb}/${bb}（下一手生效）`);
    this.broadcast();
  }

  endSession(name) {
    this.requireHost(name);
    if (!this.session) throw new UserError('还没开场');
    if (this.game.inHand) {
      this.ending = true;
      this.addLog('房主结束本场：这手牌打完后结算');
      this.broadcast();
      return;
    }
    this.finalizeSession();
  }

  finalizeSession() {
    this.clearTimer('next');
    const session = this.session;
    for (const s of this.seats) if (s) this.ledgerEntry(s.name).stack = s.chips;
    const results = Object.entries(session.ledger)
      .map(([name, e]) => ({ name, buyIn: e.buyIn, stack: e.stack, net: e.stack - e.buyIn, hands: e.hands, won: e.won }))
      .sort((a, b) => b.net - a.net);
    this.store.finishSession(session, results);
    for (const s of this.seats) if (s) s.chips = 0;
    this.session = null;
    this.ending = false;
    this.paused = false;
    this.started = false;
    this.addLog(`====== 第 ${session.id} 场结束 ======`);
    for (const r of results) this.addLog(`${r.name}：${r.net >= 0 ? '+' : ''}${r.net}`);
    for (const u of this.users.values()) {
      if (u.socketId) this.transport.send(u.socketId, 'sessionEnded', { id: session.id, results });
    }
    this.broadcast();
  }

  // ---------- 计分 ----------

  // 本场账本里取出（没有就新建并买入一份）
  ledgerEntry(name) {
    const ledger = this.session.ledger;
    if (!ledger[name]) {
      ledger[name] = { buyIn: this.session.buyIn, stack: this.session.buyIn, hands: 0, won: 0 };
      this.addLog(`${name} 买入 ${this.session.buyIn}`);
    }
    return ledger[name];
  }

  // ---------- 发牌节奏 ----------

  eligibleSeats() {
    return this.seats
      .map((s, i) => (s && s.chips > 0 && !s.away && !s.leaveAfterHand && this.users.get(s.name)?.socketId ? i : -1))
      .filter((i) => i >= 0);
  }

  canStartHand() {
    return this.session && this.started && !this.paused && !this.ending && !this.game.inHand && this.eligibleSeats().length >= 2;
  }

  maybeStartHand(delay = 800) {
    if (this.timers.next || !this.canStartHand()) return;
    this.timers.next = setTimeout(() => this.safe(() => {
      this.timers.next = null;
      if (!this.canStartHand()) return;
      this.game.startHand({ participants: this.eligibleSeats(), sb: this.session.sb, bb: this.session.bb });
      this.handSettled = false;
      this.addLog(`—— 第 ${this.game.handNo} 手 · 盲注 ${this.session.sb}/${this.session.bb} ——`);
      this.afterGameChange();
    }), delay);
  }

  // 每次牌局状态变化后调用：安排计时器、处理一手结束、推送画面
  afterGameChange() {
    const h = this.game.hand;
    this.flushGameLog();

    const key = h && h.phase === 'betting' ? `${h.no}|${h.street}|${h.toAct}|${h.actionCount}` : null;
    if (key !== this.timerKey) {
      this.timerKey = key;
      this.clearTimer('action');
      this.clearTimer('auto');
      this.deadline = null;
      if (key) this.scheduleTurn(h);
    }

    if (h?.phase === 'runout' && !this.timers.runout) {
      this.timers.runout = setTimeout(() => this.safe(() => {
        this.timers.runout = null;
        this.game.runoutStep();
        this.afterGameChange();
      }), this.cfg.runoutStreetDelayMs);
    }

    if (h?.phase === 'done' && !this.handSettled) this.onHandEnd();
    this.broadcast();
  }

  scheduleTurn(h) {
    const seat = h.toAct;
    const s = this.seats[seat];
    if (s.away || s.leaveAfterHand) {
      // 暂离的人轮到时直接替他操作，不让大家干等
      this.timers.auto = setTimeout(() => this.safe(() => {
        this.timers.auto = null;
        if (this.game.hand !== h || h.toAct !== seat) return;
        this.game.autoAct(seat);
        this.afterGameChange();
      }), 700);
      return;
    }
    this.deadline = Date.now() + this.cfg.actionTimeoutMs;
    this.timers.action = setTimeout(() => this.safe(() => {
      this.timers.action = null;
      if (this.game.hand !== h || h.toAct !== seat) return;
      const la = this.game.legalActions(seat);
      s.away = true;
      this.addLog(`${s.name} 超时，自动${la.canCheck ? '过牌' : '弃牌'}，标记为暂离`);
      this.game.autoAct(seat);
      this.afterGameChange();
    }), this.cfg.actionTimeoutMs);
  }

  onHandEnd() {
    this.handSettled = true;
    const h = this.game.hand;
    this.recordHand(h);
    if (this.session) {
      for (const p of h.players.values()) {
        const e = this.session.ledger[p.name];
        if (!e) continue;
        e.hands++;
        if (h.result.winners.includes(p.seat)) e.won++;
      }
      for (const s of this.seats) if (s) this.ledgerEntry(s.name).stack = s.chips;
      // 手牌进行中申请的借筹码，现在到账（要离座或本场要结算的就作废）
      for (const s of this.seats) {
        if (!s?.pendingBorrow) continue;
        if (s.leaveAfterHand || this.ending) s.pendingBorrow = 0;
        else this.applyBorrow(s, s.pendingBorrow);
      }
    }
    this.seats.forEach((s, i) => s?.leaveAfterHand && this.removeSeat(i));
    for (const s of this.seats) if (s && s.chips === 0) this.addLog(`${s.name} 输光了，可以点"借筹码"`);

    if (this.ending) return this.finalizeSession();
    this.store.save();
    this.maybeStartHand(h.result.type === 'showdown' ? this.cfg.showdownDelayMs : this.cfg.nextHandDelayMs);
  }

  // ---------- 工具 ----------

  clearTimer(name) {
    clearTimeout(this.timers[name]);
    this.timers[name] = null;
  }

  // 计时器回调里出错不能让整个服务器崩掉
  safe(fn) {
    try {
      fn();
    } catch (e) {
      console.error('[计时器出错]', e);
      this.broadcast();
    }
  }

  addLog(text) {
    this.log.push({ t: Date.now(), text });
    if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
  }

  flushGameLog() {
    const h = this.game.hand;
    if (!h) return;
    if (this.logCursor.hand !== h.no) this.logCursor = { hand: h.no, line: 0 };
    while (this.logCursor.line < h.log.length) this.addLog(h.log[this.logCursor.line++]);
  }

  broadcast() {
    for (const u of this.users.values()) {
      if (u.socketId) this.transport.send(u.socketId, 'state', this.viewFor(u.name));
    }
  }

  // 每个人看到的画面不同：只有自己的底牌、摊牌时亮出的牌才会发给你
  viewFor(name) {
    // 新开一场还没开局时，不再显示上一场最后那手牌
    const h = this.session && !this.started ? null : this.game.hand;
    const mySeat = this.seatOf(name);
    const result = h?.result;

    const seats = this.seats.map((s, i) => {
      if (!s) return null;
      const p = h?.players.get(i);
      let cards = null;
      if (p) {
        if (i === mySeat || (h.revealed && !p.folded)) cards = p.hole;
        else if (!p.folded) cards = ['??', '??'];
      }
      return {
        name: s.name,
        avatar: this.users.get(s.name)?.avatar ?? AVATAR_IDS[0],
        chips: s.chips,
        online: !!this.users.get(s.name)?.socketId,
        away: s.away,
        leaving: s.leaveAfterHand,
        inHand: !!p,
        folded: p?.folded ?? false,
        allIn: p?.allIn ?? false,
        bet: p?.streetBet ?? 0,
        lastAction: p?.lastAction ?? '',
        cards,
        won: result ? p?.won ?? 0 : 0,
        handName: result?.hands?.[i]?.name ?? null,
        best5: result?.hands?.[i]?.best5 ?? null,
      };
    });

    const ledger = this.session
      ? Object.entries(this.session.ledger)
        .map(([n, e]) => ({ name: n, buyIn: e.buyIn, stack: e.stack, net: e.stack - e.buyIn, hands: e.hands, won: e.won, seated: this.seatOf(n) !== -1 }))
        .sort((a, b) => b.net - a.net)
      : [];

    const mine = mySeat !== -1 ? this.seats[mySeat] : null;
    return {
      me: {
        name,
        avatar: this.users.get(name)?.avatar ?? AVATAR_IDS[0],
        seat: mySeat,
        isHost: this.host === name,
        canRebuy: !!(this.session && mine && mine.chips === 0 && !this.game.isParticipant(mySeat) && !mine.pendingBorrow),
        canBorrow: !!(this.session && mine),
        pendingBorrow: mine?.pendingBorrow ?? 0,
        borrowed: this.session && mine ? this.session.ledger[name]?.buyIn ?? 0 : 0,
        away: mine?.away ?? false,
      },
      host: this.host,
      maxSeats: this.seats.length,
      actionTimeoutMs: this.cfg.actionTimeoutMs,
      session: this.session && {
        id: this.session.id,
        buyIn: this.session.buyIn,
        sb: this.session.sb,
        bb: this.session.bb,
        startedAt: this.session.startedAt,
        started: this.started,
        paused: this.paused,
        ending: this.ending,
      },
      defaults: { buyIn: this.cfg.defaultBuyIn, sb: this.cfg.defaultSmallBlind, bb: this.cfg.defaultBigBlind },
      seats,
      hand: h && {
        no: h.no,
        street: h.street,
        streetName: STREET_NAMES[h.street],
        phase: h.phase,
        board: h.board,
        pots: this.game.displayPots().map((p) => p.amount),
        totalPot: [...h.players.values()].reduce((sum, p) => sum + p.total, 0),
        currentBet: h.currentBet,
        button: h.buttonSeat,
        sbSeat: h.sbSeat,
        bbSeat: h.bbSeat,
        toAct: h.toAct,
        remainingMs: this.deadline ? Math.max(0, this.deadline - Date.now()) : null,
        result: result && {
          type: result.type,
          winners: result.winners,
          pots: result.pots.map((p) => ({
            amount: p.amount,
            winners: p.winners.map((s) => h.players.get(s).name),
            handName: p.handName,
            returned: !!p.returned,
          })),
        },
      },
      actions: mySeat !== -1 ? this.game.legalActions(mySeat) : null,
      ledger,
      spectators: [...this.users.values()].filter((u) => u.socketId && this.seatOf(u.name) === -1).map((u) => u.name),
      log: this.log.slice(-60),
    };
  }
}

function cleanName(name, max) {
  const s = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f<>"'&]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return [...s].slice(0, max).join('');
}

function cleanText(text, max) {
  const s = String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...s].slice(0, max).join('');
}

function checkBlinds(sb, bb) {
  if (!(sb >= 1 && bb >= sb && bb <= 1_000_000)) throw new UserError('盲注不对：小盲至少 1，大盲不能小于小盲');
}
