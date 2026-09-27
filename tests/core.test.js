// 核心邏輯測試：node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/core.js');

// 造一個假的擊球結果，方便測規則
function fakePlay(p) {
  return Object.assign({ kind: 'single', text: '', outs: 0, runs: 0, hit: false, hitBases: 0, sacFly: false, bases: [false, false, false] }, p);
}

function atBat(s, type, extra) {
  return C.applyOutcome(s, Object.assign({ type }, extra));
}

test('保送只推進被迫的跑者', () => {
  const cases = [
    [[false, false, false], [true, false, false], 0],
    [[true, false, false], [true, true, false], 0],
    [[false, true, false], [true, true, false], 0],
    [[true, false, true], [true, true, true], 0],
    [[true, true, false], [true, true, true], 0],
    [[true, true, true], [true, true, true], 1],
    [[false, false, true], [true, false, true], 0],
  ];
  for (const [before, after, runs] of cases) {
    const b = before.slice();
    assert.equal(C.forceAdvance(b), runs, JSON.stringify(before));
    assert.deepEqual(b, after, JSON.stringify(before));
  }
});

test('四壞球保送、三振出局、兩好球後界外不加好球', () => {
  const s = C.newGame({ innings: 3 });
  for (let i = 0; i < 3; i++) atBat(s, 'ball');
  assert.equal(s.balls, 3);
  const ev = atBat(s, 'ball');
  assert.ok(ev.some((e) => e.kind === 'walk'));
  assert.deepEqual(s.bases, [true, false, false]);
  assert.equal(s.balls, 0);

  atBat(s, 'strike');
  atBat(s, 'foul');
  assert.equal(s.strikes, 2);
  atBat(s, 'foul');
  atBat(s, 'foul');
  assert.equal(s.strikes, 2, '兩好球後的界外球不算好球');
  const k = atBat(s, 'strike', { swinging: true });
  assert.ok(k.some((e) => e.kind === 'strikeout' && e.swinging));
  assert.equal(s.outs, 1);
  assert.equal(s.stats[0].so, 1);
  assert.equal(s.stats[0].bb, 1);
});

test('三出局換邊，壘包清空，比分板記錄這半局', () => {
  const s = C.newGame({ innings: 3 });
  atBat(s, 'inplay', { play: fakePlay({ kind: 'double', hit: true, hitBases: 2, bases: [false, true, false] }) });
  atBat(s, 'inplay', { play: fakePlay({ kind: 'single', hit: true, hitBases: 1, runs: 1, bases: [true, false, false] }) });
  assert.equal(s.runs[0], 1);
  for (let i = 0; i < 3; i++) atBat(s, 'inplay', { play: fakePlay({ kind: 'flyout', outs: 1, bases: s.bases.slice() }) });
  assert.equal(s.half, 1);
  assert.equal(s.outs, 0);
  assert.deepEqual(s.bases, [false, false, false]);
  assert.deepEqual(s.line[0], [1]);
  assert.deepEqual(s.line[1], [0]);
  assert.equal(s.hits[0], 2);
});

function retireSide(s) {
  const half = s.half;
  const inning = s.inning;
  while (!s.over && s.half === half && s.inning === inning) atBat(s, 'inplay', { play: fakePlay({ kind: 'groundout', outs: 1, bases: s.bases.slice() }) });
}

test('最後一局上半結束主隊領先：比賽結束，下半局標 X', () => {
  const s = C.newGame({ innings: 1 });
  retireSide(s);
  atBat(s, 'inplay', { play: fakePlay({ kind: 'hr', hit: true, hitBases: 4, runs: 1 }) });
  assert.equal(s.over, true);
  assert.equal(s.winner, 1);
  assert.equal(s.walkoff, true, '主隊在最後一局下半超前就是再見');

  const t = C.newGame({ innings: 2 });
  retireSide(t); // 1 上
  atBat(t, 'inplay', { play: fakePlay({ kind: 'hr', hit: true, hitBases: 4, runs: 1 }) });
  retireSide(t); // 1 下，主隊 1:0
  assert.equal(t.over, false);
  retireSide(t); // 2 上
  assert.equal(t.over, true);
  assert.equal(t.winner, 1);
  assert.equal(t.line[1][1], 'X');
});

