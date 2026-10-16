import fs from 'node:fs';
import path from 'node:path';

// 计分数据存成一个 JSON 文件，写入时先写临时文件再改名，避免写一半断电损坏
export class Store {
  constructor(file) {
    this.file = file;
    this.data = { version: 1, nextSessionId: 1, sessions: [] };
    if (fs.existsSync(file)) {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      this.save();
    }
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    try {
      fs.renameSync(tmp, this.file);
    } catch {
      // 目标文件被其他程序占用时（比如正被编辑器打开），退回直接覆盖
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
      fs.rmSync(tmp, { force: true });
    }
  }

  activeSession() {
    return this.data.sessions.find((s) => !s.endedAt) || null;
  }

  createSession({ buyIn, sb, bb }) {
    const session = { id: this.data.nextSessionId++, startedAt: Date.now(), endedAt: null, buyIn, sb, bb, ledger: {}, results: null };
    this.data.sessions.push(session);
    this.save();
    return session;
  }

  finishSession(session, results) {
    session.endedAt = Date.now();
    session.results = results;
    this.save();
  }

  scoreboard() {
    const finished = this.data.sessions.filter((s) => s.endedAt && s.results?.length);
    const totals = new Map();
    for (const s of finished) {
      for (const r of s.results) {
        const t = totals.get(r.name) || { name: r.name, net: 0, sessions: 0, best: -Infinity, hands: 0, won: 0 };
        t.net += r.net;
        t.sessions++;
        t.best = Math.max(t.best, r.net);
        t.hands += r.hands;
        t.won += r.won;
        totals.set(r.name, t);
      }
    }
    return {
      totals: [...totals.values()].sort((a, b) => b.net - a.net),
      sessions: finished
        .map((s) => ({ id: s.id, startedAt: s.startedAt, endedAt: s.endedAt, buyIn: s.buyIn, sb: s.sb, bb: s.bb, results: s.results }))
        .reverse(),
    };
  }
}
