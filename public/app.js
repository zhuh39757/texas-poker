'use strict';

// ---------- 小工具 ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => Number(n).toLocaleString('en-US');
const signed = (n) => `<span class="${n > 0 ? 'pos' : n < 0 ? 'neg' : ''}">${n > 0 ? '+' : ''}${fmt(n)}</span>`;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };

// 浏览器存储可能被禁用（隐私模式等），读写都要兜底
const storage = {
  get(key, area = localStorage) { try { return area.getItem(key); } catch { return null; } },
  set(key, val, area = localStorage) { try { val == null ? area.removeItem(key) : area.setItem(key, val); } catch { /* 忽略 */ } },
};

// ---------- 状态 ----------
let state = null;
let token = storage.get('poker.token', sessionStorage); // 每个标签页一个身份，刷新不丢
let joined = false;
let lastResultNo = 0; // 已经为哪一手播过胜负音效
let raiseOpen = false;
let raiseValue = 0;
let barSig = '';
let hostSig = '';
let localDeadline = null;
let wasMyTurn = false;
let modalKind = null;
let scoreTab = 'session';
let logTab = 'history';
let historyFetchedFor = -1;
let prevHand = { no: 0, board: 0 };
let chats = [];
let unread = 0;

// 服务器设置了进门口令时才显示口令框
fetch('/api/info').then((r) => r.json()).then((info) => {
  $('#login-pass').classList.toggle('hidden', !info.needPassword);
  $('#login-pass').required = info.needPassword;
}).catch(() => {});

const socket = io({ reconnectionDelay: 800, reconnectionDelayMax: 4000 });

socket.on('connect', () => {
  $('#conn').classList.add('hidden');
  const name = storage.get('poker.name');
  // 有凭证就自动接回；服务器重启过凭证会失效，这时用保存的昵称和口令再进
  if (token) join({ token, name, password: storage.get('poker.pass'), avatar: storage.get('poker.avatar') || undefined });
  else showLogin();
});
socket.on('chat', (msg) => {
  chats.push(msg);
  if (chats.length > 100) chats.shift();
  if (chatOpen()) renderChatList();
  else {
    if (msg.name !== state?.me.name) unread++;
    renderUnread();
    feedMessage(msg);
  }
  showBubble(msg);
});
socket.on('disconnect', () => { if (joined) $('#conn').classList.remove('hidden'); });
socket.on('state', (s) => { state = s; render(); });
socket.on('toast', (m) => toast(m));
socket.on('kicked', (m) => {
  joined = false;
  token = null;
  storage.set('poker.token', null, sessionStorage);
  showLogin(m);
});
socket.on('sessionEnded', (d) => openModal('results', d));

function join(payload) {
  socket.emit('join', payload, (res) => {
    if (!res.ok) {
      token = null;
      storage.set('poker.token', null, sessionStorage);
      showLogin(res.error);
      return;
    }
    token = res.token;
    storage.set('poker.token', token, sessionStorage);
    storage.set('poker.name', res.name);
    if (payload.password) storage.set('poker.pass', payload.password);
    chats = res.chats || [];
    joined = true;
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    render();
  });
}

function showLogin(message) {
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  const input = $('#login-name');
  if (!input.value) input.value = storage.get('poker.name') || '';
  if (!$('#login-pass').value) $('#login-pass').value = storage.get('poker.pass') || '';
  if (message) toast(message);
  input.focus();
}

$('#login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  join({ name: $('#login-name').value, password: $('#login-pass').value || undefined, avatar: chosenAvatar });
});

// ---------- 登录页：选角色 + 飘动的背景装饰 ----------
let chosenAvatar = storage.get('poker.avatar') || 'fox';

function pickAvatar(id) {
  chosenAvatar = id;
  storage.set('poker.avatar', id);
  for (const b of document.querySelectorAll('[data-pick]')) b.classList.toggle('on', b.dataset.pick === id);
}

(function fillDeco() {
  const box = $('#login .bg-deco');
  const items = ['♠', '♥', '♣', '♦', 'chip', 'chip', '♠', '♥'];
  const chipColors = ['#e9b23a', '#cf342c', '#1f8a52', '#7e4fd0', '#262626'];
  let html = '';
  for (let k = 0; k < 22; k++) {
    const it = items[k % items.length];
    const left = Math.random() * 100;
    const size = 18 + Math.random() * 34;
    const dur = 14 + Math.random() * 16;
    const delay = -Math.random() * dur;
    const style = `left:${left}%;--s:${size}px;animation-duration:${dur}s;animation-delay:${delay}s`;
    html += it === 'chip'
      ? `<i class="deco chip" style="${style};--c1:${chipColors[k % chipColors.length]}"></i>`
      : `<i class="deco suit ${it === '♥' || it === '♦' ? 'red' : ''}" style="${style}">${it}</i>`;
  }
  box.innerHTML = html;
})();

function send(event, payload = {}) {
  socket.emit(event, payload, (res) => { if (res && !res.ok) toast(res.error); });
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.textContent = message;
  if (kind) el.className = kind;
  $('#toast').append(el);
  setTimeout(() => el.remove(), 3200);
}

// ---------- 渲染 ----------
function render() {
  if (!state || !joined) return;
  const h = state.hand;
  localDeadline = h?.remainingMs != null ? Date.now() + h.remainingMs : null;
  renderStatus();
  renderHeader();
  renderSeats();
  renderCenter();
  renderBar();
  if (modalKind === 'score' && scoreTab === 'session') renderScore();
  if (modalKind === 'log') renderLog();
  if (modalKind === 'host') renderHost();
  if (modalKind === 'borrow') renderBorrow();
  renderUnread();
  turnAlert();
  playSounds();
  if (h) prevHand = { no: h.no, board: h.board.length };
}

// 背景音乐：本场开局后、没暂停时播放；胜负音效：自己参与的这一手结束时
function playSounds() {
  const s = state.session;
  Sound.setPlaying(!!(s && s.started && !s.paused));
  const h = state.hand;
  if (!h?.result || h.no === lastResultNo) return;
  lastResultNo = h.no;
  const mine = state.me.seat >= 0 ? state.seats[state.me.seat] : null;
  if (!mine?.inHand) return;
  if (h.result.winners.includes(state.me.seat)) Sound.win();
  else if (h.result.type === 'showdown' && !mine.folded) Sound.lose(); // 亮牌比输了才放，自己弃牌不放
}

function renderStatus() {
  const { session: s, hand: h } = state;
  let html;
  if (!s) html = '<span class="warn">还没开场</span>';
  else {
    html = `<b>第 ${s.id} 场</b> · 盲注 <b>${s.sb}/${s.bb}</b>`;
    if (!s.started) html += ' · <span class="warn">未开局</span>';
    if (h) html += ` · 第 ${h.no} 手 · ${h.streetName}`;
    if (s.paused) html += ' · <span class="warn">已暂停</span>';
    if (s.ending) html += ' · <span class="warn">本手后结算</span>';
  }
  html += ` · 👑 ${esc(state.host ?? '无')}`;
  $('#status').innerHTML = html;
}

function renderHeader() {
  $('#btn-host').classList.toggle('hidden', !state.me.isHost);
  $('#btn-stand').classList.toggle('hidden', state.me.seat === -1);
  $('#btn-borrow').classList.toggle('hidden', !state.me.canBorrow);
  $('#btn-borrow').classList.toggle('pending', state.me.pendingBorrow > 0);
  $('#btn-sound').textContent = Sound.prefs.music || Sound.prefs.sfx ? '🔊' : '🔇';
}

