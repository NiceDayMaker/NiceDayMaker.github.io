/* 매개변수곡선 인터랙티브 그림 — 모든 절에서 공용으로 사용
 *
 * Plot.mount(figureEl, {
 *   t: { min, max, value, label },      // 매개변수 범위 (label: 't', 'θ' 등)
 *   duration: 6,                         // 재생 시 처음부터 끝까지 걸리는 초
 *   panels: [ panelCfg, ... ],          // 같은 슬라이더를 공유하는 그래프들
 *   readout: t => html,                  // 슬라이더 아래 표시할 값
 *   controls: html                       // 추가 조작부(토글, 슬라이더)
 * })
 *
 * panelCfg = {
 *   x: t => .., y: t => ..,             // 매개변수방정식
 *   view: { x:[a,b], y:[c,d] },         // 보이는 범위 (height 없으면 x,y 축척 동일)
 *   height,                              // 고정 높이(px): x,y 축척을 따로 둘 때
 *   grid: 1, ticks: { x:[..], y:[..] }, axisLabels: ['x','y'],
 *   ghost: true,                         // 전체 경로를 점선으로 미리 보여줄지
 *   arrows: 4,                           // 방향 화살표 개수
 *   markStart, color: '--curve', map: (x,y,t)=>[x,y],
 *   under(ctx, T, t, C), over(ctx, T, t, C)  // 추가로 그릴 것
 * }
 */
