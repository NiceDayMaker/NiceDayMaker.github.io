/* 3차원 그림: 직접 만든 작은 정사영(orthographic) 렌더러.
 *
 * Space.mount(figure, {
 *   range: 4,                 // 원점(center)에서 화면 가장자리까지 보이는 대략의 길이
 *   center: [0, 0, 0],
 *   height: 340,
 *   view: { az: 30, el: 22 }, // 처음 시점(도). az: z축 둘레 회전, el: 올려다보는 각
 *   axes: 4 | [lx, ly, lz] | false,
 *   grid: 0 | 간격,           // xy평면 모눈
 *   draw(S, C, api),          // S: 그리기 도구, C: 색
 *   controls: html, readout: api => html, alt
 * }) → api { redraw, bar, canvas, setView, state }
 *
 * 마우스로 끌면 회전, 터치는 가로로 끌면 회전(세로는 페이지 스크롤).
 */
(function () {
  "use strict";
  const { palette, label, arrowHead } = window.Plot;
  const deg = Math.PI / 180;

  const V = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    mul: (a, k) => [a[0] * k, a[1] * k, a[2] * k],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    len: (a) => Math.hypot(a[0], a[1], a[2]),
    unit: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
    lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
  };

  function camera(az, el) {
    const ca = Math.cos(az * deg), sa = Math.sin(az * deg), ce = Math.cos(el * deg), se = Math.sin(el * deg);
    return {
      d: [ce * ca, ce * sa, se],          // 원점 → 카메라 방향
      r: [-sa, ca, 0],                    // 화면 오른쪽
      u: [-se * ca, -se * sa, ce],        // 화면 위쪽
    };
  }

  function mount(fig, o) {
    o = o || {};
    const state = { az: (o.view && o.view.az != null) ? o.view.az : 30, el: (o.view && o.view.el != null) ? o.view.el : 22 };
    const home = { az: state.az, el: state.el };

    const panels = document.createElement("div");
    panels.className = "panels";
    const wrap = document.createElement("div"); wrap.className = "panel";
    const canvas = document.createElement("canvas");
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", o.alt || "3차원 그림");
    canvas.className = "space";
    wrap.appendChild(canvas); panels.appendChild(wrap);
    fig.insertBefore(panels, fig.firstChild);

    const bar = document.createElement("div");
    bar.className = "bar";
    const tc = o.t || null;
    let api_play = null, api_pause = null;
    bar.innerHTML =
      (tc ? '<button class="play" type="button" aria-label="재생"></button><div class="scrub"><label>' + (tc.label || "t") +
        '</label><input type="range" min="0" max="1000" step="1" aria-label="' + (tc.label || "t") + ' 값 조절"></div>' : "") +
      '<span class="space-hint">끌어서 돌려 보세요</span><button type="button" class="space-reset">처음 시점</button>' +
      (o.controls ? '<div class="extra">' + o.controls + "</div>" : "") +
      (o.readout ? '<div class="readout" aria-live="off"></div>' : "");
    panels.after(bar);
    const readout = bar.querySelector(".readout");
    const ctx = canvas.getContext("2d");
    let W = 0, H = 0, dpr = 1;

    function size() {
      dpr = window.devicePixelRatio || 1;
      W = Math.max(10, canvas.clientWidth);
      H = o.height || 340;
      if (W < 480) H = Math.round(H * 0.85);
      canvas.style.height = H + "px";
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    }

    function tools(C) {
      const cam = camera(state.az, state.el);
      const R = o.range || 4, center = o.center || [0, 0, 0];
      const s = Math.min(W, H) / (2.15 * R);
      const P = (p) => {
        const q = V.sub(p, center);
        return [W / 2 + V.dot(q, cam.r) * s, H / 2 - V.dot(q, cam.u) * s];
      };
      const depth = (p) => V.dot(V.sub(p, center), cam.d);
      const col = (c) => (c && c.startsWith("--") ? C.get(c) : c || C.ink);
      const S = {
        cam: cam, scale: s, P: P, depth: depth, V: V, ctx: ctx, W: W, H: H,
        line(a, b, op) {
          op = op || {};
          const A = P(a), B = P(b);
          ctx.save(); ctx.strokeStyle = col(op.color); ctx.lineWidth = op.width || 1.5; ctx.globalAlpha = op.alpha == null ? 1 : op.alpha;
          if (op.dash) ctx.setLineDash(op.dash === true ? [5, 4] : op.dash);
          ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.stroke(); ctx.restore();
        },
        arrow(a, b, op) {
          op = op || {};
          const A = P(a), B = P(b), c = col(op.color), w = op.width || 2.6;
          const ang = Math.atan2(B[1] - A[1], B[0] - A[0]), L = Math.hypot(B[0] - A[0], B[1] - A[1]);
          const head = Math.min(op.head || 11, L * 0.45);
          ctx.save(); ctx.strokeStyle = c; ctx.lineWidth = w; ctx.globalAlpha = op.alpha == null ? 1 : op.alpha; ctx.lineCap = "round";
          if (op.dash) ctx.setLineDash(op.dash === true ? [6, 4] : op.dash);
          ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0] - Math.cos(ang) * head * 0.7, B[1] - Math.sin(ang) * head * 0.7); ctx.stroke();
          ctx.restore();
          if (L > 2) { ctx.save(); ctx.globalAlpha = op.alpha == null ? 1 : op.alpha; arrowHead(ctx, B[0], B[1], ang, head, c); ctx.restore(); }
          if (op.label) S.text(op.labelAt || V.lerp(a, b, op.labelT == null ? 0.6 : op.labelT), op.label, { color: op.color, dx: op.dx == null ? 10 : op.dx, dy: op.dy == null ? -10 : op.dy, bold: true, math: op.math !== false, size: op.size || 16, align: op.align });
        },
        point(p, op) {
          op = op || {};
          const A = P(p);
          ctx.save(); ctx.beginPath(); ctx.arc(A[0], A[1], op.r || 4.5, 0, Math.PI * 2);
          ctx.fillStyle = col(op.color); ctx.fill();
          if (op.ring !== false) { ctx.lineWidth = 2; ctx.strokeStyle = C.surface; ctx.stroke(); }
          ctx.restore();
          if (op.label) S.text(p, op.label, { color: op.labelColor || op.color, dx: op.dx == null ? 8 : op.dx, dy: op.dy == null ? -10 : op.dy, size: op.size || 13, math: op.math });
        },
        text(p, str, op) {
          op = op || {};
          const A = P(p);
          label(ctx, str, A[0] + (op.dx || 0), A[1] + (op.dy || 0), { size: op.size || 13, color: col(op.color), bold: op.bold, italic: op.italic, math: op.math, align: op.align || "left", halo: op.halo === false ? null : C.surface });
        },
        poly(pts, op) {
          op = op || {};
          ctx.save(); ctx.beginPath();
          pts.forEach((p, i) => { const A = P(p); i ? ctx.lineTo(A[0], A[1]) : ctx.moveTo(A[0], A[1]); });
          ctx.closePath();
          if (op.fill) { ctx.fillStyle = col(op.fill); ctx.globalAlpha = op.alpha == null ? 0.15 : op.alpha; ctx.fill(); }
          if (op.stroke) { ctx.globalAlpha = op.strokeAlpha == null ? 1 : op.strokeAlpha; ctx.strokeStyle = col(op.stroke); ctx.lineWidth = op.width || 1.2; if (op.dash) ctx.setLineDash(op.dash === true ? [4, 4] : op.dash); ctx.stroke(); }
          ctx.restore();
        },
        path(pts, op) {
          op = op || {};
          ctx.save(); ctx.strokeStyle = col(op.color); ctx.lineWidth = op.width || 2; ctx.globalAlpha = op.alpha == null ? 1 : op.alpha;
          if (op.dash) ctx.setLineDash(op.dash === true ? [5, 4] : op.dash);
          ctx.lineJoin = "round"; ctx.beginPath();
          let pen = false;
          pts.forEach((p) => { if (!p) { pen = false; return; } const A = P(p); pen ? ctx.lineTo(A[0], A[1]) : ctx.moveTo(A[0], A[1]); pen = true; });
          ctx.stroke(); ctx.restore();
        },
        // 중심 o에서 방향 u부터 v까지 반지름 r의 호 (u, v는 아무 길이)
        arc(o, u, v, r, op) {
          const pts = S.arcPts(o, u, v, r);
          S.path(pts, Object.assign({ width: 1.8 }, op));
          if (op && op.fill) S.poly([o].concat(pts), { fill: op.fill, alpha: op.alpha == null ? 0.15 : op.alpha });
          if (op && op.label) S.text(S.arcPts(o, u, v, r * (op.labelR || 1.35), 2)[1], op.label, { color: op.labelColor || op.color, align: "center", size: op.size || 15, math: true, italic: true });
        },
        arcPts(o, u, v, r, n) {
          n = n || 40;
          const a = V.unit(u), b = V.unit(v);
          const th = Math.acos(Math.max(-1, Math.min(1, V.dot(a, b))));
          let w = V.sub(b, V.mul(a, V.dot(a, b)));
          if (V.len(w) < 1e-9) w = Math.abs(a[0]) < 0.9 ? V.cross(a, [1, 0, 0]) : V.cross(a, [0, 1, 0]);
          w = V.unit(w);
          const pts = [];
          for (let i = 0; i <= n; i++) { const t = th * i / n; pts.push(V.add(o, V.add(V.mul(a, r * Math.cos(t)), V.mul(w, r * Math.sin(t))))); }
          return pts;
        },
        rightAngle(o, u, v, size, op) {
          const a = V.mul(V.unit(u), size), b = V.mul(V.unit(v), size);
          S.path([V.add(o, a), V.add(V.add(o, a), b), V.add(o, b)], Object.assign({ width: 1.4, color: "--muted" }, op));
        },
        // 법선 n, 점 p0를 지나는 평면 조각 (한 변 2*half), 두 방향 u, w도 돌려준다
        planeBasis(n) {
          const nn = V.unit(n), ref = Math.abs(nn[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
          const u = V.unit(V.cross(nn, ref)), w = V.cross(nn, u);
          return { n: nn, u: u, w: w };
        },
        plane(n, p0, half, op) {
          const B = S.planeBasis(n), hu = Array.isArray(half) ? half[0] : half, hw = Array.isArray(half) ? half[1] : half;
          const c = (i, j) => V.add(p0, V.add(V.mul(B.u, i * hu), V.mul(B.w, j * hw)));
          S.poly([c(-1, -1), c(1, -1), c(1, 1), c(-1, 1)], Object.assign({ fill: "--aux", alpha: .13, stroke: "--aux", strokeAlpha: .45 }, op));
          if (op && op.grid) {
            const g = op.grid;
            for (let k = 1; k < g; k++) {
              const f = -1 + 2 * k / g;
              S.line(c(f, -1), c(f, 1), { color: op.stroke || "--aux", alpha: .16, width: 1 });
              S.line(c(-1, f), c(1, f), { color: op.stroke || "--aux", alpha: .16, width: 1 });
            }
          }
          return B;
        },
        // 원점에서 점 p까지의 상자(좌표를 읽기 쉽게)
        box(p, op) {
          op = op || {};
          const [x, y, z] = p, c = op.color || "--axis", st = { color: c, width: 1, dash: [4, 4], alpha: op.alpha == null ? 0.8 : op.alpha };
          const pts = [[x, 0, 0], [x, y, 0], [0, y, 0], [x, 0, z], [x, y, z], [0, y, z], [0, 0, z]];
          const E = [[0, 1], [1, 2], [0, 3], [1, 4], [2, 5], [3, 4], [4, 5], [3, 6], [5, 6]];
          E.forEach(([i, j]) => S.line(pts[i], pts[j], st));
        },
      };
      return S;
    }

    function drawAxes(S, C) {
      if (o.axes === false) return;
      const L = Array.isArray(o.axes) ? o.axes : [o.axes || 4, o.axes || 4, o.axes || 4];
      const names = o.axisLabels || ["x", "y", "z"];
      for (let k = 0; k < 3; k++) {
        const e = [0, 0, 0]; e[k] = 1;
        const neg = V.mul(e, -L[k] * (o.negAxes == null ? 0.55 : o.negAxes)), pos = V.mul(e, L[k]);
        S.line([0, 0, 0], neg, { color: C.axis, width: 1.2, alpha: 0.45, dash: [3, 4] });
        S.arrow([0, 0, 0], pos, { color: C.axis, width: 1.3, head: 8 });
        S.text(V.mul(e, L[k] * 1.08), names[k], { italic: true, math: true, size: 16, color: C.muted, align: "center" });
        if (o.ticks) {
          for (let t = 1; t < L[k]; t++) {
            const p = V.mul(e, t); const A = S.P(p);
            ctx.save(); ctx.fillStyle = C.axis; ctx.beginPath(); ctx.arc(A[0], A[1], 1.8, 0, Math.PI * 2); ctx.fill(); ctx.restore();
          }
        }
      }
    }

    function drawGrid(S, C) {
      if (!o.grid) return;
      const g = o.grid, L = Array.isArray(o.axes) ? o.axes : [o.axes || 4, o.axes || 4];
      for (let x = -Math.floor(L[0] * 0.55 / g) * g; x <= L[0] + 1e-9; x += g) S.line([x, -L[1] * 0.55, 0], [x, L[1], 0], { color: C.grid, width: 1 });
      for (let y = -Math.floor(L[1] * 0.55 / g) * g; y <= L[1] + 1e-9; y += g) S.line([-L[0] * 0.55, y, 0], [L[0], y, 0], { color: C.grid, width: 1 });
    }

    function render() {
      const C = palette();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const S = tools(C);
      drawGrid(S, C);
      if (o.under) o.under(S, C, api);
      drawAxes(S, C);
      if (o.draw) o.draw(S, C, api);
      if (slider) slider.value = Math.round((t - tc.min) / (tc.max - tc.min) * 1000);
      if (readout && o.readout) readout.innerHTML = o.readout(api);
    }

    // 매개변수 t (선택): 재생 버튼과 슬라이더
    let t = tc ? (tc.value != null ? tc.value : tc.min) : 0, playing = false, last = 0, raf = 0;
    const tStep = tc && tc.step ? tc.step : 0;
    const snap = (v) => (tStep ? Math.min(tc.max, tc.min + Math.floor((v - tc.min) / tStep + 1e-9) * tStep) : v);
    let playBtn = null, slider = null;
    if (tc) {
      playBtn = bar.querySelector(".play"); slider = bar.querySelector(".scrub input");
      const ICON_PLAY = '<svg viewBox="0 0 14 14"><path d="M3 1.5v11l9.5-5.5z"/></svg>';
      const ICON_PAUSE = '<svg viewBox="0 0 14 14"><path d="M2.5 1.5h3.2v11H2.5zM8.3 1.5h3.2v11H8.3z"/></svg>';
      const setIcon = () => { playBtn.innerHTML = playing ? ICON_PAUSE : ICON_PLAY; playBtn.setAttribute("aria-label", playing ? "일시정지" : "재생"); };
      const frame = (now) => {
        if (!playing) return;
        const dt = Math.min(0.05, (now - last) / 1000); last = now;
        t += (tc.max - tc.min) * dt / (tc.duration || 6);
        if (t >= tc.max) { t = tc.max; playing = false; setIcon(); }
        render(); if (playing) raf = requestAnimationFrame(frame);
      };
      api_play = () => { if (t >= tc.max - 1e-9) t = tc.min; playing = true; setIcon(); last = performance.now(); raf = requestAnimationFrame(frame); };
      api_pause = () => { playing = false; cancelAnimationFrame(raf); setIcon(); };
      playBtn.addEventListener("click", () => (playing ? api_pause() : api_play()));
      slider.addEventListener("input", () => { api_pause(); t = tc.min + (tc.max - tc.min) * slider.value / 1000; render(); });
      setIcon();
    }

    // 끌어서 회전
    let drag = null;
    canvas.addEventListener("pointerdown", (e) => {
      drag = { x: e.clientX, y: e.clientY, az: state.az, el: state.el, touch: e.pointerType === "touch" };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!drag) return;
      state.az = drag.az - (e.clientX - drag.x) * 0.45;
      if (!drag.touch) state.el = Math.max(-75, Math.min(85, drag.el + (e.clientY - drag.y) * 0.4));
      render();
    });
    const end = () => { drag = null; };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    bar.querySelector(".space-reset").addEventListener("click", () => { state.az = home.az; state.el = home.el; render(); });

    const api = {
      fig: fig, bar: bar, canvas: canvas, state: state, V: V,
      get t() { return snap(t); },
      setT(v) { t = Math.min(tc.max, Math.max(tc.min, v)); render(); },
      play() { if (api_play) api_play(); }, pause() { if (api_pause) api_pause(); },
      redraw: render,
      setView(az, el) { state.az = az; state.el = el; render(); },
      setFrame(fr) { Object.assign(o, fr); render(); },
    };
    function resize() { size(); render(); }
    if ("ResizeObserver" in window) new ResizeObserver(resize).observe(panels);
    else window.addEventListener("resize", resize);
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
    window.addEventListener("themechange", render);
    resize();
    return api;
  }

  window.Space = { mount: mount, V: V, camera: camera };
})();