function cssPx(name) {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0;
}

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
// 让循环动画在每次重新渲染后接着原来的进度播放，而不是从头开始（避免抖一下）
const phase = (periodMs, offsetMs = 0) => `-${((Date.now() + offsetMs) % periodMs) / 1000}s`;
// 一次性动画：从 startTs 开始算，重新渲染时用负延迟接上进度
const since = (startTs, delayMs = 0) => `${delayMs - (Date.now() - startTs)}ms`;

// ---------- 角色 ----------
const AVATARS = {
  fox: ['🦊', '狐狸', '#ff8a3d'],
  panda: ['🐼', '熊猫', '#8fa3b8'],
  tiger: ['🐯', '老虎', '#ffb300'],
  frog: ['🐸', '青蛙', '#43a047'],
  cat: ['🐱', '猫咪', '#f06292'],
  dog: ['🐶', '狗狗', '#a1887f'],
  monkey: ['🐵', '猴子', '#c58b5b'],
  lion: ['🦁', '狮子', '#f9a825'],
  pig: ['🐷', '小猪', '#ff8fab'],
  rabbit: ['🐰', '兔子', '#9575cd'],
  dragon: ['🐲', '小龙', '#26a69a'],
  unicorn: ['🦄', '独角兽', '#ba68c8'],
};

// delay 不传时用循环相位（轻轻浮动）；赢了要从出结果那一刻开始跳，就传 since(...)
function avatarHTML(id, offset = 0, delay = null) {
  const [emoji, , color] = AVATARS[id] || AVATARS.fox;
  return `<div class="av" style="--av:${color};animation-delay:${delay ?? phase(3600, offset)}"><span>${emoji}</span></div>`;
}

function avatarGridHTML(current) {
  return Object.entries(AVATARS).map(([id, [emoji, label, color]]) =>
    `<button type="button" class="pick ${id === current ? 'on' : ''}" data-pick="${id}" style="--av:${color}" title="${label}">
      <span class="av"><span>${emoji}</span></span><small>${label}</small></button>`).join('');
}

// ---------- 筹码 ----------
// 面额从大到小：金 1000、紫 500、黑 100、绿 25、红 5、白 1
const CHIP_DENOMS = [[1000, '#e9b23a', '#fff1c2'], [500, '#7e4fd0', '#eadcff'], [100, '#262626', '#dcdcdc'], [25, '#1f8a52', '#d6f5e4'], [5, '#cf342c', '#ffe0dc'], [1, '#ececec', '#6f6f6f']];

function chipDiscs(amount, max) {
  const discs = [];
  let rest = Math.max(0, Math.floor(amount));
  for (const [v, c1, c2] of CHIP_DENOMS) {
    let n = Math.floor(rest / v);
    rest -= n * v;
    while (n-- > 0 && discs.length < max) discs.push([c1, c2]);
    if (discs.length >= max) break;
  }
  return discs;
}

const discHTML = ([c1, c2], i) => `<i style="--c1:${c1};--c2:${c2};--i:${i}"></i>`;

// 一摞筹码（下注用）
function chipStack(amount, max = 5) {
  return `<span class="stack">${chipDiscs(amount, max).map(discHTML).join('')}</span>`;
}

// 几摞筹码（底池用）
function chipPile(amount) {
  const cols = [[], [], []];
  chipDiscs(amount, 15).forEach((d, i) => cols[i % 3].push(d));
  return cols.filter((c) => c.length).map((c) => `<span class="stack">${c.map(discHTML).join('')}</span>`).join('');
}

// ---------- 扑克牌 ----------
function cardHTML(c, cls = '', style = '') {
  if (!c) return `<div class="card slot ${cls}"></div>`;
  if (c === '??') return `<div class="card back ${cls}" style="${style}"></div>`;
  const red = c[1] === 'h' || c[1] === 'd';
  const r = c[0] === 'T' ? '10' : c[0];
  return `<div class="card ${red ? 'red' : ''} ${cls}" style="${style}"><span class="ci"><b>${r}</b><i>${SUIT[c[1]]}</i></span><span class="cs">${SUIT[c[1]]}</span></div>`;
}

// 摊牌时把赢家组成最大牌型的 5 张高亮
function highlightSet() {
  const h = state.hand;
  if (h?.result?.type !== 'showdown') return null;
  const set = new Set();
  for (const s of h.result.winners) for (const c of state.seats[s]?.best5 || []) set.add(c);
  return set;
}

// ---------- 动画用的时间点 ----------
const anim = {
  dealHand: 0, // 哪一手开始发牌
  dealAt: 0,
  boardAt: [], // 每张公共牌第一次出现的时间
  boardHand: 0,
  resultHand: 0, // 哪一手出了结果
  resultAt: 0,
  prevBets: new Map(), // 上一次渲染时每个座位面前的下注 { x, y, amount }
  betsHand: 0,
  potFlownFor: 0,
};

