import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { config } from './config.js';
import { Store } from './store.js';
import { Room } from './room.js';
import { UserError } from './errors.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = express();
app.use(express.static(path.join(root, 'public')));
// 自定义音频（public/audio/*.mp3）有哪些，前端据此决定用文件还是用合成音
const audioFiles = () => ['bgm', 'win', 'lose'].filter((n) => fs.existsSync(path.join(root, 'public', 'audio', `${n}.mp3`)));
app.get('/api/info', (req, res) => res.json({ needPassword: !!config.roomPassword, audio: audioFiles() }));

const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10_000, pingTimeout: 8_000 });
const store = new Store(path.resolve(root, config.dataFile));
const room = new Room({
  config,
  store,
  transport: {
    send: (id, event, data) => io.to(id).emit(event, data),
    kick: (id, message) => {
      const s = io.sockets.sockets.get(id);
      if (!s) return;
      s.emit('kicked', message);
      s.disconnect(true);
    },
  },
});

// 防止有人一直试口令：同一个 IP 连错太多次就锁一段时间
const failures = new Map(); // ip -> { count, first }
function lockedOut(ip) {
  const f = failures.get(ip);
  if (f && Date.now() - f.first > config.passwordLockMs) failures.delete(ip);
  return (failures.get(ip)?.count ?? 0) >= config.passwordMaxFailures;
}
function recordFailure(ip) {
  const f = failures.get(ip) || { count: 0, first: Date.now() };
  f.count++;
  failures.set(ip, f);
}

io.on('connection', (socket) => {
  const ip = socket.handshake.address;
  // 统一处理：参数校验失败、规则不允许 → 提示玩家；其他异常 → 记日志
  const on = (event, fn) => socket.on(event, (payload, ack) => {
    let res;
    try {
      res = { ok: true, ...(fn(payload && typeof payload === 'object' ? payload : {}) || {}) };
    } catch (e) {
      if (!(e instanceof UserError)) console.error(`[${event}]`, e);
      res = { ok: false, error: e instanceof UserError ? e.message : '服务器出错了，请看服务器窗口的日志' };
    }
    if (typeof ack === 'function') ack(res);
    else if (!res.ok) socket.emit('toast', res.error);
  });
  const me = () => {
    if (!socket.data.name) throw new UserError('请先进入房间');
    return socket.data.name;
  };

  on('join', (p) => {
    if (socket.data.name) room.disconnect(socket.id);
    let r;
    try {
      r = room.join(socket.id, {
        name: p.name,
        token: typeof p.token === 'string' ? p.token : '',
        password: p.password,
        avatar: typeof p.avatar === 'string' ? p.avatar : undefined,
        locked: lockedOut(ip), // 只拦"用口令进门"，已进来的人凭凭证重连不受影响
      });
    } catch (e) {
      if (e.code === 'BAD_PASSWORD') recordFailure(ip);
      throw e;
    }
    socket.data.name = r.name;
    return r;
  });
  on('chat', (p) => room.chat(me(), p.text));
  on('avatar', (p) => room.setAvatar(me(), String(p.id)));
  on('history', () => ({ data: room.historyFor(me()) }));
  on('sit', (p) => room.sit(me(), Number(p.seat)));
  on('stand', () => room.stand(me()));
  on('action', (p) => room.act(me(), String(p.type), p.amount));
  on('rebuy', () => room.rebuy(me()));
  on('borrow', (p) => room.borrow(me(), p.amount));
  on('back', () => room.back(me()));
  on('host:start', (p) => room.startSession(me(), p));
  on('host:deal', () => room.deal(me()));
  on('host:pause', () => room.togglePause(me()));
  on('host:blinds', (p) => room.setBlinds(me(), p));
  on('host:end', () => room.endSession(me()));
  on('scoreboard', () => ({ data: store.scoreboard() }));
  socket.on('disconnect', () => room.disconnect(socket.id));
});

server.listen(config.port, '0.0.0.0', () => {
  console.log('\n  德州扑克服务器已启动（按 Ctrl+C 停止）\n');
  console.log(`  本机打开:   http://localhost:${config.port}`);
  for (const [ifname, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  局域网地址: http://${a.address}:${config.port}   （${ifname}）`);
    }
  }
  console.log('\n  朋友连同一个 WiFi，用上面"WLAN"那一行的地址打开即可');
  console.log(config.roomPassword ? '  已开启进门口令\n' : '  未设置进门口令（放到公网前务必用 --password 设置）\n');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`端口 ${config.port} 被占用了：可能服务器已经开着，或者换个端口：set PORT=3001 后再启动`);
  else console.error(e);
  process.exit(1);
});