test('再見安打只算到超前的那一分；再見全壘打全部算', () => {
  const s = C.newGame({ innings: 1 });
  retireSide(s);
  // 平手、滿壘，二壘安打本來會回來三分
  s.bases = [true, true, true];
  atBat(s, 'inplay', { play: fakePlay({ kind: 'double', hit: true, hitBases: 2, runs: 3, bases: [false, true, false] }) });
  assert.equal(s.over, true);
  assert.equal(s.runs[1], 1);

  const t = C.newGame({ innings: 1 });
  retireSide(t);
  t.bases = [true, true, true];
  atBat(t, 'inplay', { play: fakePlay({ kind: 'hr', hit: true, hitBases: 4, runs: 4 }) });
  assert.equal(t.runs[1], 4);
  assert.equal(t.walkoff, true);
});

test('延長賽打滿仍平手就和局', () => {
  const s = C.newGame({ innings: 1 });
  for (let i = 0; i < 1 + 3; i++) {
    retireSide(s);
    retireSide(s);
  }
  assert.equal(s.over, true);
  assert.equal(s.winner, -1);
  assert.equal(s.inning, s.maxInnings);
});

test('投球軌跡的終點就是進壘點', () => {
  const rng = C.makeRng(1);
  for (const type of C.PITCH_ORDER) {
    const p = C.createPitch({ type, target: { x: 0.1, z: 0.8 }, rng });
    const end = C.pitchPos(p, p.T);
    assert.ok(Math.abs(end.x - p.end.x) < 1e-9 && Math.abs(end.z - p.end.z) < 1e-9, type);
    assert.ok(Math.abs(end.y) < 1e-9, type);
    const start = C.pitchPos(p, 0);
    assert.ok(Math.abs(start.y - C.RELEASE.y) < 1e-9);
  }
  const fb = C.createPitch({ type: 'FB', target: { x: 0, z: 0.8 }, rng });
  const cb = C.createPitch({ type: 'CB', target: { x: 0, z: 0.8 }, rng });
  assert.ok(cb.T > fb.T, '曲球比直球慢');
});

test('好球帶判定包含球的半徑', () => {
  assert.equal(C.isStrike(0, 0.8), true);
  assert.equal(C.isStrike(C.ZONE.halfW + C.BALL_R - 0.001, 0.8), true);
  assert.equal(C.isStrike(C.ZONE.halfW + C.BALL_R + 0.01, 0.8), false);
  assert.equal(C.isStrike(0, C.ZONE.top + C.BALL_R + 0.01), false);
  assert.equal(C.isStrike(0, C.ZONE.bottom - C.BALL_R + 0.001), true);
});

test('揮棒：時機完美且對準會紮實擊中；太早往左、太晚往右；差太多揮空', () => {
  const rng = C.makeRng(2);
  const p = C.createPitch({ type: 'FB', target: { x: 0, z: 0.8 }, control: 0, rng });
  const at = C.pitchPos(p, p.T);
  const perfect = C.evaluateSwing({ pitch: p, swingTime: p.T - C.SWING.lag, cursor: { x: at.x, z: at.z }, rng });
  assert.equal(perfect.contact, true);
  assert.equal(perfect.timingLabel, 'perfect');
  assert.ok(perfect.ev > 165, `ev ${perfect.ev}`);

  let early = 0;
  let late = 0;
  for (let i = 0; i < 200; i++) {
    const e = C.evaluateSwing({ pitch: p, swingTime: p.T - C.SWING.lag - 0.07, cursor: at, rng });
    const l = C.evaluateSwing({ pitch: p, swingTime: p.T - C.SWING.lag + 0.07, cursor: at, rng });
    if (e.contact) early += e.spray;
    if (l.contact) late += l.spray;
  }
  assert.ok(early < 0 && late > 0, '太早拉打往左外野、太晚推打往右外野');

  const whiff = C.evaluateSwing({ pitch: p, swingTime: p.T - 0.4, cursor: at, rng });
  assert.equal(whiff.contact, false);
  const wrongSpot = C.evaluateSwing({ pitch: p, swingTime: p.T - C.SWING.lag, cursor: { x: at.x + 0.3, z: at.z }, rng });
  assert.equal(wrongSpot.contact, false);
});