(function () {
  "use strict";
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  function palette() {
    return {
      ink: cssVar("--ink"), muted: cssVar("--muted"), grid: cssVar("--grid"), axis: cssVar("--axis"),
      curve: cssVar("--curve"), aux: cssVar("--aux"), auxSoft: cssVar("--aux-soft"),
      surface: cssVar("--surface"), rule: cssVar("--rule"), ok: cssVar("--ok"),
      get: (n) => cssVar(n),
    };
  }

  function fmt(v, d) {
    d = d == null ? 2 : d;
    if (Math.abs(v) < 0.5 * Math.pow(10, -d)) v = 0;
    return v.toFixed(d).replace("-", "−");
  }
  function fmtPi(t) {
    const k = t / Math.PI;
    if (Math.abs(k) < 0.005) return "0";
    if (Math.abs(k - 1) < 0.005) return "π";
    return fmt(k) + "π";
  }

  /* ---------- 그리기 도구 ---------- */
  function arrowHead(ctx, x, y, ang, size, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(size, 0);
    ctx.lineTo(-size * 0.8, size * 0.62);
    ctx.lineTo(-size * 0.45, 0);
    ctx.lineTo(-size * 0.8, -size * 0.62);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  function dot(ctx, x, y, r, fill, ring) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    if (ring) { ctx.lineWidth = 2.5; ctx.strokeStyle = ring; ctx.stroke(); }
    ctx.fillStyle = fill;
    ctx.fill();
  }
  function hollow(ctx, x, y, r, color, bg) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = bg; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = color; ctx.stroke();
  }
  function label(ctx, text, x, y, opt) {
    opt = opt || {};
    ctx.save();
    ctx.font = (opt.italic ? "italic " : "") + (opt.bold ? "600 " : "") + (opt.size || 13) + "px " +
      (opt.math ? '"KaTeX_Math", "Times New Roman", serif' : getComputedStyle(document.body).fontFamily);
    ctx.fillStyle = opt.color || palette().ink;
    ctx.textAlign = opt.align || "left";
    ctx.textBaseline = opt.base || "middle";
    if (opt.halo) {
      ctx.lineWidth = 4; ctx.strokeStyle = opt.halo; ctx.lineJoin = "round";
      ctx.strokeText(text, x, y);
    }
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  /* ---------- 하나의 그래프 패널 ---------- */
  function Panel(host, cfg, plot) {
    this.cfg = cfg;
    this.plot = plot;
    const wrap = document.createElement("div");
    wrap.className = "panel";
    if (cfg.title) {
      const p = document.createElement("p");
      p.className = "panel-title";
      p.innerHTML = cfg.title;
      wrap.appendChild(p);
    }
    if (cfg.maxWidth) { wrap.style.maxWidth = cfg.maxWidth; wrap.style.marginInline = "auto"; wrap.style.width = "100%"; }
    this.canvas = document.createElement("canvas");
    this.canvas.setAttribute("role", "img");
    this.canvas.setAttribute("aria-label", cfg.alt || "매개변수곡선 그래프");
    wrap.appendChild(this.canvas);
    host.appendChild(wrap);
    this.ctx = this.canvas.getContext("2d");
  }

  Panel.prototype.resize = function () {
    const cfg = this.cfg;
    const w = Math.max(10, this.canvas.clientWidth);
    const vx = cfg.view.x, vy = cfg.view.y;
    let h = cfg.height || w * (vy[1] - vy[0]) / (vx[1] - vx[0]);
    if (cfg.maxHeight) h = Math.min(h, cfg.maxHeight);
    const dpr = window.devicePixelRatio || 1;
    this.w = w; this.h = h;
    this.canvas.style.height = h + "px";
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.dpr = dpr;
  };

  Panel.prototype.transform = function () {
    const vx = this.cfg.view.x, vy = this.cfg.view.y, w = this.w, h = this.h;
    const T = {
      X: (x) => (x - vx[0]) / (vx[1] - vx[0]) * w,
      Y: (y) => h - (y - vy[0]) / (vy[1] - vy[0]) * h,
      sx: w / (vx[1] - vx[0]),
      sy: h / (vy[1] - vy[0]),
      w: w, h: h,
    };
    const self = this;
    T.pt = function (t) {
      let x = self.cfg.x(t), y = self.cfg.y(t);
      if (self.cfg.map) { const m = self.cfg.map(x, y, t); x = m[0]; y = m[1]; }
      return [T.X(x), T.Y(y)];
    };
    return T;
  };

  Panel.prototype.path = function (ctx, T, a, b, n) {
    if (b <= a) return;
    const steps = Math.max(2, Math.ceil(n));
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const p = T.pt(a + (b - a) * i / steps);
      if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
    }
  };

  Panel.prototype.draw = function (t) {
    const cfg = this.cfg, ctx = this.ctx, C = palette();
    const T = this.transform();
    const r = this.plot.range;
    const tMin = r.min, tMax = r.max;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, T.w, T.h);

    const vx = cfg.view.x, vy = cfg.view.y;
    // 모눈
    const g = cfg.grid == null ? 1 : cfg.grid;
    if (g) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = C.grid;
      ctx.beginPath();
      for (let gx = Math.ceil(vx[0] / g) * g; gx <= vx[1]; gx += g) { const X = Math.round(T.X(gx)) + 0.5; ctx.moveTo(X, 0); ctx.lineTo(X, T.h); }
      for (let gy = Math.ceil(vy[0] / g) * g; gy <= vy[1]; gy += g) { const Y = Math.round(T.Y(gy)) + 0.5; ctx.moveTo(0, Y); ctx.lineTo(T.w, Y); }
      ctx.stroke();
    }
    // 축
    ctx.strokeStyle = C.axis;
    ctx.lineWidth = 1.3;
    const axL = cfg.axisLabels || ["x", "y"];
    if (vy[0] <= 0 && vy[1] >= 0) {
      const Y = T.Y(0);
      ctx.beginPath(); ctx.moveTo(0, Y); ctx.lineTo(T.w - 2, Y); ctx.stroke();
      arrowHead(ctx, T.w - 4, Y, 0, 6, C.axis);
      label(ctx, axL[0], T.w - 8, Y + 13, { italic: true, math: true, size: 15, color: C.muted, align: "right" });
    }
    if (cfg.yAxis !== false && vx[0] <= 0 && vx[1] >= 0) {
      const X = T.X(0);
      ctx.beginPath(); ctx.moveTo(X, T.h); ctx.lineTo(X, 2); ctx.stroke();
      arrowHead(ctx, X, 4, -Math.PI / 2, 6, C.axis);
      label(ctx, axL[1], X + 9, 12, { italic: true, math: true, size: 15, color: C.muted });
    }
    // 눈금
    const ticks = cfg.ticks || {};
    const tickLab = (v) => (typeof v === "object" ? v : { v: v, label: Number.isInteger(v) ? fmt(v, 0) : String(+v.toFixed(2)).replace("-", "−") });
    const y0 = Math.min(Math.max(T.Y(0), 0), T.h);
    const x0 = Math.min(Math.max(T.X(0), 0), T.w);
    (ticks.x || []).map(tickLab).forEach((k) => {
      const X = T.X(k.v);
      ctx.strokeStyle = C.axis; ctx.beginPath(); ctx.moveTo(X, y0 - 3); ctx.lineTo(X, y0 + 3); ctx.stroke();
      label(ctx, k.label, X, y0 + 13, { size: 11, color: C.muted, align: "center" });
    });
    (ticks.y || []).map(tickLab).forEach((k) => {
      const Y = T.Y(k.v);
      ctx.strokeStyle = C.axis; ctx.beginPath(); ctx.moveTo(x0 - 3, Y); ctx.lineTo(x0 + 3, Y); ctx.stroke();
      label(ctx, k.label, x0 - 6, Y, { size: 11, color: C.muted, align: "right" });
    });
    if (cfg.origin !== false && vx[0] < 0 && vy[0] < 0) {
      label(ctx, "0", T.X(0) - 5, T.Y(0) + 11, { size: 11, color: C.muted, align: "right" });
    }

    if (cfg.under) cfg.under(ctx, T, t, C, r);
    if (cfg.curve === false) { if (cfg.over) cfg.over(ctx, T, t, C, r); return; }

    const color = C.get(cfg.color || "--curve");
    const N = cfg.samples || 500;
    // 전체 경로 미리보기
    if (cfg.ghost !== false) {
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.setLineDash([4, 5]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = color;
      this.path(ctx, T, tMin, tMax, N);
      ctx.stroke();
      ctx.restore();
    }
    // 지나온 경로
    const frac = (t - tMin) / (tMax - tMin || 1);
    ctx.lineWidth = cfg.lineWidth || 2.6;
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.strokeStyle = color;
    this.path(ctx, T, tMin, t, N * frac);
    ctx.stroke();

    // 방향 화살표
    const nA = cfg.arrows == null ? 4 : cfg.arrows;
    for (let i = 0; i < nA; i++) {
      const ta = tMin + (i + 0.5) / nA * (tMax - tMin);
      if (ta > t) break;
      const eps = (tMax - tMin) * 1e-3;
      const p = T.pt(ta), q = T.pt(ta + eps);
      if (Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-6) continue;
      arrowHead(ctx, p[0], p[1], Math.atan2(q[1] - p[1], q[0] - p[0]), 7, color);
    }
    // 시점
    if (cfg.markStart) {
      const s = T.pt(tMin);
      hollow(ctx, s[0], s[1], 4.5, color, C.surface);
    }
    if (cfg.over) cfg.over(ctx, T, t, C, r);
    // 현재 위치
    if (cfg.point !== false) {
      const p = T.pt(t);
      dot(ctx, p[0], p[1], 5.5, color, C.surface);
    }
  };

  /* ---------- 그림 하나 (패널 여러 개 + 조작부) ---------- */
  function mount(fig, opts) {
    const range = { min: opts.t.min, max: opts.t.max };
    const plot = { range: range };
    const panelsEl = document.createElement("div");
    panelsEl.className = "panels";
    panelsEl.style.setProperty("--n", opts.stack ? 1 : opts.panels.length);
    fig.insertBefore(panelsEl, fig.firstChild);
    const panels = opts.panels.map((cfg) => new Panel(panelsEl, cfg, plot));

    const bar = document.createElement("div");
    bar.className = "bar";
    const sym = opts.t.label || "t";
    bar.innerHTML =
      '<button class="play" type="button" aria-label="재생"></button>' +
      '<div class="scrub"><label>' + sym + '</label><input type="range" min="0" max="1000" step="1" aria-label="' + sym + ' 값 조절"></div>' +
      (opts.controls ? '<div class="extra">' + opts.controls + "</div>" : "") +
      '<div class="readout" aria-live="off"></div>';
    panelsEl.after(bar);
    const btn = bar.querySelector(".play");
    const slider = bar.querySelector('.scrub input[type="range"]');
    const readout = bar.querySelector(".readout");

    let t = opts.t.value != null ? opts.t.value : range.max;
    let playing = false, last = 0, raf = 0;
    const duration = opts.duration || 6;

    const ICON_PLAY = '<svg viewBox="0 0 14 14"><path d="M3 1.5v11l9.5-5.5z"/></svg>';
    const ICON_PAUSE = '<svg viewBox="0 0 14 14"><path d="M2.5 1.5h3.2v11H2.5zM8.3 1.5h3.2v11H8.3z"/></svg>';
    function setIcon() {
      btn.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
      btn.setAttribute("aria-label", playing ? "일시정지" : "재생");
    }

    // t.step이 있으면 그림은 그 간격으로 끊어서(이산적으로) 바뀐다
    let step = opts.t.step || 0;
    const snap = (v) => (step ? Math.min(range.max, range.min + Math.floor((v - range.min) / step + 1e-9) * step) : v);
    function render() {
      const tv = snap(t);
      panels.forEach((p) => p.draw(tv));
      slider.value = Math.round((t - range.min) / (range.max - range.min) * 1000);
      if (opts.readout) readout.innerHTML = opts.readout(tv, api);
    }
    function resize() { panels.forEach((p) => p.resize()); render(); }

    function frame(now) {
      if (!playing) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      t += (range.max - range.min) * dt / duration;
      if (t >= range.max) { t = range.max; playing = false; setIcon(); }
      render();
      if (playing) raf = requestAnimationFrame(frame);
    }
    function play() {
      if (t >= range.max - 1e-9) t = range.min;
      playing = true; setIcon();
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
    function pause() { playing = false; cancelAnimationFrame(raf); setIcon(); }

    btn.addEventListener("click", () => (playing ? pause() : play()));
    slider.addEventListener("input", () => {
      pause();
      t = range.min + (range.max - range.min) * slider.value / 1000;
      render();
    });

    const api = {
      fig: fig, bar: bar, panels: panels, fmt: fmt, fmtPi: fmtPi, range: range,
      get t() { return t; },
      setT(v) { t = Math.min(range.max, Math.max(range.min, v)); render(); },
      setRange(min, max, value) {
        pause(); range.min = min; range.max = max;
        t = value != null ? value : max; render();
      },
      redraw: render,
      setStep(v) { step = v || 0; render(); },
      play: play, pause: pause,
    };

    setIcon();
    if ("ResizeObserver" in window) new ResizeObserver(resize).observe(panelsEl);
    else window.addEventListener("resize", resize);
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
    window.addEventListener("themechange", render);
    resize();
    return api;
  }

  /* ---------- 그림 위에 얹는 도구 ---------- */
  // 점 (fx(t), fy(t))에서의 접선. 방향은 전진 차분으로 구해서 뾰족점(사이클로이드)에서도 극한 방향을 따른다.
  function tangent(ctx, T, fx, fy, t, color, opt) {
    opt = opt || {};
    const h = opt.h || 1e-4;
    let x0 = fx(t), y0 = fy(t);
    let dx = fx(t + h) - x0, dy = fy(t + h) - y0;
    if (Math.hypot(dx, dy) < 1e-12) { dx = fx(t + 1e-2) - x0; dy = fy(t + 1e-2) - y0; }
    const px = T.X(x0), py = T.Y(y0);
    let ux = dx * T.sx, uy = -dy * T.sy;
    const L = Math.hypot(ux, uy);
    if (L < 1e-12) return;
    ux /= L; uy /= L;
    const len = opt.len || 3000;
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = opt.width || 1.6;
    if (opt.dash) ctx.setLineDash(opt.dash);
    if (opt.alpha != null) ctx.globalAlpha = opt.alpha;
    ctx.beginPath(); ctx.moveTo(px - ux * len, py - uy * len); ctx.lineTo(px + ux * len, py + uy * len); ctx.stroke();
    ctx.restore();
  }
  // 곡선과 x축 사이를 채운다 (a ≤ t ≤ b).
  function fillUnder(ctx, T, fx, fy, a, b, color, n) {
    if (b <= a) return;
    n = n || 200;
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(T.X(fx(a)), T.Y(0));
    for (let k = 0; k <= n; k++) { const s = a + (b - a) * k / n; ctx.lineTo(T.X(fx(s)), T.Y(fy(s))); }
    ctx.lineTo(T.X(fx(b)), T.Y(0));
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }


  /* ---------- 극좌표 ---------- */
  // π/2 배수 눈금 이름
  function piHalf(k) {
    if (k === 0) return "0";
    const sgn = k < 0 ? "−" : "", a = Math.abs(k);
    if (a % 2 === 0) { const m = a / 2; return sgn + (m === 1 ? "" : m) + "π"; }
    return sgn + (a === 1 ? "" : a) + "π/2";
  }
  // 극좌표 모눈: 동심원과 π/6 간격 방사선
  function polarGrid(ctx, T, C, opt) {
    opt = opt || {};
    const rings = opt.rings || [1, 2, 3];
    const maxR = opt.maxR || rings[rings.length - 1];
    ctx.save();
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
    rings.forEach((rr) => { ctx.beginPath(); ctx.arc(T.X(0), T.Y(0), rr * T.sx, 0, Math.PI * 2); ctx.stroke(); });
    for (let k = 0; k < 12; k++) {
      const a = k * Math.PI / 6;
      ctx.beginPath(); ctx.moveTo(T.X(0), T.Y(0)); ctx.lineTo(T.X(maxR * Math.cos(a)), T.Y(maxR * Math.sin(a))); ctx.stroke();
    }
    ctx.restore();
    if (opt.labels !== false) rings.forEach((rr) => label(ctx, String(rr), T.X(rr) + 3, T.Y(0) + 10, { size: 10.5, color: C.muted }));
  }
  // O에서 점 (r, θ)까지의 선. r < 0이면 θ 방향을 점선으로, 실제 점은 반대편.
  function polarRay(ctx, T, C, rr, th, opt) {
    opt = opt || {};
    const O = [T.X(0), T.Y(0)];
    const len = Math.abs(rr);
    ctx.save();
    ctx.lineWidth = 1.4;
    if (rr < 0) {
      ctx.strokeStyle = C.muted; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(O[0], O[1]); ctx.lineTo(T.X(len * Math.cos(th)), T.Y(len * Math.sin(th))); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.strokeStyle = C.ink;
    ctx.beginPath(); ctx.moveTo(O[0], O[1]); ctx.lineTo(T.X(rr * Math.cos(th)), T.Y(rr * Math.sin(th))); ctx.stroke();
    // 각 θ 표시 (극축에서 θ까지, 여러 바퀴면 나선으로)
    if (opt.angle !== false && Math.abs(th) > 0.02) {
      ctx.strokeStyle = C.curve; ctx.lineWidth = 1.3;
      ctx.beginPath();
      const n = Math.max(12, Math.ceil(Math.abs(th) * 20));
      const base = opt.angleR || 16;
      for (let k = 0; k <= n; k++) {
        const a = th * k / n, rad = base + 3 * Math.abs(a) / (Math.PI * 2) * 2;
        const px = O[0] + rad * Math.cos(a), py = O[1] - rad * Math.sin(a);
        k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
      ctx.stroke();
      const rad = base + 3 * Math.abs(th) / Math.PI;
      const ex = O[0] + rad * Math.cos(th), ey = O[1] - rad * Math.sin(th);
      const tang = th > 0 ? -th - Math.PI / 2 : -th + Math.PI / 2;
      arrowHead(ctx, ex, ey, tang, 5, C.curve);
    }
    ctx.restore();
  }
  // f(θ) < 0인 부분을 다른 색으로 덧그린다
  function negParts(f, color) {
    return function (ctx, T, t, C, rg) {
      const n = Math.max(2, Math.ceil(800 * (t - rg.min) / (rg.max - rg.min || 1)));
      ctx.save(); ctx.strokeStyle = color ? C.get(color) : C.aux; ctx.lineWidth = 2.8; ctx.lineCap = "round";
      let open = false;
      ctx.beginPath();
      for (let k = 0; k <= n; k++) {
        const s = rg.min + (t - rg.min) * k / n;
        const p = T.pt(s);
        if (f(s) < 0) { open ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); open = true; }
        else open = false;
      }
      ctx.stroke(); ctx.restore();
    };
  }
  /* 극곡선 r = f(θ): 왼쪽은 xy평면, 오른쪽은 (θ, r) 그래프
   * polar(fig, { f, range:[a,b], value, R, rings, rview:[lo,hi], side, duration, arrows, readout, note, over, under, maxWidth, controls })
   */
  function polar(fig, o) {
    const f = o.f;
    const X = (t) => f(t) * Math.cos(t), Y = (t) => f(t) * Math.sin(t);
    const R = o.R || 2.4;
    const neg = negParts(f);
    const main = {
      x: X, y: Y, view: o.view || { x: [-R, R], y: [-R, R] }, grid: 0, origin: false,
      arrows: o.arrows == null ? 4 : o.arrows, markStart: true, samples: o.samples || 900,
      maxWidth: o.maxWidth || "24rem", alt: o.alt || "극곡선",
      under(ctx, T, t, C, rg) { polarGrid(ctx, T, C, { rings: o.rings || [1, 2], maxR: R * 1.5 }); if (o.under) o.under(ctx, T, t, C, rg); },
      over(ctx, T, t, C, rg) {
        if (o.negColor !== false) neg(ctx, T, t, C, rg);
        polarRay(ctx, T, C, f(t), t, { angle: o.angle });
        if (o.over) o.over(ctx, T, t, C, rg);
      },
    };
    const panels = [main];
    if (o.side !== false) {
      const lo = o.range[0], hi = o.range[1];
      const ticks = [];
      for (let k = Math.ceil(lo / (Math.PI / 2)); k <= Math.floor(hi / (Math.PI / 2) + 1e-9); k++) if (k) ticks.push({ v: k * Math.PI / 2, label: piHalf(k) });
      const rv = o.rview || [-R, R];
      panels.push({
        title: o.sideTitle || "θ에 따른 r 값", x: (t) => t, y: f, arrows: 0, grid: 0, origin: false,
        view: { x: [lo - 0.35, hi + 0.75], y: rv }, height: o.sideHeight || 200,
        axisLabels: ["θ", "r"], ticks: { x: ticks, y: o.rticks || [] },
        over(ctx, T, t, C, rg) {
          if (o.negColor !== false) neg(ctx, T, t, C, rg);
          ctx.save(); ctx.strokeStyle = C.muted; ctx.setLineDash([3, 3]); ctx.globalAlpha = .7;
          ctx.beginPath(); ctx.moveTo(T.X(t), T.Y(0)); ctx.lineTo(T.X(t), T.Y(f(t))); ctx.stroke(); ctx.restore();
        },
      });
      main.title = o.mainTitle || "xy평면의 곡선";
    }
    const readout = o.readout || ((t) => {
      const rr = f(t);
      return "θ = <b>" + fmtPi(t) + "</b>, <i>r</i> = <b>" + fmt(rr) + "</b>" + (rr < -1e-9 ? " (음수라서 반대편에 찍힘)" : "") +
        ", (<i>x</i>, <i>y</i>) = (" + fmt(X(t)) + ", " + fmt(Y(t)) + ")" + (o.note ? "<br>" + o.note(t) : "");
    });
    return mount(fig, {
      t: { min: o.range[0], max: o.range[1], value: o.value, label: "θ" },
      duration: o.duration || 8, panels: panels, readout: readout, controls: o.controls,
    });
  }

  /* ---------- 수열·급수: n에 따른 값을 점으로 찍는 패널 ----------
   * seqPanel({ f: n => 값, nMax, y:[lo,hi], title, yLabel, height, color, joined,
   *            lines:[{ y, label, color:'--ok', dash:true }], bands:[{ from, to, color }], yTicks, alt })
   * Plot.mount의 t를 "지금까지 찍은 항의 개수 n"으로 쓴다.
   */
  function seqPanel(o) {
    const xt = [];
    const step = o.nMax > 30 ? 10 : 5;
    for (let k = step; k < o.nMax; k += step) xt.push(k);
    return {
      curve: false, x: () => 0, y: () => 0, grid: 0, origin: false, title: o.title, alt: o.alt || o.title,
      height: o.height || 220, view: { x: [-o.nMax * 0.11, o.nMax + 1.5], y: [o.y[0] - (o.y[1] - o.y[0]) * 0.09, o.y[1]] },
      axisLabels: ["n", o.yLabel || ""], ticks: { x: o.xTicks || xt, y: o.yTicks || [] },
      under(ctx, T, N, C) {
        (o.bands || []).forEach((b) => {
          const y0 = T.Y(Math.min(b.to, this.view.y[1])), y1 = T.Y(Math.max(b.from, this.view.y[0]));
          ctx.save(); ctx.fillStyle = C.get(b.color); ctx.globalAlpha = b.alpha || 0.08; ctx.fillRect(0, y0, T.w, y1 - y0); ctx.restore();
        });
        (o.lines || []).forEach((l) => {
          if (l.y < this.view.y[0] || l.y > this.view.y[1]) return;
          const col = C.get(l.color || "--muted");
          ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = 1.3; if (l.dash !== false) ctx.setLineDash([5, 4]);
          ctx.beginPath(); ctx.moveTo(T.X(0), T.Y(l.y)); ctx.lineTo(T.w, T.Y(l.y)); ctx.stroke(); ctx.restore();
          if (l.label) label(ctx, l.label, T.w - 4, T.Y(l.y) - 9, { size: 11.5, color: col, align: "right", halo: C.surface });
        });
      },
      over(ctx, T, N, C) {
        const n = Math.floor(N + 1e-9), col = C.get(o.color || "--curve");
        const top = this.view.y[1], bot = this.view.y[0];
        if (o.joined) {
          ctx.save(); ctx.strokeStyle = col; ctx.globalAlpha = .45; ctx.lineWidth = 1.2; ctx.beginPath();
          let started = false;
          for (let k = 1; k <= n; k++) {
            const v = o.f(k); if (!isFinite(v)) { started = false; continue; }
            const Y = T.Y(Math.max(bot, Math.min(top, v)));
            started ? ctx.lineTo(T.X(k), Y) : ctx.moveTo(T.X(k), Y); started = true;
          }
          ctx.stroke(); ctx.restore();
        }
        for (let k = 1; k <= n; k++) {
          const v = o.f(k);
          if (Number.isNaN(v)) continue;
          if (!isFinite(v) || v > top) { arrowHead(ctx, T.X(k), 7, -Math.PI / 2, 5, col); continue; }
          if (v < bot) { arrowHead(ctx, T.X(k), T.h - 7, Math.PI / 2, 5, col); continue; }
          dot(ctx, T.X(k), T.Y(v), k === n ? 4.5 : 2.8, col, k === n ? C.surface : null);
        }
      },
    };
  }

  /* ---------- 절 머리: 급수 (항은 막대, 부분합은 계단) ---------- */
  function heroSeries(canvas, a, N, limit) {
    const ctx = canvas.getContext("2d");
    let W = 0, H = 0, k = reduceMotion ? 1 : 0, start = 0;
    const DUR = 2800;
    function size() {
      const dpr = window.devicePixelRatio || 1;
      W = canvas.clientWidth; H = canvas.clientHeight;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    function draw() {
      const C = palette();
      ctx.clearRect(0, 0, W, H);
      const base = H - 4, sy = (H - 14) / limit, bw = W / N;
      const shown = k * N;
      ctx.strokeStyle = C.rule; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, base + 0.5); ctx.lineTo(W, base + 0.5); ctx.stroke();
      ctx.save(); ctx.setLineDash([5, 5]); ctx.strokeStyle = C.muted;
      ctx.beginPath(); ctx.moveTo(0, base - limit * sy); ctx.lineTo(W, base - limit * sy); ctx.stroke(); ctx.restore();
      let S = 0;
      ctx.strokeStyle = C.curve; ctx.lineWidth = 2.2; ctx.lineJoin = "round"; ctx.beginPath(); ctx.moveTo(0, base);
      for (let n = 1; n <= N; n++) {
        if (n - 1 > shown) break;
        const frac = Math.min(1, shown - (n - 1)), an = a(n);
        ctx.save(); ctx.fillStyle = C.auxSoft; ctx.fillRect((n - 1) * bw + 1, base - an * sy * frac, Math.max(1, bw - 2), an * sy * frac); ctx.restore();
        S += an * frac;
        ctx.lineTo((n - 1) * bw, base - S * sy);
        ctx.lineTo((n - 1 + frac) * bw, base - S * sy);
      }
      ctx.stroke();
    }
    function tick(now) {
      if (!start) start = now;
      k = Math.min(1, (now - start) / DUR); k = 1 - Math.pow(1 - k, 2);
      draw(); if (k < 1) requestAnimationFrame(tick);
    }
    size();
    if (reduceMotion) draw(); else requestAnimationFrame(tick);
    const redraw = () => { size(); draw(); };
    if ("ResizeObserver" in window) new ResizeObserver(redraw).observe(canvas);
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", redraw);
    window.addEventListener("themechange", redraw);
  }

  /* ---------- 절 머리: 극곡선 견본 줄 (페이지 열 때 한 번) ---------- */
  // items: [{ f, range:[a,b], R }] — 각각 같은 크기 칸에 그려진다
  function heroPolar(canvas, items) {
    const ctx = canvas.getContext("2d");
    let W = 0, H = 0, k = reduceMotion ? 1 : 0, start = 0;
    const DUR = 3200;
    function size() {
      const dpr = window.devicePixelRatio || 1;
      W = canvas.clientWidth; H = canvas.clientHeight;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    function draw() {
      const C = palette();
      ctx.clearRect(0, 0, W, H);
      const cell = Math.min(H, W / items.length);
      const gap = (W - cell * items.length) / Math.max(1, items.length - 1);
      items.forEach((it, idx) => {
        const cx = idx * (cell + gap) + cell / 2, cy = H / 2, s = (cell / 2 - 6) / it.R;
        ctx.strokeStyle = C.rule; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(cx - cell / 2 + 4, cy); ctx.lineTo(cx + cell / 2 - 4, cy); ctx.stroke();
        const a = it.range[0], b = a + (it.range[1] - it.range[0]) * k;
        const n = Math.max(2, Math.ceil(400 * k));
        ctx.strokeStyle = C.curve; ctx.lineWidth = 2; ctx.lineJoin = "round";
        ctx.beginPath();
        if (it.fill) ctx.moveTo(cx, cy);
        for (let j = 0; j <= n; j++) {
          const th = a + (b - a) * j / n, rr = it.f(th);
          const x = cx + s * rr * Math.cos(th), y = cy - s * rr * Math.sin(th);
          (j || it.fill) ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        if (it.fill) { ctx.closePath(); ctx.fillStyle = C.auxSoft; ctx.fill(); }
        ctx.stroke();
        dot(ctx, cx, cy, 2, C.ink);
      });
    }
    function tick(now) {
      if (!start) start = now;
      k = Math.min(1, (now - start) / DUR);
      k = 1 - Math.pow(1 - k, 2);
      draw();
      if (k < 1) requestAnimationFrame(tick);
    }
    size();
    if (reduceMotion) draw(); else requestAnimationFrame(tick);
    const redraw = () => { size(); draw(); };
    if ("ResizeObserver" in window) new ResizeObserver(redraw).observe(canvas);
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", redraw);
    window.addEventListener("themechange", redraw);
  }

  /* ---------- 절 머리의 사이클로이드 (페이지 열 때 한 번) ---------- */
  function heroCycloid(canvas, heroOpt) {
    heroOpt = heroOpt || {};
    const ctx = canvas.getContext("2d");
    let W = 0, H = 0, R = 0, theta = 0, done = false, start = 0;
    const DUR = 3600;
    function size() {
      const dpr = window.devicePixelRatio || 1;
      W = canvas.clientWidth; H = canvas.clientHeight;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      R = (H - 14) / 2;
    }
    function draw(th) {
      const C = palette();
      ctx.clearRect(0, 0, W, H);
      const base = H - 4;
      ctx.strokeStyle = C.rule; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, base + 0.5); ctx.lineTo(W, base + 0.5); ctx.stroke();
      // 자취
      ctx.strokeStyle = C.curve; ctx.lineWidth = 2.4; ctx.lineCap = "round";
      ctx.beginPath();
      const steps = Math.max(2, Math.ceil(th * 40));
      for (let i = 0; i <= steps; i++) {
        const a = th * i / steps;
        const x = R * (a - Math.sin(a)), y = base - R * (1 - Math.cos(a));
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      // 구르는 원
      const cx = R * th, cy = base - R;
      ctx.strokeStyle = C.aux; ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.8;
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
      const px = R * (th - Math.sin(th)), py = base - R * (1 - Math.cos(th));
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(px, py); ctx.stroke();
      ctx.globalAlpha = 1;
      if (heroOpt.tangent && th > 0.02) {
        // P에서의 접선: 방향 (1 − cos θ, sin θ)
        let ux = 1 - Math.cos(th), uy = -Math.sin(th);
        const L = Math.hypot(ux, uy); ux /= L; uy /= L;
        ctx.strokeStyle = C.ink; ctx.lineWidth = 1.3;
        ctx.beginPath(); ctx.moveTo(px - ux * 70, py - uy * 70); ctx.lineTo(px + ux * 70, py + uy * 70); ctx.stroke();
      }
      dot(ctx, cx, cy, 2.5, C.aux);
      dot(ctx, px, py, 5, C.curve, C.paper || cssVar("--paper"));
    }
    function maxTheta() { return (W - R - 4) / R; }
    function tick(now) {
      if (!start) start = now;
      const k = Math.min(1, (now - start) / DUR);
      const ease = 1 - Math.pow(1 - k, 2);
      theta = ease * maxTheta();
      draw(theta);
      if (k < 1) requestAnimationFrame(tick); else done = true;
    }
    size();
    if (reduceMotion) { done = true; theta = maxTheta(); draw(theta); }
    else requestAnimationFrame(tick);
    const redraw = () => { size(); if (done) theta = maxTheta(); draw(theta); };
    if ("ResizeObserver" in window) new ResizeObserver(redraw).observe(canvas);
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", redraw);
    window.addEventListener("themechange", redraw);
  }

  window.Plot = { mount: mount, polar: polar, heroPolar: heroPolar, seqPanel: seqPanel, heroSeries: heroSeries, polarGrid: polarGrid, polarRay: polarRay, negParts: negParts, piHalf: piHalf, heroCycloid: heroCycloid, tangent: tangent, fillUnder: fillUnder, fmt: fmt, fmtPi: fmtPi, label: label, dot: dot, hollow: hollow, arrowHead: arrowHead, palette: palette };
})();
