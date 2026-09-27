/*
 * 紅不讓棒球 — 核心邏輯
 *
 * 這個檔案只負責「規則與計算」：好壞球與出局、壘上跑者、局數與勝負、
 * 投球軌跡、揮棒判定、擊球飛行、守備與跑壘結果、電腦投打 AI。
 * 不碰 DOM，所以瀏覽器（game.js）和 Node（tests/）都能直接載入。
 *
 * 座標系（單位：公尺、秒）
 *   原點：本壘板　+x：朝一壘／右外野　+y：朝中外野　+z：朝上
 */
(function (root, factory) {
  const core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  else root.BaseballCore = core;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEG = Math.PI / 180;
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const dist2d = (ax, ay, bx, by) => Math.sqrt((ax - bx) * (ax - bx) + (ay - by) * (ay - by));

  // ───────────── 亂數（可指定種子，方便測試重現） ─────────────

  function makeRng(seed) {
    let a = seed >>> 0 || 1;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randn(rng) {
    let u = 0;
    while (u === 0) u = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  }

  function pickWeighted(rng, weights) {
    const keys = Object.keys(weights);
    let total = 0;
    for (const k of keys) total += weights[k];
    let r = rng() * total;
    for (const k of keys) {
      r -= weights[k];
      if (r < 0) return k;
    }
    return keys[keys.length - 1];
  }

  // ───────────── 球場 ─────────────

  const FIELD = {
    baseDist: 27.43, // 壘間距離
    moundY: 18.44, // 投手板到本壘
    fenceLine: 97, // 左右外野全壘打牆
    fenceCenter: 118, // 中外野全壘打牆
    fenceHeight: 3.3,
    foulAngle: 45, // 界外線與中線的夾角（度）
  };

  // 0 本壘、1 一壘、2 二壘、3 三壘（4 代表跑回本壘）
  const BASES = [
    { x: 0, y: 0 },
    { x: 19.4, y: 19.4 },
    { x: 0, y: 38.8 },
    { x: -19.4, y: 19.4 },
  ];
  const basePos = (b) => BASES[b % 4];

  // 擊球方向（度）：0 是中外野，負值往左外野，正值往右外野
  function sprayOf(x, y) {
    return Math.atan2(x, y) / DEG;
  }

  function fenceDistance(sprayDeg) {
    const a = Math.min(Math.abs(sprayDeg), FIELD.foulAngle) * DEG;
    return FIELD.fenceLine + (FIELD.fenceCenter - FIELD.fenceLine) * Math.cos(2 * a);
  }

  // 好球帶（規則上的框），判定時再加上球的半徑
  const ZONE = { halfW: 0.216, bottom: 0.5, top: 1.04 };
  const BALL_R = 0.037;

  function isStrike(x, z) {
    return Math.abs(x) <= ZONE.halfW + BALL_R && z >= ZONE.bottom - BALL_R && z <= ZONE.top + BALL_R;
  }

  // ───────────── 投球 ─────────────

  // speed：球速 km/h；ax / az：橫向與垂直加速度（m/s²，az 已含重力），決定變化方向與幅度
  // control：控球誤差倍率；trick：騙打者的程度（電腦打者用）
  const PITCHES = {
    FB: { id: 'FB', name: '直球', speed: 147, spread: 3, ax: -1.5, az: -4.8, control: 1.0, trick: 0 },
    SL: { id: 'SL', name: '滑球', speed: 133, spread: 3, ax: 8.5, az: -12, control: 1.15, trick: 1.0 },
    CB: { id: 'CB', name: '曲球', speed: 117, spread: 3, ax: 3.5, az: -18, control: 1.25, trick: 1.2 },
    CH: { id: 'CH', name: '變速球', speed: 125, spread: 3, ax: -4.5, az: -13, control: 1.1, trick: 0.9 },
  };
  const PITCH_ORDER = ['FB', 'SL', 'CB', 'CH'];

  // 右投手的出手點（從捕手方向看在左側）
  const RELEASE = { x: -0.5, y: 16.9, z: 1.78 };

  // 真實飛行時間（秒）：球出手後會減速，平均球速約為初速的 93%
  function flightTime(speedKmh) {
    return RELEASE.y / ((speedKmh / 3.6) * 0.93);
  }

  /**
   * 建立一顆球。target 是投手瞄準的進壘點（本壘板平面上的 x, z），
   * 會加上控球誤差；軌跡是拋物線，終點就是實際進壘點，變化球會「彎進」終點。
   * slow 是慢動作倍率：遊戲時間 = 真實時間 × slow，讓人來得及反應。
   */
  function createPitch(opts) {
    const rng = opts.rng || Math.random;
    const def = PITCHES[opts.type] || PITCHES.FB;
    const slow = opts.slow || 1.85;
    const speed = def.speed + (rng() * 2 - 1) * def.spread;
    const sigma = (opts.control == null ? 0.05 : opts.control) * def.control;
    const aim = { x: clamp(opts.target.x, -0.9, 0.9), z: clamp(opts.target.z, 0.15, 1.6) };
    const end = { x: aim.x + randn(rng) * sigma, z: Math.max(0.12, aim.z + randn(rng) * sigma) };
    const Tr = flightTime(speed);
    const R = RELEASE;
    return {
      type: def.id,
      name: def.name,
      speed: Math.round(speed),
      release: R,
      aim,
      end,
      ax: def.ax,
      az: def.az,
      vx: (end.x - R.x - 0.5 * def.ax * Tr * Tr) / Tr,
      vy: -R.y / Tr,
      vz: (end.z - R.z - 0.5 * def.az * Tr * Tr) / Tr,
      Treal: Tr,
      slow,
      T: Tr * slow, // 遊戲時間中，球抵達本壘板的時刻
      strike: isStrike(end.x, end.z),
      hbp: end.x < -0.6 && end.z > 0.25 && end.z < 1.75,
    };
  }

  // t：出手後經過的遊戲秒數
  function pitchPos(p, t) {
    const tr = t / p.slow;
    return {
      x: p.release.x + p.vx * tr + 0.5 * p.ax * tr * tr,
      y: p.release.y + p.vy * tr,
      z: p.release.z + p.vz * tr + 0.5 * p.az * tr * tr,
    };
  }

  // 雙人鍵盤對戰時，投手用方向鍵選的九宮格進壘點
  function gridTarget(h, v) {
    return { x: h * 0.17, z: v > 0 ? 0.97 : v < 0 ? 0.6 : 0.78 };
  }

  // ───────────── 揮棒判定 ─────────────

  const SWING = {
    lag: 0.06, // 按下揮棒到球棒進入擊球點的時間（遊戲秒）
    perfect: 0.035, // 完美時機 ±
    window: 0.14, // 碰得到球的時機 ±
    shift: 0.25, // 時機偏差換算成擊球點前後位移的比例
    evBase: 74, // 擊球初速 = evBase + evGain × 擊球品質（km/h）
    evGain: 106,
    rx: 0.13, // 打擊圈半寬（公尺）
    rz: 0.12, // 打擊圈半高
  };

  /**
   * 揮棒結果。
   *  時機：太早 → 拉打（往左外野）、太晚 → 推打（往右外野），太偏就是界外。
   *  上下：球在打擊圈中心上方 → 打到球的下緣 → 高飛球；球在下方 → 滾地球。
   *  兩者越準，擊球初速（ev）越快。
   */
  function evaluateSwing(opts) {
    const { pitch, swingTime, cursor } = opts;
    const rng = opts.rng || Math.random;
    const meet = opts.meet || 1;
    const tc = swingTime + SWING.lag;
    const e = tc - pitch.T;
    const out = { timing: e, tc, contact: false, foul: false, tip: false };
    out.timingLabel = Math.abs(e) <= SWING.perfect ? 'perfect' : e < 0 ? 'early' : 'late';
    const bp = pitchPos(pitch, Math.max(0, pitch.T + SWING.shift * e));
    const dx = (bp.x - cursor.x) / (SWING.rx * meet);
    const dz = (bp.z - cursor.z) / (SWING.rz * meet);
    const d = Math.sqrt(dx * dx + dz * dz);
    out.dx = dx;
    out.dz = dz;
    out.d = d;
    out.ballAt = bp;
    if (Math.abs(e) > SWING.window || d > 1) return out;

    out.contact = true;
    const at = Math.abs(e);
    const qt = at <= SWING.perfect ? 1 : 1 - (0.65 * (at - SWING.perfect)) / (SWING.window - SWING.perfect);
    const qd = 1 - 0.5 * dx * dx - 0.7 * dz * dz;
    const q = qt * Math.max(0.2, qd);
    out.quality = q;
    // power / lift：全壘打大賽時打者刻意拉高擊球角度、全力揮棒
    out.ev = clamp(SWING.evBase + SWING.evGain * q + 0.12 * (pitch.speed - 130) + (opts.power || 0) + randn(rng) * 3.5, 45, 195);
    out.la = clamp(12 + (opts.lift || 0) + 30 * dz + 30 * dz * dz * dz + randn(rng) * 4, -50, 85);
    out.spray = 52 * (e / SWING.window) + 7 * dx + randn(rng) * 5;
    if (Math.abs(out.spray) > FIELD.foulAngle) {
      out.foul = true;
    } else if (d > 0.88 && rng() < 0.55) {
      // 擦棒：只碰到球的邊緣，往後方飛
      out.foul = true;
      out.tip = true;
      out.spray = (rng() < 0.5 ? -1 : 1) * (115 + rng() * 45);
      out.la = 25 + rng() * 35;
      out.ev = Math.min(out.ev, 110);
    }
    return out;
  }

  // ───────────── 擊球飛行 ─────────────

  const PHYS = {
    g: 9.8,
    drag: 0.0038, // 空氣阻力係數（已含球的質量與截面積）
    bounce: 0.42, // 落地反彈的垂直保留比例
    bounceKeep: 0.72, // 落地後水平速度保留比例
    roll: 4.2, // 草地滾動減速度 m/s²
    dt: 1 / 240,
    sample: 1 / 60,
  };

  /**
   * 模擬擊出去的球：飛行、撞牆、落地彈跳、滾動。
   * 回傳的 path 每 1/60 秒一個取樣點，air=true 代表球還沒碰過地面或牆（可以接殺）。
   */
  function simulateBattedBall(evKmh, laDeg, sprayDeg) {
    const v = evKmh / 3.6;
    const la = laDeg * DEG;
    const sp = sprayDeg * DEG;
    const fair = Math.abs(sprayDeg) <= FIELD.foulAngle;
    let x = 0;
    let y = 0.4;
    let z = 0.85;
    let vx = v * Math.cos(la) * Math.sin(sp);
    let vy = v * Math.cos(la) * Math.cos(sp);
    let vz = v * Math.sin(la);
    const path = [{ t: 0, x, y, z, air: true }];
    const dt = PHYS.dt;
    let t = 0;
    let nextSample = PHYS.sample;
    let apex = z;
    let landing = null;
    let wall = null;
    let hr = null;
    let inAir = true;
    let rolling = false;
    let stopped = false;
    let visualEnd = false;

    while (t < 15) {
      if (!rolling) {
        const s = Math.sqrt(vx * vx + vy * vy + vz * vz);
        vx -= PHYS.drag * s * vx * dt;
        vy -= PHYS.drag * s * vy * dt;
        vz -= (PHYS.g + PHYS.drag * s * vz) * dt;
      } else {
        const hs = Math.sqrt(vx * vx + vy * vy);
        if (hs < 0.3) {
          vx = 0;
          vy = 0;
          stopped = true;
        } else {
          const k = Math.max(0, hs - PHYS.roll * dt) / hs;
          vx *= k;
          vy *= k;
        }
      }
      x += vx * dt;
      y += vy * dt;
      z += vz * dt;
      t += dt;
      if (z > apex) apex = z;

      if (hr) {
        // 全壘打：繼續飛，算出「落在地面高度時」的距離；看台從牆頂往後升高，球落進看台就不再畫
        const r = Math.sqrt(x * x + y * y);
        const standZ = FIELD.fenceHeight + (r - fenceDistance(sprayOf(x, y))) * 0.55;
        if (!visualEnd && z <= standZ) {
          visualEnd = true;
          path.push({ t, x, y, z, air: true });
          hr.landT = t;
        }
        if (z <= 0) {
          hr.distance = r;
          break;
        }
        if (!visualEnd && t >= nextSample) {
          path.push({ t, x, y, z, air: true });
          nextSample += PHYS.sample;
        }
        continue;
      }

      // 全壘打牆
      if (fair) {
        const r = Math.sqrt(x * x + y * y);
        const phi = sprayOf(x, y);
        const fd = fenceDistance(phi);
        if (Math.abs(phi) <= FIELD.foulAngle && r >= fd) {
          if (inAir && z > FIELD.fenceHeight) {
            hr = { t, x, y, z, distance: 0, landT: 0 };
            path.push({ t, x, y, z, air: true });
            continue;
          }
          const nx = x / r;
          const ny = y / r;
          const vr = vx * nx + vy * ny;
          if (vr > 0) {
            vx = (vx - 1.4 * vr * nx) * 0.7;
            vy = (vy - 1.4 * vr * ny) * 0.7;
          }
          x = nx * (fd - 0.05);
          y = ny * (fd - 0.05);
          if (!wall) wall = { t, x, y, z };
          inAir = false;
        }
      }

      // 落地彈跳
      if (!rolling && z <= 0) {
        z = 0;
        if (!landing) landing = { t, x, y };
        inAir = false;
        vz = -vz * PHYS.bounce;
        vx *= PHYS.bounceKeep;
        vy *= PHYS.bounceKeep;
        if (vz < 1.2) {
          vz = 0;
          rolling = true;
        }
      }

      if (t >= nextSample || stopped) {
        path.push({ t, x, y, z, air: inAir });
        nextSample += PHYS.sample;
      }
      if (stopped) break;
    }

    let distance = 0;
    if (hr) distance = hr.distance || Math.sqrt(x * x + y * y);
    else if (wall && (!landing || wall.t < landing.t)) distance = Math.sqrt(wall.x * wall.x + wall.y * wall.y);
    else if (landing) distance = Math.sqrt(landing.x * landing.x + landing.y * landing.y);

    return { ev: evKmh, la: laDeg, spray: sprayDeg, fair, path, apex, landing, wall, hr: !!hr, hrInfo: hr, distance };
  }

  // ───────────── 守備與跑壘 ─────────────

  const FIELDERS = [
    { id: 'P', name: '投手', x: 0, y: 17.6, speed: 5.8, reach: 1.3, react: 0.3, infield: true },
    { id: 'C', name: '捕手', x: 0, y: -1.0, speed: 5.2, reach: 1.2, react: 0.35, infield: true },
    { id: '1B', name: '一壘手', x: 16.5, y: 24.5, speed: 6.2, reach: 1.7, react: 0.25, infield: true },
    { id: '2B', name: '二壘手', x: 9.5, y: 35.5, speed: 6.6, reach: 1.9, react: 0.25, infield: true },
    { id: '3B', name: '三壘手', x: -16.5, y: 25.0, speed: 6.2, reach: 1.8, react: 0.25, infield: true },
    { id: 'SS', name: '游擊手', x: -9.5, y: 35.5, speed: 6.8, reach: 1.9, react: 0.25, infield: true },
    { id: 'LF', name: '左外野手', x: -44, y: 76, speed: 7.3, reach: 1.9, react: 0.4, infield: false },
    { id: 'CF', name: '中外野手', x: 0, y: 92, speed: 7.6, reach: 1.9, react: 0.4, infield: false },
    { id: 'RF', name: '右外野手', x: 44, y: 76, speed: 7.3, reach: 1.9, react: 0.4, infield: false },
  ];
  const FIELDER_BY_ID = {};
  for (const f of FIELDERS) FIELDER_BY_ID[f.id] = f;
  const AREA = { P: '投手', C: '捕手', '1B': '一壘', '2B': '二壘', '3B': '三壘', SS: '游擊', LF: '左外野', CF: '中外野', RF: '右外野' };

  const RUN = {
    first: 4.3, // 打者從擊球到踩上一壘
    perBase: 3.6, // 之後每多跑一個壘包
    lead: 3.9, // 壘上跑者（有離壘）跑到下一個壘包
  };
  const THROW = { speed: 33, ofSpeed: 28, transfer: 0.5, relay: 0.6, ofPickup: 0.8 };

  const FIELDING = {
    accel: 10, // 守備員起跑加速度 m/s²
    catchAir: 2.7, // 飛球：跳起來接得到的高度
    catchGround: 1.5, // 彈跳球：伸手撿得到的高度
  };

  // 守備員在 t 秒內能跑多遠（先反應、再加速到最高速）
  function runDistance(f, t) {
    const tau = t - f.react;
    if (tau <= 0) return 0;
    const a = FIELDING.accel;
    const tAcc = f.speed / a;
    return tau < tAcc ? 0.5 * a * tau * tau : 0.5 * f.speed * tAcc + f.speed * (tau - tAcc);
  }

  // 跑 d 公尺需要的時間（runDistance 的反函數）
  function runTime(f, d) {
    const a = FIELDING.accel;
    const tAcc = f.speed / a;
    const dAcc = 0.5 * f.speed * tAcc;
    return f.react + (d < dAcc ? Math.sqrt((2 * d) / a) : tAcc + (d - dAcc) / f.speed);
  }

  function fielderMargin(f, p) {
    return runDistance(f, p.t) + f.reach - dist2d(p.x, p.y, f.x, f.y);
  }

  function scanFielders(path, start, excluded) {
    for (let i = start; i < path.length; i++) {
      const p = path[i];
      if (p.z > (p.air ? FIELDING.catchAir : FIELDING.catchGround)) continue;
      let best = null;
      for (const f of FIELDERS) {
        if (excluded && excluded.id === f.id && p.t < excluded.until) continue;
        const m = fielderMargin(f, p);
        if (m >= 0 && (!best || m > best.margin)) best = { f, i, t: p.t, x: p.x, y: p.y, z: p.z, air: p.air, margin: m };
      }
      if (best) return best;
    }
    return null;
  }

  // 找出第一個處理到球的守備員；飛球在邊緣時要撲接，可能失手
  function fieldBall(path, rng) {
    let excluded = null;
    let start = 1;
    let dove = null;
    for (;;) {
      const hit = scanFielders(path, start, excluded);
      if (!hit) break;
      if (!hit.air) return Object.assign(hit, { dove });
      // 同一名守備員在落地前找最從容的接球點
      let best = hit;
      for (let j = hit.i + 1; j < path.length && path[j].air; j++) {
        const p = path[j];
        if (p.z > FIELDING.catchAir) continue;
        const m = fielderMargin(hit.f, p);
        if (m > best.margin) best = Object.assign({}, hit, { i: j, t: p.t, x: p.x, y: p.y, z: p.z, margin: m });
      }
      if (best.margin < 1.0) {
        if (rng() >= 0.35 + 0.6 * best.margin) {
          dove = { id: best.f.id, t: best.t, x: best.x, y: best.y };
          excluded = { id: best.f.id, until: best.t + 1.3 };
          start = best.i + 1;
          continue;
        }
        best.dive = true;
      }
      return Object.assign(best, { dove });
    }
    // 沒人攔到（例如一路滾到牆邊）：最近的守備員跑過去撿
    const last = path[path.length - 1];
    let best = null;
    for (const f of FIELDERS) {
      const d = dist2d(last.x, last.y, f.x, f.y);
      const t = Math.max(last.t, runTime(f, Math.max(0, d - f.reach)));
      if (!best || t < best.t) best = { f, i: path.length - 1, t, x: last.x, y: last.y, z: 0, air: false, margin: 0 };
    }
    return Object.assign(best, { dove });
  }

  function runLegs(from, to, t0, per, first) {
    const legs = [];
    let t = t0;
    for (let b = from; b < to; b++) {
      const dur = b === from && first ? first : per;
      legs.push({ a: b, b: b + 1, t0: t, t1: t + dur });
      t += dur;
    }
    return { from, to, legs, out: false };
  }

  const batterLegs = (to) => runLegs(0, to, 0.35, RUN.perBase, RUN.first - 0.35);
  const runnerLegs = (from, to, t0) => runLegs(from, to, t0 == null ? 0.15 : t0, RUN.perBase, (t0 == null ? RUN.lead - 0.15 : 3.8));

  // 內野手把球送到某個壘包的時間（能自己踩壘就跑過去）
  function arriveAtBag(f, fp, tf, base) {
    const bag = BASES[base];
    const d = dist2d(fp.x, fp.y, bag.x, bag.y);
    const natural = base === 1 ? f.id === '1B' : f.id === 'SS' || f.id === '2B';
    if (natural && d < 6) return { t: tf + d / 6, run: true, receiver: f.id };
    const receiver = base === 1 ? (f.id === '1B' ? 'P' : '1B') : f.id === 'SS' ? '2B' : 'SS';
    return { t: tf + THROW.transfer + d / THROW.speed, run: false, receiver };
  }

  function ofThrowTime(fp, base) {
    const b = basePos(base);
    const d = dist2d(fp.x, fp.y, b.x, b.y);
    return d / THROW.ofSpeed + (d > 65 ? THROW.relay : 0);
  }

  function areaOfSpray(phi) {
    return phi < -15 ? '左外野' : phi > 15 ? '右外野' : '中外野';
  }

  /**
   * 依擊球飛行結果、壘上狀況判定這一球的結局，並產生給畫面用的動畫資料。
   * ctx.bases：[一壘, 二壘, 三壘] 是否有人；ctx.outs：出局數（擊球前）
   */
  function resolvePlay(bb, ctx) {
    ctx = ctx || {};
    const rng = ctx.rng || Math.random;
    const on = (ctx.bases || [false, false, false]).slice();
    const outs0 = ctx.outs || 0;
    const A = { ballEnd: 0, fielders: [], throws: [], runners: [], marks: [], end: 0, hr: false, holder: null };
    const play = {
      kind: '',
      text: '',
      outs: 0,
      runs: 0,
      hit: false,
      hitBases: 0,
      sacFly: false,
      dive: false,
      bases: [false, false, false],
      distance: Math.round(bb.distance || 0),
      fielder: null,
      bb,
      anim: A,
    };
    const moved = new Set();
    const addRunner = (r) => {
      A.runners.push(r);
      if (r.from > 0) moved.add(r.from);
    };

    if (bb.hr) {
      const runners = [3, 2, 1].filter((b) => on[b - 1]);
      play.kind = 'hr';
      play.hit = true;
      play.hitBases = 4;
      play.runs = runners.length + 1;
      play.text = ['陽春全壘打', '兩分全壘打', '三分全壘打', '滿貫全壘打'][play.runs - 1];
      A.hr = true;
      A.ballEnd = bb.path[bb.path.length - 1].t;
      const trot = Math.min(A.ballEnd, 2.5);
      for (const b of runners) addRunner(runLegs(b, 4, trot, 0.8));
      addRunner(runLegs(0, 4, trot, 0.8));
      A.end = Math.max(A.ballEnd + 1.5, trot + 3.4);
      return play;
    }

    const fd = fieldBall(bb.path, rng);
    const f = fd.f;
    const fp = { x: fd.x, y: fd.y };
    const tf = fd.t;
    play.fielder = f.id;
    A.ballEnd = tf;
    A.holder = f.id;
    const fDist = dist2d(fp.x, fp.y, f.x, f.y);
    A.fielders.push({ id: f.id, from: { x: f.x, y: f.y }, to: fp, t0: f.react, t1: Math.min(tf, runTime(f, fDist)) });
    if (fd.dove && fd.dove.id !== f.id) {
      const g = FIELDER_BY_ID[fd.dove.id];
      A.fielders.push({ id: g.id, from: { x: g.x, y: g.y }, to: { x: fd.dove.x, y: fd.dove.y }, t0: g.react, t1: fd.dove.t, dive: true });
    }
    const dHome = Math.sqrt(fp.x * fp.x + fp.y * fp.y);

    const finish = () => {
      for (let b = 1; b <= 3; b++) if (on[b - 1] && !moved.has(b)) A.runners.push({ from: b, to: b, legs: [], out: false });
      let end = Math.max(A.ballEnd, 0.5);
      for (const m of A.fielders) end = Math.max(end, m.t1);
      for (const th of A.throws) end = Math.max(end, th.t1);
      for (const r of A.runners) if (r.legs.length) end = Math.max(end, r.legs[r.legs.length - 1].t1);
      for (const m of A.marks) end = Math.max(end, m.t);
      A.end = end + 0.5;
      return play;
    };

    // ── 飛球被接殺 ──
    if (fd.air) {
      play.outs = 1;
      let text;
      if (f.infield) {
        play.kind = bb.apex > 9 ? 'popout' : 'lineout';
        text = f.name + (play.kind === 'popout' ? '接殺內野高飛球' : '接殺平飛球');
      } else if (bb.la < 17) {
        play.kind = 'lineout';
        text = AREA[f.id] + '平飛球接殺';
      } else {
        play.kind = 'flyout';
        text = AREA[f.id] + '高飛球接殺';
      }
      if (fd.dive) {
        play.dive = true;
        text = '美技！' + text;
      }
      const nb = on.slice();
      A.marks.push({ t: tf, x: fp.x, y: fp.y, text: 'OUT' });
      let homeRunner = null;
      if (outs0 < 2 && !f.infield) {
        if (on[2] && dHome > 68) {
          homeRunner = runnerLegs(3, 4, tf + 0.15);
          addRunner(homeRunner);
          nb[2] = false;
          play.runs = 1;
          play.sacFly = true;
          text += '，高飛犧牲打';
        }
        if (on[1] && !nb[2] && dHome > 84) {
          addRunner(runnerLegs(2, 3, tf + 0.15));
          nb[1] = false;
          nb[2] = true;
        }
      }
      if (homeRunner) {
        const tIn = homeRunner.legs[homeRunner.legs.length - 1].t1;
        A.throws.push({ from: fp, to: BASES[0], t0: tf + 0.45, t1: Math.max(tIn + 0.35, tf + 0.45 + ofThrowTime(fp, 0)) });
      } else if (!f.infield) {
        A.throws.push({ from: fp, to: BASES[2], t0: tf + 0.5, t1: tf + 0.5 + ofThrowTime(fp, 2) });
      }
      play.text = text;
      play.bases = nb;
      return finish();
    }

    // ── 內野滾地球 ──
    if (f.infield && dHome < 44) {
      const to1 = arriveAtBag(f, fp, tf, 1);
      let result = null;
      let to2 = null;
      let relayT = 0;
      if (on[0] && outs0 < 2) {
        to2 = arriveAtBag(f, fp, tf, 2);
        if (to2.t < RUN.lead) {
          relayT = to2.t + 0.55 + FIELD.baseDist / THROW.speed;
          result = relayT < RUN.first ? 'dp' : 'fc';
        }
      }
      if (!result) result = to1.t < RUN.first ? 'go' : 'ifh';

      const cover = (receiver, base, byT) => {
        if (!receiver || receiver === f.id) return;
        const g = FIELDER_BY_ID[receiver];
        const bag = BASES[base];
        const d = dist2d(g.x, g.y, bag.x, bag.y);
        A.fielders.push({ id: g.id, from: { x: g.x, y: g.y }, to: bag, t0: 0.3, t1: Math.min(byT - 0.15, 0.3 + d / 6.5) });
      };
      const sendTo = (arr, base, t0, fromPt) => {
        if (arr.run) {
          A.fielders.push({ id: f.id, from: fromPt, to: BASES[base], t0, t1: arr.t });
        } else {
          A.throws.push({ from: fromPt, to: BASES[base], t0: t0 + THROW.transfer, t1: arr.t });
          cover(arr.receiver, base, arr.t);
        }
      };

      const batter = batterLegs(1);
      const nb = [false, false, false];
      if (result === 'dp' || result === 'fc') {
        const r1 = runnerLegs(1, 2);
        r1.out = true;
        r1.outAt = to2.t;
        addRunner(r1);
        sendTo(to2, 2, tf, fp);
        A.marks.push({ t: to2.t, x: BASES[2].x, y: BASES[2].y, text: 'OUT' });
        A.holder = to2.run ? f.id : to2.receiver;
        if (result === 'dp') {
          A.throws.push({ from: BASES[2], to: BASES[1], t0: to2.t + 0.55, t1: relayT });
          cover('1B', 1, relayT);
          batter.out = true;
          batter.outAt = relayT;
          A.marks.push({ t: relayT, x: BASES[1].x, y: BASES[1].y, text: 'OUT' });
          A.holder = '1B';
          play.kind = 'dp';
          play.outs = 2;
          play.text = AREA[f.id] + '滾地球，雙殺打';
        } else {
          play.kind = 'fc';
          play.outs = 1;
          play.text = AREA[f.id] + '滾地球，野手選擇';
          nb[0] = true;
        }
      } else if (result === 'go') {
        batter.out = true;
        batter.outAt = to1.t;
        sendTo(to1, 1, tf, fp);
        A.marks.push({ t: to1.t, x: BASES[1].x, y: BASES[1].y, text: 'OUT' });
        A.holder = to1.run ? f.id : to1.receiver;
        play.kind = 'groundout';
        play.outs = 1;
        play.text = AREA[f.id] + '滾地球出局';
      } else {
        sendTo(to1, 1, tf, fp);
        A.holder = to1.run ? f.id : to1.receiver;
        play.kind = 'single';
        play.hit = true;
        play.hitBases = 1;
        play.text = '內野安打';
        nb[0] = true;
      }
      A.runners.push(batter);

      // 其他跑者：沒有形成第三個出局就各推進一個壘包
      const inningOver = outs0 + play.outs >= 3;
      for (const b of [3, 2, 1]) {
        if (!on[b - 1] || moved.has(b)) continue;
        if (inningOver) continue;
        addRunner(runnerLegs(b, b + 1));
        if (b === 3) play.runs++;
        else nb[b] = true;
      }
      play.bases = nb;
      return finish();
    }

    // ── 安打：看球回傳的時間，決定打者能跑到幾壘 ──
    const tBall = (base) => tf + THROW.ofPickup + ofThrowTime(fp, base);
    let hb = 1;
    if (RUN.first + RUN.perBase + 0.2 < tBall(2)) hb = 2;
    if (hb >= 2 && RUN.first + 2 * RUN.perBase + 0.2 < tBall(3)) hb = 3;
    if (hb >= 3 && RUN.first + 3 * RUN.perBase + 0.4 < tBall(4)) hb = 4;

    const nb = [false, false, false];
    let leadTarget = 99;
    for (const b of [3, 2, 1]) {
      if (!on[b - 1]) continue;
      let adv = hb;
      if (hb === 1 && b === 2) adv = 2;
      if (hb === 1 && b === 1 && tf > 3.2) adv = 2;
      if (hb === 2 && b === 1 && tf > 3.4) adv = 3;
      let target = Math.min(b + adv, 4);
      if (leadTarget < 4 && target >= leadTarget) target = leadTarget - 1;
      leadTarget = target;
      addRunner(runnerLegs(b, target));
      if (target >= 4) play.runs++;
      else nb[target - 1] = true;
    }
    A.runners.push(batterLegs(hb));
    if (hb >= 4) play.runs++;
    else nb[hb - 1] = true;

    const throwBase = Math.min(hb + 1, 4);
    A.throws.push({ from: fp, to: basePos(throwBase), t0: tf + THROW.ofPickup, t1: tf + THROW.ofPickup + ofThrowTime(fp, throwBase) });
    A.holder = null;

    const area = f.infield ? areaOfSpray(sprayOf(fp.x, fp.y)) : AREA[f.id];
    play.kind = ['single', 'double', 'triple', 'ihr'][hb - 1];
    play.hit = true;
    play.hitBases = hb;
    play.text = hb === 4 ? '場內全壘打' : area + ['一壘安打', '二壘安打', '三壘安打'][hb - 1];
    if (bb.wall && hb < 4) play.text += '（打到全壘打牆）';
    play.bases = nb;
    return finish();
  }

  // ───────────── 比賽規則 ─────────────

  const newStats = () => ({ pa: 0, ab: 0, h: 0, hr: 0, bb: 0, so: 0, rbi: 0 });

  function newGame(opts) {
    opts = opts || {};
    const innings = opts.innings || 3;
    return {
      mode: 'game',
      innings,
      maxInnings: innings + 3, // 延長賽最多三局，再平手就和局
      inning: 1,
      half: 0, // 0 上半局（客隊進攻）、1 下半局（主隊進攻）
      outs: 0,
      balls: 0,
      strikes: 0,
      bases: [false, false, false],
      runs: [0, 0],
      hits: [0, 0],
      line: [[0], []],
      stats: [newStats(), newStats()],
      over: false,
      winner: null, // 0 客隊、1 主隊、-1 和局
      walkoff: false,
    };
  }

  function newDerby(opts) {
    opts = opts || {};
    const players = opts.players || 1;
    const pitches = opts.pitches || DERBY.pitches;
    const fill = (v) => Array.from({ length: players }, () => v);
    return {
      mode: 'derby',
      players,
      pitches,
      current: 0,
      left: fill(pitches),
      hrs: fill(0),
      longest: fill(0),
      dist: fill(0),
      over: false,
      winner: null,
    };
  }

  // 保送：只有被迫的跑者才推進；回傳得分
  function forceAdvance(bases) {
    let runs = 0;
    if (bases[0]) {
      if (bases[1]) {
        if (bases[2]) runs = 1;
        bases[2] = true;
      }
      bases[1] = true;
    }
    bases[0] = true;
    return runs;
  }

  const walkoffSpot = (s) => s.half === 1 && s.inning >= s.innings;

  function gameOver(s, ev, winner, walkoff) {
    s.over = true;
    s.winner = winner;
    s.walkoff = !!walkoff;
    ev.push({ kind: 'game_over', winner, walkoff: !!walkoff });
  }

  function score(s, ev, runs) {
    if (runs <= 0) return;
    const team = s.half;
    s.runs[team] += runs;
    s.line[team][s.inning - 1] = (s.line[team][s.inning - 1] || 0) + runs;
    ev.push({ kind: 'score', team, runs });
    if (walkoffSpot(s) && s.runs[1] > s.runs[0]) gameOver(s, ev, 1, true);
  }

  function endHalf(s, ev) {
    ev.push({ kind: 'side_retired', inning: s.inning, half: s.half });
    s.outs = 0;
    s.balls = 0;
    s.strikes = 0;
    s.bases = [false, false, false];
    if (s.half === 0) {
      if (s.inning >= s.innings && s.runs[1] > s.runs[0]) {
        s.line[1][s.inning - 1] = 'X';
        gameOver(s, ev, 1, false);
        return;
      }
      s.half = 1;
    } else {
      if (s.inning >= s.innings && s.runs[0] !== s.runs[1]) {
        gameOver(s, ev, s.runs[0] > s.runs[1] ? 0 : 1, false);
        return;
      }
      if (s.inning >= s.maxInnings) {
        gameOver(s, ev, -1, false);
        return;
      }
      s.inning++;
      s.half = 0;
    }
    s.line[s.half][s.inning - 1] = 0;
    ev.push({ kind: 'half_start', inning: s.inning, half: s.half });
  }

  function addOuts(s, ev, n) {
    s.outs += n;
    if (s.outs >= 3) endHalf(s, ev);
  }

  function endPA(s) {
    s.balls = 0;
    s.strikes = 0;
  }

  /**
   * 把一球的結果套用到比賽狀態上（直接修改 s），回傳事件列表給畫面使用。
   * outcome.type：'ball' | 'strike'（swinging 表示揮空）| 'foul' | 'hbp' | 'inplay'（附 play）
   */
  function applyOutcome(s, o) {
    return s.mode === 'derby' ? applyDerby(s, o) : applyGame(s, o);
  }

  function applyGame(s, o) {
    const ev = [];
    if (s.over) return ev;
    const st = s.stats[s.half];
    switch (o.type) {
      case 'ball':
        s.balls++;
        if (s.balls < 4) {
          ev.push({ kind: 'ball' });
          break;
        }
        st.pa++;
        st.bb++;
        ev.push({ kind: 'walk', text: '四壞球保送' });
        endPA(s);
        score(s, ev, forceAdvance(s.bases));
        break;
      case 'hbp':
        st.pa++;
        st.bb++;
        ev.push({ kind: 'hbp', text: '觸身球保送' });
        endPA(s);
        score(s, ev, forceAdvance(s.bases));
        break;
      case 'strike':
        s.strikes++;
        if (s.strikes < 3) {
          ev.push({ kind: 'strike', swinging: !!o.swinging });
          break;
        }
        st.pa++;
        st.ab++;
        st.so++;
        ev.push({ kind: 'strikeout', swinging: !!o.swinging, text: o.swinging ? '揮棒落空，三振出局' : '站著不動，三振出局' });
        endPA(s);
        addOuts(s, ev, 1);
        break;
      case 'foul':
        if (s.strikes < 2) s.strikes++;
        ev.push({ kind: 'foul' });
        break;
      case 'inplay': {
        const p = o.play;
        st.pa++;
        if (!p.sacFly) st.ab++;
        if (p.hit) {
          st.h++;
          s.hits[s.half]++;
          if (p.hitBases === 4) st.hr++;
        }
        ev.push({ kind: 'play', play: p, text: p.text });
        endPA(s);
        s.bases = p.bases.slice();
        let runs = p.runs;
        if (runs > 0 && walkoffSpot(s) && p.kind !== 'hr') {
          // 再見安打：只算到超前的那一分
          const need = s.runs[0] - s.runs[1] + 1;
          if (need > 0 && runs > need) runs = need;
        }
        st.rbi += runs;
        score(s, ev, runs);
        if (!s.over && p.outs) addOuts(s, ev, p.outs);
        break;
      }
    }
    return ev;
  }

  function derbyWinner(s) {
    if (s.players < 2) return 0;
    if (s.hrs[0] !== s.hrs[1]) return s.hrs[0] > s.hrs[1] ? 0 : 1;
    if (s.longest[0] !== s.longest[1]) return s.longest[0] > s.longest[1] ? 0 : 1;
    return -1;
  }

  // 全壘打大賽的打擊加成（打者刻意拉高角度、全力揮棒）
  const DERBY = { power: 5, lift: 7, pitches: 10 };

  // 全壘打大賽：每人固定球數，只有飛出全壘打牆才算；沒揮棒的壞球不扣球數
  function applyDerby(s, o) {
    const ev = [];
    if (s.over) return ev;
    const p = s.current;
    if (o.type === 'ball' || o.type === 'hbp') {
      ev.push({ kind: 'derby_ball', player: p });
      return ev;
    }
    s.left[p] = Math.max(0, s.left[p] - 1);
    const play = o.type === 'inplay' ? o.play : null;
    if (play && play.kind === 'hr') {
      const d = Math.round(play.distance);
      s.hrs[p]++;
      s.dist[p] += d;
      if (d > s.longest[p]) s.longest[p] = d;
      ev.push({ kind: 'derby_hr', player: p, distance: d });
    } else {
      ev.push({ kind: 'derby_pitch', player: p });
    }
    if (s.left[p] === 0) {
      if (p + 1 < s.players) {
        s.current = p + 1;
        ev.push({ kind: 'derby_next', player: s.current });
      } else {
        s.over = true;
        s.winner = derbyWinner(s);
        ev.push({ kind: 'game_over', winner: s.winner });
      }
    }
    return ev;
  }

  // ───────────── 電腦 AI ─────────────

  const LEVELS = {
    easy: {
      name: '簡單',
      slow: 2.25,
      meet: 1.25,
      pitch: { zone: 0.58, edge: 0.2, control: 0.07, mix: { FB: 0.62, SL: 0.14, CB: 0.08, CH: 0.16 } },
      bat: { read: 0.075, swingStrike: 0.6, swingBall: 0.28, timing: 0.08, aim: 0.088, guessFast: 0.8, lift: 0.01 },
    },
    normal: {
      name: '普通',
      slow: 1.85,
      meet: 1.0,
      pitch: { zone: 0.47, edge: 0.45, control: 0.055, mix: { FB: 0.46, SL: 0.2, CB: 0.14, CH: 0.2 } },
      bat: { read: 0.055, swingStrike: 0.72, swingBall: 0.18, timing: 0.066, aim: 0.078, guessFast: 0.66, lift: 0 },
    },
    hard: {
      name: '困難',
      slow: 1.55,
      meet: 0.86,
      pitch: { zone: 0.45, edge: 0.65, control: 0.042, mix: { FB: 0.42, SL: 0.22, CB: 0.16, CH: 0.2 } },
      bat: { read: 0.04, swingStrike: 0.8, swingBall: 0.14, timing: 0.058, aim: 0.07, guessFast: 0.6, lift: -0.008 },
    },
  };
  const level = (name) => LEVELS[name] || LEVELS.normal;

  // 電腦投手：依球數決定要不要進好球帶、投什麼球
  function cpuChoosePitch(s, levelName, rng, opts) {
    rng = rng || Math.random;
    if (opts && opts.derby) {
      return { type: rng() < 0.78 ? 'FB' : 'CH', target: { x: randn(rng) * 0.06, z: 0.78 + randn(rng) * 0.07 } };
    }
    const L = level(levelName).pitch;
    const b = s ? s.balls : 0;
    const k = s ? s.strikes : 0;
    let zoneP = L.zone;
    if (b === 3) zoneP += 0.3;
    else if (b - k >= 2) zoneP += 0.18;
    else if (k === 2 && b < 2) zoneP -= 0.25;
    else if (k > b) zoneP -= 0.08;

    const w = Object.assign({}, L.mix);
    if (k === 2) {
      w.SL *= 1.4;
      w.CB *= 1.4;
      w.CH *= 1.2;
    }
    if (b >= 2 && b > k) w.FB *= 1.7;
    const type = pickWeighted(rng, w);

    let target;
    if (rng() < clamp(zoneP, 0.1, 0.95)) {
      if (rng() < L.edge) {
        const side = rng() < 0.5 ? -1 : 1;
        target = rng() < 0.5
          ? { x: side * (0.13 + rng() * 0.06), z: 0.62 + rng() * 0.34 }
          : { x: (rng() * 2 - 1) * 0.15, z: rng() < 0.5 ? 0.58 + rng() * 0.07 : 0.93 + rng() * 0.07 };
      } else {
        target = { x: (rng() * 2 - 1) * 0.12, z: 0.68 + rng() * 0.22 };
      }
    } else if (type === 'FB') {
      target = rng() < 0.6 ? { x: (rng() * 2 - 1) * 0.18, z: 1.18 + rng() * 0.1 } : { x: -0.34 - rng() * 0.06, z: 0.85 + rng() * 0.2 };
    } else if (type === 'SL') {
      target = { x: 0.32 + rng() * 0.08, z: 0.42 + rng() * 0.2 };
    } else if (type === 'CB') {
      target = { x: (rng() * 2 - 1) * 0.15, z: 0.3 + rng() * 0.12 };
    } else {
      target = { x: 0.08 + rng() * 0.2, z: 0.34 + rng() * 0.1 };
    }
    return { type, target };
  }

  // 電腦打者：判斷好壞球決定要不要揮，時機與瞄準帶有誤差；猜直球卻來變化球時，容易太早揮、揮在球的上方
  function cpuBatterPlan(pitch, s, levelName, rng) {
    rng = rng || Math.random;
    const L = level(levelName).bat;
    const trick = PITCHES[pitch.type].trick;
    const read = L.read * (1 + 0.7 * trick);
    const looksStrike = isStrike(pitch.end.x + randn(rng) * read, pitch.end.z + randn(rng) * read);
    let p = looksStrike ? L.swingStrike : L.swingBall;
    if (s && s.strikes === 2) p += looksStrike ? 0.14 : 0.12;
    if (s && s.balls === 3 && s.strikes < 2) p -= 0.18;
    if (s && s.balls === 3 && s.strikes === 0) p -= 0.35;
    if (rng() >= clamp(p, 0.02, 0.97)) return null;

    const guessFast = rng() < L.guessFast;
    const fooled = guessFast && pitch.type !== 'FB';
    const expectT = (guessFast ? flightTime(PITCHES.FB.speed) : flightTime(124)) * pitch.slow;
    const bias = (expectT - pitch.T) * 0.35;
    const swingTime = pitch.T - SWING.lag + bias + randn(rng) * L.timing;
    const aim = L.aim * (1 + 0.4 * trick);
    const at = pitchPos(pitch, pitch.T);
    return {
      swingTime,
      cursor: { x: at.x + randn(rng) * aim, z: at.z + randn(rng) * aim + L.lift + (fooled ? 0.035 * trick : 0) },
    };
  }

  // ───────────── 整合：一球從投出到結果 ─────────────

  function resolvePitch(s, pitch, swing, opts) {
    opts = opts || {};
    const rng = opts.rng || Math.random;
    if (!swing) {
      if (pitch.hbp) return { type: 'hbp' };
      return { type: pitch.strike ? 'strike' : 'ball', swinging: false };
    }
    const derby = s.mode === 'derby';
    const sw = evaluateSwing({
      pitch,
      swingTime: swing.swingTime,
      cursor: swing.cursor,
      meet: opts.meet || 1,
      power: derby ? DERBY.power : 0,
      lift: derby ? DERBY.lift : 0,
      rng,
    });
    if (!sw.contact) return { type: 'strike', swinging: true, swing: sw };
    if (sw.foul) return { type: 'foul', swing: sw };
    const bb = simulateBattedBall(sw.ev, sw.la, sw.spray);
    const play = resolvePlay(bb, { bases: derby ? null : s.bases, outs: derby ? 0 : s.outs, rng });
    return { type: 'inplay', swing: sw, play };
  }

  // 電腦對電腦投一球（測試與「電腦代投」快轉用）
  function simulatePitch(s, cfg, rng) {
    const pl = cfg.pitchLevel || 'normal';
    const choice = cpuChoosePitch(s, pl, rng);
    const pitch = createPitch({ type: choice.type, target: choice.target, slow: level(pl).slow, control: level(pl).pitch.control, rng });
    const plan = cpuBatterPlan(pitch, s, cfg.batLevel || 'normal', rng);
    const outcome = resolvePitch(s, pitch, plan, { rng });
    return { pitch, outcome, events: applyOutcome(s, outcome) };
  }

  // 快轉電腦的半局，回傳每位打者的結果文字
  function simulateHalfInning(s, cfg, rng) {
    const half = s.half;
    const inning = s.inning;
    const log = [];
    for (let guard = 0; guard < 600 && !s.over && s.half === half && s.inning === inning; guard++) {
      const { events } = simulatePitch(s, cfg, rng);
      for (const e of events) {
        if (e.text) log.push({ text: e.text, kind: e.kind, play: e.play || null });
        if (e.kind === 'score') log.push({ text: `得 ${e.runs} 分`, kind: 'score', runs: e.runs });
      }
    }
    return log;
  }

  function simulateGame(cfg, rng) {
    const s = newGame({ innings: cfg.innings || 9 });
    for (let guard = 0; guard < 20000 && !s.over; guard++) simulatePitch(s, cfg, rng);
    return s;
  }

  return {
    // 工具
    makeRng,
    randn,
    clamp,
    // 球場與規則常數
    FIELD,
    BASES,
    ZONE,
    BALL_R,
    PITCHES,
    PITCH_ORDER,
    RELEASE,
    SWING,
    PHYS,
    FIELDERS,
    FIELDING,
    LEVELS,
    RUN,
    THROW,
    DERBY,
    fenceDistance,
    sprayOf,
    isStrike,
    // 投打
    flightTime,
    createPitch,
    pitchPos,
    gridTarget,
    evaluateSwing,
    simulateBattedBall,
    fieldBall,
    resolvePlay,
    resolvePitch,
    // 比賽
    newGame,
    newDerby,
    applyOutcome,
    forceAdvance,
    // 電腦
    cpuChoosePitch,
    cpuBatterPlan,
    simulatePitch,
    simulateHalfInning,
    simulateGame,
  };
});