function renderSeats() {
  const box = $('#table');
  const W = box.clientWidth;
  const H = box.clientHeight;
  const sw = cssPx('--seat-w');
  const sh = cssPx('--seat-h');
  const n = state.maxSeats;
  const h = state.hand;
  const me = state.me;
  const rotate = me.seat >= 0 ? me.seat : 0; // 自己永远在正下方
  const hl = highlightSet();
  if (h && h.no !== anim.dealHand) {
    anim.dealHand = h.no;
    anim.dealAt = Date.now();
  }
  if (h?.result && anim.resultHand !== h.no) {
    anim.resultHand = h.no;
    anim.resultAt = Date.now();
  }
  let html = '';

  for (let i = 0; i < n; i++) {
    const k = (i - rotate + n) % n;
    const theta = Math.PI / 2 + (k * 2 * Math.PI) / n; // 从正下方开始顺时针
    const rx = W / 2 - sw / 2 - 2;
    const ry = H / 2 - sh / 2 - 6;
    const x = W / 2 + rx * Math.cos(theta);
    const y = H / 2 + ry * Math.sin(theta);
    const s = state.seats[i];
    const pos = `left:${x}px;top:${y}px`;

    if (!s) {
      const canSit = me.seat === -1;
      html += `<div class="seat empty ${canSit ? 'cansit' : ''}" style="${pos}" ${canSit ? `data-seat="${i}"` : ''}>
        <div class="av-wrap"><div class="av ghost"><span>${canSit ? '+' : ''}</span></div></div>
        <div class="plate"><div class="name">${canSit ? '坐下' : '空位'}</div><div class="chips">${i + 1} 号位</div></div></div>`;
      continue;
    }

    const isMe = i === me.seat;
    const live = h && h.phase !== 'done';
    const turn = live && h.phase === 'betting' && h.toAct === i;
    const winner = h?.result?.winners.includes(i);
    const cls = ['seat'];
    if (isMe) cls.push('me');
    if (s.folded) cls.push('folded');
    if (winner) cls.push('winner');
    if (!s.online || s.away || (live && !s.inHand)) cls.push('out');
    const avCls = [];
    if (turn) avCls.push('turn');
    if (winner) avCls.push('won');
    if (s.allIn && !s.folded && h) avCls.push('allin');

    let tag = '';
    let tagCls = '';
    if (h?.result && s.handName && !s.folded) [tag, tagCls] = [s.handName, 'hand'];
    else if (s.allIn) [tag, tagCls] = ['ALL IN', 'allin'];
    else if (s.folded) [tag, tagCls] = ['弃牌', 'fold'];
    else if (!s.online) tag = '离线';
    else if (s.away) tag = '暂离';
    else if (s.leaving) tag = '离座中';
    else if (s.lastAction) [tag, tagCls] = [s.lastAction, actionClass(s.lastAction)];
    else if (live && !s.inHand) tag = '等下一手';
    else if (state.session && s.chips === 0) tag = '输光了';

    let cards = '';
    if (s.cards) cards = s.cards.map((c) => cardHTML(c, hl && winner && hl.has(c) ? 'hl' : '')).join('');

    let badge = '';
    if (h && h.button === i) badge = '<div class="badge D">D</div>';
    else if (h && live && h.sbSeat === i) badge = '<div class="badge SB">SB</div>';
    else if (h && live && h.bbSeat === i) badge = '<div class="badge BB">BB</div>';

    const winLabel = winner && s.won > 0
      ? `<div class="win" style="animation-delay:${since(anim.resultAt, 500)}">+${fmt(s.won)}</div>` : '';

    html += `<div class="${cls.join(' ')}" style="${pos}" data-i="${i}" data-bet="${s.bet}">
      ${winLabel}
      <div class="av-wrap ${avCls.join(' ')}" ${isMe ? 'data-act="avatar-open" title="点我换角色"' : ''}>
        ${turn ? '<div class="ring"></div>' : ''}
        ${avatarHTML(s.avatar, i * 431, winner ? since(anim.resultAt, 300) : null)}
        ${s.name === state.host ? '<span class="host-crown">👑</span>' : ''}
        ${badge}
        ${!s.online ? '<span class="status-ico">📴</span>' : s.away ? '<span class="status-ico">💤</span>' : ''}
        <div class="hole">${cards}</div>
      </div>
      <div class="plate">
        <div class="name">${esc(s.name)}</div>
        <div class="chips"><i class="chip-ico"></i>${state.session ? fmt(s.chips) : '—'}</div>
      </div>
      ${tag ? `<div class="tag ${tagCls}">${esc(tag)}</div>` : ''}
    </div>`;
  }
  $('#seats').innerHTML = html;

  let bets = '';
  const curBets = new Map();
  let dealIdx = 0;
  const inHandCount = state.seats.filter((s) => s?.inHand).length || 1;
  for (const el of $('#seats').querySelectorAll('.seat')) {
    // 座位实际大小随状态变化，渲染后量一下，超出牌桌区域就往里收
    const w = el.offsetWidth;
    const hh = el.offsetHeight;
    const x = clamp(parseFloat(el.style.left), w / 2 + 2, W - w / 2 - 2);
    const y = clamp(parseFloat(el.style.top), hh / 2 + 2, H - hh / 2 - 2);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    if (!el.dataset.i) continue;

    // 发牌动画：底牌从牌桌中央飞到座位上，一人一张轮两圈
    const holeCards = el.querySelectorAll('.hole .card');
    if (!reduceMotion && holeCards.length && Date.now() - anim.dealAt < 2500) {
      holeCards.forEach((card, j) => {
        card.style.setProperty('--fx', `${W / 2 - x}px`);
        card.style.setProperty('--fy', `${H / 2 - y}px`);
        card.style.animationDelay = since(anim.dealAt, (dealIdx + j * inHandCount) * 70);
        card.classList.add('dealt');
      });
      dealIdx++;
    }

    // 下注筹码：从座位边缘朝牌桌中心再挪一段
    const bet = Number(el.dataset.bet);
    if (bet > 0) {
      const dx = W / 2 - x;
      const dy = H / 2 - y;
      const len = Math.hypot(dx, dy) || 1;
      const reach = Math.abs(dx / len) * (w / 2) + Math.abs(dy / len) * (hh / 2) + 26;
      const bx = x + (dx / len) * reach;
      const by = y + (dy / len) * reach;
      curBets.set(Number(el.dataset.i), { x: bx, y: by, amount: bet });
      bets += `<div class="bet" style="left:${bx}px;top:${by}px">${chipStack(bet)}<span class="amt">${fmt(bet)}</span></div>`;
    }
  }
  $('#seats').insertAdjacentHTML('beforeend', bets);

  // 本条街下注收进底池：上一次还摆在面前、这次没了的筹码，飞向底池
  if (h && anim.betsHand === h.no) {
    for (const [seat, b] of anim.prevBets) {
      if (!curBets.has(seat)) queueFly({ x: b.x, y: b.y }, 'pot', b.amount, 4, 0);
    }
  }
  anim.prevBets = curBets;
  anim.betsHand = h?.no ?? 0;
  tickTimer();
}

function actionClass(text) {
  if (/加注|下注/.test(text)) return 'raise';
  if (/跟注/.test(text)) return 'call';
  if (/过牌/.test(text)) return 'check';
  return '';
}

function renderCenter() {
  const { hand: h, session, me } = state;
  const hl = highlightSet();

  if (!h) {
    $('#pot').innerHTML = '';
    $('#board').innerHTML = '<div class="card slot"></div>'.repeat(5);
    let msg;
    const n = readyCount();
    if (!session) msg = me.isHost ? '<button class="primary big" data-act="host-open">开始新场</button>' : `等待房主 ${esc(state.host ?? '')} 开始新场`;
    else if (!session.started) {
      msg = me.isHost
        ? `<button class="primary big" data-act="deal" ${n < 2 ? 'disabled' : ''}>开局（${n} 人就座）</button>
           <div class="hint-line">${n < 2 ? '至少 2 人坐下才能开局' : '人齐了就点开局，之后每手自动发牌'}</div>`
        : `等待房主 ${esc(state.host ?? '')} 开局 · 已就座 ${n} 人`;
    } else msg = '等待玩家坐下（至少 2 人）';
    $('#result').innerHTML = `<div class="waiting">${msg}</div>`;
    flushFlies();
    return;
  }

  // 底池：结算后筹码已经飞给赢家，不再显示那堆
  let pot = '';
  if (h.totalPot > 0 && !h.result) {
    pot = `<div class="pot-pile">${chipPile(h.totalPot)}</div><div class="pot-amt">底池 <b>${fmt(h.totalPot)}</b></div>`;
    if (h.pots.length > 1) pot += `<div class="side-pots">主池 ${fmt(h.pots[0])}${h.pots.slice(1).map((p, i) => ` · 边池${i + 1} ${fmt(p)}`).join('')}</div>`;
  }
  $('#pot').innerHTML = pot;

  // 公共牌：新出现的翻面登场
  if (anim.boardHand !== h.no) {
    anim.boardHand = h.no;
    anim.boardAt = [];
  }
  let board = '';
  for (let i = 0; i < 5; i++) {
    const c = h.board[i];
    if (c && !anim.boardAt[i]) anim.boardAt[i] = Date.now() + (i < 3 ? i * 120 : 0);
    const cls = [];
    let style = '';
    if (c && !reduceMotion && Date.now() - anim.boardAt[i] < 900) {
      cls.push('flip');
      style = `animation-delay:${since(anim.boardAt[i])}`;
    }
    if (c && hl) cls.push(hl.has(c) ? 'hl' : 'dim');
    board += cardHTML(c, cls.join(' '), style);
  }
  $('#board').innerHTML = board;

  let result = '';
  if (h.result) {
    let lines;
    if (h.result.type === 'uncontested') {
      const p = h.result.pots[0];
      lines = `<div class="line"><b>${esc(p.winners[0])}</b> 赢得 ${fmt(p.amount)}</div>`;
    } else {
      let side = 0;
      lines = h.result.pots.map((p) => {
        if (p.returned) return `<div class="line small">退还 ${esc(p.winners[0])} ${fmt(p.amount)}</div>`;
        const label = side++ === 0 ? (h.result.pots.filter((x) => !x.returned).length > 1 ? '主池' : '底池') : `边池${side - 1}`;
        return `<div class="line">${label} ${fmt(p.amount)} → <b>${p.winners.map(esc).join('、')}</b> <span class="hand-name">${esc(p.handName)}${p.winners.length > 1 ? ' · 平分' : ''}</span></div>`;
      }).join('');
    }
    if (session?.ending) lines += '<div class="line small">本场即将结算…</div>';
    result = `<div class="win-banner" style="animation-delay:${since(anim.resultAt, 350)}">${lines}</div>`;

    // 底池飞向赢家，再撒一把彩带
    if (anim.potFlownFor !== h.no) {
      anim.potFlownFor = h.no;
      for (const seat of h.result.winners) {
        const won = state.seats[seat]?.won || h.totalPot;
        queueFly('pot', { seat }, won, 7, 450);
        if (!reduceMotion) setTimeout(() => confettiAtSeat(seat), 1050);
      }
    }
  } else if (session?.paused && h.phase === 'done') {
    result = '<div class="line">房主暂停了发牌</div>';
  }
  $('#result').innerHTML = result;
  flushFlies();
}

