/*
 * 紅不讓棒球 — 畫面、操作、音效與比賽流程
 *
 * 規則與物理都在 core.js（window.BaseballCore），這裡把它們接成可以玩的遊戲：
 *   - Canvas 兩個視角：捕手後方的「打擊視角」、擊出後的「全場視角」
 *   - 鍵盤（1P：WASD＋F／空白鍵，2P：方向鍵＋Enter）、滑鼠、觸控
 *   - WebAudio 即時合成音效，不需要任何音檔
 *   - 一球一球推進的比賽流程、計分板與選單
 */
(function () {
  'use strict';

  const C = window.BaseballCore;
  const clamp = C.clamp;
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (t) => t * t * (3 - 2 * t);
  const DEG = Math.PI / 180;
  const $ = (id) => document.getElementById(id);
  const mq = (q) => !!(window.matchMedia && window.matchMedia(q).matches);
  const reduceMotion = mq('(prefers-reduced-motion: reduce)');
  let touchUI = mq('(hover: none) and (pointer: coarse)');

  // ───────── 手感參數 ─────────
  const WINDUP = 0.95; // 投球動作（遊戲秒）
  const HIT_CAM = 0.5; // 擊出後在打擊視角停留多久（真實秒）
  const FIELD_SPEED = 1.45; // 全場動畫的播放速度
  const CURSOR_SPEED = 1.25; // 鍵盤移動打擊圈的速度（m/s）
  const TARGET_SPEED = 0.95; // 鍵盤移動捕手手套的速度
  const CUR_BOX = { x0: -0.5, x1: 0.5, z0: 0.25, z1: 1.35 };
  const TGT_BOX = { x0: -0.6, x1: 0.6, z0: 0.2, z1: 1.45 };
  const HUMAN_CONTROL = 0.05; // 玩家投球的控球誤差（公尺）

  const TEAM = [
    { ui: '#6ab4ff', jersey: '#2f7fdc', cap: '#173f7a' },
    { ui: '#ff9061', jersey: '#e2572b', cap: '#8a2d10' },
    { ui: '#c7d0dc', jersey: '#8b97a8', cap: '#3b4455' }, // 全壘打大賽的餵球投手
  ];
  const COL = {
    skin: '#e2b38a',
    pants: '#ece8dc',
    shoe: '#15181c',
    bat: '#d8a65f',
    glove: '#8b4f24',
    grass: '#2c7a3a',
    grass2: '#33873f',
    dirt: '#a5673f',
    dirt2: '#b77850',
    track: '#6c4630',
    chalk: '#f3efe4',
    wall: '#133b2d',
    wallTop: '#f2c94c',
    stands: '#0d1631',
    ball: '#fbfaf5',
    seam: '#d0403a',
    amber: '#f7b733',
    red: '#ff5b45',
    green: '#5cdb8b',
  };
  const NUM_FONT = '"Big Shoulders Display", "Arial Narrow", Impact, sans-serif';
  const ZH_FONT = '"Chiron GoRound TC", "PingFang TC", "Microsoft JhengHei", "Noto Sans TC", sans-serif';

  // ───────── DOM ─────────
  const el = {};
  [
    'board', 'line', 'status', 'inningHalf', 'inningNum', 'diamond', 'count', 'btnSound', 'btnPause', 'stage', 'view',
    'matchup', 'gun', 'flash', 'banner', 'bannerTitle', 'bannerSub', 'legend', 'pad', 'padTypes', 'btnThrow', 'hint',
    'menu', 'menuNote', 'btnStart', 'pause', 'btnResume', 'btnRestart', 'btnQuit', 'sim', 'simTitle', 'simLog',
    'btnSimOk', 'over', 'overKicker', 'overTitle', 'overScore', 'overStats', 'overNote', 'btnAgain', 'btnMenu',
  ].forEach((id) => (el[id] = $(id)));

  // ───────── 設定（存在這台裝置的瀏覽器裡） ─────────
  const store = {
    get(key, fallback) {
      try {
        const v = window.localStorage.getItem('hrbb:' + key);
        return v == null ? fallback : JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        window.localStorage.setItem('hrbb:' + key, JSON.stringify(value));
      } catch {
        /* 不能存也照常遊戲 */
      }
    },
  };

  function sanitize(s) {
    return {
      mode: s.mode === 'derby' ? 'derby' : 'game',
      players: +s.players === 2 ? 2 : 1,
      innings: [1, 3, 5].includes(+s.innings) ? +s.innings : 3,
      level: C.LEVELS[s.level] ? s.level : 'normal',
      pitching: s.pitching === 'cpu' ? 'cpu' : 'human',
      sound: s.sound !== false,
    };
  }
  const settings = sanitize(Object.assign({}, store.get('settings', {})));

  // ───────── 音效（WebAudio 合成） ─────────
  const Sound = (function () {
    let ac = null;
    let out = null;
    let noiseBuf = null;
    let on = settings.sound;

    function ready() {
      if (!on) return false;
      if (!ac) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        try {
          ac = new AC();
        } catch {
          return false;
        }
        out = ac.createGain();
        out.gain.value = 0.55;
        out.connect(ac.destination);
        noiseBuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      }
      if (ac.state === 'suspended') ac.resume().catch(() => {});
      return true;
    }
    function envelope(g, t, peak, attack, dur) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(peak, t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    }
    function noise(t, dur, o) {
      const src = ac.createBufferSource();
      src.buffer = noiseBuf;
      src.loop = true;
      const f = ac.createBiquadFilter();
      f.type = o.type || 'bandpass';
      f.frequency.value = o.freq || 1000;
      f.Q.value = o.q || 0.8;
      const g = ac.createGain();
      envelope(g, t, o.gain || 0.3, o.attack || 0.004, dur);
      src.connect(f);
      f.connect(g);
      g.connect(out);
      src.start(t, Math.random() * 1.5);
      src.stop(t + dur + 0.05);
      return f;
    }
    function tone(t, dur, freq, o) {
      const osc = ac.createOscillator();
      osc.type = o.type || 'sine';
      osc.frequency.setValueAtTime(freq, t);
      if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + dur);
      const g = ac.createGain();
      envelope(g, t, o.gain || 0.2, o.attack || 0.004, dur);
      osc.connect(g);
      g.connect(out);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    }
    const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);

    return {
      get on() {
        return on;
      },
      set(v) {
        on = v;
        if (!ac) return;
        if (v) ac.resume().catch(() => {});
        else ac.suspend().catch(() => {});
      },
      unlock() {
        ready();
      },
      crack(power) {
        if (!ready()) return;
        const t = ac.currentTime;
        const p = clamp(power, 0, 1);
        noise(t, 0.07 + 0.05 * p, { type: 'highpass', freq: 1500, gain: 0.35 + 0.45 * p });
        tone(t, 0.09, 1800 + 900 * p, { type: 'triangle', gain: 0.12 + 0.2 * p, to: 700 });
        noise(t, 0.18, { freq: 600, q: 1.5, gain: 0.12 + 0.2 * p });
      },
      mitt() {
        if (!ready()) return;
        const t = ac.currentTime;
        noise(t, 0.1, { type: 'lowpass', freq: 700, gain: 0.55 });
        tone(t, 0.09, 150, { gain: 0.35, to: 70 });
      },
      whoosh(gain) {
        if (!ready()) return;
        const t = ac.currentTime;
        const f = noise(t, 0.22, { freq: 400, q: 0.9, gain: gain || 0.1, attack: 0.1 });
        f.frequency.exponentialRampToValueAtTime(1800, t + 0.2);
      },
      cheer(level) {
        if (!ready()) return;
        const t = ac.currentTime;
        const k = level || 1;
        const d = 1.6 + 1.4 * k;
        noise(t, d, { freq: 950, q: 0.5, gain: 0.12 * k, attack: 0.3 });
        noise(t + 0.05, d * 0.9, { freq: 2300, q: 0.9, gain: 0.05 * k, attack: 0.35 });
      },
      groan() {
        if (!ready()) return;
        const t = ac.currentTime;
        const f = noise(t, 1.0, { freq: 520, q: 1.4, gain: 0.07, attack: 0.15 });
        f.frequency.exponentialRampToValueAtTime(260, t + 0.9);
      },
      organ(notes, step) {
        if (!ready()) return;
        const t = ac.currentTime;
        const st = step || 0.13;
        notes.forEach((m, i) => {
          if (m == null) return;
          const d = i === notes.length - 1 ? st * 3 : st * 1.2;
          tone(t + i * st, d, midi(m), { type: 'square', gain: 0.045 });
          tone(t + i * st, d, midi(m + 12), { type: 'triangle', gain: 0.03 });
        });
      },
      boom() {
        if (!ready()) return;
        const t = ac.currentTime;
        noise(t, 0.7, { type: 'lowpass', freq: 900, gain: 0.3, attack: 0.01 });
        noise(t + 0.05, 0.9, { type: 'highpass', freq: 3000, gain: 0.05, attack: 0.1 });
      },
      tick() {
        if (!ready()) return;
        tone(ac.currentTime, 0.05, 880, { type: 'square', gain: 0.03 });
      },
    };
  })();
  const CHARGE = [67, 72, 76, 79, null, 76, 79];
  const FANFARE = [72, 76, 79, 84, 79, 84];

  // ───────── 相機與投影 ─────────
  // 相機永遠朝 +y（中外野）看，可以往下俯視 pitch 度
  const NEAR = 0.3;

  function makeCam(px, py, pz, pitchDeg) {
    const p = pitchDeg * DEG;
    return { px, py, pz, cos: Math.cos(p), sin: Math.sin(p), f: 1, cx: 0, cy: 0 };
  }
  function toCam(c, x, y, z) {
    const dx = x - c.px;
    const dy = y - c.py;
    const dz = z - c.pz;
    return { r: dx, d: dy * c.cos - dz * c.sin, u: dy * c.sin + dz * c.cos };
  }
  function proj(c, x, y, z) {
    const q = toCam(c, x, y, z);
    if (q.d < NEAR) return null;
    const k = c.f / q.d;
    return { x: c.cx + q.r * k, y: c.cy - q.u * k, s: k };
  }
  // 多邊形投影（會切掉相機後方的部分）
  function projPoly(c, pts) {
    const q = pts.map((p) => toCam(c, p[0], p[1], p[2] || 0));
    const outPts = [];
    for (let i = 0; i < q.length; i++) {
      const a = q[i];
      const b = q[(i + 1) % q.length];
      const ain = a.d >= NEAR;
      const bin = b.d >= NEAR;
      if (ain) outPts.push(a);
      if (ain !== bin) {
        const t = (NEAR - a.d) / (b.d - a.d);
        outPts.push({ r: a.r + (b.r - a.r) * t, d: NEAR, u: a.u + (b.u - a.u) * t });
      }
    }
    return outPts.map((v) => [c.cx + (v.r * c.f) / v.d, c.cy - (v.u * c.f) / v.d]);
  }
  function pathPoly(g, c, pts) {
    const s = projPoly(c, pts);
    if (s.length < 3) return false;
    g.beginPath();
    g.moveTo(s[0][0], s[0][1]);
    for (let i = 1; i < s.length; i++) g.lineTo(s[i][0], s[i][1]);
    g.closePath();
    return true;
  }
  function fillPoly(g, c, pts, color) {
    if (!pathPoly(g, c, pts)) return;
    g.fillStyle = color;
    g.fill();
  }
  function fitCam(c, pts, box) {
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (const p of pts) {
      const q = toCam(c, p[0], p[1], p[2]);
      const u = q.r / q.d;
      const v = q.u / q.d;
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      v0 = Math.min(v0, v);
      v1 = Math.max(v1, v);
    }
    c.f = Math.min((box.x1 - box.x0) / (u1 - u0), (box.y1 - box.y0) / (v1 - v0));
    c.cx = (box.x0 + box.x1) / 2 - (c.f * (u0 + u1)) / 2;
    c.cy = (box.y0 + box.y1) / 2 + (c.f * (v0 + v1)) / 2;
  }

  const canvas = el.view;
  const ctx = canvas.getContext('2d');
  let W = 0;
  let H = 0;
  let DPR = 1;
  let batCam = null;
  let fieldCam = null;
  let batLayer = null;
  let fieldLayer = null;
  let needResize = true;
  let layersDirty = true;

  // 打擊視角：站在捕手後方，本壘板在畫面下緣、投手在上方
  function setupBatCam() {
    const c = makeCam(0, -4.4, 1.35, 0);
    const a = toCam(c, 0, 0.2, 0);
    const b = toCam(c, 0, C.FIELD.moundY, 2.35);
    const va = a.u / a.d;
    const vb = b.u / b.d;
    const fFit = (0.72 * H) / (vb - va);
    c.f = Math.min(fFit, W * 2.6);
    c.cx = W / 2;
    if (c.f < fFit - 0.5) {
      const z = toCam(c, 0, 0, 0.77);
      c.cy = 0.6 * H + (c.f * z.u) / z.d;
    } else {
      c.cy = 0.92 * H + c.f * va;
    }
    return c;
  }

  // 全場視角：本壘後上方俯瞰，直式螢幕會拉得更高更陡
  function setupFieldCam() {
    const t = clamp((W / H - 0.65) / (1.75 - 0.65), 0, 1);
    const py = lerp(-18, -46, t);
    const pz = lerp(92, 38, t);
    const lookY = lerp(50, 60, t);
    const c = makeCam(0, py, pz, Math.atan2(pz, lookY - py) / DEG);
    const pts = [[0, -6, 0], [-14, 6, 0], [14, 6, 0]];
    for (let a = -45; a <= 45; a += 5) {
      const r = C.fenceDistance(a);
      pts.push([r * Math.sin(a * DEG), r * Math.cos(a * DEG), 0], [r * Math.sin(a * DEG), r * Math.cos(a * DEG), 9]);
    }
    fitCam(c, pts, { x0: 10, y0: 8, x1: W - 10, y1: H - 10 });
    return c;
  }

  function buildLayer(draw) {
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(W * DPR));
    cv.height = Math.max(1, Math.round(H * DPR));
    const g = cv.getContext('2d');
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    draw(g);
    return cv;
  }

  function resize() {
    needResize = false;
    const r = el.stage.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (w === W && h === H && dpr === DPR && !layersDirty) return;
    W = w;
    H = h;
    DPR = dpr;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    batCam = setupBatCam();
    fieldCam = setupFieldCam();
    batLayer = buildLayer((g) => drawStadium(g, batCam, 'bat'));
    fieldLayer = buildLayer((g) => drawStadium(g, fieldCam, 'field'));
    layersDirty = false;
  }

  // ───────── 球場（靜態背景，只在尺寸改變時重畫） ─────────
  const TOWERS = [
    [-75, 118],
    [75, 118],
    [-108, 52],
    [108, 52],
  ];

  function standsRing() {
    // 看台內緣：左邊界外、外野全壘打牆、右邊界外
    const pts = [];
    const side = (sgn, s) => ({ x: sgn * (s + 12) * Math.SQRT1_2, y: (s - 12) * Math.SQRT1_2, h: 1.4 });
    for (let s = 18; s <= 90; s += 8) pts.push(side(-1, s));
    for (let a = -45; a <= 45; a += 3) {
      const r = C.fenceDistance(a) + 0.4;
      pts.push({ x: r * Math.sin(a * DEG), y: r * Math.cos(a * DEG), h: C.FIELD.fenceHeight });
    }
    for (let s = 90; s >= 18; s -= 8) pts.push(side(1, s));
    // 本壘後方的看台（打擊視角在相機後面，看不到）
    for (const [x, y] of [[16, -9], [8, -16], [0, -18], [-8, -16], [-16, -9]]) pts.push({ x, y, h: 1.4 });
    pts.push(pts[0]);
    return pts;
  }

  function fenceArc(inset) {
    const pts = [];
    for (let a = -45; a <= 45; a += 3) {
      const r = C.fenceDistance(a) - (inset || 0);
      pts.push([r * Math.sin(a * DEG), r * Math.cos(a * DEG), 0]);
    }
    return pts;
  }

  function drawStadium(g, c, view) {
    const rnd = C.makeRng(20260927);
    const hy = c.cy - c.f * (c.sin / c.cos);
    const sky = g.createLinearGradient(0, hy - H, 0, hy);
    sky.addColorStop(0, '#02050f');
    sky.addColorStop(0.72, '#0b1733');
    sky.addColorStop(1, '#1c3263');
    g.fillStyle = sky;
    g.fillRect(0, 0, W, H);
    if (hy < H) {
      g.fillStyle = '#0a1228';
      g.fillRect(0, Math.max(0, hy), W, H - Math.max(0, hy));
    }
    g.fillStyle = 'rgba(255, 255, 255, 0.5)';
    for (let i = 0; i < 90; i++) {
      const x = rnd() * W;
      const y = rnd() * (hy - 20);
      if (y > 0) g.fillRect(x, y, 1.3, 1.3);
    }
    drawTowers(g, c);
    drawStands(g, c, rnd, view);
    drawWall(g, c);
    drawGround(g, c, view);

    // 燈光從兩側灑下來
    g.save();
    g.globalCompositeOperation = 'lighter';
    for (const s of [-1, 1]) {
      const x = W / 2 + s * W * 0.45;
      const y = Math.min(hy - 60, H * 0.02);
      const rad = Math.max(W, H) * 0.55;
      const glow = g.createRadialGradient(x, y, 0, x, y, rad);
      glow.addColorStop(0, 'rgba(255, 244, 214, 0.16)');
      glow.addColorStop(1, 'rgba(255, 244, 214, 0)');
      g.fillStyle = glow;
      g.fillRect(0, 0, W, H);
    }
    g.restore();
    const vig = g.createRadialGradient(W / 2, H * 0.55, Math.min(W, H) * 0.35, W / 2, H * 0.55, Math.max(W, H) * 0.8);
    vig.addColorStop(0, 'rgba(0, 0, 0, 0)');
    vig.addColorStop(1, 'rgba(0, 0, 0, 0.35)');
    g.fillStyle = vig;
    g.fillRect(0, 0, W, H);
  }

  function drawTowers(g, c) {
    for (const [x, y] of TOWERS) {
      const base = proj(c, x, y, 0);
      const top = proj(c, x, y, 42);
      if (!base || !top) continue;
      g.strokeStyle = '#0a1122';
      g.lineWidth = Math.max(1, 0.8 * top.s);
      g.beginPath();
      g.moveTo(base.x, base.y);
      g.lineTo(top.x, top.y);
      g.stroke();
      const rad = Math.max(30, 45 * top.s);
      const glow = g.createRadialGradient(top.x, top.y, 0, top.x, top.y, rad);
      glow.addColorStop(0, 'rgba(255, 248, 225, 0.55)');
      glow.addColorStop(1, 'rgba(255, 248, 225, 0)');
      g.fillStyle = glow;
      g.fillRect(top.x - rad, top.y - rad, rad * 2, rad * 2);
      const w = 14 * top.s;
      const h = 6 * top.s;
      g.fillStyle = '#fff4d6';
      g.fillRect(top.x - w / 2, top.y - h, w, h);
      g.fillStyle = 'rgba(255, 200, 110, 0.85)';
      for (let i = 0; i < 6; i++) {
        for (let j = 0; j < 3; j++) g.fillRect(top.x - w / 2 + (i + 0.2) * (w / 6), top.y - h + (j + 0.2) * (h / 3), (w / 6) * 0.6, (h / 3) * 0.6);
      }
    }
  }

  // 看台底色：一小塊觀眾花紋重複鋪滿
  let crowdTile = null;
  const CROWD = ['#d9d2bf', '#8fa0bf', '#e08d6a', '#6d90d4', '#e7c870', '#b9b9b9', '#9a7e62', '#d96b6b', '#7fc0a0'];
  function crowdPattern(g) {
    if (!crowdTile) {
      crowdTile = document.createElement('canvas');
      crowdTile.width = 48;
      crowdTile.height = 48;
      const t = crowdTile.getContext('2d');
      const rnd = C.makeRng(99);
      t.fillStyle = COL.stands;
      t.fillRect(0, 0, 48, 48);
      for (let row = 0; row < 8; row++) {
        for (let i = 0; i < 12; i++) {
          const x = i * 4 + (row % 2) * 2 + rnd() * 1.2;
          const y = row * 6 + rnd() * 1.5;
          const a = 0.3 + rnd() * 0.45;
          t.globalAlpha = a;
          t.fillStyle = CROWD[Math.floor(rnd() * CROWD.length)];
          t.fillRect(x, y + 1.6, 2.4, 3);
          t.globalAlpha = a * 0.8;
          t.fillStyle = COL.skin;
          t.fillRect(x + 0.5, y, 1.4, 1.4);
        }
      }
    }
    return g.createPattern(crowdTile, 'repeat');
  }

  function drawStands(g, c, rnd, view) {
    const ring = standsRing();
    const DEPTH = 42;
    const TOP = 24;
    // 每個點取相鄰兩段的平均法線，相鄰看台共用邊線才不會露出縫隙（看台是一圈，頭尾相接）
    const m = ring.length - 1;
    const normals = ring.map((p, i) => {
      let nx = 0;
      let ny = 0;
      const u = i % m;
      for (const [a, b] of [
        [ring[(u - 1 + m) % m], p],
        [p, ring[(u + 1) % m]],
      ]) {
        if (a === b) continue;
        let x = b.y - a.y;
        let y = -(b.x - a.x);
        const len = Math.hypot(x, y) || 1;
        x /= len;
        y /= len;
        if (x * (a.x + b.x) / 2 + y * ((a.y + b.y) / 2 - 45) < 0) {
          x = -x;
          y = -y;
        }
        nx += x;
        ny += y;
      }
      const len = Math.hypot(nx, ny) || 1;
      return [nx / len, ny / len];
    });
    const at = (i, t) => [ring[i].x + normals[i][0] * DEPTH * t, ring[i].y + normals[i][1] * DEPTH * t, lerp(ring[i].h, TOP, t)];
    const quads = [];
    for (let i = 0; i < ring.length - 1; i++) {
      const m = at(i, 0.5);
      const n = at(i + 1, 0.5);
      quads.push({ i, d: toCam(c, (m[0] + n[0]) / 2, (m[1] + n[1]) / 2, 10).d });
    }
    quads.sort((p, q) => q.d - p.d);
    const pattern = crowdPattern(g);
    const density = view === 'bat' ? 1 / 70 : 1 / 140;
    for (const { i } of quads) {
      for (let k = 0; k < 6; k++) {
        const quad = [at(i, k / 6), at(i + 1, k / 6), at(i + 1, (k + 1) / 6), at(i, (k + 1) / 6)];
        if (!pathPoly(g, c, quad)) continue;
        g.fillStyle = pattern;
        g.fill();
        g.lineWidth = 1;
        g.strokeStyle = pattern;
        g.stroke();
        if (k % 2) {
          g.fillStyle = 'rgba(2, 6, 18, 0.28)';
          g.fill();
        }
      }
      const perQuad = Math.round(clamp(polyArea(projPoly(c, [at(i, 0), at(i + 1, 0), at(i + 1, 1), at(i, 1)])) * density, 6, 300));
      for (let n = 0; n < perQuad; n++) {
        const u = rnd();
        const t = 0.02 + rnd() * 0.96;
        const p0 = at(i, t);
        const p1 = at(i + 1, t);
        const p = proj(c, lerp(p0[0], p1[0], u), lerp(p0[1], p1[1], u), lerp(p0[2], p1[2], u) + 0.4);
        const color = CROWD[Math.floor(rnd() * CROWD.length)];
        const alpha = 0.5 + rnd() * 0.4;
        if (!p) continue;
        const sz = clamp(0.5 * p.s, 1, 5);
        g.globalAlpha = alpha;
        g.fillStyle = color;
        g.fillRect(p.x - sz / 2, p.y - sz, sz, sz * 1.2);
      }
      g.globalAlpha = 1;
    }
  }

  function polyArea(pts) {
    let sum = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      sum += p[0] * q[1] - q[0] * p[1];
    }
    return Math.abs(sum) / 2;
  }

  function drawWall(g, c) {
    const top = C.FIELD.fenceHeight;
    for (let a = -45; a < 45; a += 3) {
      const r0 = C.fenceDistance(a);
      const r1 = C.fenceDistance(a + 3);
      const x0 = r0 * Math.sin(a * DEG);
      const y0 = r0 * Math.cos(a * DEG);
      const x1 = r1 * Math.sin((a + 3) * DEG);
      const y1 = r1 * Math.cos((a + 3) * DEG);
      fillPoly(g, c, [[x0, y0, 0], [x1, y1, 0], [x1, y1, top], [x0, y0, top]], COL.wall);
      fillPoly(g, c, [[x0, y0, top - 0.2], [x1, y1, top - 0.2], [x1, y1, top], [x0, y0, top]], COL.wallTop);
    }
    // 全壘打牆上的距離（公尺）
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const a of [-45, -22, 0, 22, 45]) {
      const r = C.fenceDistance(a) - 0.1;
      const p = proj(c, r * Math.sin(a * DEG), r * Math.cos(a * DEG), top * 0.52);
      if (!p || 1.5 * p.s < 7) continue;
      g.font = `800 ${Math.round(1.5 * p.s)}px ${NUM_FONT}`;
      g.fillStyle = 'rgba(241, 234, 211, 0.88)';
      g.fillText(`${Math.round(C.fenceDistance(a))}M`, p.x, p.y);
    }
    // 界外標竿
    for (const s of [-1, 1]) {
      const r = C.fenceDistance(45);
      const a = proj(c, s * r * Math.SQRT1_2, r * Math.SQRT1_2, 0);
      const b = proj(c, s * r * Math.SQRT1_2, r * Math.SQRT1_2, 22);
      if (!a || !b) continue;
      g.strokeStyle = COL.wallTop;
      g.lineWidth = Math.max(1.5, 0.35 * b.s);
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke();
    }
  }

  function circlePts(x, y, r, z) {
    const pts = [];
    for (let k = 0; k < 32; k++) {
      const a = (k / 32) * Math.PI * 2;
      pts.push([x + r * Math.cos(a), y + r * Math.sin(a), z || 0]);
    }
    return pts;
  }

  function drawGround(g, c, view) {
    const ring = standsRing();
    const field = ring.slice(0, -1).map((p) => [p.x, p.y, 0]);
    fillPoly(g, c, field, COL.grass);

    // 草皮修剪條紋
    g.save();
    if (pathPoly(g, c, field)) {
      g.clip();
      for (let y = -12; y < 130; y += 12) fillPoly(g, c, [[-160, y, 0], [160, y, 0], [160, y + 6, 0], [-160, y + 6, 0]], COL.grass2);
    }
    g.restore();

    // 警告區（牆前的紅土帶）
    fillPoly(g, c, fenceArc(0).concat(fenceArc(4.5).reverse()), COL.track);

    // 內野紅土
    const dirt = [[0, 0, 0], [27.5, 27.5, 0]];
    const a0 = Math.atan2(27.5, 27.5 - C.FIELD.moundY);
    for (let k = 1; k < 24; k++) {
      const a = lerp(a0, -a0, k / 24);
      dirt.push([29 * Math.sin(a), C.FIELD.moundY + 29 * Math.cos(a), 0]);
    }
    dirt.push([-27.5, 27.5, 0]);
    fillPoly(g, c, dirt, COL.dirt);
    fillPoly(g, c, [[0, 1.6, 0], [17.8, 19.4, 0], [0, 37.2, 0], [-17.8, 19.4, 0]], COL.grass);
    g.save();
    if (pathPoly(g, c, [[0, 1.6, 0], [17.8, 19.4, 0], [0, 37.2, 0], [-17.8, 19.4, 0]])) {
      g.clip();
      for (let y = 0; y < 40; y += 12) fillPoly(g, c, [[-30, y, 0], [30, y, 0], [30, y + 6, 0], [-30, y + 6, 0]], COL.grass2);
    }
    g.restore();
    fillPoly(g, c, circlePts(0, 0, 4), COL.dirt);
    for (const b of [1, 2, 3]) fillPoly(g, c, circlePts(C.BASES[b].x, C.BASES[b].y, 2.6), COL.dirt);
    fillPoly(g, c, circlePts(0, C.FIELD.moundY, 2.74, 0.08), COL.dirt2);

    // 白線
    const lineQuad = (x0, y0, x1, y1, w) => {
      const dx = x1 - x0;
      const dy = y1 - y0;
      const l = Math.hypot(dx, dy);
      const nx = (-dy / l) * (w / 2);
      const ny = (dx / l) * (w / 2);
      fillPoly(g, c, [[x0 + nx, y0 + ny, 0.01], [x1 + nx, y1 + ny, 0.01], [x1 - nx, y1 - ny, 0.01], [x0 - nx, y0 - ny, 0.01]], COL.chalk);
    };
    const pole = C.fenceDistance(45) * Math.SQRT1_2;
    const lw = view === 'field' ? 0.4 : 0.1;
    lineQuad(0.25, 0.25, pole, pole, lw);
    lineQuad(-0.25, 0.25, -pole, pole, lw);
    if (view === 'bat') {
      g.strokeStyle = COL.chalk;
      for (const s of [-1, 1]) {
        if (pathPoly(g, c, [[s * 0.37, -0.9, 0.01], [s * 1.59, -0.9, 0.01], [s * 1.59, 0.93, 0.01], [s * 0.37, 0.93, 0.01]])) {
          const p = proj(c, s * 0.9, 0, 0);
          g.lineWidth = p ? Math.max(1, 0.05 * p.s) : 1;
          g.stroke();
        }
      }
    }
    fillPoly(g, c, [[-0.216, 0.2, 0.02], [0.216, 0.2, 0.02], [0.216, -0.016, 0.02], [0, -0.232, 0.02], [-0.216, -0.016, 0.02]], '#f7f4ea');
    const bs = view === 'field' ? 0.7 : 0.27;
    for (const b of [1, 2, 3]) {
      const { x, y } = C.BASES[b];
      fillPoly(g, c, [[x, y - bs, 0.05], [x + bs, y, 0.05], [x, y + bs, 0.05], [x - bs, y, 0.05]], '#f7f4ea');
    }
    fillPoly(g, c, [[-0.3, C.FIELD.moundY - 0.08, 0.2], [0.3, C.FIELD.moundY - 0.08, 0.2], [0.3, C.FIELD.moundY + 0.08, 0.2], [-0.3, C.FIELD.moundY + 0.08, 0.2]], '#f7f4ea');
  }

  // ───────── 人物 ─────────
  const V3 = (x, y, z) => [x, y, z];
  const vlerp = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  const norm = (v) => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };

  function roundRectPath(g, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + rr, y);
    g.arcTo(x + w, y, x + w, y + h, rr);
    g.arcTo(x + w, y + h, x, y + h, rr);
    g.arcTo(x, y + h, x, y, rr);
    g.arcTo(x, y, x + w, y, rr);
    g.closePath();
  }

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  // 依關節畫出一個人（關節是世界座標）
  function drawFigure(g, c, J, look) {
    const P = {};
    const J2 = Object.assign({}, J);
    const sh = [J.ls[0] - J.rs[0], J.ls[1] - J.rs[1], J.ls[2] - J.rs[2]];
    J2.hl = [J.hip[0] + sh[0] * 0.42, J.hip[1] + sh[1] * 0.42, J.hip[2] + sh[2] * 0.42];
    J2.hr = [J.hip[0] - sh[0] * 0.42, J.hip[1] - sh[1] * 0.42, J.hip[2] - sh[2] * 0.42];
    const eo = look.elbow || { l: [0, 0, -0.12], r: [0, 0, -0.12] };
    const elbow = (a, b, o) => [(J[a][0] + J[b][0]) / 2 + o[0], (J[a][1] + J[b][1]) / 2 + o[1], (J[a][2] + J[b][2]) / 2 + o[2]];
    J2.le = elbow('ls', 'lh', eo.l);
    J2.re = elbow('rs', 'rh', eo.r);
    for (const k in J2) {
      const p = proj(c, J2[k][0], J2[k][1], J2[k][2]);
      if (!p) return;
      P[k] = p;
    }
    const k = P.hip.s;
    const w = (m) => Math.max(1.2, m * k);
    const ink = 'rgba(4, 8, 16, 0.6)';
    const seg = (pts, width, color) => {
      g.strokeStyle = color;
      g.lineWidth = width;
      g.beginPath();
      g.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
      g.stroke();
    };
    const limb = (pts, m, color) => {
      seg(pts, w(m) + 2.4, ink);
      seg(pts, w(m), color);
    };
    g.lineCap = 'round';
    g.lineJoin = 'round';
    limb([P.hl, P.lk, P.lf], 0.15, look.pants);
    limb([P.hr, P.rk, P.rf], 0.15, look.pants);
    for (const f of ['lf', 'rf']) {
      g.fillStyle = COL.shoe;
      g.beginPath();
      g.ellipse(P[f].x, P[f].y, w(0.09), w(0.05), 0, 0, Math.PI * 2);
      g.fill();
    }
    // 軀幹
    const torso = [P.ls, P.rs, P.hr, P.hl];
    g.beginPath();
    g.moveTo(torso[0].x, torso[0].y);
    for (let i = 1; i < 4; i++) g.lineTo(torso[i].x, torso[i].y);
    g.closePath();
    g.lineWidth = w(0.14) + 2.4;
    g.strokeStyle = ink;
    g.stroke();
    g.fillStyle = look.jersey;
    g.lineWidth = w(0.14);
    g.strokeStyle = look.jersey;
    g.fill();
    g.stroke();
    seg([P.hl, P.hr], Math.max(1.5, w(0.05)), 'rgba(10, 14, 24, 0.7)');
    if (look.number && k > 60) {
      const cx = (P.ls.x + P.rs.x + P.hl.x + P.hr.x) / 4;
      const cy = (P.ls.y + P.rs.y + P.hl.y + P.hr.y) / 4 - (P.hl.y - P.ls.y) * 0.08;
      g.font = `900 ${Math.round(0.3 * k)}px ${NUM_FONT}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineWidth = Math.max(2, 0.03 * k);
      g.strokeStyle = look.cap;
      g.strokeText(look.number, cx, cy);
      g.fillStyle = '#f7f4ea';
      g.fillText(look.number, cx, cy);
    }
    // 手臂
    limb([P.rs, P.re, P.rh], 0.1, look.jersey);
    limb([P.ls, P.le, P.lh], 0.1, look.jersey);
    g.fillStyle = look.glove ? COL.glove : look.gloves || COL.skin;
    g.beginPath();
    g.arc(P.lh.x, P.lh.y, look.glove ? w(0.1) : w(0.055), 0, Math.PI * 2);
    g.fill();
    g.fillStyle = look.gloves || COL.skin;
    g.beginPath();
    g.arc(P.rh.x, P.rh.y, w(0.055), 0, Math.PI * 2);
    g.fill();
    // 頭與帽子／頭盔
    const hr = Math.max(2, 0.115 * P.head.s);
    const neck = { x: (P.ls.x + P.rs.x) / 2, y: (P.ls.y + P.rs.y) / 2 };
    seg([neck, P.head], Math.max(1.5, 0.1 * P.head.s), COL.skin);
    g.fillStyle = ink;
    g.beginPath();
    g.arc(P.head.x, P.head.y, hr + 1.2, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = COL.skin;
    g.beginPath();
    g.arc(P.head.x, P.head.y, hr, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = look.cap;
    g.beginPath();
    g.arc(P.head.x, P.head.y - hr * 0.08, hr * (look.helmet ? 1.14 : 1.04), Math.PI * 1.02, Math.PI * 1.98);
    g.closePath();
    g.fill();
    if (look.helmet) {
      g.beginPath();
      g.arc(P.head.x, P.head.y, hr * 1.1, Math.PI * 0.9, Math.PI * 2.1);
      g.fill();
      g.beginPath();
      g.ellipse(P.head.x + hr * 0.4, P.head.y + hr * 0.15, hr * 0.45, hr * 0.55, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = 'rgba(255, 255, 255, 0.18)';
      g.beginPath();
      g.ellipse(P.head.x - hr * 0.35, P.head.y - hr * 0.55, hr * 0.35, hr * 0.18, -0.4, 0, Math.PI * 2);
      g.fill();
    }
  }

  // 打者（右打，站在本壘板左側、面向 +x）
  const BAT_BASE = { x: -0.92, y: 0.05 };
  const STANCE = {
    lf: V3(0.02, 0.4, 0),
    rf: V3(-0.04, -0.36, 0),
    lk: V3(0.1, 0.33, 0.47),
    rk: V3(0.07, -0.28, 0.47),
    hip: V3(0, 0.02, 0.9),
    neck: V3(0.04, -0.02, 1.42),
    ls: V3(0.06, 0.17, 1.38),
    rs: V3(0, -0.2, 1.4),
    head: V3(0.08, -0.03, 1.6),
  };
  const LOADED = {
    lf: V3(0.02, 0.6, 0),
    rf: V3(-0.02, -0.34, 0.03),
    lk: V3(0.14, 0.5, 0.48),
    rk: V3(0.12, -0.22, 0.42),
    hip: V3(0.06, 0.1, 0.86),
    neck: V3(0.1, 0.06, 1.36),
    ls: V3(0.14, 0.24, 1.32),
    rs: V3(0.18, -0.1, 1.33),
    head: V3(0.1, 0.07, 1.56),
  };
  const toBat = (v) => [BAT_BASE.x + v[0], BAT_BASE.y + v[1], v[2]];

  function batterRig(swing, now) {
    let hands;
    let dir;
    let bu = 0;
    if (!swing) {
      const bob = Math.sin(now * 2.2) * 0.04;
      hands = toBat([0.12, -0.24, 1.27 + bob * 0.3]);
      dir = norm([-0.3, -0.52 + bob, 0.72]);
    } else {
      const t = swing.t;
      const lag = C.SWING.lag;
      const dC = norm([1, 0.1, -0.06]);
      const cp = [swing.cursor.x, 0.3, swing.cursor.z];
      const keys = [
        { t: 0, h: toBat([0.12, -0.24, 1.27]), d: norm([-0.3, -0.52, 0.72]) },
        { t: lag, h: [cp[0] - 0.62 * dC[0], cp[1] - 0.62 * dC[1], cp[2] - 0.62 * dC[2]], d: dC },
        { t: lag + 0.12, h: toBat([0.25, 0.32, 1.35]), d: norm([-0.3, 0.8, 0.3]) },
        { t: lag + 0.26, h: toBat([0.05, 0.12, 1.5]), d: norm([-0.75, 0.1, 0.55]) },
      ];
      let i = 0;
      while (i < keys.length - 2 && t > keys[i + 1].t) i++;
      const a = keys[i];
      const b = keys[i + 1];
      const u = clamp((t - a.t) / (b.t - a.t), 0, 1);
      const e = i === 0 ? u * u : smooth(u);
      hands = vlerp(a.h, b.h, e);
      dir = norm(vlerp(a.d, b.d, e));
      bu = smooth(clamp(t / lag, 0, 1));
    }
    const J = {};
    for (const k in STANCE) J[k] = toBat(vlerp(STANCE[k], LOADED[k], bu));
    J.lh = hands;
    J.rh = hands;
    return { J, hands, tip: [hands[0] + dir[0] * 0.86, hands[1] + dir[1] * 0.86, hands[2] + dir[2] * 0.86] };
  }

  function drawBat(g, c, hands, tip) {
    const a = proj(c, hands[0], hands[1], hands[2]);
    const b = proj(c, tip[0], tip[1], tip[2]);
    if (!a || !b) return;
    const w0 = Math.max(1.5, 0.035 * a.s);
    const w1 = Math.max(2.5, 0.068 * b.s);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l = Math.hypot(dx, dy) || 1;
    const nx = -dy / l;
    const ny = dx / l;
    g.beginPath();
    g.moveTo(a.x + (nx * w0) / 2, a.y + (ny * w0) / 2);
    g.lineTo(b.x + (nx * w1) / 2, b.y + (ny * w1) / 2);
    g.lineTo(b.x - (nx * w1) / 2, b.y - (ny * w1) / 2);
    g.lineTo(a.x - (nx * w0) / 2, a.y - (ny * w0) / 2);
    g.closePath();
    g.fillStyle = COL.bat;
    g.strokeStyle = 'rgba(40, 22, 6, 0.75)';
    g.lineWidth = 1;
    g.fill();
    g.stroke();
  }

  // 投手（面向本壘，從捕手看右手在畫面左邊）
  const MOUND = { x: 0, y: 18.3, z: 0.25 };
  const P_SET = {
    lf: V3(0.14, 0.05, 0),
    rf: V3(-0.14, 0.05, 0),
    lk: V3(0.13, 0, 0.48),
    rk: V3(-0.13, 0, 0.48),
    hip: V3(0, 0, 0.93),
    neck: V3(0, 0, 1.45),
    ls: V3(0.2, 0, 1.42),
    rs: V3(-0.2, 0, 1.42),
    head: V3(0, 0, 1.64),
    lh: V3(0.04, -0.2, 1.2),
    rh: V3(-0.03, -0.18, 1.18),
  };
  const P_LIFT = Object.assign({}, P_SET, {
    lf: V3(0.08, -0.05, 0.55),
    lk: V3(0.1, -0.25, 0.9),
    rk: V3(-0.12, 0.02, 0.5),
    hip: V3(0, 0.03, 0.95),
    neck: V3(0, 0.05, 1.47),
    head: V3(0, 0.06, 1.66),
    lh: V3(0.02, -0.15, 1.3),
    rh: V3(-0.02, -0.15, 1.3),
  });
  const P_COCK = {
    lf: V3(0.22, -0.8, 0),
    lk: V3(0.2, -0.62, 0.45),
    rf: V3(-0.14, 0.05, 0),
    rk: V3(-0.1, -0.15, 0.42),
    hip: V3(0.03, -0.35, 0.82),
    neck: V3(0.02, -0.45, 1.33),
    head: V3(0.02, -0.5, 1.53),
    rs: V3(-0.2, -0.42, 1.32),
    ls: V3(0.22, -0.5, 1.32),
    rh: V3(-0.6, -0.1, 1.62),
    lh: V3(0.45, -0.8, 1.3),
  };
  const P_REL = {
    lf: V3(0.22, -0.8, 0),
    lk: V3(0.2, -0.75, 0.45),
    rf: V3(-0.12, -0.1, 0.1),
    rk: V3(-0.1, -0.4, 0.4),
    hip: V3(0.02, -0.55, 0.8),
    neck: V3(-0.05, -0.8, 1.3),
    head: V3(-0.06, -0.9, 1.48),
    rs: V3(-0.25, -0.75, 1.3),
    ls: V3(0.18, -0.7, 1.28),
    rh: V3(C.RELEASE.x - MOUND.x, C.RELEASE.y - MOUND.y, C.RELEASE.z - MOUND.z),
    lh: V3(0.3, -0.7, 1.05),
  };
  const P_FOLLOW = Object.assign({}, P_REL, {
    rh: V3(0.3, -1.0, 0.75),
    rf: V3(-0.15, -0.5, 0.45),
    rk: V3(-0.12, -0.6, 0.55),
    head: V3(0, -0.95, 1.4),
    neck: V3(0, -0.85, 1.25),
  });
  const toMound = (v) => [MOUND.x + v[0], MOUND.y + v[1], MOUND.z + v[2]];

  function blendPose(a, b, t) {
    const J = {};
    for (const k in a) J[k] = toMound(vlerp(a[k], b[k], t));
    return J;
  }

  function pitcherRig(now) {
    if (G.phase === 'windup') {
      const w = G.t / WINDUP;
      if (w < 0.4) return blendPose(P_SET, P_LIFT, smooth(w / 0.4));
      if (w < 0.78) return blendPose(P_LIFT, P_COCK, smooth((w - 0.4) / 0.38));
      return blendPose(P_COCK, P_REL, smooth((w - 0.78) / 0.22));
    }
    if (G.phase === 'pitch' || G.phase === 'hit' || G.phase === 'foul' || (G.phase === 'wait' && G.pitch)) {
      const since = G.phase === 'pitch' ? G.t : 1;
      return blendPose(P_REL, P_FOLLOW, smooth(clamp(since / 0.45, 0, 1)));
    }
    const J = blendPose(P_SET, P_SET, 0);
    const breath = Math.sin(now * 1.6) * 0.012;
    for (const k of ['neck', 'head', 'ls', 'rs', 'lh', 'rh']) J[k][2] += breath;
    return J;
  }

  // 全場視角的小人
  function drawMini(g, c, x, y, color, cap, running, phase) {
    const f = proj(c, x, y, 0);
    const h = proj(c, x, y, 1.85);
    if (!f || !h) return;
    const height = Math.max(12, f.y - h.y);
    const top = f.y - height;
    const bw = height * 0.32;
    g.fillStyle = 'rgba(0, 0, 0, 0.28)';
    g.beginPath();
    g.ellipse(f.x, f.y, bw * 0.9, bw * 0.28, 0, 0, Math.PI * 2);
    g.fill();
    const swing = running ? Math.sin(phase) * bw * 0.55 : bw * 0.22;
    g.strokeStyle = COL.pants;
    g.lineCap = 'round';
    g.lineWidth = Math.max(1.6, bw * 0.34);
    g.beginPath();
    g.moveTo(f.x, top + height * 0.55);
    g.lineTo(f.x - swing, f.y);
    g.moveTo(f.x, top + height * 0.55);
    g.lineTo(f.x + swing, f.y);
    g.stroke();
    g.fillStyle = 'rgba(4, 8, 16, 0.6)';
    roundRectPath(g, f.x - bw / 2 - 1, top + height * 0.2 - 1, bw + 2, height * 0.42 + 2, bw * 0.35);
    g.fill();
    g.fillStyle = color;
    roundRectPath(g, f.x - bw / 2, top + height * 0.2, bw, height * 0.42, bw * 0.3);
    g.fill();
    g.fillStyle = COL.skin;
    g.beginPath();
    g.arc(f.x, top + height * 0.12, height * 0.11, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = cap;
    g.beginPath();
    g.arc(f.x, top + height * 0.1, height * 0.115, Math.PI, 0);
    g.fill();
  }

  function drawBall(g, c, x, y, z, o) {
    const p = proj(c, x, y, z);
    if (!p) return null;
    const r = Math.max(o.min || 1.6, C.BALL_R * p.s * (o.scale || 1));
    if (o.shadow !== false) {
      const sh = proj(c, x, y, 0);
      if (sh) {
        g.fillStyle = `rgba(0, 0, 0, ${clamp(0.4 - z * 0.015, 0.08, 0.4)})`;
        g.beginPath();
        g.ellipse(sh.x, sh.y, r * 1.1, r * 0.4, 0, 0, Math.PI * 2);
        g.fill();
      }
    }
    if (o.glow) {
      g.fillStyle = 'rgba(255, 255, 240, 0.25)';
      g.beginPath();
      g.arc(p.x, p.y, r * 2, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = COL.ball;
    g.beginPath();
    g.arc(p.x, p.y, r, 0, Math.PI * 2);
    g.fill();
    if (r > 5) {
      g.strokeStyle = COL.seam;
      g.lineWidth = Math.max(1, r * 0.12);
      g.beginPath();
      g.arc(p.x - r * 0.9, p.y, r * 0.7, -0.9, 0.9);
      g.stroke();
      g.beginPath();
      g.arc(p.x + r * 0.9, p.y, r * 0.7, Math.PI - 0.9, Math.PI + 0.9);
      g.stroke();
    } else {
      g.strokeStyle = 'rgba(20, 20, 30, 0.45)';
      g.lineWidth = 1;
      g.stroke();
    }
    return { x: p.x, y: p.y, r };
  }

  // ───────── 遊戲狀態 ─────────
  const G = {
    screen: 'menu', // menu | play | over
    paused: false,
    cfg: null,
    s: null, // core.js 的比賽狀態
    phase: 'idle', // ready | aim | windup | pitch | hit | play | foul | wait | sim
    t: 0,
    view: 'bat',
    roles: null,
    teams: { bat: 0, field: 1 },
    pitch: null,
    pitchCmd: null,
    swing: null,
    outcome: null,
    contactDone: false,
    cpuPlan: null,
    play: null,
    playT: 0,
    foulBB: null,
    cursors: [
      { x: 0, z: 0.78 },
      { x: 0, z: 0.78 },
    ],
    aim: { type: 'FB', target: { x: 0, z: 0.78 } },
    marker: null,
    fx: [],
    sparks: [],
    fireworks: [],
    hrFx: false,
    shake: 0,
    slow: 1.85,
    meet: 1,
    cpuControl: 0.055,
    hiddenMode: false,
    readyDur: 1,
    waitDur: 0,
    next: null,
    frameNow: 0,
    rng: Math.random,
  };

  const teamNames = (cfg) => ((cfg || settings).players === 2 ? ['1P', '2P'] : ['1P', 'CPU']);
  const playerName = (p) => (p === 1 ? '2P' : '1P');
  const halfLabel = (s) => `第 ${s.inning} 局${s.half ? '下' : '上'}`;

  // 誰在打、誰在投
  function roles() {
    const s = G.s;
    const cfg = G.cfg;
    if (s.mode === 'derby') return { batter: { human: true, player: s.current }, pitcher: { human: false } };
    const human = (team) => cfg.players === 2 || team === 0;
    const bat = s.half;
    const fieldTeam = 1 - bat;
    return {
      batter: human(bat) ? { human: true, player: bat } : { human: false },
      pitcher: cfg.pitching === 'human' && human(fieldTeam) ? { human: true, player: fieldTeam } : { human: false },
    };
  }

  function sideTeams() {
    const s = G.s;
    if (!s) return { bat: 0, field: 1 };
    if (s.mode === 'derby') return { bat: s.current, field: 2 };
    return { bat: s.half, field: 1 - s.half };
  }

  // ───────── 比賽流程 ─────────
  function startMatch(saved) {
    readMenu();
    const cfg = saved ? saved.cfg : Object.assign({}, settings);
    G.cfg = cfg;
    G.s = saved ? saved.s : cfg.mode === 'derby' ? C.newDerby({ players: cfg.players }) : C.newGame({ innings: cfg.innings });
    const L = C.LEVELS[cfg.level] || C.LEVELS.normal;
    const derby = cfg.mode === 'derby';
    G.slow = derby ? L.slow + 0.15 : L.slow;
    G.meet = derby ? L.meet * 1.1 : L.meet;
    G.cpuControl = derby ? 0.04 : L.pitch.control;
    G.hiddenMode = !derby && cfg.players === 2 && cfg.pitching === 'human' && !touchUI;
    G.cursors = [
      { x: 0, z: 0.78 },
      { x: 0, z: 0.78 },
    ];
    G.aim = { type: 'FB', target: { x: 0, z: 0.78 } };
    G.marker = null;
    G.fx = [];
    G.sparks = [];
    G.fireworks = [];
    G.screen = 'play';
    G.paused = false;
    G.view = 'bat';
    G.play = null;
    G.pitch = null;
    G.roles = roles();
    G.teams = sideTeams();
    for (const o of [el.menu, el.over, el.pause, el.sim]) o.hidden = true;
    blurActive();
    renderBoard();
    el.matchup.hidden = false;
    updateControls();
    Sound.unlock();
    if (saved) return enterReady();
    Sound.organ(CHARGE, 0.12);
    showBanner({
      title: derby ? '全壘打大賽' : '比賽開始',
      sub: derby ? `${playerName(0)} 先上場，每人 ${G.s.pitches} 球` : `${teamNames(cfg)[0]} 先攻`,
      tone: 'change',
    });
    wait(1.7, () => {
      hideBanner();
      enterReady();
    });
  }

  function wait(dur, next) {
    G.phase = 'wait';
    G.t = 0;
    G.waitDur = dur;
    G.next = next;
    updateControls();
  }

  function enterReady() {
    if (G.s.over) return showGameOver();
    G.view = 'bat';
    G.play = null;
    G.phase = 'ready';
    G.t = 0;
    G.pitch = null;
    G.swing = null;
    G.outcome = null;
    G.cpuPlan = null;
    G.contactDone = false;
    G.pitchCmd = null;
    G.foulBB = null;
    G.hrFx = false;
    G.fx = G.fx.filter((f) => f.kind !== 'label');
    G.roles = roles();
    G.teams = sideTeams();
    const r = G.roles;
    if (!r.batter.human && !r.pitcher.human) return startSim();
    G.readyDur = r.pitcher.human ? 0.35 : 0.75 + G.rng() * 0.6;
    if (r.pitcher.human && G.hiddenMode) renderLegend();
    el.gun.hidden = true;
    renderBoard();
    updateControls();
  }

  function enterAim() {
    G.phase = 'aim';
    G.t = 0;
    if (G.hiddenMode) renderLegend();
    else selectType(G.aim.type);
    updateControls();
  }

  function cpuPick() {
    const derby = G.s.mode === 'derby';
    const ch = C.cpuChoosePitch(derby ? null : G.s, G.cfg.level, G.rng, { derby });
    G.pitchCmd = { type: ch.type, target: ch.target };
  }

  function enterWindup() {
    G.phase = 'windup';
    G.t = 0;
    updateControls();
  }

  function humanThrow() {
    if (G.phase !== 'aim') return;
    const r = G.roles;
    if (G.hiddenMode) {
      const d = dirOf(r.pitcher.player);
      const type = d.up ? 'FB' : d.right ? 'SL' : d.down ? 'CB' : d.left ? 'CH' : 'FB';
      G.pitchCmd = { type, target: null, hidden: true };
    } else {
      G.pitchCmd = { type: G.aim.type, target: { x: G.aim.target.x, z: G.aim.target.z } };
    }
    enterWindup();
  }

  function release() {
    const cmd = G.pitchCmd;
    let target = cmd.target;
    if (cmd.hidden) {
      // 雙人鍵盤對戰：出手瞬間按住的方向決定九宮格位置
      const d = dirOf(G.roles.pitcher.player);
      target = C.gridTarget((d.right ? 1 : 0) - (d.left ? 1 : 0), (d.up ? 1 : 0) - (d.down ? 1 : 0));
    }
    G.pitch = C.createPitch({
      type: cmd.type,
      target,
      slow: G.slow,
      control: G.roles.pitcher.human ? HUMAN_CONTROL : G.cpuControl,
      rng: G.rng,
    });
    G.phase = 'pitch';
    G.t = 0;
    G.swing = null;
    G.outcome = null;
    G.contactDone = false;
    G.marker = null;
    G.cpuPlan = G.roles.batter.human ? null : C.cpuBatterPlan(G.pitch, G.s, G.cfg.level, G.rng);
    Sound.whoosh(0.05);
    updateControls();
  }

  function doSwing(cursor, time, human) {
    G.swing = { time, cursor: { x: cursor.x, z: cursor.z }, human };
    G.contactDone = false;
    G.outcome = C.resolvePitch(G.s, G.pitch, { swingTime: time, cursor: G.swing.cursor }, { meet: human ? G.meet : 1, rng: G.rng });
    Sound.whoosh(0.12);
  }

  function swingNow() {
    if (G.phase !== 'pitch' || G.swing) return;
    const r = G.roles;
    const t = G.t + Math.max(0, (performance.now() - G.frameNow) / 1000);
    doSwing(G.cursors[r.batter.player], t, true);
  }

  function updatePitch() {
    const p = G.pitch;
    if (G.cpuPlan && !G.swing && G.t >= G.cpuPlan.swingTime) doSwing(G.cpuPlan.cursor, G.cpuPlan.swingTime, false);
    if (G.swing && !G.contactDone && G.t >= G.swing.time + C.SWING.lag) {
      G.contactDone = true;
      const sw = G.outcome.swing;
      if (sw && sw.contact) {
        showTiming(sw);
        if (G.outcome.type === 'foul') return startFoul();
        if (G.outcome.type === 'inplay') return startHit();
      } else if (G.swing.human) {
        showTiming(sw);
      }
    }
    if (G.t >= p.T + 0.14) {
      Sound.mitt();
      const end = proj(batCam, p.end.x, -0.6, p.end.z);
      if (end) G.fx.push({ kind: 'pop', x: end.x, y: end.y, age: 0, life: 0.25 });
      if (!G.outcome) G.outcome = C.resolvePitch(G.s, p, null, { rng: G.rng });
      callPitch();
    }
  }

  function showTiming(sw) {
    if (!sw || !G.swing || !G.swing.human) return;
    const p = proj(batCam, G.swing.cursor.x, 0, G.swing.cursor.z);
    if (!p) return;
    let text;
    let color = COL.chalk;
    if (sw.contact && sw.timingLabel === 'perfect') {
      text = '完美！';
      color = COL.amber;
    } else if (sw.contact) {
      text = sw.timingLabel === 'early' ? '稍早' : '稍晚';
    } else if (Math.abs(sw.timing) > C.SWING.window) {
      text = sw.timing < 0 ? '太早了' : '太晚了';
    } else {
      text = sw.dz > 0 ? '揮在球下方' : '揮在球上方';
      if (Math.abs(sw.dx) > Math.abs(sw.dz)) text = '沒對準';
    }
    G.fx.push({ kind: 'label', text, color, x: p.x, y: p.y - C.SWING.rz * G.meet * p.s - 16, age: 0, life: 0.95 });
  }

  function startFoul() {
    const sw = G.outcome.swing;
    G.foulBB = C.simulateBattedBall(sw.ev, sw.la, sw.spray);
    G.phase = 'foul';
    G.playT = 0;
    Sound.crack(0.25);
    burstAtContact(0.3);
    flash(sw.tip ? '擦棒界外' : '界外球', 'good');
    showGun();
  }

  function startHit() {
    const o = G.outcome;
    G.play = o.play;
    G.phase = 'hit';
    G.playT = 0;
    Sound.crack(o.swing.quality);
    burstAtContact(o.swing.quality);
    if (o.play.kind === 'hr') G.shake = 0.35;
    showGun();
    updateControls();
  }

  function burstAtContact(power) {
    const bp = G.outcome.swing.ballAt;
    const p = proj(batCam, bp.x, 0.1, bp.z);
    if (p) G.fx.push({ kind: 'burst', x: p.x, y: p.y, age: 0, life: 0.32, power });
  }

  function callPitch() {
    const o = G.outcome;
    const p = G.pitch;
    G.marker = { x: p.end.x, z: p.end.z, strike: p.strike };
    if (o.type === 'strike') flash(o.swinging ? '揮棒落空' : '好球！', 'strike');
    else if (o.type === 'hbp') flash('觸身球！', 'ball');
    else flash('壞球', 'ball');
    showGun();
    afterOutcome(C.applyOutcome(G.s, o));
  }

  function finishFoul() {
    afterOutcome(C.applyOutcome(G.s, G.outcome));
  }

  function finishPlay() {
    afterOutcome(C.applyOutcome(G.s, G.outcome));
  }

  function skipPlay() {
    if (G.phase === 'hit') {
      G.phase = 'play';
      G.view = 'field';
    }
    if (G.phase === 'play' && G.play) {
      G.playT = G.play.anim.end;
      if (G.play.kind === 'hr' && !G.hrFx) startHomeRunFx();
    }
  }

  const HIT_TITLE = { single: '一壘安打', double: '二壘安打', triple: '三壘安打', ihr: '場內全壘打！', hr: '紅不讓！' };
  const OUT_TITLE = { flyout: '接殺出局', lineout: '接殺出局', popout: '接殺出局', groundout: '刺殺出局', dp: '雙殺！', fc: '封殺出局' };
  const WALKOFF_TITLE = { walk: '再見保送！', hbp: '再見觸身球！', hr: '再見全壘打！', ihr: '再見全壘打！' };

  // 把一組事件變成大字幕
  function describe(ev) {
    let b = null;
    let runs = 0;
    let over = null;
    let cause = null;
    for (const e of ev) {
      if (e.kind === 'score') runs += e.runs;
      else if (e.kind === 'game_over') over = e;
      else if (e.kind === 'walk') {
        b = { title: '四壞球保送', tone: 'hit' };
        cause = 'walk';
      } else if (e.kind === 'hbp') {
        b = { title: '觸身球', sub: '保送上一壘', tone: 'hit' };
        cause = 'hbp';
      } else if (e.kind === 'strikeout') {
        b = { title: '三振！', sub: e.swinging ? '揮棒落空' : '站著不動被三振', tone: 'out' };
      } else if (e.kind === 'play') {
        const p = e.play;
        cause = p.kind;
        if (p.hit) {
          const infield = p.text === '內野安打';
          b = {
            title: infield ? '內野安打' : HIT_TITLE[p.kind],
            sub: p.kind === 'hr' ? `${p.text} · 飛行距離 ${p.distance} 公尺` : infield ? '' : p.text,
            tone: p.hitBases === 4 ? 'hr' : 'hit',
          };
        } else {
          b = { title: OUT_TITLE[p.kind] || '出局', sub: p.text, tone: 'out' };
        }
      }
    }
    if (b && runs && cause !== 'hr') b.sub = (b.sub ? b.sub + ' · ' : '') + `得 ${runs} 分`;
    if (over && over.walkoff) {
      b = b || { sub: '' };
      b.title = WALKOFF_TITLE[cause] || '再見安打！';
      b.tone = 'hr';
    }
    return b;
  }

  function afterOutcome(ev) {
    renderBoard();
    if (G.s.mode === 'derby') return afterDerby(ev);
    const over = ev.some((e) => e.kind === 'game_over');
    const retired = ev.some((e) => e.kind === 'side_retired');
    const b = describe(ev);
    if (b) {
      showBanner(b);
      if (b.tone === 'hr') {
        Sound.organ(FANFARE, 0.11);
        if (!G.hrFx) startHomeRunFx();
      } else if (b.tone === 'hit') Sound.cheer(0.8);
      else Sound.groan();
    }
    wait(b ? (b.tone === 'hr' ? 2.6 : 1.8) : 0.75, () => {
      hideBanner();
      if (over) return showGameOver();
      if (retired) return changeSides();
      enterReady();
    });
  }

  function afterDerby(ev) {
    const s = G.s;
    const hr = ev.find((e) => e.kind === 'derby_hr');
    const next = ev.find((e) => e.kind === 'derby_next');
    const over = ev.some((e) => e.kind === 'game_over');
    const o = G.outcome;
    let dur = 0.75;
    if (hr) {
      showBanner({ title: '紅不讓！', sub: `飛行距離 ${hr.distance} 公尺`, tone: 'hr' });
      Sound.organ(FANFARE, 0.11);
      dur = 2.2;
    } else if (o && o.type === 'inplay') {
      const p = o.play;
      showBanner({ title: '沒飛出去', sub: p.distance > 30 ? `${p.text} · ${p.distance} 公尺` : p.text, tone: 'out' });
      Sound.groan();
      dur = 1.5;
    } else if (ev.some((e) => e.kind === 'derby_ball')) {
      flash('壞球不算球數', 'ball');
    }
    wait(dur, () => {
      hideBanner();
      if (over) return showGameOver();
      if (next) {
        showBanner({ title: `換 ${playerName(next.player)} 上場`, sub: `一樣 ${s.pitches} 球`, tone: 'change' });
        return wait(1.7, () => {
          hideBanner();
          enterReady();
        });
      }
      enterReady();
    });
  }

  function changeSides() {
    const s = G.s;
    const names = teamNames(G.cfg);
    showBanner({ title: '攻守交換', sub: `${halfLabel(s)} · ${names[s.half]} 進攻`, tone: 'change' });
    renderBoard();
    wait(1.5, () => {
      hideBanner();
      enterReady();
    });
  }

  // 1P 選「電腦代投」時，電腦的進攻半局直接快轉
  function startSim() {
    G.phase = 'sim';
    const s = G.s;
    const label = halfLabel(s);
    const before = s.runs[1];
    const log = C.simulateHalfInning(s, { pitchLevel: G.cfg.level, batLevel: G.cfg.level }, G.rng);
    const scored = s.runs[1] - before;
    renderBoard();
    updateControls();
    el.simTitle.textContent = `電腦進攻・${label}（得 ${scored} 分）`;
    el.simLog.textContent = '';
    for (const item of log) {
      const li = document.createElement('li');
      li.textContent = item.text;
      const good = item.kind === 'walk' || item.kind === 'hbp' || (item.play && item.play.hit);
      li.className = item.kind === 'score' ? 'score' : good ? 'hit' : 'out';
      el.simLog.appendChild(li);
    }
    el.btnSimOk.textContent = s.over ? '看比賽結果' : '換我打擊';
    el.sim.hidden = false;
    el.btnSimOk.focus({ preventScroll: true });
    if (scored) Sound.groan();
  }

  function showGameOver() {
    G.screen = 'over';
    G.phase = 'idle';
    updateControls();
    const s = G.s;
    const cfg = G.cfg;
    if (s.mode === 'derby') {
      el.overKicker.textContent = '全壘打大賽結束';
      let note = '';
      if (cfg.players === 1) {
        el.overTitle.textContent = `${s.hrs[0]} 支全壘打`;
        const best = store.get('derbyBest', null);
        const mine = { hrs: s.hrs[0], longest: s.longest[0] };
        if (!best || mine.hrs > best.hrs || (mine.hrs === best.hrs && mine.longest > best.longest)) {
          store.set('derbyBest', mine);
          note = mine.hrs ? '新紀錄！' : '';
        } else {
          note = `最佳紀錄：${best.hrs} 支，最遠 ${best.longest} 公尺`;
        }
      } else {
        el.overTitle.textContent = s.winner === -1 ? '平手' : `${playerName(s.winner)} 獲勝！`;
        if (s.winner !== -1 && s.hrs[0] === s.hrs[1]) note = '全壘打一樣多，比最遠的一支';
      }
      el.overScore.textContent = '';
      let rows = '<tr><th></th><th>全壘打</th><th>最遠</th><th>總距離</th></tr>';
      for (let p = 0; p < s.players; p++) {
        rows += `<tr><td class="name">${playerName(p)}</td><td>${s.hrs[p]}</td><td>${s.longest[p] ? s.longest[p] + ' m' : '–'}</td><td>${s.dist[p] ? s.dist[p] + ' m' : '–'}</td></tr>`;
      }
      el.overStats.innerHTML = rows;
      el.overNote.textContent = note;
      if (s.hrs.some((n) => n > 0)) Sound.cheer(1.2);
    } else {
      const names = teamNames(cfg);
      el.overKicker.textContent = s.walkoff ? '再見比賽' : '比賽結束';
      let title;
      if (s.winner === -1) title = '平手';
      else if (cfg.players === 1) title = s.winner === 0 ? '你贏了！' : '電腦獲勝';
      else title = `${names[s.winner]} 獲勝！`;
      el.overTitle.textContent = title;
      el.overScore.innerHTML = `<table class="line">${lineScoreHTML()}</table>`;
      let rows = '<tr><th></th><th>安打</th><th>全壘打</th><th>三振</th><th>保送</th><th>打點</th></tr>';
      for (const t of [0, 1]) {
        const st = s.stats[t];
        rows += `<tr><td class="name">${names[t]}</td><td>${st.h}</td><td>${st.hr}</td><td>${st.so}</td><td>${st.bb}</td><td>${st.rbi}</td></tr>`;
      }
      el.overStats.innerHTML = rows;
      el.overNote.textContent = s.winner === -1 ? '延長賽打完還是平手。' : '';
      if (s.winner === 0 || cfg.players === 2) Sound.cheer(1.2);
    }
    el.over.hidden = false;
    el.btnAgain.focus({ preventScroll: true });
  }

  function showMenu() {
    G.screen = 'menu';
    G.paused = false;
    G.s = null;
    G.roles = null;
    G.play = null;
    G.pitch = null;
    G.view = 'bat';
    G.phase = 'idle';
    G.marker = null;
    for (const o of [el.pause, el.over, el.sim]) o.hidden = true;
    el.menu.hidden = false;
    el.matchup.hidden = true;
    el.gun.hidden = true;
    hideBanner();
    updateControls();
    syncMenu();
    renderBoard();
    el.btnStart.focus({ preventScroll: true });
  }

  function togglePause(force) {
    if (G.screen !== 'play') return;
    G.paused = force != null ? force : !G.paused;
    el.pause.hidden = !G.paused;
    clearHeld();
    if (G.paused) el.btnResume.focus({ preventScroll: true });
    else blurActive();
  }

  // ───────── 每一格畫面的更新 ─────────
  function update(dt) {
    G.t += dt;
    const r = G.roles;
    const ph = G.phase;
    if (r && r.batter.human && (ph === 'ready' || ph === 'aim' || ph === 'windup' || (ph === 'pitch' && !G.swing))) moveCursor(r.batter.player, dt);
    if (r && r.pitcher.human && !G.hiddenMode && ph === 'aim') moveTarget(r.pitcher.player, dt);
    switch (ph) {
      case 'ready':
        if (G.t >= G.readyDur) {
          if (r.pitcher.human) enterAim();
          else {
            cpuPick();
            enterWindup();
          }
        }
        break;
      case 'windup':
        if (G.t >= WINDUP) release();
        break;
      case 'pitch':
        updatePitch();
        break;
      case 'hit':
        G.playT += dt;
        if (G.playT >= HIT_CAM) {
          G.phase = 'play';
          G.view = 'field';
          G.fx = G.fx.filter((f) => f.kind !== 'label' && f.kind !== 'burst');
        }
        break;
      case 'play': {
        G.playT += dt * FIELD_SPEED;
        const hr = G.play.bb.hrInfo;
        if (G.play.kind === 'hr' && !G.hrFx && hr && G.playT >= hr.t) startHomeRunFx();
        if (G.playT >= G.play.anim.end) finishPlay();
        break;
      }
      case 'foul':
        G.playT += dt;
        if (G.playT >= 1.0) finishFoul();
        break;
      case 'wait':
        if (G.t >= G.waitDur) {
          const n = G.next;
          G.next = null;
          if (n) n();
        }
        break;
    }
  }

  function moveCursor(p, dt) {
    const d = dirOf(p);
    const vx = (d.right ? 1 : 0) - (d.left ? 1 : 0);
    const vz = (d.up ? 1 : 0) - (d.down ? 1 : 0);
    if (!vx && !vz) return;
    const k = (CURSOR_SPEED * dt) / (vx && vz ? Math.SQRT2 : 1);
    const cur = G.cursors[p];
    cur.x = clamp(cur.x + vx * k, CUR_BOX.x0, CUR_BOX.x1);
    cur.z = clamp(cur.z + vz * k, CUR_BOX.z0, CUR_BOX.z1);
  }

  function moveTarget(p, dt) {
    const d = dirOf(p);
    const vx = (d.right ? 1 : 0) - (d.left ? 1 : 0);
    const vz = (d.up ? 1 : 0) - (d.down ? 1 : 0);
    if (!vx && !vz) return;
    const k = (TARGET_SPEED * dt) / (vx && vz ? Math.SQRT2 : 1);
    const t = G.aim.target;
    t.x = clamp(t.x + vx * k, TGT_BOX.x0, TGT_BOX.x1);
    t.z = clamp(t.z + vz * k, TGT_BOX.z0, TGT_BOX.z1);
  }

  function startHomeRunFx() {
    G.hrFx = true;
    Sound.cheer(1.6);
    const n = reduceMotion ? 1 : 5;
    for (let i = 0; i < n; i++) G.fireworks.push({ at: performance.now() / 1000 + i * 0.35 });
  }

  function spawnFirework() {
    const c = G.view === 'field' ? fieldCam : batCam;
    const x = (Math.random() * 2 - 1) * 55;
    const p = proj(c, x, 128 + Math.random() * 20, 36 + Math.random() * 18);
    const px = p ? clamp(p.x, W * 0.1, W * 0.9) : W * (0.2 + Math.random() * 0.6);
    const py = p ? clamp(p.y, H * 0.08, H * 0.4) : H * (0.1 + Math.random() * 0.2);
    const colors = [COL.amber, COL.red, '#fff6d8', TEAM[0].ui, '#7fe0a0'];
    const color = colors[Math.floor(Math.random() * colors.length)];
    const speed = Math.max(70, H * 0.3);
    for (let i = 0; i < 70; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.35 + Math.random() * 0.65);
      G.sparks.push({ x: px, y: py, vx: Math.cos(a) * v, vy: Math.sin(a) * v, age: 0, life: 1.1 + Math.random() * 0.6, color });
    }
    Sound.boom();
  }

  function updateFx(dt) {
    const now = performance.now() / 1000;
    if (G.fireworks.length) {
      G.fireworks = G.fireworks.filter((f) => {
        if (now < f.at) return true;
        spawnFirework();
        return false;
      });
    }
    for (const f of G.fx) f.age += dt;
    G.fx = G.fx.filter((f) => f.age < f.life);
    for (const s of G.sparks) {
      s.age += dt;
      s.vy += 150 * dt;
      s.vx *= 0.985;
      s.vy *= 0.985;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
    }
    G.sparks = G.sparks.filter((s) => s.age < s.life);
    if (G.shake > 0) G.shake = Math.max(0, G.shake - dt);
  }

  // ───────── 繪製 ─────────
  function samplePath(path, t) {
    if (t <= path[0].t) return path[0];
    const n = path.length;
    if (t >= path[n - 1].t) return path[n - 1];
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (path[mid].t <= t) lo = mid;
      else hi = mid;
    }
    const a = path[lo];
    const b = path[hi];
    const u = (t - a.t) / (b.t - a.t || 1);
    return { x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), z: lerp(a.z, b.z, u) };
  }

  function render(now) {
    const g = ctx;
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    g.save();
    if (G.shake > 0 && !reduceMotion) g.translate((Math.random() - 0.5) * 16 * G.shake, (Math.random() - 0.5) * 16 * G.shake);
    if (G.view === 'field' && G.play) renderField(g, now);
    else renderBat(g, now);
    g.restore();
    drawFx(g);
  }

  const NUMBERS = ['1', '2', '7'];
  function lookFor(team, batter) {
    const t = TEAM[team] || TEAM[0];
    const look = { jersey: t.jersey, cap: t.cap, pants: COL.pants, helmet: batter, glove: !batter };
    if (batter) {
      look.number = NUMBERS[team] || '1';
      look.gloves = '#f1ead3';
      look.elbow = { l: [0.03, 0.12, -0.16], r: [-0.1, -0.14, -0.1] };
    }
    return look;
  }

  function renderBat(g, now) {
    const c = batCam;
    g.drawImage(batLayer, 0, 0, W, H);
    const r = G.roles;
    const teams = G.teams;
    const pJ = pitcherRig(now);
    drawFigure(g, c, pJ, lookFor(teams.field, false));
    if (G.phase === 'windup' || (G.phase === 'aim' && G.pitchCmd == null) || G.phase === 'ready') {
      const h = pJ.rh;
      const p = proj(c, h[0], h[1] - 0.05, h[2]);
      if (p && G.screen === 'play') {
        g.fillStyle = COL.ball;
        g.beginPath();
        g.arc(p.x, p.y, Math.max(1.4, C.BALL_R * p.s), 0, Math.PI * 2);
        g.fill();
      }
    }

    const humanBatter = r && r.batter.human;
    const aimingV = r && r.pitcher.human && !G.hiddenMode && G.phase === 'aim';
    drawZone(g, c, aimingV);

    let ballPos = null;
    if (G.phase === 'pitch' && G.pitch) ballPos = C.pitchPos(G.pitch, Math.min(G.t, G.pitch.T + 0.14));
    if (ballPos && ballPos.y > 0.6) drawPitchBall(g, c, ballPos);

    let swingT = -1;
    if (G.swing) {
      if (G.phase === 'pitch') swingT = G.t - G.swing.time;
      else if (G.phase === 'hit' || G.phase === 'foul') swingT = C.SWING.lag + G.playT;
      else if (G.phase === 'wait') swingT = 9;
    }
    const rig = batterRig(swingT >= 0 ? { t: swingT, cursor: G.swing.cursor } : null, now);
    drawFigure(g, c, rig.J, lookFor(teams.bat, true));
    if (ballPos && ballPos.y <= 0.6) drawPitchBall(g, c, ballPos);
    drawBat(g, c, rig.hands, rig.tip);

    if ((G.phase === 'hit' || G.phase === 'play') && G.play) {
      const b = samplePath(G.play.bb.path, G.playT);
      drawBall(g, c, b.x, b.y, b.z, { min: 1.6, glow: true });
    }
    if (G.phase === 'foul' && G.foulBB) {
      const b = samplePath(G.foulBB.path, G.playT);
      drawBall(g, c, b.x, b.y, b.z, { min: 1.6, glow: true });
    }
    if (G.marker) drawMarker(g, c, G.marker);
    if (aimingV) drawMitt(g, c, G.aim.target);
    if (humanBatter && G.screen === 'play' && G.phase !== 'hit' && G.phase !== 'foul') {
      const cur = G.swing ? G.swing.cursor : G.cursors[r.batter.player];
      const near = G.phase === 'pitch' && !G.swing ? clamp(1 - (G.pitch.T - G.t) / 0.4, 0, 1) : 0;
      drawCursor(g, c, cur, TEAM[teams.bat].ui, near);
    }
  }

  function drawPitchBall(g, c, pos) {
    const p = G.pitch;
    for (let k = 3; k >= 1; k--) {
      const tt = G.t - k * 0.02;
      if (tt < 0) continue;
      const q = C.pitchPos(p, Math.min(tt, p.T + 0.14));
      const s = proj(c, q.x, q.y, q.z);
      if (!s) continue;
      g.fillStyle = `rgba(255, 255, 255, ${(0.14 * (4 - k)) / 3})`;
      g.beginPath();
      g.arc(s.x, s.y, Math.max(1.4, C.BALL_R * s.s), 0, Math.PI * 2);
      g.fill();
    }
    drawBall(g, c, pos.x, pos.y, pos.z, { min: 1.8 });
  }

  function drawZone(g, c, strong) {
    const Z = C.ZONE;
    const a = proj(c, -Z.halfW, 0, Z.top);
    const b = proj(c, Z.halfW, 0, Z.bottom);
    if (!a || !b) return;
    const x0 = a.x;
    const y0 = a.y;
    const x1 = b.x;
    const y1 = b.y;
    g.save();
    g.strokeStyle = strong ? 'rgba(241, 234, 211, 0.55)' : 'rgba(241, 234, 211, 0.28)';
    g.lineWidth = 1.5;
    g.strokeRect(x0, y0, x1 - x0, y1 - y0);
    if (strong) {
      g.strokeStyle = 'rgba(241, 234, 211, 0.22)';
      g.beginPath();
      for (const k of [1, 2]) {
        g.moveTo(x0 + ((x1 - x0) * k) / 3, y0);
        g.lineTo(x0 + ((x1 - x0) * k) / 3, y1);
        g.moveTo(x0, y0 + ((y1 - y0) * k) / 3);
        g.lineTo(x1, y0 + ((y1 - y0) * k) / 3);
      }
      g.stroke();
    }
    g.strokeStyle = 'rgba(241, 234, 211, 0.85)';
    g.lineWidth = 2.5;
    const L = Math.min(x1 - x0, y1 - y0) * 0.18;
    for (const [x, y, sx, sy] of [
      [x0, y0, 1, 1],
      [x1, y0, -1, 1],
      [x0, y1, 1, -1],
      [x1, y1, -1, -1],
    ]) {
      g.beginPath();
      g.moveTo(x + sx * L, y);
      g.lineTo(x, y);
      g.lineTo(x, y + sy * L);
      g.stroke();
    }
    g.restore();
  }

  function drawCursor(g, c, cur, color, near) {
    const p = proj(c, cur.x, 0, cur.z);
    if (!p) return;
    const rx = C.SWING.rx * G.meet * p.s;
    const rz = C.SWING.rz * G.meet * p.s;
    g.save();
    if (near > 0) {
      g.shadowColor = color;
      g.shadowBlur = 14 * near;
    }
    g.fillStyle = hexA(color, 0.1 + 0.14 * near);
    g.strokeStyle = color;
    g.lineWidth = 2.5;
    g.beginPath();
    g.ellipse(p.x, p.y, rx, rz, 0, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.shadowBlur = 0;
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(p.x - 7, p.y);
    g.lineTo(p.x + 7, p.y);
    g.moveTo(p.x, p.y - 7);
    g.lineTo(p.x, p.y + 7);
    g.stroke();
    g.restore();
  }

  function drawMitt(g, c, t) {
    const p = proj(c, t.x, -0.25, t.z);
    if (!p) return;
    const r = 0.11 * p.s;
    g.save();
    g.setLineDash([4, 4]);
    g.strokeStyle = 'rgba(247, 183, 51, 0.7)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(p.x - r * 2.4, p.y);
    g.lineTo(p.x + r * 2.4, p.y);
    g.moveTo(p.x, p.y - r * 2.4);
    g.lineTo(p.x, p.y + r * 2.4);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = COL.glove;
    g.strokeStyle = '#3a1f0c';
    g.lineWidth = 2;
    g.beginPath();
    g.ellipse(p.x, p.y, r, r * 1.1, 0, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.fillStyle = '#5c3214';
    g.beginPath();
    g.ellipse(p.x, p.y + r * 0.1, r * 0.55, r * 0.6, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }

  function drawMarker(g, c, m) {
    const p = proj(c, m.x, 0, m.z);
    if (!p) return;
    const r = Math.max(4, C.BALL_R * p.s * 1.3);
    g.save();
    g.strokeStyle = m.strike ? COL.amber : COL.green;
    g.fillStyle = hexA(m.strike ? COL.amber : COL.green, 0.3);
    g.lineWidth = 2;
    g.beginPath();
    g.arc(p.x, p.y, r, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.restore();
  }

  function fielderPos(A, f, t) {
    let x = f.x;
    let y = f.y;
    let running = false;
    for (const m of A.fielders) {
      if (m.id !== f.id || t < m.t0) continue;
      const u = m.t1 > m.t0 ? clamp((t - m.t0) / (m.t1 - m.t0), 0, 1) : 1;
      x = lerp(m.from.x, m.to.x, u);
      y = lerp(m.from.y, m.to.y, u);
      if (u < 1) running = true;
    }
    return { x, y, running };
  }

  const basePt = (b) => (b >= 4 ? C.BASES[0] : C.BASES[b]);

  function runnerPos(rn, t) {
    if (!rn.legs.length) return { x: basePt(rn.from).x, y: basePt(rn.from).y, running: false };
    if (rn.out && rn.outAt != null && t > rn.outAt + 0.7) return null;
    const last = rn.legs[rn.legs.length - 1];
    if (t >= last.t1) {
      if (rn.to >= 4 && t > last.t1 + 0.5) return null;
      const p = basePt(rn.to);
      return { x: p.x, y: p.y, running: false };
    }
    for (const leg of rn.legs) {
      if (t < leg.t0) {
        const p = rn.from === 0 ? { x: -0.9, y: 0 } : basePt(leg.a);
        return { x: p.x, y: p.y, running: false };
      }
      if (t <= leg.t1) {
        const u = (t - leg.t0) / (leg.t1 - leg.t0);
        const a = leg.a === 0 && rn.from === 0 ? { x: -0.9, y: 0 } : basePt(leg.a);
        const b = basePt(leg.b);
        return { x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), running: true };
      }
    }
    return null;
  }

  function fieldBallPos(play, t) {
    const A = play.anim;
    const path = play.bb.path;
    if (A.hr) return t <= A.ballEnd ? samplePath(path, t) : null;
    if (t <= A.ballEnd) return samplePath(path, t);
    let pos = null;
    for (const th of A.throws) {
      if (t < th.t0) break;
      if (t <= th.t1) {
        const u = (t - th.t0) / (th.t1 - th.t0 || 1);
        const d = Math.hypot(th.to.x - th.from.x, th.to.y - th.from.y);
        return {
          x: lerp(th.from.x, th.to.x, u),
          y: lerp(th.from.y, th.to.y, u),
          z: lerp(1.4, 1.2, u) + Math.min(6, d * 0.06) * 4 * u * (1 - u),
        };
      }
      pos = { x: th.to.x, y: th.to.y, z: 1.2 };
    }
    if (pos) return pos;
    const f = C.FIELDERS.find((q) => q.id === play.fielder);
    const fp = fielderPos(A, f, t);
    return { x: fp.x, y: fp.y, z: 1.2 };
  }

  function renderField(g, now) {
    const c = fieldCam;
    g.drawImage(fieldLayer, 0, 0, W, H);
    const play = G.play;
    const A = play.anim;
    const t = G.playT;
    const def = TEAM[G.teams.field] || TEAM[2];
    const off = TEAM[G.teams.bat] || TEAM[0];
    const figures = [];
    for (const f of C.FIELDERS) {
      const p = fielderPos(A, f, t);
      figures.push({ x: p.x, y: p.y, color: def.jersey, cap: def.cap, running: p.running });
    }
    for (const rn of A.runners) {
      const p = runnerPos(rn, t);
      if (p) figures.push({ x: p.x, y: p.y, color: off.jersey, cap: off.cap, running: p.running });
    }
    figures.sort((a, b) => b.y - a.y);
    for (const f of figures) drawMini(g, c, f.x, f.y, f.color, f.cap, f.running, now * 16);

    const b = fieldBallPos(play, t);
    if (b) {
      if (t <= A.ballEnd) {
        g.save();
        g.lineCap = 'round';
        for (let k = 1; k <= 12; k++) {
          const q0 = samplePath(play.bb.path, Math.max(0, t - k * 0.03));
          const q1 = samplePath(play.bb.path, Math.max(0, t - (k - 1) * 0.03));
          const p0 = proj(c, q0.x, q0.y, q0.z);
          const p1 = proj(c, q1.x, q1.y, q1.z);
          if (!p0 || !p1) continue;
          g.strokeStyle = `rgba(255, 255, 240, ${0.35 * (1 - k / 13)})`;
          g.lineWidth = 2.5;
          g.beginPath();
          g.moveTo(p0.x, p0.y);
          g.lineTo(p1.x, p1.y);
          g.stroke();
        }
        g.restore();
      }
      drawBall(g, c, b.x, b.y, b.z, { scale: 3.2, min: 2.8, glow: true });
    }

    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const m of A.marks) {
      const age = t - m.t;
      if (age < 0 || age > 2.4) continue;
      const p = proj(c, m.x, m.y, 4);
      if (!p) continue;
      g.globalAlpha = clamp(1 - (age - 1.7) / 0.7, 0, 1);
      g.font = `900 ${Math.round(clamp(H * 0.045, 16, 30))}px ${NUM_FONT}`;
      g.lineWidth = 4;
      g.strokeStyle = 'rgba(4, 8, 16, 0.85)';
      g.strokeText('OUT', p.x, p.y);
      g.fillStyle = COL.red;
      g.fillText('OUT', p.x, p.y);
      g.globalAlpha = 1;
    }
    if (A.hr && play.bb.hrInfo && t >= play.bb.hrInfo.landT) {
      const last = play.bb.path[play.bb.path.length - 1];
      const p = proj(c, last.x, last.y, last.z + 6);
      if (p) {
        g.font = `900 ${Math.round(clamp(H * 0.05, 18, 34))}px ${NUM_FONT}`;
        g.lineWidth = 5;
        g.strokeStyle = 'rgba(4, 8, 16, 0.85)';
        g.strokeText(`${play.distance} M`, p.x, p.y);
        g.fillStyle = COL.amber;
        g.fillText(`${play.distance} M`, p.x, p.y);
      }
    }
  }

  function drawFx(g) {
    for (const f of G.fx) {
      const u = f.age / f.life;
      if (f.kind === 'burst') {
        const rad = lerp(8, 34 + 40 * f.power, smooth(u));
        g.save();
        g.globalAlpha = 1 - u;
        g.strokeStyle = '#fffbe8';
        g.lineWidth = 3;
        g.beginPath();
        g.arc(f.x, f.y, rad, 0, Math.PI * 2);
        g.stroke();
        for (let i = 0; i < 10; i++) {
          const a = (i / 10) * Math.PI * 2 + 0.3;
          g.beginPath();
          g.moveTo(f.x + Math.cos(a) * rad * 0.6, f.y + Math.sin(a) * rad * 0.6);
          g.lineTo(f.x + Math.cos(a) * rad * 1.3, f.y + Math.sin(a) * rad * 1.3);
          g.stroke();
        }
        g.restore();
      } else if (f.kind === 'pop') {
        g.save();
        g.globalAlpha = 1 - u;
        g.strokeStyle = 'rgba(255, 255, 255, 0.8)';
        g.lineWidth = 2;
        g.beginPath();
        g.arc(f.x, f.y, lerp(4, 20, u), 0, Math.PI * 2);
        g.stroke();
        g.restore();
      } else if (f.kind === 'label') {
        g.save();
        g.globalAlpha = 1 - u * u;
        g.font = `800 ${Math.round(clamp(H * 0.035, 15, 24))}px ${ZH_FONT}`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.lineWidth = 4;
        g.strokeStyle = 'rgba(4, 8, 16, 0.8)';
        g.strokeText(f.text, f.x, f.y - 18 * u);
        g.fillStyle = f.color;
        g.fillText(f.text, f.x, f.y - 18 * u);
        g.restore();
      }
    }
    if (G.sparks.length) {
      g.save();
      g.globalCompositeOperation = 'lighter';
      for (const s of G.sparks) {
        g.globalAlpha = clamp(1 - s.age / s.life, 0, 1);
        g.fillStyle = s.color;
        g.beginPath();
        g.arc(s.x, s.y, 2.2, 0, Math.PI * 2);
        g.fill();
      }
      g.restore();
    }
  }

  // ───────── 計分板與文字 ─────────
  function lineScoreHTML() {
    const s = G.s;
    const cfg = s && G.cfg ? G.cfg : settings;
    const names = teamNames(cfg);
    const n = s ? Math.max(cfg.innings, s.inning) : cfg.innings;
    let html = '<thead><tr><th class="team"></th>';
    for (let i = 1; i <= n; i++) html += `<th class="inn">${i}</th>`;
    html += '<th class="gap"></th><th>R</th><th>H</th></tr></thead><tbody>';
    for (const t of [0, 1]) {
      const batting = s && !s.over && G.screen === 'play' && s.half === t;
      html += `<tr><th class="team team--${t ? 'b' : 'a'}${batting ? ' batting' : ''}">${names[t]}</th>`;
      for (let i = 0; i < n; i++) {
        const v = s ? s.line[t][i] : null;
        const cur = batting && s.inning === i + 1;
        html += `<td class="inn${v != null ? ' on' : ''}${cur ? ' cur' : ''}">${v != null ? v : ''}</td>`;
      }
      html += `<td class="gap"></td><td class="total">${s ? s.runs[t] : 0}</td><td class="total">${s ? s.hits[t] : 0}</td></tr>`;
    }
    return html + '</tbody>';
  }

  function renderBoard() {
    const s = G.s;
    const derby = s ? s.mode === 'derby' : settings.mode === 'derby';
    el.status.hidden = derby;
    if (derby) {
      const players = s ? s.players : settings.players;
      el.line.className = 'line derby';
      let html = '<thead><tr><th class="team"></th><th>HR</th><th>剩餘</th><th>最遠</th></tr></thead><tbody>';
      for (let p = 0; p < players; p++) {
        const cur = s && !s.over && G.screen === 'play' && s.current === p;
        const left = s ? s.left[p] : C.DERBY.pitches;
        const longest = s && s.longest[p] ? s.longest[p] : '–';
        html += `<tr><th class="team team--${p ? 'b' : 'a'}${cur ? ' batting' : ''}">${playerName(p)}</th><td class="on">${s ? s.hrs[p] : 0}</td><td class="total">${left}</td><td class="total">${longest}</td></tr>`;
      }
      el.line.innerHTML = html + '</tbody>';
      return;
    }
    el.line.className = 'line';
    el.line.innerHTML = lineScoreHTML();
    el.inningHalf.textContent = s && s.half ? '▼' : '▲';
    el.inningNum.textContent = s ? s.inning : 1;
    const lamps = [s ? s.balls : 0, s ? s.strikes : 0, s ? s.outs : 0];
    el.count.querySelectorAll('.count__row').forEach((row, i) => {
      row.querySelectorAll('i').forEach((lamp, j) => lamp.classList.toggle('on', j < lamps[i]));
    });
    el.diamond.querySelectorAll('.base').forEach((b) => b.classList.toggle('on', !!(s && s.bases[+b.dataset.base - 1])));
  }

  function renderMatchup() {
    const r = G.roles;
    const s = G.s;
    if (!r || !s || G.screen !== 'play') {
      el.matchup.hidden = true;
      return;
    }
    el.matchup.hidden = false;
    if (s.mode === 'derby') {
      const p = s.current;
      const n = s.pitches - s.left[p] + 1;
      el.matchup.innerHTML = `打擊 <span class="${p ? 'b' : 'a'}">${playerName(p)}</span> · 第 ${Math.min(n, s.pitches)} 球／${s.pitches}`;
      return;
    }
    const names = teamNames(G.cfg);
    const bat = s.half;
    const pitcherName = r.pitcher.human ? names[1 - bat] : G.cfg.players === 2 ? '電腦代投' : 'CPU';
    el.matchup.innerHTML = `打擊 <span class="${bat ? 'b' : 'a'}">${names[bat]}</span> · 投球 <span class="${bat ? 'a' : 'b'}">${pitcherName}</span>`;
  }

  function showGun() {
    const p = G.pitch;
    if (!p) return;
    el.gun.innerHTML = `${p.name} <b>${p.speed}</b> km/h`;
    el.gun.hidden = false;
  }

  let flashTimer = 0;
  function flash(text, tone) {
    el.flash.textContent = text;
    el.flash.className = `flash flash--${tone}`;
    void el.flash.offsetWidth;
    el.flash.classList.add('show');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => el.flash.classList.remove('show'), 1050);
  }

  function showBanner(b) {
    el.banner.className = `banner banner--${b.tone || 'hit'}`;
    el.bannerTitle.textContent = b.title;
    el.bannerSub.textContent = b.sub || '';
    el.banner.hidden = false;
    for (const node of [el.bannerTitle, el.bannerSub]) {
      node.style.animation = 'none';
      void node.offsetWidth;
      node.style.animation = '';
    }
  }

  function hideBanner() {
    el.banner.hidden = true;
  }

  function buildPad() {
    el.padTypes.textContent = '';
    C.PITCH_ORDER.forEach((id, i) => {
      const def = C.PITCHES[id];
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pad__type';
      b.id = `pitch${id}`;
      b.dataset.type = id;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', 'false');
      b.innerHTML = `<span>${def.name}</span><small>${touchUI ? '' : `${i + 1} · `}${def.speed}</small>`;
      b.addEventListener('click', () => {
        selectType(id);
        Sound.tick();
        blurActive();
      });
      el.padTypes.appendChild(b);
    });
  }

  function selectType(id) {
    G.aim.type = id;
    el.padTypes.querySelectorAll('.pad__type').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.type === id)));
  }

  function renderLegend() {
    const p = G.roles.pitcher.player;
    const k = p === 0 ? { up: 'W', right: 'D', down: 'S', left: 'A', act: 'F', move: 'WASD' } : { up: '↑', right: '→', down: '↓', left: '←', act: 'Enter', move: '方向鍵' };
    el.legend.className = `legend legend--${p === 0 ? 'left' : 'right'}`;
    el.legend.innerHTML =
      `<h4>投手 ${playerName(p)}：${k.move} + ${k.act}</h4>` +
      `<ol><li>按住方向選球種，再按 <kbd>${k.act}</kbd> 開始投球<div class="keys">` +
      `<span><kbd>${k.up}</kbd> 直球</span><span><kbd>${k.right}</kbd> 滑球</span><span><kbd>${k.down}</kbd> 曲球</span><span><kbd>${k.left}</kbd> 變速球</span></div></li>` +
      '<li>抬腿時按住方向決定進壘點，不按就是正中間。</li></ol>';
  }

  function hintText() {
    const r = G.roles;
    const ph = G.phase;
    if (!r || G.screen !== 'play') return '';
    if (ph === 'hit' || ph === 'play') return touchUI ? '點畫面可以快轉' : '按揮棒鍵或點畫面可以快轉';
    if (!r.batter.human || ph === 'wait' || ph === 'sim') return '';
    if (touchUI) return '球進本壘時，點一下球的位置揮棒';
    if (G.cfg.players === 1) return '移動 WASD／方向鍵／滑鼠　·　揮棒 F／空白鍵／Enter／點擊';
    return r.batter.player === 0 ? '打者 1P：WASD 移動、F 揮棒' : '打者 2P：方向鍵移動、Enter 揮棒';
  }

  function updateControls() {
    const r = G.roles;
    const ph = G.phase;
    const playing = G.screen === 'play' && r;
    el.pad.hidden = !(playing && r.pitcher.human && !G.hiddenMode && ph === 'aim');
    el.legend.hidden = !(playing && r.pitcher.human && G.hiddenMode && (ph === 'aim' || ph === 'windup' || ph === 'ready'));
    el.hint.textContent = el.pad.hidden ? hintText() : '';
    renderMatchup();
  }

  // ───────── 選單 ─────────
  const radioValue = (name) => {
    const i = document.querySelector(`input[name="${name}"]:checked`);
    return i ? i.value : undefined;
  };

  function readMenu() {
    Object.assign(
      settings,
      sanitize({
        mode: radioValue('mode'),
        players: radioValue('players'),
        innings: radioValue('innings'),
        level: radioValue('level'),
        pitching: radioValue('pitching'),
        sound: settings.sound,
      })
    );
    store.set('settings', settings);
  }

  function setRadio(name, value) {
    const i = document.querySelector(`input[name="${name}"][value="${value}"]`);
    if (i) i.checked = true;
  }

  function menuNote() {
    const s = settings;
    if (s.mode === 'derby') {
      if (s.players === 2) return '兩人輪流各打 10 球，全壘打多的贏；一樣多就比最遠的一支。';
      const best = store.get('derbyBest', null);
      const base = '打 10 球，只有飛出全壘打牆才算。';
      return best && best.hrs ? `${base}目前最佳：${best.hrs} 支，最遠 ${best.longest} 公尺。` : base;
    }
    if (s.players === 1) return s.pitching === 'human' ? '你是先攻的客隊；輪到電腦進攻時換你投球。' : '你只負責打擊，電腦進攻的半局會自動快轉。';
    if (s.pitching === 'cpu') return '1P 先攻、2P 後攻，兩人輪流打擊，電腦幫雙方投球。';
    return touchUI ? '1P 先攻、2P 後攻，輪到防守的人投球。' : '1P 先攻、2P 後攻，輪到防守的人投球。用鍵盤投球時，打者看不到你選了什麼球。';
  }

  function syncMenu() {
    setRadio('mode', settings.mode);
    setRadio('players', String(settings.players));
    setRadio('innings', String(settings.innings));
    setRadio('level', settings.level);
    setRadio('pitching', settings.pitching);
    document.querySelectorAll('.opt[data-for="game"]').forEach((o) => (o.hidden = settings.mode !== 'game'));
    el.menuNote.textContent = menuNote();
    el.btnStart.textContent = settings.mode === 'derby' ? '開始全壘打大賽' : '開始比賽';
    if (G.screen === 'menu') renderBoard();
  }

  function blurActive() {
    const a = document.activeElement;
    if (a && a !== document.body && typeof a.blur === 'function') a.blur();
  }

  function overlayOpen() {
    return !el.menu.hidden || !el.pause.hidden || !el.sim.hidden || !el.over.hidden;
  }

  // ───────── 輸入 ─────────
  const KEYS = {
    KeyW: [0, 'up'],
    KeyA: [0, 'left'],
    KeyS: [0, 'down'],
    KeyD: [0, 'right'],
    KeyF: [0, 'act'],
    Space: [0, 'act'],
    ArrowUp: [1, 'up'],
    ArrowLeft: [1, 'left'],
    ArrowDown: [1, 'down'],
    ArrowRight: [1, 'right'],
    Enter: [1, 'act'],
    NumpadEnter: [1, 'act'],
    Numpad0: [1, 'act'],
    Slash: [1, 'act'],
  };
  const held = [
    { up: false, down: false, left: false, right: false },
    { up: false, down: false, left: false, right: false },
  ];

  function clearHeld() {
    for (const h of held) for (const k in h) h[k] = false;
  }

  // 一個人玩時，兩組按鍵都控制 1P
  function dirOf(p) {
    const sets = G.cfg && G.cfg.players === 2 ? [held[p]] : held;
    const d = { up: false, down: false, left: false, right: false };
    for (const h of sets) for (const k in d) d[k] = d[k] || h[k];
    return d;
  }

  function action(p) {
    const r = G.roles;
    if (!r) return;
    if (G.phase === 'pitch' && r.batter.human && r.batter.player === p) swingNow();
    else if (G.phase === 'aim' && r.pitcher.human && r.pitcher.player === p) humanThrow();
    else if (G.phase === 'hit' || G.phase === 'play') skipPlay();
  }

  function cycleType(step) {
    const i = C.PITCH_ORDER.indexOf(G.aim.type);
    selectType(C.PITCH_ORDER[(i + step + C.PITCH_ORDER.length) % C.PITCH_ORDER.length]);
  }

  document.addEventListener('keydown', (e) => {
    if (G.screen !== 'play') return;
    if (e.code === 'Escape' || e.code === 'KeyP') {
      e.preventDefault();
      togglePause();
      return;
    }
    if (G.paused || overlayOpen() || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = KEYS[e.code];
    if (k) {
      e.preventDefault();
      const p = G.cfg && G.cfg.players === 2 ? k[0] : 0;
      if (k[1] === 'act') {
        if (!e.repeat) action(p);
      } else {
        held[k[0]][k[1]] = true;
      }
      return;
    }
    const pick = /^(?:Digit|Numpad)([1-4])$/.exec(e.code);
    if (pick && G.phase === 'aim' && !G.hiddenMode) {
      e.preventDefault();
      selectType(C.PITCH_ORDER[+pick[1] - 1]);
    } else if ((e.code === 'KeyQ' || e.code === 'KeyE') && G.phase === 'aim' && !G.hiddenMode) {
      e.preventDefault();
      cycleType(e.code === 'KeyE' ? 1 : -1);
    }
  });
  document.addEventListener('keyup', (e) => {
    const k = KEYS[e.code];
    if (k && k[1] !== 'act') held[k[0]][k[1]] = false;
  });
  window.addEventListener('blur', clearHeld);

  function localPoint(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // 打擊視角沒有俯角，所以可以直接把螢幕座標換回本壘板平面
  function screenToPlate(pt) {
    const c = batCam;
    const d = -c.py;
    return { x: c.px + ((pt.x - c.cx) * d) / c.f, z: c.pz - ((pt.y - c.cy) * d) / c.f };
  }

  function setCursorTo(p, pt) {
    const q = screenToPlate(pt);
    const cur = G.cursors[p];
    cur.x = clamp(q.x, CUR_BOX.x0, CUR_BOX.x1);
    cur.z = clamp(q.z, CUR_BOX.z0, CUR_BOX.z1);
  }

  function setTargetTo(pt) {
    const q = screenToPlate(pt);
    G.aim.target.x = clamp(q.x, TGT_BOX.x0, TGT_BOX.x1);
    G.aim.target.z = clamp(q.z, TGT_BOX.z0, TGT_BOX.z1);
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' && !touchUI) {
      touchUI = true;
      buildPad();
    }
    Sound.unlock();
    if (G.screen !== 'play' || G.paused || overlayOpen()) return;
    e.preventDefault();
    const r = G.roles;
    if (!r) return;
    const pt = localPoint(e);
    if (G.phase === 'hit' || G.phase === 'play') return skipPlay();
    if (G.view !== 'bat') return;
    if (G.phase === 'aim' && r.pitcher.human && !G.hiddenMode) return setTargetTo(pt);
    if (r.batter.human) {
      setCursorTo(r.batter.player, pt);
      if (G.phase === 'pitch') swingNow();
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || G.screen !== 'play' || G.paused || G.view !== 'bat') return;
    const r = G.roles;
    if (!r) return;
    const pt = localPoint(e);
    if (G.phase === 'aim' && r.pitcher.human && !G.hiddenMode) setTargetTo(pt);
    else if (r.batter.human && !(G.phase === 'pitch' && G.swing)) setCursorTo(r.batter.player, pt);
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // ───────── 按鈕 ─────────
  document.querySelectorAll('#menu input[type="radio"]').forEach((i) =>
    i.addEventListener('change', () => {
      readMenu();
      syncMenu();
      Sound.tick();
    })
  );
  el.btnStart.addEventListener('click', () => startMatch());
  el.btnThrow.addEventListener('click', () => {
    humanThrow();
    blurActive();
  });
  el.btnPause.addEventListener('click', () => togglePause(true));
  el.btnResume.addEventListener('click', () => togglePause(false));
  el.btnRestart.addEventListener('click', () => startMatch());
  el.btnQuit.addEventListener('click', showMenu);
  el.btnAgain.addEventListener('click', () => startMatch());
  el.btnMenu.addEventListener('click', showMenu);
  el.btnSimOk.addEventListener('click', () => {
    el.sim.hidden = true;
    blurActive();
    if (G.s.over) showGameOver();
    else enterReady();
  });
  el.btnSound.addEventListener('click', () => {
    settings.sound = !settings.sound;
    store.set('settings', settings);
    Sound.set(settings.sound);
    updateSoundButton();
  });

  function updateSoundButton() {
    el.btnSound.setAttribute('aria-pressed', String(settings.sound));
    el.btnSound.setAttribute('aria-label', settings.sound ? '音效：開' : '音效：關');
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && G.screen === 'play' && !G.paused) togglePause(true);
  });
  window.addEventListener('resize', () => (needResize = true));
  if (window.ResizeObserver) new ResizeObserver(() => (needResize = true)).observe(el.stage);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      layersDirty = true;
      needResize = true;
    });
  }

  // ───────── 主迴圈 ─────────
  let last = 0;
  function frame(now) {
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;
    if (needResize) resize();
    if (G.screen === 'play' && !G.paused) update(dt);
    G.frameNow = now;
    if (!G.paused) updateFx(dt);
    render(now / 1000);
    requestAnimationFrame(frame);
  }

  // 在 Claude 的 Artifact 裡重新發佈時，保留設定和進行中的比賽
  const hot = window.claude && window.claude.hot;
  if (hot && typeof hot.snapshot === 'function') {
    try {
      hot.snapshot(() => ({
        settings: Object.assign({}, settings),
        save: G.screen === 'play' && G.s && !G.s.over ? { cfg: G.cfg, s: G.s } : null,
      }));
    } catch {
      /* 沒有熱更新也沒關係 */
    }
  }

  function boot(data) {
    if (data && data.settings) Object.assign(settings, sanitize(data.settings));
    Sound.set(settings.sound);
    updateSoundButton();
    buildPad();
    syncMenu();
    resize();
    requestAnimationFrame(frame);
    if (data && data.save && data.save.s && data.save.cfg) startMatch(data.save);
    else showMenu();
  }

  if (hot && typeof hot.ready === 'function') hot.ready(boot);
  else boot((hot && hot.data) || {});
})();