test('擊球飛行：強勁高飛球飛出全壘打牆，軟弱滾地球不會', () => {
  const big = C.simulateBattedBall(175, 30, 0);
  assert.equal(big.hr, true);
  assert.ok(big.distance > C.FIELD.fenceCenter);
  const weak = C.simulateBattedBall(90, -5, 10);
  assert.equal(weak.hr, false);
  assert.ok(weak.landing, '滾地球會落地');
  const foul = C.simulateBattedBall(150, 25, 60);
  assert.equal(foul.fair, false);
  assert.equal(foul.hr, false);
});

test('滿貫全壘打四分、清空壘包', () => {
  const bb = C.simulateBattedBall(178, 30, -10);
  assert.equal(bb.hr, true);
  const play = C.resolvePlay(bb, { bases: [true, true, true], outs: 1, rng: C.makeRng(3) });
  assert.equal(play.kind, 'hr');
  assert.equal(play.runs, 4);
  assert.equal(play.text, '滿貫全壘打');
  assert.deepEqual(play.bases, [false, false, false]);
});

test('每一種擊球結果都讓人數守恆：原本壘上 + 打者 = 得分 + 壘上 + 出局', () => {
  const rng = C.makeRng(4);
  const seen = new Set();
  for (let i = 0; i < 4000; i++) {
    const bases = [rng() < 0.4, rng() < 0.4, rng() < 0.4];
    const outs = Math.floor(rng() * 3);
    const bb = C.simulateBattedBall(60 + rng() * 125, -30 + rng() * 90, -44 + rng() * 88);
    const play = C.resolvePlay(bb, { bases, outs, rng });
    seen.add(play.kind);
    assert.ok(play.text, '要有結果文字');
    assert.ok(play.anim.end > 0, '要有動畫長度');
    if (outs + play.outs >= 3) {
      assert.equal(play.runs, 0, `第三個出局時不得分（${play.kind}）`);
      continue;
    }
    const before = bases.filter(Boolean).length + 1;
    const after = play.runs + play.bases.filter(Boolean).length + play.outs;
    assert.equal(after, before, `${play.kind} ${JSON.stringify(bases)} → ${JSON.stringify(play.bases)} runs ${play.runs} outs ${play.outs}`);
  }
  for (const k of ['hr', 'single', 'double', 'groundout', 'flyout', 'lineout', 'dp']) assert.ok(seen.has(k), `應該出現 ${k}`);
});

test('全壘打大賽：揮棒才扣球數，壞球不扣；依全壘打數、再依最遠距離決勝', () => {
  const s = C.newDerby({ players: 2, pitches: 2 });
  C.applyOutcome(s, { type: 'ball' });
  assert.equal(s.left[0], 2);
  C.applyOutcome(s, { type: 'inplay', play: fakePlay({ kind: 'hr', distance: 120 }) });
  const ev = C.applyOutcome(s, { type: 'strike', swinging: true });
  assert.ok(ev.some((e) => e.kind === 'derby_next'));
  assert.equal(s.current, 1);
  C.applyOutcome(s, { type: 'inplay', play: fakePlay({ kind: 'hr', distance: 131 }) });
  const end = C.applyOutcome(s, { type: 'foul' });
  assert.equal(s.over, true);
  assert.equal(s.winner, 1, '同樣一支全壘打，比較遠的贏');
  assert.ok(end.some((e) => e.kind === 'game_over'));
});

test('電腦對電腦：每一場都會正常結束，比分板加總等於總分', () => {
  const rng = C.makeRng(5);
  for (const lv of ['easy', 'normal', 'hard']) {
    for (let g = 0; g < 40; g++) {
      const s = C.simulateGame({ innings: 3, pitchLevel: lv, batLevel: lv }, rng);
      assert.equal(s.over, true, `${lv} 第 ${g} 場沒有結束`);
      for (const t of [0, 1]) {
        const sum = s.line[t].reduce((a, v) => a + (typeof v === 'number' ? v : 0), 0);
        assert.equal(sum, s.runs[t]);
      }
      if (s.winner === -1) assert.equal(s.runs[0], s.runs[1]);
      else assert.ok(s.runs[s.winner] > s.runs[1 - s.winner]);
      assert.ok(s.inning <= s.maxInnings);
    }
  }
});

test('電腦快轉半局只會跑完目前這個半局', () => {
  const rng = C.makeRng(6);
  const s = C.newGame({ innings: 3 });
  const log = C.simulateHalfInning(s, { pitchLevel: 'normal', batLevel: 'normal' }, rng);
  assert.ok(log.length >= 3);
  assert.equal(s.half, 1);
  assert.equal(s.inning, 1);
});