// ---------- 飞筹码、彩带（画在 #fx 层，不受重新渲染影响）----------
let flyQueue = [];

function queueFly(from, to, amount, count, delay) {
  if (!reduceMotion) flyQueue.push({ from, to, amount, count, delay });
}

function resolvePoint(p) {
  const t = $('#table').getBoundingClientRect();
  if (p === 'pot') {
    const pot = $('#pot').getBoundingClientRect();
    if (pot.width) return { x: pot.left - t.left + pot.width / 2, y: pot.top - t.top + 18 };
    return { x: t.width / 2, y: t.height / 2 };
  }
  if (p.seat != null) {
    const el = $(`#seats .seat[data-i="${p.seat}"]`);
    if (!el) return null;
    return { x: parseFloat(el.style.left), y: parseFloat(el.style.top) };
  }
  return p;
}

// 等 renderCenter 把底池画好后再起飞，这样能算准底池的位置
function flushFlies() {
  const list = flyQueue;
  flyQueue = [];
  for (const f of list) {
    const from = resolvePoint(f.from);
    const to = resolvePoint(f.to);
    if (!from || !to) continue;
    chipDiscs(f.amount, f.count).forEach(([c1, c2], k) => {
      const el = document.createElement('i');
      el.className = 'fly-chip';
      el.style.cssText = `left:${from.x}px;top:${from.y}px;--c1:${c1};--c2:${c2}`;
      $('#fx').append(el);
      const dx = to.x - from.x + (Math.random() * 14 - 7);
      const dy = to.y - from.y + (Math.random() * 14 - 7);
      el.animate([
        { transform: 'translate(-50%, -50%) scale(1)', opacity: 1 },
        { transform: `translate(calc(-50% + ${dx * 0.5}px), calc(-50% + ${dy * 0.5 - 24}px)) scale(1.15)`, opacity: 1, offset: 0.5 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(.9)`, opacity: 0.2 },
      ], { duration: 620, delay: f.delay + k * 55, easing: 'cubic-bezier(.3,.6,.4,1)', fill: 'both' }).onfinish = () => el.remove();
    });
  }
}

function confettiAtSeat(seat) {
  const p = resolvePoint({ seat });
  if (!p) return;
  const colors = ['#f5c451', '#ff6b6b', '#4cc38a', '#5aa9ff', '#c084fc', '#ffffff'];
  for (let k = 0; k < 24; k++) {
    const el = document.createElement('i');
    el.className = 'confetti';
    el.style.cssText = `left:${p.x}px;top:${p.y}px;background:${colors[k % colors.length]}`;
    $('#fx').append(el);
    const ang = Math.random() * Math.PI * 2;
    const dist = 40 + Math.random() * 70;
    el.animate([
      { transform: 'translate(-50%, -50%) rotate(0deg)', opacity: 1 },
      { transform: `translate(calc(-50% + ${Math.cos(ang) * dist}px), calc(-50% + ${Math.sin(ang) * dist + 40}px)) rotate(${Math.random() * 720}deg)`, opacity: 0 },
    ], { duration: 1100 + Math.random() * 500, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'forwards' }).onfinish = () => el.remove();
  }
}

// 能参与发牌的人数：坐着、在线、有筹码、没暂离
function readyCount() {
  return state.seats.filter((s) => s && s.chips > 0 && s.online && !s.away && !s.leaving).length;
}

function renderBar() {
  const { me, session, hand: h, actions: a } = state;
  const mine = me.seat >= 0 ? state.seats[me.seat] : null;
  const eligible = readyCount();
  const sig = JSON.stringify([me, session, h?.no, h?.phase, h?.toAct, a, mine?.chips, mine?.inHand, mine?.folded, eligible, state.host]);
  if (sig === barSig) return;
  const wasTurnBar = barSig && JSON.parse(barSig)[5];
  barSig = sig;
  const bar = $('#actionbar');

  if (a) {
    if (!wasTurnBar || JSON.stringify(wasTurnBar) !== JSON.stringify(a)) {
      raiseOpen = false;
      raiseValue = a.minRaiseTo;
    }
    const callLabel = a.canCheck ? '过牌' : a.callAmount >= mine.chips ? `All-in ${fmt(a.callAmount)}` : `跟注 ${fmt(a.callAmount)}`;
    bar.innerHTML = `
      <div class="turn-track"><i id="turn-progress"></i></div>
      <div class="turn-info">轮到你了 · 剩 <span id="countdown"></span> 秒</div>
      <div class="raise-panel ${raiseOpen ? '' : 'hidden'}" id="raise-panel">
        <div class="quick">
          <button data-q="min">最小</button><button data-q="0.5">½池</button><button data-q="0.75">¾池</button><button data-q="1">1池</button><button data-q="max">All-in</button>
        </div>
        <div class="raise-row">
          <input type="range" id="raise-range" min="${a.minRaiseTo}" max="${a.maxRaiseTo}" step="${Math.max(1, session?.sb || 1)}" value="${raiseValue}" ${a.minRaiseTo === a.maxRaiseTo ? 'disabled' : ''}>
          <input type="number" id="raise-num" min="${a.minRaiseTo}" max="${a.maxRaiseTo}" value="${raiseValue}" inputmode="numeric">
          <button class="primary" data-act="raise" id="raise-go"></button>
        </div>
      </div>
      <div class="actions">
        <button class="btn-fold" data-act="fold">弃牌</button>
        <button class="btn-call" data-act="${a.canCheck ? 'check' : 'call'}">${callLabel}</button>
        <button class="btn-raise ${raiseOpen ? 'on' : ''}" data-act="raise-toggle" ${a.canRaise ? '' : 'disabled'}>${a.isBet ? '下注' : '加注'}</button>
      </div>`;
    updateRaiseLabel();
    tickTimer();
    return;
  }

  let msg;
  if (!session) msg = me.isHost ? '你是房主 <button class="primary" data-act="host-open">开始新场</button>' : `等待房主 ${esc(state.host ?? '')} 开始新场`;
  else if (me.seat === -1) msg = session.started ? '观战中 · 点一个空位坐下' : '点一个空位坐下，等房主开局';
  else if (!session.started) {
    msg = me.isHost
      ? `人齐了就开局 <button class="primary" data-act="deal" ${eligible < 2 ? 'disabled' : ''}>开局（${eligible} 人）</button>`
      : `已坐下，等待房主 ${esc(state.host ?? '')} 开局`;
  } else if (me.canRebuy) msg = `筹码输光了 <button class="primary" data-act="borrow-open">💰 借筹码</button>`;
  else if (me.pendingBorrow && mine.inHand && h && h.phase !== 'done') msg = `已申请借 ${fmt(me.pendingBorrow)}，这手结束后到账`;
  else if (me.away) msg = '你处于暂离状态，不会发牌给你 <button class="primary" data-act="back">我回来了</button>';
  else if (h && h.phase !== 'done' && mine.inHand && !mine.folded) {
    msg = h.toAct != null ? `等待 ${esc(state.seats[h.toAct]?.name)} 行动…` : '发牌中…';
  } else if (h && h.phase !== 'done' && mine.inHand) msg = '已弃牌，等这手结束';
  else if (h && h.phase !== 'done') msg = '下一手开始加入';
  else if (session.paused) msg = '房主暂停了发牌';
  else if (eligible < 2) msg = '等待更多玩家坐下（至少 2 人）';
  else msg = '下一手马上开始…';
  bar.innerHTML = `<div class="bar-msg">${msg}</div>`;
}

function potRaiseTo(frac) {
  const a = state.actions;
  const h = state.hand;
  const potAfterCall = h.totalPot + a.toCall;
  return Math.round(h.currentBet + potAfterCall * frac);
}

function setRaise(v) {
  const a = state.actions;
  if (!a) return;
  raiseValue = clamp(Math.floor(Number(v) || 0), a.minRaiseTo, a.maxRaiseTo);
  const range = $('#raise-range');
  const num = $('#raise-num');
  if (range) range.value = raiseValue;
  if (num && document.activeElement !== num) num.value = raiseValue;
  updateRaiseLabel();
}

function updateRaiseLabel() {
  const a = state.actions;
  const go = $('#raise-go');
  if (!a || !go) return;
  go.textContent = raiseValue >= a.maxRaiseTo ? `All-in ${fmt(a.maxRaiseTo)}` : `${a.isBet ? '下注' : '加注到'} ${fmt(raiseValue)}`;
}

function tickTimer() {
  const h = state?.hand;
  const rem = localDeadline ? Math.max(0, localDeadline - Date.now()) : 0;
  const cd = $('#countdown');
  if (cd) cd.textContent = Math.ceil(rem / 1000);
  if (!h) return;
  // 轮到谁，谁的头像外圈就是倒计时圈；自己的回合时操作栏顶上还有一条进度条
  const frac = state.actionTimeoutMs ? rem / state.actionTimeoutMs : 0;
  const ring = $('.av-wrap.turn .ring');
  if (ring) {
    ring.style.setProperty('--p', frac.toFixed(3));
    ring.classList.toggle('low', rem < 8000);
  }
  const prog = $('#turn-progress');
  if (prog) {
    prog.style.width = `${frac * 100}%`;
    prog.classList.toggle('low', rem < 8000);
  }
}
setInterval(tickTimer, 200);

function turnAlert() {
  const myTurn = !!state.actions;
  document.title = myTurn ? '🔔 轮到你了 · 德州扑克' : '德州扑克';
  if (myTurn && !wasMyTurn) {
    navigator.vibrate?.(120);
    Sound.turn();
  }
  wasMyTurn = myTurn;
}

// ---------- 弹窗 ----------
function openModal(kind, data) {
  modalKind = kind;
  hostSig = '';
  historyFetchedFor = -1;
  $('#modal').classList.remove('hidden');
  $('#modal-body').innerHTML = '';
  if (kind === 'score') {
    $('#modal-title').textContent = '计分板';
    renderScore();
  } else if (kind === 'log') {
    $('#modal-title').textContent = '牌局记录';
    renderLog();
  } else if (kind === 'borrow') {
    $('#modal-title').textContent = '借筹码';
    borrowSig = '';
    renderBorrow();
  } else if (kind === 'sound') {
    $('#modal-title').textContent = '声音设置';
    renderSoundSettings();
  } else if (kind === 'avatar') {
    $('#modal-title').textContent = '换个角色';
    $('#modal-body').innerHTML = `<div class="avatar-grid">${avatarGridHTML(state.me.avatar)}</div>`;
  } else if (kind === 'host') {
    $('#modal-title').textContent = '房主设置';
    renderHost();
  } else if (kind === 'results') {
    $('#modal-title').textContent = `第 ${data.id} 场结算`;
    $('#modal-body').innerHTML = resultsTable(data.results);
  }
}

function closeModal() {
  modalKind = null;
  $('#modal').classList.add('hidden');
}

function resultsTable(rows) {
  if (!rows.length) return '<div class="empty-note">这场没有人参与</div>';
  return `<table class="score"><tr><th>#</th><th>玩家</th><th>借入</th><th>最终筹码</th><th>盈亏</th></tr>
    ${rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.name)}</td><td>${fmt(r.buyIn)}</td><td>${fmt(r.stack)}</td><td>${signed(r.net)}</td></tr>`).join('')}</table>`;
}

function renderScore(data) {
  const tabs = `<div class="tabs">
    <button data-tab="session" class="${scoreTab === 'session' ? 'on' : ''}">本场</button>
    <button data-tab="total" class="${scoreTab === 'total' ? 'on' : ''}">总榜</button>
    <button data-tab="history" class="${scoreTab === 'history' ? 'on' : ''}">历史场次</button></div>`;
  let body = '';

  if (scoreTab === 'session') {
    if (!state.session) body = '<div class="empty-note">现在没有进行中的场次</div>';
    else if (!state.ledger.length) body = '<div class="empty-note">还没有人入座</div>';
    else {
      body = `<table class="score"><tr><th>#</th><th>玩家</th><th>借入</th><th>筹码</th><th>盈亏</th><th>手数</th><th>赢</th></tr>
        ${state.ledger.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.name)}${r.seated ? '' : ' <span class="muted">(离座)</span>'}</td>
          <td>${fmt(r.buyIn)}</td><td>${fmt(r.stack)}</td><td>${signed(r.net)}</td><td>${r.hands}</td><td>${r.won}</td></tr>`).join('')}</table>
        <p class="muted" style="font-size:12px">筹码按上一手结束时计算；盈亏 = 筹码 − 借入</p>`;
    }
  } else if (!data) {
    body = '<div class="empty-note">加载中…</div>';
    socket.emit('scoreboard', {}, (res) => { if (modalKind === 'score' && scoreTab !== 'session') renderScore(res.data); });
  } else if (scoreTab === 'total') {
    body = data.totals.length
      ? `<table class="score"><tr><th>#</th><th>玩家</th><th>总盈亏</th><th>场次</th><th>最佳单场</th><th>胜手率</th></tr>
        ${data.totals.map((t, i) => `<tr><td>${i + 1}</td><td>${esc(t.name)}</td><td>${signed(t.net)}</td><td>${t.sessions}</td>
          <td>${signed(t.best)}</td><td>${t.hands ? Math.round((t.won / t.hands) * 100) : 0}%</td></tr>`).join('')}</table>
        <p class="muted" style="font-size:12px">只统计已结束的场次</p>`
      : '<div class="empty-note">还没有结束过的场次</div>';
  } else {
    body = data.sessions.length
      ? data.sessions.map((s) => `<details class="session"><summary>第 ${s.id} 场 <span class="muted">${when(s.startedAt)}–${when(s.endedAt, true)} · 盲注 ${s.sb}/${s.bb} · 起始筹码 ${fmt(s.buyIn)}</span></summary>
          <div>${resultsTable(s.results)}</div></details>`).join('')
      : '<div class="empty-note">还没有结束过的场次</div>';
  }
  $('#modal-body').innerHTML = tabs + body;
}

function when(t, timeOnly) {
  const d = new Date(t);
  const p = (x) => String(x).padStart(2, '0');
  const time = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return timeOnly ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

// 文字里的牌（如 "Ah"、"Td"）换成带花色的样子
function prettyCards(text) {
  return esc(text).replace(/\b([2-9TJQKA])([shdc])\b/g, (_, r, s) =>
    `<span class="ct ${s === 'h' || s === 'd' ? 'red' : ''}">${r === 'T' ? '10' : r}${SUIT[s]}</span>`);
}

function renderLog() {
  const body = $('#modal-body');
  const tabs = `<div class="tabs">
    <button data-logtab="history" class="${logTab === 'history' ? 'on' : ''}">手牌历史</button>
    <button data-logtab="activity" class="${logTab === 'activity' ? 'on' : ''}">房间动态</button></div>`;

  if (logTab === 'activity') {
    const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 30;
    body.innerHTML = `${tabs}<div class="log-list">${state.log.map((l) => `<div><time>${when(l.t, true)}</time>${prettyCards(l.text)}</div>`).join('')}</div>
      ${state.spectators.length ? `<div class="spectators">观战：${state.spectators.map(esc).join('、')}</div>` : ''}`;
    if (atBottom) body.scrollTop = body.scrollHeight;
    return;
  }

  // 手牌历史只在又打完一手时才重新拉取，别把你展开的那一手收起来
  const h = state.hand;
  const lastDone = h ? (h.phase === 'done' ? h.no : h.no - 1) : 0;
  if (lastDone === historyFetchedFor) return;
  historyFetchedFor = lastDone;
  if (!body.querySelector('.hand, .empty-note')) body.innerHTML = `${tabs}<div class="empty-note">加载中…</div>`;
  socket.emit('history', {}, (res) => {
    if (modalKind !== 'log' || logTab !== 'history' || !res.ok) return;
    const open = new Set([...body.querySelectorAll('details.hand[open]')].map((d) => d.dataset.no));
    if (!open.size && res.data.length) open.add(String(res.data[0].no)); // 默认展开最近一手
    body.innerHTML = tabs + historyHTML(res.data);
    for (const d of body.querySelectorAll('details.hand')) if (open.has(d.dataset.no)) d.open = true;
  });
}

function historyHTML(list) {
  if (!list.length) return '<div class="empty-note">还没有打完的手牌</div>';
  const cards = (arr) => arr.map((c) => cardHTML(c)).join('');
  return list.map((r) => {
    const me = r.players.find((p) => p.me);
    const winners = r.players.filter((p) => p.net > 0);
    const rows = r.players.map((p) => {
      let hole = '<span class="muted">未亮</span>';
      if (p.hole) hole = `<div class="mini-cards">${cards(p.hole)}</div>`;
      else if (p.folded) hole = '<span class="muted">弃牌</span>';
      return `<tr class="${p.me ? 'me-row' : ''}"><td>${esc(p.name)}${p.name === r.button ? ' <span class="dtag">D</span>' : ''}</td>
        <td>${hole}</td><td>${esc(p.handName ?? '')}</td><td>${fmt(p.start)}</td><td>${signed(p.net)}</td></tr>`;
    }).join('');
    return `<details class="hand" data-no="${r.no}">
      <summary><b>第 ${r.no} 手</b> <span class="muted">${when(r.t, true)} · 盲注 ${r.sb}/${r.bb} · 底池 ${fmt(r.pot)}</span>
        <div class="hand-sum">赢家 ${winners.map((w) => `${esc(w.name)} ${signed(w.net)}`).join('、')}${me ? ` <span class="muted">· 我</span> ${signed(me.net)}` : ''}</div></summary>
      <div class="hand-body">
        <div class="mini-board">${r.board.length ? cards(r.board) : '<span class="muted">没发公共牌就结束了</span>'}</div>
        <table class="score"><tr><th>玩家</th><th>底牌</th><th>牌型</th><th>起始</th><th>盈亏</th></tr>${rows}</table>
        <div class="log-list">${r.log.map((l) => `<div class="${l.startsWith('——') ? 'street' : ''}">${prettyCards(l)}</div>`).join('')}</div>
      </div></details>`;
  }).join('');
}

// ---------- 聊天 ----------
const PHRASES = ['好牌！👍', '运气不错 😏', '快点吧 🙏', '诈唬吧？🤔', '我 all-in 了，敢跟吗？', '再来一把！', '先撤了，下次再战 👋'];
const EMOJIS = ['😂', '😭', '😎', '🤔', '👍', '🔥', '💰', '🙈', '😡', '🍀'];

// 左下角聊天面板：快捷短语和表情只需要渲染一次
$('#chat-phrases').innerHTML = PHRASES.map((p) => `<button data-say="${esc(p)}">${esc(p)}</button>`).join('');
$('#chat-emojis').innerHTML = EMOJIS.map((e) => `<button data-say="${e}">${e}</button>`).join('');

const chatOpen = () => !$('#chatpanel').classList.contains('hidden');

function toggleChat(open = !chatOpen()) {
  $('#chatpanel').classList.toggle('hidden', !open);
  $('#chatfeed').classList.toggle('hidden', open);
  $('#chatbtn').classList.toggle('on', open);
  if (open) {
    unread = 0;
    renderUnread();
    renderChatList();
    if (window.matchMedia('(pointer: fine)').matches) $('#chat-input').focus(); // 手机上不自动弹键盘
  }
}

// 面板关着时，新消息在左下角实时弹出，8 秒后淡出
function feedMessage(msg) {
  const feed = $('#chatfeed');
  const el = document.createElement('div');
  el.className = `feed-msg ${msg.name === state?.me.name ? 'mine' : ''}`;
  el.innerHTML = `<b>${esc(msg.name)}</b>${esc(msg.text)}`;
  feed.append(el);
  while (feed.children.length > 4) feed.firstElementChild.remove();
  setTimeout(() => el.classList.add('fade'), 8000);
  setTimeout(() => el.remove(), 8800);
}

function renderChatList() {
  const list = $('#chat-list');
  if (!list) return;
  const me = state?.me.name;
  list.innerHTML = chats.length
    ? chats.map((m) => `<div class="msg ${m.name === me ? 'mine' : ''}"><span class="who">${esc(m.name)}</span><time>${when(m.t, true)}</time><div class="text">${esc(m.text)}</div></div>`).join('')
    : '<div class="empty-note">还没有人说话</div>';
  list.scrollTop = list.scrollHeight;
}

function sendChat(text) {
  if (!text.trim()) return;
  socket.emit('chat', { text }, (res) => {
    if (!res.ok) return toast(res.error);
    const input = $('#chat-input');
    if (input && input.value === text) input.value = '';
  });
}

function renderUnread() {
  const el = $('#unread');
  el.textContent = unread > 9 ? '9+' : String(unread);
  el.classList.toggle('hidden', unread === 0);
}

// 说话的人在座位上，就在他头顶冒个气泡（观众的消息只在左下角显示）
function showBubble(msg) {
  if (!state || !joined) return;
  const i = state.seats.findIndex((s) => s?.name === msg.name);
  const seatEl = i >= 0 ? $(`#seats .seat[data-i="${i}"]`) : null;
  if (!seatEl) return;
  for (const old of $('#bubbles').children) if (old.dataset.name === msg.name) old.remove();
  const el = document.createElement('div');
  el.className = 'bubble';
  el.dataset.name = msg.name;
  el.textContent = msg.text;
  $('#bubbles').append(el);
  const table = $('#table');
  const W = table.clientWidth;
  const bw = el.offsetWidth;
  const bh = el.offsetHeight;
  const sx = parseFloat(seatEl.style.left);
  const sy = parseFloat(seatEl.style.top);
  // 先试着放在座位头顶（坐标是气泡的底边中点）
  let x = clamp(sx, bw / 2 + 4, W - bw / 2 - 4);
  let y = Math.max(bh + 8, sy - seatEl.offsetHeight / 2);
  // 会挡住公共牌就挪到座位侧面，往离中心远的那边放
  const t = table.getBoundingClientRect();
  const b = $('#board').getBoundingClientRect();
  const overlaps = x + bw / 2 > b.left - t.left && x - bw / 2 < b.right - t.left && y > b.top - t.top && y - bh - 6 < b.bottom - t.top;
  if (overlaps) {
    const side = sx < W / 2 ? -1 : 1;
    const sideX = sx + side * (seatEl.offsetWidth / 2 + bw / 2 + 8);
    const fits = sideX - bw / 2 >= 0 && sideX + bw / 2 <= W;
    x = fits ? sideX : sx - side * (seatEl.offsetWidth / 2 + bw / 2 + 8);
    y = sy + bh / 2;
    el.classList.add('side');
  }
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  setTimeout(() => el.remove(), 4500);
}

// ---------- 借筹码 ----------
let borrowSig = '';
let borrowValue = 1000;

function renderBorrow() {
  const { me, session } = state;
  const mine = me.seat >= 0 ? state.seats[me.seat] : null;
  const sig = JSON.stringify([me.canBorrow, me.pendingBorrow, mine?.chips, me.borrowed, session?.buyIn, state.hand?.phase, mine?.inHand]);
  if (sig === borrowSig) return; // 别在你拖滑块时把面板刷掉
  borrowSig = sig;
  if (!me.canBorrow) {
    $('#modal-body').innerHTML = '<div class="empty-note">坐下并且开场之后才能借筹码</div>';
    return;
  }
  const max = session.buyIn;
  borrowValue = clamp(borrowValue, 1, max);
  const inHand = state.hand && state.hand.phase !== 'done' && mine.inHand;
  const quick = [100, 200, 500, max].filter((v, i, a) => v <= max && a.indexOf(v) === i);
  $('#modal-body').innerHTML = `
    <div class="borrow-stats">
      <div><span class="muted">现在筹码</span><b>${fmt(mine.chips)}</b></div>
      <div><span class="muted">本场已借</span><b>${fmt(me.borrowed)}</b></div>
      <div><span class="muted">单次最多</span><b>${fmt(max)}</b></div>
    </div>
    ${me.pendingBorrow ? `<div class="pending-note">已申请借 <b>${fmt(me.pendingBorrow)}</b>，这手结束后到账 <button data-act="borrow-cancel">取消</button></div>` : ''}
    <div class="quick">${quick.map((v) => `<button data-borrow="${v}">${fmt(v)}</button>`).join('')}</div>
    <div class="raise-row">
      <input type="range" id="borrow-range" min="1" max="${max}" step="1" value="${borrowValue}">
      <input type="number" id="borrow-num" min="1" max="${max}" value="${borrowValue}" inputmode="numeric">
    </div>
    <button class="primary" data-act="borrow-go" id="borrow-go" style="width:100%;padding:12px">借 ${fmt(borrowValue)}</button>
    <p class="muted" style="font-size:12px">${inHand
      ? '你正在打这一手，借的筹码这手结束后到账（不能看了底牌再加码）。'
      : '马上到账。'} 借的都算进"借入"，盈亏 = 筹码 − 借入。</p>`;
}

function setBorrow(v) {
  const max = state.session?.buyIn || 1000;
  borrowValue = clamp(Math.floor(Number(v) || 0), 1, max);
  if ($('#borrow-range')) $('#borrow-range').value = borrowValue;
  if ($('#borrow-num') && document.activeElement !== $('#borrow-num')) $('#borrow-num').value = borrowValue;
  if ($('#borrow-go')) $('#borrow-go').textContent = `借 ${fmt(borrowValue)}`;
}

// ---------- 声音设置 ----------
function renderSoundSettings() {
  const p = Sound.prefs;
  const custom = ['bgm', 'win', 'lose'].filter((n) => Sound.hasFile(n));
  $('#modal-body').innerHTML = `
    <label class="switch-row"><input type="checkbox" id="snd-music" ${p.music ? 'checked' : ''}> 背景音乐（开局后播放）</label>
    <div class="raise-row"><span class="muted">音量</span><input type="range" id="snd-music-vol" min="0" max="1" step="0.05" value="${p.musicVol}"></div>
    <label class="switch-row"><input type="checkbox" id="snd-sfx" ${p.sfx ? 'checked' : ''}> 音效（轮到你、胜利、失败）</label>
    <div class="raise-row"><span class="muted">音量</span><input type="range" id="snd-sfx-vol" min="0" max="1" step="0.05" value="${p.sfxVol}"></div>
    <div class="host-actions" style="margin-top:8px"><button data-act="test-win">试听胜利</button><button data-act="test-lose">试听失败</button></div>
    <p class="muted" style="font-size:12px">音乐和音效都是浏览器现场合成的原创声音${custom.length ? `；已使用自定义文件：${custom.join('、')}` : ''}。手机静音键打开时可能听不到。</p>`;
}

function renderHost() {
  const s = state.session;
  const sig = JSON.stringify([!!s, s?.id, s?.started, s?.paused, s?.ending, state.me.isHost]);
  if (sig === hostSig) return; // 别在你输入时把表单刷掉
  hostSig = sig;
  if (!state.me.isHost) {
    $('#modal-body').innerHTML = '<div class="empty-note">你已经不是房主了</div>';
    return;
  }
  const d = state.defaults;
  if (!s) {
    $('#modal-body').innerHTML = `
      <div class="section-title">开始新场</div>
      <div class="form-grid">
        <label>起始筹码<input id="f-buyin" type="number" inputmode="numeric" value="${d.buyIn}"></label>
        <label>小盲<input id="f-sb" type="number" inputmode="numeric" value="${d.sb}"></label>
        <label>大盲<input id="f-bb" type="number" inputmode="numeric" value="${d.bb}"></label>
      </div>
      <button class="primary" data-act="start-session" style="width:100%;padding:12px">开始新场</button>
      <p class="muted" style="font-size:12px">坐下时自动借入起始筹码。之后每个人可以随时再借，单次最多借"起始筹码"这么多；牌局进行中借的，这手结束后到账。</p>`;
  } else {
    $('#modal-body').innerHTML = `
      ${s.started ? '' : `
      <button class="primary" data-act="deal" style="width:100%;padding:12px">开局</button>
      <p class="muted" style="font-size:12px">等大家坐好再点。开局后每一手打完会自动发下一手，不用再点。</p>
      <hr>`}
      <div class="section-title">修改盲注（下一手生效）</div>
      <div class="form-grid two">
        <label>小盲<input id="f-sb" type="number" inputmode="numeric" value="${s.sb}"></label>
        <label>大盲<input id="f-bb" type="number" inputmode="numeric" value="${s.bb}"></label>
      </div>
      <button data-act="set-blinds" style="width:100%">修改盲注</button>
      <hr>
      <div class="host-actions">
        ${s.started ? `<button data-act="pause">${s.paused ? '▶ 继续发牌' : '⏸ 暂停发牌'}</button>` : ''}
        <button class="danger" data-act="end-session" ${s.ending ? 'disabled' : ''}>${s.ending ? '本手结束后结算…' : '结束本场并结算'}</button>
      </div>
      <p class="muted" style="font-size:12px">暂停：当前这手打完后不再发新的一手。结束：正在打的这手结束后，把每个人的盈亏记入计分板。</p>`;
  }
}

// ---------- 交互 ----------
document.addEventListener('click', (e) => {
  const seatEl = e.target.closest('[data-seat]');
  if (seatEl) return send('sit', { seat: Number(seatEl.dataset.seat) });

  const q = e.target.closest('[data-q]');
  if (q && state?.actions) {
    const a = state.actions;
    const v = q.dataset.q;
    setRaise(v === 'min' ? a.minRaiseTo : v === 'max' ? a.maxRaiseTo : potRaiseTo(Number(v)));
    return;
  }

  const tab = e.target.closest('[data-tab]');
  if (tab) {
    scoreTab = tab.dataset.tab;
    renderScore();
    return;
  }

  const logtab = e.target.closest('[data-logtab]');
  if (logtab) {
    logTab = logtab.dataset.logtab;
    historyFetchedFor = -1;
    $('#modal-body').innerHTML = '';
    renderLog();
    return;
  }

  const say = e.target.closest('[data-say]');
  if (say) return sendChat(say.dataset.say);

  const bq = e.target.closest('[data-borrow]');
  if (bq) return setBorrow(bq.dataset.borrow);

  const pick = e.target.closest('[data-pick]');
  if (pick) {
    pickAvatar(pick.dataset.pick);
    if (joined) {
      send('avatar', { id: pick.dataset.pick });
      if (modalKind === 'avatar') closeModal();
    }
    return;
  }

  const btn = e.target.closest('[data-act]');
  if (btn) doAction(btn.dataset.act);
});

function doAction(act) {
  const a = state?.actions;
  switch (act) {
    case 'fold':
      if (a?.canCheck && !confirm('现在可以免费过牌，确定要弃牌吗？')) return;
      return send('action', { type: 'fold' });
    case 'check':
    case 'call':
      return send('action', { type: act });
    case 'raise-toggle':
      raiseOpen = !raiseOpen;
      $('#raise-panel')?.classList.toggle('hidden', !raiseOpen);
      document.querySelector('.btn-raise')?.classList.toggle('on', raiseOpen);
      return;
    case 'raise':
      if (!a) return;
      return raiseValue >= a.maxRaiseTo ? send('action', { type: 'allin' }) : send('action', { type: 'raise', amount: raiseValue });
    case 'back':
      return send(act);
    case 'borrow-open':
      return openModal('borrow');
    case 'avatar-open':
      return openModal('avatar');
    case 'borrow-go':
      socket.emit('borrow', { amount: borrowValue }, (res) => {
        if (!res.ok) return toast(res.error);
        closeModal();
        const inHand = state.hand && state.hand.phase !== 'done' && state.seats[state.me.seat]?.inHand;
        toast(inHand ? `已申请借 ${fmt(borrowValue)}，这手结束后到账` : `借到 ${fmt(borrowValue)}`, 'info');
      });
      return;
    case 'borrow-cancel':
      return send('borrow', { amount: 0 });
    case 'test-win':
      return Sound.win();
    case 'test-lose':
      return Sound.lose();
    case 'host-open':
      return openModal('host');
    case 'deal':
      send('host:deal');
      if (modalKind === 'host') closeModal();
      return;
    case 'start-session':
      send('host:start', { buyIn: $('#f-buyin').value, sb: $('#f-sb').value, bb: $('#f-bb').value });
      return closeModal();
    case 'set-blinds':
      send('host:blinds', { sb: $('#f-sb').value, bb: $('#f-bb').value });
      return toast('已提交，下一手生效', 'info');
    case 'pause':
      return send('host:pause');
    case 'end-session':
      if (confirm('确定结束本场并结算吗？')) send('host:end');
      return;
  }
}

document.addEventListener('input', (e) => {
  if (e.target.id === 'raise-range') setRaise(e.target.value);
  if (e.target.id === 'raise-num') {
    const a = state?.actions;
    const v = Math.floor(Number(e.target.value) || 0);
    if (a) {
      raiseValue = clamp(v, a.minRaiseTo, a.maxRaiseTo);
      $('#raise-range').value = raiseValue;
      updateRaiseLabel();
    }
  }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'raise-num') setRaise(e.target.value);
  if (e.target.id === 'borrow-num') setBorrow(e.target.value);
  if (e.target.id === 'snd-music') Sound.set('music', e.target.checked);
  if (e.target.id === 'snd-sfx') Sound.set('sfx', e.target.checked);
  if (e.target.id?.startsWith('snd-')) renderHeader();
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'borrow-range') setBorrow(e.target.value);
  if (e.target.id === 'borrow-num') {
    const v = Math.floor(Number(e.target.value) || 0);
    if (v >= 1) setBorrow(v);
  }
  if (e.target.id === 'snd-music-vol') Sound.set('musicVol', Number(e.target.value));
  if (e.target.id === 'snd-sfx-vol') Sound.set('sfxVol', Number(e.target.value));
});

// 电脑快捷键：F 弃牌、C/空格 过牌或跟注、R 打开加注、回车确认加注
document.addEventListener('keydown', (e) => {
  if (!state?.actions || e.target.matches('input:not([type=range])') || modalKind) return;
  const a = state.actions;
  const k = e.key.toLowerCase();
  if (k === 'f') doAction('fold');
  else if (k === 'c' || k === ' ') { e.preventDefault(); doAction(a.canCheck ? 'check' : 'call'); }
  else if (k === 'r' && a.canRaise) doAction('raise-toggle');
  else if (k === 'enter' && raiseOpen) doAction('raise');
});

$('#btn-score').onclick = () => { scoreTab = 'session'; openModal('score'); };
$('#btn-log').onclick = () => openModal('log');
$('#chatbtn').onclick = () => toggleChat();
$('#chat-close').onclick = () => toggleChat(false);
$('#btn-borrow').onclick = () => openModal('borrow');
document.addEventListener('submit', (e) => {
  if (e.target.id !== 'chat-form') return;
  e.preventDefault();
  sendChat($('#chat-input').value);
});
$('#btn-host').onclick = () => openModal('host');
$('#btn-stand').onclick = () => {
  const mine = state.seats[state.me.seat];
  const inHand = state.hand && state.hand.phase !== 'done' && mine?.inHand && !mine.folded;
  if (!inHand || confirm('正在打的这手会直接弃牌，确定离座吗？')) send('stand');
};
$('#btn-sound').onclick = () => openModal('sound');
$('#modal-close').onclick = closeModal;
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
// 牌桌区域尺寸变了（转屏、拉窗口、顶栏换行）就重新排座位
new ResizeObserver(() => state && joined && renderSeats()).observe($('#table'));
// 左下角聊天始终浮在操作栏上方，操作栏变高（比如展开加注面板）时跟着上移
new ResizeObserver(() => document.documentElement.style.setProperty('--bar-h', `${$('#actionbar').offsetHeight}px`)).observe($('#actionbar'));

// 角色列表定义在后面，所以登录页的角色格子放到最后再画
$('#avatar-grid').innerHTML = avatarGridHTML(chosenAvatar);
