/* 3차원 그림: 직접 만든 작은 정사영(orthographic) 렌더러.
 *
 * Space.mount(figure, {
 *   range: 4,                 // 원점(center)에서 화면 가장자리까지 보이는 대략의 길이
 *   center: [0, 0, 0],
 *   height: 340,
 *   view: { az: 30, el: 22 }, // 처음 시점(도). az: z축 둘레 회전, el: 올려다보는 각
 *   axes: 4 | [lx, ly, lz] | false,
 *   grid: 0 | 간격,           // xy평면 모눈
 *   draw(S, C, api),          // S: 그리기 도구, C: 색 (S.mesh로 곡면을 깊이 순서대로)
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

  // '#rrggbb', '#rgb', 'rgb(a)' → [r, g, b]
  function rgbOf(s) {
    s = (s || "").trim();
    if (s[0] === "#") {
      if (s.length === 4) return [1, 2, 3].map((i) => parseInt(s[i] + s[i], 16));
      return [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
    }
    const m = s.match(/[\d.]+/g);
    return m ? m.slice(0, 3).map(Number) : [120, 120, 120];
  }

  /* ---------- CPU 렌더러(WebGL2를 못 쓸 때): 픽셀 단위 깊이 버퍼, 여러 겹 반투명 합성 ---------- */
  const KL = 4;                              // 픽셀마다 보관하는 가까운 조각 수
  const RB = { n: 0 };                       // 모든 그림이 함께 쓰는 버퍼
  function rbuf(N) {
    if (RB.n < N) {
      RB.n = N;
      RB.cnt = new Uint8Array(N); RB.dep = new Float32Array(N * KL); RB.alp = new Float32Array(N * KL);
      RB.col = new Uint8ClampedArray(N * KL * 3); RB.own = new Int16Array(N * KL); RB.stamp = new Int32Array(N);
    }
    return RB;
  }
  let offCanvas = null;

  /* ---------- WebGL2 렌더러: 깊이 벗겨내기(depth peeling)로 반투명 곡면 여러 겹 합성 ---------- */
  const PEELS = 6;                           // 픽셀마다 앞에서부터 벗겨 낼 겹 수
  const GLR = { state: 0 };                  // 0: 아직, 1: 사용 가능, -1: 사용 불가
  function glInit() {
    if (GLR.state) return GLR.state > 0;
    GLR.state = -1;
    try {
      const cv = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1) : document.createElement("canvas");
      // failIfMajorPerformanceCaveat: 그래픽카드 없이 소프트웨어로 흉내 내는 WebGL이면 거절(그땐 CPU 렌더러가 더 빠름)
      const gl = cv.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, failIfMajorPerformanceCaveat: true });
      if (!gl) return false;
      // 소프트웨어 렌더러(SwiftShader, llvmpipe 등)면 CPU 렌더러를 씀
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      const rname = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || "") : "";
      if (/swiftshader|llvmpipe|softpipe|software|basic render/i.test(rname)) return false;
      cv.addEventListener("webglcontextlost", (e) => { e.preventDefault(); GLR.state = -1; });
      const sh = (type, src) => {
        const o = gl.createShader(type); gl.shaderSource(o, src); gl.compileShader(o);
        if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o));
        return o;
      };
      const prog = (vs, fs) => {
        const p = gl.createProgram();
        gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
        return p;
      };
      const H = "#version 300 es\nprecision highp float;\nprecision highp int;\n";
      // 곡면 삼각형: 화면 좌표(px, 아래로 +y)와 깊이(카메라 쪽 +)를 받는다
      const triP = prog(H + `
        in vec3 a_p; in vec4 a_c;
        uniform vec2 u_size; uniform float u_dr;
        out vec4 v_c;
        void main() {
          v_c = a_c;
          gl_Position = vec4(a_p.x / u_size.x * 2.0 - 1.0, 1.0 - a_p.y / u_size.y * 2.0, clamp(-a_p.z / u_dr, -1.0, 1.0), 1.0);
        }`, H + `
        in vec4 v_c;
        uniform highp sampler2D u_prev; uniform int u_peel; uniform float u_eps; uniform float u_off;
        out vec4 o;
        void main() {
          // 기울기에 비례해 살짝 뒤로 미룸(곡면 위 선이 자기 곡면에 묻히지 않게). 깊이를 직접 써서 벗겨내기 비교와 일치시킴
          float d = min(1.0, gl_FragCoord.z + u_off * fwidth(gl_FragCoord.z) + 2e-6);
          gl_FragDepth = d;
          if (u_peel == 1 && d <= texelFetch(u_prev, ivec2(gl_FragCoord.xy), 0).r + u_eps) discard;
          o = vec4(v_c.rgb * v_c.a, v_c.a);
        }`);
      // 굵은 선분: 사각형으로 늘려 그리고, 조각 셰이더에서 거리로 가장자리 부드럽게, 점선, 깊이 계산
      const lineP = prog(H + `
        in vec3 a_a; in vec3 a_b; in vec2 a_k; in vec4 a_c; in vec4 a_w;
        uniform vec2 u_size; uniform float u_dr;
        out vec2 v_p; flat out vec3 v_a; flat out vec3 v_b; flat out vec4 v_c; flat out vec4 v_w;
        void main() {
          vec2 dv = a_b.xy - a_a.xy; float L = length(dv);
          vec2 dir = L > 1e-6 ? dv / L : vec2(1.0, 0.0), nr = vec2(-dir.y, dir.x);
          float ext = a_w.x + 1.5;
          vec2 p = (a_k.x < 0.0 ? a_a.xy - dir * ext : a_b.xy + dir * ext) + nr * a_k.y * ext;
          v_p = p; v_a = a_a; v_b = a_b; v_c = a_c; v_w = a_w;
          float z = a_k.x < 0.0 ? a_a.z : a_b.z;
          gl_Position = vec4(p.x / u_size.x * 2.0 - 1.0, 1.0 - p.y / u_size.y * 2.0, clamp(-z / u_dr, -1.0, 1.0), 1.0);
        }`, H + `
        in vec2 v_p; flat in vec3 v_a; flat in vec3 v_b; flat in vec4 v_c; flat in vec4 v_w;
        uniform highp sampler2D u_prev; uniform int u_peel; uniform float u_dr; uniform float u_epsL;
        out vec4 o;
        void main() {
          vec2 dv = v_b.xy - v_a.xy; float L2 = dot(dv, dv);
          float t = L2 > 1e-9 ? clamp(dot(v_p - v_a.xy, dv) / L2, 0.0, 1.0) : 0.0;
          float d = length(v_p - (v_a.xy + t * dv));
          float cov = clamp(v_w.x + 0.5 - d, 0.0, 1.0);
          if (cov <= 0.0) discard;
          if (v_w.y > 0.0) { float sp = mod(v_w.w + t * sqrt(L2), v_w.y + v_w.z); if (sp > v_w.y) discard; }
          float z = mix(v_a.z, v_b.z, t);
          float fd = clamp(-z / u_dr, -1.0, 1.0) * 0.5 + 0.5;
          gl_FragDepth = fd;
          if (u_peel == 1 && fd <= texelFetch(u_prev, ivec2(gl_FragCoord.xy), 0).r + u_epsL) discard;
          float a = v_c.a * cov;
          o = vec4(v_c.rgb * a, a);
        }`);
      // 화면 전체에 텍스처 한 장 그리기(합성용)
      const quadP = prog(H + `
        void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`, H + `
        uniform highp sampler2D u_tex; out vec4 o;
        void main() { o = texelFetch(u_tex, ivec2(gl_FragCoord.xy), 0); }`);

      // 내려받기 전 줄이기: 출력 화소 하나 = 렌더 화소 n×n의 평균(가장자리 매끄럽게)
      const downP = prog(H + `
        void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`, H + `
        uniform highp sampler2D u_tex; uniform vec2 u_org; uniform float u_f; uniform int u_n; uniform float u_rh;
        out vec4 o;
        void main() {
          // 출력 0행 = 맨 위 행(readPixels가 0행부터 주므로 그대로 ImageData 순서가 됨)
          vec2 dp = gl_FragCoord.xy - 0.5 + u_org;
          vec4 acc = vec4(0.0);
          for (int j = 0; j < 4; j++) { if (j >= u_n) break;
            for (int i = 0; i < 4; i++) { if (i >= u_n) break;
              vec2 r = (dp + (vec2(float(i), float(j)) + 0.5) / float(u_n)) * u_f;   // 렌더 좌표(아래로 +y)
              acc += texelFetch(u_tex, ivec2(int(r.x), int(u_rh - r.y)), 0);
            } }
          acc /= float(u_n * u_n);
          o = acc.a > 0.0 ? vec4(acc.rgb / acc.a, acc.a) : vec4(0.0);   // ImageData용: 미리 곱한 알파를 풂
        }`);
      const loc = (p, names) => { const r = {}; names.forEach((n) => { r[n] = n[0] === "a" && n[1] === "_" ? gl.getAttribLocation(p, n) : gl.getUniformLocation(p, n); }); return r; };
      GLR.tri = { p: triP, l: loc(triP, ["a_p", "a_c", "u_size", "u_dr", "u_prev", "u_peel", "u_eps", "u_off"]), buf: gl.createBuffer(), vao: gl.createVertexArray() };
      GLR.line = { p: lineP, l: loc(lineP, ["a_a", "a_b", "a_k", "a_c", "a_w", "u_size", "u_dr", "u_prev", "u_peel", "u_epsL"]), buf: gl.createBuffer(), vao: gl.createVertexArray() };
      GLR.quad = { p: quadP, l: loc(quadP, ["u_tex"]), vao: gl.createVertexArray() };
      GLR.down = { p: downP, l: loc(downP, ["u_tex", "u_org", "u_f", "u_n", "u_rh"]) };
      // 꼭짓점 배치
      gl.bindVertexArray(GLR.tri.vao); gl.bindBuffer(gl.ARRAY_BUFFER, GLR.tri.buf);
      [["a_p", 3, 0], ["a_c", 4, 3]].forEach(([n, k, off]) => { const L = GLR.tri.l[n]; gl.enableVertexAttribArray(L); gl.vertexAttribPointer(L, k, gl.FLOAT, false, 28, off * 4); });
      gl.bindVertexArray(GLR.line.vao); gl.bindBuffer(gl.ARRAY_BUFFER, GLR.line.buf);
      [["a_a", 3, 0], ["a_b", 3, 3], ["a_k", 2, 6], ["a_c", 4, 8], ["a_w", 4, 12]].forEach(([n, k, off]) => { const L = GLR.line.l[n]; gl.enableVertexAttribArray(L); gl.vertexAttribPointer(L, k, gl.FLOAT, false, 64, off * 4); });
      gl.bindVertexArray(null);
      GLR.gl = gl; GLR.cv = cv; GLR.w = 0; GLR.h = 0;
      GLR.maxTex = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
      GLR.state = 1;
      return true;
    } catch (e) {
      if (window.console) console.warn("WebGL 렌더러를 쓸 수 없어 CPU로 그려요:", e && e.message);
      GLR.state = -1;
      return false;
    }
  }
  function glTargets(w, h) {
    const gl = GLR.gl;
    if (GLR.w >= w && GLR.h >= h) return;
    const W = Math.max(w, GLR.w), H = Math.max(h, GLR.h);
    [GLR.colTex, GLR.accTex, GLR.outTex, GLR.dTex0, GLR.dTex1].forEach((t) => t && gl.deleteTexture(t));
    [GLR.fb0, GLR.fb1, GLR.fbA, GLR.fbO].forEach((f) => f && gl.deleteFramebuffer(f));
    const tex = (ifmt, fmt, type) => {
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, W, H, 0, fmt, type, null);
      return t;
    };
    GLR.colTex = tex(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    GLR.accTex = tex(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    GLR.outTex = tex(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    GLR.dTex0 = tex(gl.DEPTH_COMPONENT24, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT);
    GLR.dTex1 = tex(gl.DEPTH_COMPONENT24, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT);
    const fbo = (c, d) => {
      const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, c, 0);
      if (d) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, d, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("framebuffer");
      return f;
    };
    GLR.fb0 = fbo(GLR.colTex, GLR.dTex0); GLR.fb1 = fbo(GLR.colTex, GLR.dTex1); GLR.fbA = fbo(GLR.accTex, null); GLR.fbO = fbo(GLR.outTex, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    GLR.w = W; GLR.h = H;
  }

  // 반환값: true면 그렸음, false면 CPU 렌더러로 넘김
  function meshGL(S, C, col, cam, surfs, extras) {
    if (!glInit()) return false;
    const gl = GLR.gl;
    if (gl.isContextLost()) { GLR.state = -1; return false; }
    const ctx = S.ctx, W = S.W, H = S.H, P = S.P, depth = S.depth;
    const dpr = window.devicePixelRatio || 1;
    let ss = Math.min(4, Math.max(2, 2 * dpr));                // 화면보다 크게 그려서 줄이며 가장자리 매끄럽게
    if (W * H * ss * ss > 9e6) ss = Math.sqrt(9e6 / (W * H));
    ss = Math.min(ss, (GLR.maxTex - 2) / W, (GLR.maxTex - 2) / H);
    const RW = Math.max(1, Math.round(W * ss)), RH = Math.max(1, Math.round(H * ss));
    const R = 2.15 * Math.min(W, H) / 2 / S.scale, DR = 3 * R;
    const proj = (p) => { const q = P(p); return [q[0] * ss, q[1] * ss, depth(p)]; };
    const Ld = V.unit(V.add(V.add(V.mul(cam.d, 0.75), V.mul(cam.u, 0.55)), V.mul(cam.r, -0.35)));

    // 꼭짓점 모으기
    const T = [], Lv = [];
    const pushT = (q, c, a) => T.push(q[0], q[1], q[2], c[0] / 255, c[1] / 255, c[2] / 255, a);
    const K = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
    function poly(pts, wpx, rgb, a, dash, bias) {
      let s0 = 0, prev = null;
      for (let i = 0; i < pts.length; i++) {
        const q = pts[i] ? proj(pts[i]) : null;
        if (q && prev) {
          const A = [prev[0], prev[1], prev[2] + bias], B = [q[0], q[1], q[2] + bias];
          for (let k = 0; k < 6; k++) Lv.push(A[0], A[1], A[2], B[0], B[1], B[2], K[k][0], K[k][1], rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, a, wpx / 2, dash ? dash[0] : 0, dash ? dash[1] : 0, s0);
          s0 += Math.hypot(q[0] - prev[0], q[1] - prev[1]);
        }
        prev = q;
      }
    }
    surfs.forEach((sf) => {
      const { nu, nv, a, G, Q, CL } = buildSurf(sf, Ld, col, proj);
      for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
        const A = Q[i][j], B = Q[i + 1][j], Cq = Q[i + 1][j + 1], D = Q[i][j + 1];
        if (!A || !B || !Cq || !D) continue;
        pushT(A, CL[i][j], a); pushT(B, CL[i + 1][j], a); pushT(Cq, CL[i + 1][j + 1], a);
        pushT(A, CL[i][j], a); pushT(Cq, CL[i + 1][j + 1], a); pushT(D, CL[i][j + 1], a);
      }
      // 곡면에 붙는 격자선: 아주 조금만 앞으로 띄우고, 곡면 쪽을 화면 기울기만큼 뒤로 밀어서 자기 곡면 위에만 보이게
      const lc = rgbOf(col(sf.lineColor || C.surface)), la = sf.lineAlpha == null ? 0.28 : sf.lineAlpha, lw = (sf.lineWidth || 0.9) * ss, gb = 0.002 * R;
      if (sf.lines !== false && la > 0) {
        const su = sf.lineStep || Math.max(1, Math.round(nu / 24)), sv = sf.lineStep || Math.max(1, Math.round(nv / 24));
        for (let i = 0; i <= nu; i += su) poly(G[i], lw, lc, la, null, gb);
        for (let j = 0; j <= nv; j += sv) poly(G.map((r) => r[j]), lw, lc, la, null, gb);
      }
      (sf.gridLines || []).forEach((g) => poly(g.pts, (g.width || sf.lineWidth || 1) * ss, g.color ? rgbOf(col(g.color)) : lc, g.alpha == null ? la : g.alpha, null, gb));
    });
    extras.forEach((ex) => {
      const dash = ex.dash ? (ex.dash === true ? [5, 4] : ex.dash).map((v) => v * ss) : null;
      poly(ex.pts, (ex.width || 2.4) * ss, rgbOf(col(ex.color)), ex.alpha == null ? 1 : ex.alpha, dash, (ex.bias == null ? 0.04 : ex.bias) * R);
    });
    if (!T.length && !Lv.length) { drawXray(ctx, P, col, extras); return true; }
    // 실제로 그린 범위(화면 px)만 옮겨 붙임
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (let i = 0; i < T.length; i += 7) { const x = T[i], y = T[i + 1]; if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
    for (let i = 0; i < Lv.length; i += 16) {
      const m = Lv[i + 12] + 2;
      for (const o of [0, 3]) { const x = Lv[i + o], y = Lv[i + o + 1]; if (x - m < bx0) bx0 = x - m; if (x + m > bx1) bx1 = x + m; if (y - m < by0) by0 = y - m; if (y + m > by1) by1 = y + m; }
    }
    bx0 = Math.max(0, Math.floor(bx0) - 2); by0 = Math.max(0, Math.floor(by0) - 2);
    bx1 = Math.min(RW, Math.ceil(bx1) + 2); by1 = Math.min(RH, Math.ceil(by1) + 2);
    if (bx1 <= bx0 || by1 <= by0) { drawXray(ctx, P, col, extras); return true; }

    try {
      glTargets(RW, RH);
      const nT = T.length / 7, nL = Lv.length / 16;
      gl.bindBuffer(gl.ARRAY_BUFFER, GLR.tri.buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(T), gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, GLR.line.buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(Lv), gl.DYNAMIC_DRAW);
      gl.viewport(0, 0, RW, RH);
      gl.disable(gl.CULL_FACE);
      // 누적 버퍼 비우기
      gl.bindFramebuffer(gl.FRAMEBUFFER, GLR.fbA); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      const epsD = 1e-5, epsL = (0.006 * R) / DR * 0.5;
      for (let k = 0; k < PEELS; k++) {
        const fb = k % 2 ? GLR.fb1 : GLR.fb0, prev = k % 2 ? GLR.dTex0 : GLR.dTex1;
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.clearColor(0, 0, 0, 0); gl.clearDepth(1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(true); gl.disable(gl.BLEND);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, prev);
        if (nT) {
          const t = GLR.tri; gl.useProgram(t.p); gl.bindVertexArray(t.vao);
          gl.uniform2f(t.l.u_size, RW, RH); gl.uniform1f(t.l.u_dr, DR); gl.uniform1i(t.l.u_prev, 0); gl.uniform1i(t.l.u_peel, k ? 1 : 0); gl.uniform1f(t.l.u_eps, epsD);
          gl.uniform1f(t.l.u_off, ss + 1.5);
          gl.drawArrays(gl.TRIANGLES, 0, nT);
        }
        if (nL) {
          const l = GLR.line; gl.useProgram(l.p); gl.bindVertexArray(l.vao);
          gl.uniform2f(l.l.u_size, RW, RH); gl.uniform1f(l.l.u_dr, DR); gl.uniform1i(l.l.u_prev, 0); gl.uniform1i(l.l.u_peel, k ? 1 : 0); gl.uniform1f(l.l.u_epsL, epsL);
          gl.drawArrays(gl.TRIANGLES, 0, nL);
        }
        // 이번 겹을 누적 버퍼 뒤쪽에 깔기(앞→뒤 합성)
        gl.bindFramebuffer(gl.FRAMEBUFFER, GLR.fbA);
        gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE_MINUS_DST_ALPHA, gl.ONE);
        gl.bindTexture(gl.TEXTURE_2D, GLR.colTex);
        gl.useProgram(GLR.quad.p); gl.bindVertexArray(GLR.quad.vao); gl.uniform1i(GLR.quad.l.u_tex, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      // 화면 해상도로 줄여서(그린 범위만) 읽어 옴
      const f = ss / dpr, n = Math.min(4, Math.ceil(f - 1e-6));
      const ox0 = Math.floor(bx0 / f), oy0 = Math.floor(by0 / f), OW = Math.min(Math.ceil(bx1 / f), Math.floor(RW / f)) - ox0, OH = Math.min(Math.ceil(by1 / f), Math.floor(RH / f)) - oy0;
      if (OW <= 0 || OH <= 0) { drawXray(ctx, P, col, extras); return true; }
      gl.bindFramebuffer(gl.FRAMEBUFFER, GLR.fbO); gl.viewport(0, 0, OW, OH); gl.disable(gl.BLEND);
      gl.bindTexture(gl.TEXTURE_2D, GLR.accTex);
      const dn = GLR.down; gl.useProgram(dn.p); gl.bindVertexArray(GLR.quad.vao);
      gl.uniform1i(dn.l.u_tex, 0); gl.uniform2f(dn.l.u_org, ox0, oy0); gl.uniform1f(dn.l.u_f, f); gl.uniform1i(dn.l.u_n, n); gl.uniform1f(dn.l.u_rh, RH - 1e-4);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const px = new Uint8Array(OW * OH * 4);
      gl.readPixels(0, 0, OW, OH, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.bindVertexArray(null); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (!offCanvas) offCanvas = document.createElement("canvas");
      if (offCanvas.width < OW) offCanvas.width = OW;
      if (offCanvas.height < OH) offCanvas.height = OH;
      const octx = offCanvas.getContext("2d", { willReadFrequently: true });
      const img = new ImageData(new Uint8ClampedArray(px.buffer), OW, OH);
      octx.clearRect(0, 0, offCanvas.width, offCanvas.height);
      octx.putImageData(img, 0, 0);
      ctx.save();
      ctx.drawImage(offCanvas, 0, 0, OW, OH, ox0 / dpr, oy0 / dpr, OW / dpr, OH / dpr);
      ctx.restore();
    } catch (e) {
      if (window.console) console.warn("WebGL 렌더러 오류, CPU로 바꿔요:", e && e.message);
      GLR.state = -1;
      return false;
    }
    drawXray(ctx, P, col, extras);
    return true;
  }

  // 곡면 격자: 꼭짓점 위치(G), 화면 좌표(Q), 음영 넣은 꼭짓점 색(CL, 0~255)
  function buildSurf(sf, Ld, col, proj) {
    const nu = Array.isArray(sf.n) ? sf.n[0] : sf.n || 24, nv = Array.isArray(sf.n) ? sf.n[1] : sf.n || 24;
    const c1 = rgbOf(col(sf.color || "--aux")), c2 = sf.color2 ? rgbOf(col(sf.color2)) : null;
    const a = sf.alpha == null ? 0.88 : sf.alpha;
    const G = [];
    for (let i = 0; i <= nu; i++) {
      const row = [];
      for (let j = 0; j <= nv; j++) {
        const p = sf.f(sf.u[0] + (sf.u[1] - sf.u[0]) * i / nu, sf.v[0] + (sf.v[1] - sf.v[0]) * j / nv);
        row.push(p && isFinite(p[0]) && isFinite(p[1]) && isFinite(p[2]) ? p : null);
      }
      G.push(row);
    }
    // 꼭짓점 색(법선으로 음영, 고로 셰이딩)
    const Q = [], CL = [];
    const g = (i, j) => (i >= 0 && i <= nu && j >= 0 && j <= nv ? G[i][j] : null);
    for (let i = 0; i <= nu; i++) {
      const qr = [], cr = [];
      for (let j = 0; j <= nv; j++) {
        const p = G[i][j];
        if (!p) { qr.push(null); cr.push(null); continue; }
        const pu = V.sub(g(i + 1, j) || p, g(i - 1, j) || p), pv = V.sub(g(i, j + 1) || p, g(i, j - 1) || p);
        const nr = V.cross(pu, pv), ln = V.len(nr);
        const shade = ln < 1e-12 ? 0.8 : 0.42 + 0.58 * Math.abs(V.dot(nr, Ld) / ln);
        let base = c1;
        if (c2) {
          const zr = sf.zr || [-1, 1], k = Math.max(0, Math.min(1, (p[2] - zr[0]) / (zr[1] - zr[0] || 1)));
          base = [c1[0] + (c2[0] - c1[0]) * k, c1[1] + (c2[1] - c1[1]) * k, c1[2] + (c2[2] - c1[2]) * k];
        }
        qr.push(proj(p)); cr.push([base[0] * shade, base[1] * shade, base[2] * shade]);
      }
      Q.push(qr); CL.push(cr);
    }
    return { nu, nv, a, G, Q, CL };
  }

  function meshRaster(S, C, col, cam, surfs, extras) {
    const ctx = S.ctx, W = S.W, H = S.H, P = S.P, depth = S.depth;
    const dpr = window.devicePixelRatio || 1;
    let ss = Math.max(1.5, dpr);                             // 1배 화면은 1.5배로 그려서 줄이며 계단 완화
    if (W * H * ss * ss > 1.6e6) ss = Math.sqrt(1.6e6 / (W * H));
    const RW = Math.max(1, Math.round(W * ss)), RH = Math.max(1, Math.round(H * ss)), N = RW * RH;
    const B = rbuf(N), cnt = B.cnt, dep = B.dep, alp = B.alp, cl = B.col, own = B.own, stamp = B.stamp;
    cnt.fill(0, 0, N); stamp.fill(0, 0, N);
    const R = 2.15 * Math.min(W, H) / 2 / S.scale;          // 화면에 보이는 대략의 길이
    let x0b = RW, y0b = RH, x1b = -1, y1b = -1;
    const proj = (p) => { const q = P(p); return [q[0] * ss, q[1] * ss, depth(p)]; };

    // 조각 하나 넣기: 가까운 것부터 KL개만 남김. 같은 주인(owner)의 거의 같은 깊이는 합침.
    function put(idx, z, r, g, b, a, o, eps) {
      const base = idx * KL; let c = cnt[idx];
      for (let i = 0; i < c; i++) {
        const k = base + i;
        if (own[k] === o && Math.abs(dep[k] - z) < eps) {
          if (a > alp[k] || z > dep[k]) { if (a >= alp[k]) { cl[k * 3] = r; cl[k * 3 + 1] = g; cl[k * 3 + 2] = b; alp[k] = a; } dep[k] = Math.max(dep[k], z); }
          return;
        }
      }
      let pos = 0;
      while (pos < c && dep[base + pos] >= z) { if (alp[base + pos] >= 0.995) return; pos++; }
      if (pos >= KL) return;
      const last = Math.min(c, KL - 1);
      for (let i = last; i > pos; i--) {
        const k = base + i, k1 = k - 1;
        dep[k] = dep[k1]; alp[k] = alp[k1]; own[k] = own[k1];
        cl[k * 3] = cl[k1 * 3]; cl[k * 3 + 1] = cl[k1 * 3 + 1]; cl[k * 3 + 2] = cl[k1 * 3 + 2];
      }
      const k = base + pos;
      dep[k] = z; alp[k] = a; own[k] = o; cl[k * 3] = r; cl[k * 3 + 1] = g; cl[k * 3 + 2] = b;
      c = Math.min(c + 1, KL);
      if (a >= 0.995) c = pos + 1;                       // 불투명하면 그 뒤는 버림
      cnt[idx] = c;
    }

    function tri(A, Bp, Cp, ca, cb, cc, a, o, eps) {
      const area = (Bp[0] - A[0]) * (Cp[1] - A[1]) - (Cp[0] - A[0]) * (Bp[1] - A[1]);
      if (Math.abs(area) < 1e-9) return;
      let xa = Math.floor(Math.min(A[0], Bp[0], Cp[0])), xb = Math.ceil(Math.max(A[0], Bp[0], Cp[0]));
      let ya = Math.floor(Math.min(A[1], Bp[1], Cp[1])), yb = Math.ceil(Math.max(A[1], Bp[1], Cp[1]));
      xa = Math.max(0, xa); ya = Math.max(0, ya); xb = Math.min(RW - 1, xb); yb = Math.min(RH - 1, yb);
      if (xa > xb || ya > yb) return;
      x0b = Math.min(x0b, xa); y0b = Math.min(y0b, ya); x1b = Math.max(x1b, xb); y1b = Math.max(y1b, yb);
      const ia = 1 / area, E = -1e-7;
      // w0: 꼭짓점 A의 무게 (변 B→C), w1: B (변 C→A)
      const d0x = -(Cp[1] - Bp[1]) * ia, d1x = -(A[1] - Cp[1]) * ia;
      for (let y = ya; y <= yb; y++) {
        const py = y + 0.5, px0 = xa + 0.5;
        let w0 = ((Bp[0] - px0) * (Cp[1] - py) - (Cp[0] - px0) * (Bp[1] - py)) * ia;
        let w1 = ((Cp[0] - px0) * (A[1] - py) - (A[0] - px0) * (Cp[1] - py)) * ia;
        let row = y * RW + xa;
        for (let x = xa; x <= xb; x++, w0 += d0x, w1 += d1x, row++) {
          const w2 = 1 - w0 - w1;
          if (w0 < E || w1 < E || w2 < E) continue;
          const z = w0 * A[2] + w1 * Bp[2] + w2 * Cp[2];
          put(row, z, w0 * ca[0] + w1 * cb[0] + w2 * cc[0], w0 * ca[1] + w1 * cb[1] + w2 * cc[1], w0 * ca[2] + w1 * cb[2] + w2 * cc[2], a, o, eps);
        }
      }
    }

    // 굵은 선분. mode 0: 조각으로 넣기, mode 1: 주인 곡면 위에 색 섞기
    function seg(A, Bp, wpx, rgb, a, o, mode, dash, s0, sid, eps) {
      const dx = Bp[0] - A[0], dy = Bp[1] - A[1], L2 = dx * dx + dy * dy, L = Math.sqrt(L2), hw = wpx / 2;
      const m = hw + 1;
      const xa = Math.max(0, Math.floor(Math.min(A[0], Bp[0]) - m)), xb = Math.min(RW - 1, Math.ceil(Math.max(A[0], Bp[0]) + m));
      const ya = Math.max(0, Math.floor(Math.min(A[1], Bp[1]) - m)), yb = Math.min(RH - 1, Math.ceil(Math.max(A[1], Bp[1]) + m));
      if (xa > xb || ya > yb) return;
      if (mode === 0) { x0b = Math.min(x0b, xa); y0b = Math.min(y0b, ya); x1b = Math.max(x1b, xb); y1b = Math.max(y1b, yb); }
      for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
        const px = x + 0.5 - A[0], py = y + 0.5 - A[1];
        let t = L2 > 1e-9 ? (px * dx + py * dy) / L2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = px - t * dx, ey = py - t * dy, d = Math.sqrt(ex * ex + ey * ey);
        let cov = hw + 0.5 - d; if (cov <= 0) continue; if (cov > 1) cov = 1;
        if (dash) { const sp = (s0 + t * L) % (dash[0] + dash[1]); if (sp > dash[0]) continue; }
        const z = A[2] + t * (Bp[2] - A[2]), idx = y * RW + x;
        if (mode === 0) { put(idx, z, rgb[0], rgb[1], rgb[2], a * cov, o, eps); continue; }
        if (stamp[idx] === sid) continue;
        const base = idx * KL, c = cnt[idx];
        for (let i = 0; i < c; i++) {
          const k = base + i;
          if (own[k] === o && Math.abs(dep[k] - z) < eps) {
            const f = a * cov;
            cl[k * 3] += (rgb[0] - cl[k * 3]) * f; cl[k * 3 + 1] += (rgb[1] - cl[k * 3 + 1]) * f; cl[k * 3 + 2] += (rgb[2] - cl[k * 3 + 2]) * f;
            stamp[idx] = sid; break;
          }
        }
      }
    }
    function poly(pts, wpx, rgb, a, o, mode, dash, bias, sid, eps) {
      const Q = pts.map((p) => (p ? proj(p) : null));
      let s0 = 0;
      for (let i = 0; i + 1 < Q.length; i++) {
        const A = Q[i], Bq = Q[i + 1];
        if (!A || !Bq) continue;
        seg([A[0], A[1], A[2] + bias], [Bq[0], Bq[1], Bq[2] + bias], wpx, rgb, a, o, mode, dash, s0, sid, eps);
        s0 += Math.hypot(Bq[0] - A[0], Bq[1] - A[1]);
      }
    }

    const Ld = V.unit(V.add(V.add(V.mul(cam.d, 0.75), V.mul(cam.u, 0.55)), V.mul(cam.r, -0.35)));
    const epsSurf = 0.002 * R, epsLine = 0.03 * R;
    let sid = 1;
    surfs.forEach((sf, si) => {
      const o = si + 1;
      const { nu, nv, a, G, Q, CL } = buildSurf(sf, Ld, col, proj);
      for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
        const A = Q[i][j], Bq = Q[i + 1][j], Cq = Q[i + 1][j + 1], D = Q[i][j + 1];
        if (!A || !Bq || !Cq || !D) continue;
        tri(A, Bq, Cq, CL[i][j], CL[i + 1][j], CL[i + 1][j + 1], a, o, epsSurf);
        tri(A, Cq, D, CL[i][j], CL[i + 1][j + 1], CL[i][j + 1], a, o, epsSurf);
      }
      // 곡면에 붙는 격자선
      const lc = rgbOf(col(sf.lineColor || C.surface)), la = sf.lineAlpha == null ? 0.28 : sf.lineAlpha, lw = (sf.lineWidth || 0.9) * ss;
      if (sf.lines !== false && la > 0) {
        const su = sf.lineStep || Math.max(1, Math.round(nu / 24)), sv = sf.lineStep || Math.max(1, Math.round(nv / 24));
        for (let i = 0; i <= nu; i += su) poly(G[i], lw, lc, la, o, 1, null, 0, sid++, epsLine);
        for (let j = 0; j <= nv; j += sv) poly(G.map((r) => r[j]), lw, lc, la, o, 1, null, 0, sid++, epsLine);
      }
      (sf.gridLines || []).forEach((gl) => poly(gl.pts, (gl.width || sf.lineWidth || 1) * ss, gl.color ? rgbOf(col(gl.color)) : lc, gl.alpha == null ? la : gl.alpha, o, 1, null, 0, sid++, epsLine));
    });
    // 따로 그리는 선(곡선, 접선 등)
    extras.forEach((ex, ei) => {
      const o = -(ei + 1);
      const dash = ex.dash ? (ex.dash === true ? [5, 4] : ex.dash).map((v) => v * ss) : null;
      poly(ex.pts, (ex.width || 2.4) * ss, rgbOf(col(ex.color)), ex.alpha == null ? 1 : ex.alpha, o, 0, dash, (ex.bias == null ? 0.04 : ex.bias) * R, 0, epsLine * 2);
    });
    if (x1b < x0b || y1b < y0b) return;

    // 뒤에서 앞으로 합성
    const bw = x1b - x0b + 1, bh = y1b - y0b + 1;
    if (!offCanvas) offCanvas = document.createElement("canvas");
    if (offCanvas.width < bw) offCanvas.width = bw;
    if (offCanvas.height < bh) offCanvas.height = bh;
    const octx = offCanvas.getContext("2d", { willReadFrequently: true });
    const img = octx.createImageData(bw, bh), d = img.data;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const idx = (y + y0b) * RW + (x + x0b), c = cnt[idx];
      if (!c) continue;
      let r = 0, gg = 0, b = 0, A = 0;
      for (let i = c - 1; i >= 0; i--) {
        const k = idx * KL + i, af = alp[k], na = 1 - af;
        r = cl[k * 3] * af + r * na; gg = cl[k * 3 + 1] * af + gg * na; b = cl[k * 3 + 2] * af + b * na; A = af + A * na;
      }
      const o4 = (y * bw + x) * 4;
      if (A > 0) { d[o4] = r / A; d[o4 + 1] = gg / A; d[o4 + 2] = b / A; d[o4 + 3] = A * 255; }
    }
    octx.clearRect(0, 0, offCanvas.width, offCanvas.height);
    octx.putImageData(img, 0, 0);
    ctx.save();
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    ctx.drawImage(offCanvas, 0, 0, bw, bh, x0b / ss, y0b / ss, bw / ss, bh / ss);
    ctx.restore();
    drawXray(ctx, P, col, extras);
  }

  // xray: 가려진 부분도 옅게 보여 줄 선은 위에 한 번 더
  function drawXray(ctx, P, col, extras) {
    ctx.save();
    extras.forEach((ex) => {
      if (!ex.xray) return;
      ctx.globalAlpha = ex.xray * (ex.alpha == null ? 1 : ex.alpha);
      ctx.strokeStyle = col(ex.color); ctx.lineWidth = (ex.width || 2.4) * 0.8; ctx.lineJoin = "round"; ctx.lineCap = "round";
      ctx.setLineDash(ex.dash ? (ex.dash === true ? [5, 4] : ex.dash) : []);
      ctx.beginPath(); let pen = false;
      ex.pts.forEach((p) => { if (!p) { pen = false; return; } const q = P(p); pen ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); pen = true; });
      ctx.stroke(); ctx.setLineDash([]);
    });
    ctx.restore();
  }

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
        // 곡면과 선을 픽셀 단위 깊이로 그린다(WebGL2, 안 되면 CPU). 서로 뚫고 지나가는 곡면도 정확히 가려짐.
        // surfs: [{ f(u,v) → [x,y,z] | null, u:[a,b], v:[c,d], n: 24 | [nu,nv],
        //           color: '--aux', color2: '--curve'(높이에 따라 섞기), zr:[z0,z1], alpha: .88,
        //           lines: true(매개변수 격자), lineAlpha, lineColor, gridLines: [{ pts, alpha }](곡면에 붙는 선) }]
        // extras: [{ pts:[...], color, width, dash, alpha, bias, xray }]  (곡면 위의 곡선 등, xray: 가려진 부분을 옅게 보일 비율)
        mesh(surfs, extras) {
          if (!meshGL(S, C, col, cam, surfs || [], extras || [])) meshRaster(S, C, col, cam, surfs || [], extras || []);
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

  window.Space = { mount: mount, V: V, camera: camera, rgbOf: rgbOf };
})();
