/* ===== 粒子宇宙 · WebGL 粒子引擎 ===== */
(function () {
  'use strict';

  var canvas = document.getElementById('cosmos');
  var gl = canvas.getContext('webgl', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance'
  });
  if (!gl) {
    document.body.innerHTML = '<p style="color:#7df9ff;text-align:center;margin-top:40vh">你的浏览器不支持 WebGL,换个现代浏览器再来看宇宙。</p>';
    return;
  }

  /* ---------- 基本参数 ---------- */
  var DPR = Math.min(window.devicePixelRatio || 1, 2);
  var isMobile = Math.min(window.innerWidth, window.innerHeight) < 700 || /Mobi|Android|iPhone/i.test(navigator.userAgent);
  var N = isMobile ? 45000 : 130000;      // 总粒子数
  var activeN = N;                         // 当前实际参与的粒子数(FPS 调节)
  var W = 0, H = 0, CX = 0, CY = 0, MAXR = 0;

  var mode = 'text';                       // 开场先用文字模式拼 LOGO
  var timeSec = 0;

  /* ---------- 粒子状态 ---------- */
  var px = new Float32Array(N), py = new Float32Array(N);
  var vx = new Float32Array(N), vy = new Float32Array(N);
  var tx = new Float32Array(N), ty = new Float32Array(N);   // 文字目标
  var hasT = new Uint8Array(N);
  var gr0 = new Float32Array(N), gth0 = new Float32Array(N); // 星系基准分布
  var gr = new Float32Array(N), gth = new Float32Array(N);   // 星系实时极坐标
  var gw = new Float32Array(N);                              // 角速度
  var seed = new Float32Array(N);
  var fst = new Uint8Array(N);                               // 烟花状态 0=尘埃 1=绽放
  var fl = new Float32Array(N);                              // 烟花寿命
  var colR = new Float32Array(N), colG = new Float32Array(N), colB = new Float32Array(N);
  var baseSize = new Float32Array(N);

  var dyn = new Float32Array(N * 4);       // [x, y, size, alpha] 每帧上传
  var colArr = new Float32Array(N * 3);    // [r, g, b] 调色时上传

  var TILT = -0.32, SQUASH = 0.62;
  var cosT = Math.cos(TILT), sinT = Math.sin(TILT);

  for (var i = 0; i < N; i++) seed[i] = Math.random() * Math.PI * 2;

  /* ---------- 调色板 ---------- */
  var PALETTES = [
    { name: '星辰', css: 'linear-gradient(135deg,#7df9ff,#4f7cff,#b26bff)',
      stops: [[125,249,255],[79,124,255],[178,107,255],[255,247,214]] },
    { name: '熔金', css: 'linear-gradient(135deg,#fff3c4,#ffc94d,#ff3d81)',
      stops: [[255,243,196],[255,201,77],[255,120,71],[255,61,129]] },
    { name: '霓虹', css: 'linear-gradient(135deg,#00e5ff,#ff2ec4,#8a2eff)',
      stops: [[0,229,255],[255,46,196],[138,46,255],[255,255,255]] },
    { name: '极光', css: 'linear-gradient(135deg,#52ffb8,#00d4ff,#7cffcb)',
      stops: [[82,255,184],[0,212,255],[124,255,203],[233,255,240]] }
  ];
  var palIdx = 0;

  function palColor(t, out) {
    var stops = PALETTES[palIdx].stops;
    var seg = Math.min(stops.length - 2, Math.floor(t * (stops.length - 1)));
    var f = t * (stops.length - 1) - seg;
    var a = stops[seg], b = stops[seg + 1];
    out[0] = (a[0] + (b[0] - a[0]) * f) / 255;
    out[1] = (a[1] + (b[1] - a[1]) * f) / 255;
    out[2] = (a[2] + (b[2] - a[2]) * f) / 255;
  }

  var tmpC = [0, 0, 0];
  function recolor() {
    for (var i = 0; i < N; i++) {
      var t;
      if (mode === 'text' && hasT[i]) {
        t = Math.max(0, Math.min(1, (tx[i] - W * 0.18) / (W * 0.64)));
      } else {
        t = Math.max(0, Math.min(1, gr0[i] / (MAXR || 1)));
        // 核心偏暖白
        if (t < 0.14) t = 0.96;
      }
      palColor(t, tmpC);
      var tw = 0.75 + 0.25 * Math.sin(seed[i] * 7.3);
      colR[i] = tmpC[0] * tw; colG[i] = tmpC[1] * tw; colB[i] = tmpC[2] * tw;
      colArr[i * 3] = colR[i]; colArr[i * 3 + 1] = colG[i]; colArr[i * 3 + 2] = colB[i];
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
    gl.bufferData(gl.ARRAY_BUFFER, colArr, gl.DYNAMIC_DRAW);
  }

  /* ---------- WebGL 程序 ---------- */
  function makeProgram(vsSrc, fsSrc) {
    function sh(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    }
    var p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  var pointProg = makeProgram(
    'attribute vec4 a_dyn;\n' +      // x, y, size, alpha
    'attribute vec3 a_col;\n' +
    'uniform vec2 u_res;\n' +
    'varying vec3 v_col;\n' +
    'varying float v_a;\n' +
    'void main(){\n' +
    '  vec2 clip = (a_dyn.xy / u_res) * 2.0 - 1.0;\n' +
    '  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);\n' +
    '  gl_PointSize = a_dyn.z;\n' +
    '  v_col = a_col; v_a = a_dyn.w;\n' +
    '}',
    'precision mediump float;\n' +
    'varying vec3 v_col;\n' +
    'varying float v_a;\n' +
    'void main(){\n' +
    '  vec2 d = gl_PointCoord - 0.5;\n' +
    '  float r = length(d) * 2.0;\n' +
    '  if (r > 1.0) discard;\n' +
    '  float glow = exp(-r * r * 5.0);\n' +
    '  float core = smoothstep(0.32, 0.0, r);\n' +
    '  float a = (glow * 0.55 + core) * v_a;\n' +
    '  gl_FragColor = vec4(v_col * a, a);\n' +
    '}'
  );
  var fadeProg = makeProgram(
    'attribute vec2 a_p;\n' +
    'void main(){ gl_Position = vec4(a_p, 0.0, 1.0); }',
    'precision mediump float;\n' +
    'uniform float u_fade;\n' +
    'void main(){ gl_FragColor = vec4(0.012, 0.016, 0.035, u_fade); }'
  );

  var dynBuf = gl.createBuffer();
  var colBuf = gl.createBuffer();
  var quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

  var locDyn = gl.getAttribLocation(pointProg, 'a_dyn');
  var locCol = gl.getAttribLocation(pointProg, 'a_col');
  var locRes = gl.getUniformLocation(pointProg, 'u_res');
  var locQuad = gl.getAttribLocation(fadeProg, 'a_p');
  var locFade = gl.getUniformLocation(fadeProg, 'u_fade');

  /* ---------- 星系分布 ---------- */
  function initGalaxy() {
    var ARMS = 3;
    for (var i = 0; i < N; i++) {
      var kind = i % 9;                    // 0 = 晕尘, 1 = 核球, 其余 = 旋臂
      var t = Math.pow(Math.random(), 1.3);
      var r = 22 * DPR + t * MAXR;
      var arm = i % ARMS;
      var scatter = (Math.random() + Math.random() + Math.random() - 1.5) * (0.15 + 0.24 * t);
      var th = arm * (Math.PI * 2 / ARMS) + r * (0.0135 / DPR) + scatter;
      if (kind === 0) { r = Math.random() * MAXR * 1.18; th = Math.random() * Math.PI * 2; }
      else if (kind === 1) {
        r = Math.abs(Math.random() + Math.random() - 1) * MAXR * 0.17 + 4 * DPR;
        th = Math.random() * Math.PI * 2;
      }
      gr0[i] = r; gth0[i] = th;
      gr[i] = r; gth[i] = th;
      gw[i] = (26 * DPR) / (r + 42 * DPR) * (kind === 0 ? 0.5 : 1);
      baseSize[i] = (kind === 0 ? 0.9 : 1.1 + (1 - t) * 1.4 + Math.random() * 0.7) * DPR;
    }
  }

  function polarIdeal(i, out) {
    var c = Math.cos(gth[i]), s = Math.sin(gth[i]);
    var rx = gr[i] * c, ry = gr[i] * s * SQUASH;
    out[0] = CX + rx * cosT - ry * sinT;
    out[1] = CY + rx * sinT + ry * cosT;
  }
  var tmpP = [0, 0];

  /* ---------- 文字目标 ---------- */
  var textCanvas = document.createElement('canvas');
  var textCtx = textCanvas.getContext('2d', { willReadFrequently: true });

  function setTextTargets(str) {
    str = (str || '').trim();
    if (!str) return false;
    var tw = Math.floor(W * 0.88), th = Math.floor(H * 0.62);
    textCanvas.width = tw; textCanvas.height = th;
    textCtx.clearRect(0, 0, tw, th);
    var fs = Math.floor(Math.min(th * 0.72, (tw * 0.92) / Math.max(1, str.length) * 1.28));
    textCtx.font = '900 ' + fs + 'px "Noto Serif SC","Source Han Serif SC","Songti SC",SimSun,"Microsoft YaHei",serif';
    textCtx.textAlign = 'center';
    textCtx.textBaseline = 'middle';
    textCtx.fillStyle = '#fff';
    textCtx.fillText(str, tw / 2, th / 2);
    var img = textCtx.getImageData(0, 0, tw, th).data;

    var lit = 0;
    for (var p = 3; p < img.length; p += 4) if (img[p] > 100) lit++;
    if (!lit) return false;
    var maxTargets = Math.floor(activeN * 0.58);
    var stride = Math.max(1, Math.ceil(lit / maxTargets));
    var ox = (W - tw) / 2, oy = (H - th) / 2 - H * 0.04;

    var m = 0, k = 0;
    for (var y = 0; y < th; y++) {
      for (var x = 0; x < tw; x++) {
        if (img[(y * tw + x) * 4 + 3] > 100) {
          if (k % stride === 0 && m < N) {
            tx[m] = ox + x + (Math.random() - 0.5) * 1.6;
            ty[m] = oy + y + (Math.random() - 0.5) * 1.6;
            hasT[m] = 1;
            m++;
          }
          k++;
        }
      }
    }
    for (var j = m; j < N; j++) hasT[j] = 0;
    return true;
  }

  /* ---------- 输入 ---------- */
  var mouseX = 0, mouseY = 0, mouseOn = false;
  var waves = [];   // {x, y, t}

  function toDev(e) {
    var r = canvas.getBoundingClientRect();
    mouseX = (e.clientX - r.left) * DPR;
    mouseY = (e.clientY - r.top) * DPR;
  }
  canvas.addEventListener('pointermove', function (e) { toDev(e); mouseOn = true; wake(); });
  canvas.addEventListener('pointerleave', function () { mouseOn = false; });
  canvas.addEventListener('pointerdown', function (e) {
    toDev(e); mouseOn = true;
    waves.push({ x: mouseX, y: mouseY, t: timeSec });
    if (waves.length > 6) waves.shift();
    var flash = document.getElementById('flash');
    flash.style.setProperty('--fx', (e.clientX / window.innerWidth * 100) + '%');
    flash.style.setProperty('--fy', (e.clientY / window.innerHeight * 100) + '%');
    flash.classList.remove('on'); void flash.offsetWidth; flash.classList.add('on');
    sfx.boom();
    wake();
  });

  /* ---------- 音效 ---------- */
  var sfx = (function () {
    var ac = null, muted = false;
    function ctx() {
      if (!ac) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (AC) ac = new AC();
      }
      if (ac && ac.state === 'suspended') ac.resume();
      return ac;
    }
    function env(g, t0, peak, dur) {
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    }
    return {
      unlock: function () { ctx(); },
      toggle: function () { muted = !muted; return muted; },
      boom: function () {
        var a = ctx(); if (!a || muted) return;
        var t = a.currentTime;
        var o = a.createOscillator(), g = a.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(120, t);
        o.frequency.exponentialRampToValueAtTime(32, t + 0.42);
        env(g, t, 0.5, 0.5);
        o.connect(g).connect(a.destination);
        o.start(t); o.stop(t + 0.55);
        var len = Math.floor(a.sampleRate * 0.25);
        var buf = a.createBuffer(1, len, a.sampleRate);
        var d = buf.getChannelData(0);
        for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
        var src = a.createBufferSource(); src.buffer = buf;
        var f = a.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900;
        var g2 = a.createGain(); env(g2, t, 0.25, 0.3);
        src.connect(f).connect(g2).connect(a.destination);
        src.start(t);
      },
      chime: function () {
        var a = ctx(); if (!a || muted) return;
        var t = a.currentTime;
        [660, 990].forEach(function (fq, i) {
          var o = a.createOscillator(), g = a.createGain();
          o.type = 'sine'; o.frequency.value = fq;
          env(g, t + i * 0.06, 0.12, 0.5);
          o.connect(g).connect(a.destination);
          o.start(t + i * 0.06); o.stop(t + i * 0.06 + 0.55);
        });
      },
      ignite: function () {
        var a = ctx(); if (!a || muted) return;
        var t = a.currentTime;
        var o = a.createOscillator(), g = a.createGain();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(140, t);
        o.frequency.exponentialRampToValueAtTime(1200, t + 0.5);
        var f = a.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1600;
        env(g, t, 0.18, 0.6);
        o.connect(f).connect(g).connect(a.destination);
        o.start(t); o.stop(t + 0.65);
      }
    };
  })();

  /* ---------- 模式切换 ---------- */
  var burstTimer = 0;
  function setMode(m, silent) {
    if (m === mode) return;
    mode = m;
    if (m === 'fireworks') {
      // 全屏撒成星空底,清掉上个模式留下的形状残影
      for (var i = 0; i < N; i++) {
        fst[i] = 0; fl[i] = 0;
        px[i] = Math.random() * W; py[i] = Math.random() * H;
        vx[i] = 0; vy[i] = 0;
      }
      burstTimer = 0.2;
    }
    if (m === 'galaxy' || m === 'blackhole') recolor();
    document.querySelectorAll('.mode-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.mode === m);
    });
    if (!silent) sfx.chime();
  }

  /* ---------- 物理更新 ---------- */
  function applyPointer(dt) {
    if (!mouseOn) return;
    var R = 150 * DPR, R2 = R * R, F = 620 * DPR;
    var x0 = mouseX - R, x1 = mouseX + R, y0 = mouseY - R, y1 = mouseY + R;
    for (var i = 0; i < activeN; i++) {
      var x = px[i], y = py[i];
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      var dx = x - mouseX, dy = y - mouseY;
      var d2 = dx * dx + dy * dy;
      if (d2 > R2 || d2 < 0.01) continue;
      var d = Math.sqrt(d2);
      var f = (1 - d / R) * F * dt / d;
      vx[i] += dx * f; vy[i] += dy * f;
    }
  }

  function applyWaves() {
    for (var w = waves.length - 1; w >= 0; w--) {
      var wv = waves[w];
      var age = timeSec - wv.t;
      if (age > 0.05) { waves.splice(w, 1); continue; }
      var Rs = 320 * DPR, K = 340 * DPR;
      for (var i = 0; i < activeN; i++) {
        var dx = px[i] - wv.x, dy = py[i] - wv.y;
        var d = Math.sqrt(dx * dx + dy * dy) + 1;
        if (d > Rs) continue;
        var f = (1 - d / Rs) * K / d;
        vx[i] += dx * f; vy[i] += dy * f;
      }
    }
  }

  function updGalaxy(dt) {
    var heal = Math.min(1, dt * 0.7);
    var pull = Math.min(1, dt * 2.6);
    for (var i = 0; i < activeN; i++) {
      gth[i] += gw[i] * dt * 0.55;
      gr[i] += (gr0[i] - gr[i]) * heal;
      polarIdeal(i, tmpP);
      px[i] += (tmpP[0] - px[i]) * pull + vx[i] * dt;
      py[i] += (tmpP[1] - py[i]) * pull + vy[i] * dt;
      vx[i] *= 0.9; vy[i] *= 0.9;
      var tw = Math.sin(timeSec * 1.7 + seed[i]);
      dyn[i * 4 + 2] = baseSize[i] * (1 + 0.22 * tw);
      dyn[i * 4 + 3] = 0.3 + 0.18 * tw;
    }
  }

  function updBlackhole(dt) {
    var HOLE = 46 * DPR;   // 视界半径:内侧粒子熄灭,形成黑心 + 亮环
    for (var i = 0; i < activeN; i++) {
      var sp = (170 * DPR) / (gr[i] + 26 * DPR);
      gth[i] += sp * dt * 1.15;
      gr[i] -= (26 * DPR) * dt * (0.3 + sp * 0.8);
      if (gr[i] < HOLE * 0.55) {
        gr[i] = MAXR * (0.55 + Math.random() * 0.75);
        gth[i] = Math.random() * Math.PI * 2;
      }
      polarIdeal(i, tmpP);
      var pull = Math.min(1, dt * 3.4);
      px[i] += (tmpP[0] - px[i]) * pull + vx[i] * dt;
      py[i] += (tmpP[1] - py[i]) * pull + vy[i] * dt;
      vx[i] *= 0.9; vy[i] *= 0.9;
      var heat = Math.min(1, sp * 1.2);
      var a = 0.07 + heat * 0.24;
      if (gr[i] < HOLE * 1.2) a *= Math.max(0, (gr[i] - HOLE * 0.55) / (HOLE * 0.65));
      dyn[i * 4 + 2] = baseSize[i] * (0.55 + heat * 0.75);
      dyn[i * 4 + 3] = a;
    }
  }

  function updFireworks(dt) {
    burstTimer -= dt;
    if (burstTimer <= 0) {
      burstTimer = 0.55 + Math.random() * 0.65;
      spawnBurst();
      if (Math.random() < 0.25) spawnBurst();   // 偶尔双发齐放
    }
    var g = 92 * DPR;
    for (var i = 0; i < activeN; i++) {
      if (fst[i] === 1) {
        vy[i] += g * dt;
        vx[i] *= 0.985; vy[i] *= 0.985;
        px[i] += vx[i] * dt; py[i] += vy[i] * dt;
        fl[i] -= dt * 0.62;
        if (fl[i] <= 0) { fst[i] = 0; }
        var a = Math.max(0, fl[i]);
        dyn[i * 4 + 2] = baseSize[i] * (0.9 + a * 1.3);
        dyn[i * 4 + 3] = a * (0.55 + 0.45 * Math.sin(timeSec * 14 + seed[i]));
      } else {
        px[i] += (Math.sin(seed[i] + timeSec * 0.3) * 5 * DPR + vx[i]) * dt;
        py[i] += (Math.cos(seed[i] * 1.3 + timeSec * 0.26) * 5 * DPR + vy[i]) * dt;
        vx[i] *= 0.94; vy[i] *= 0.94;
        if (px[i] < 0) px[i] += W; else if (px[i] > W) px[i] -= W;
        if (py[i] < 0) py[i] += H; else if (py[i] > H) py[i] -= H;
        dyn[i * 4 + 2] = baseSize[i] * 0.55;
        dyn[i * 4 + 3] = 0.05 + 0.04 * Math.sin(timeSec * 2 + seed[i] * 3);
      }
    }
  }

  var burstCursor = 0;
  function spawnBurst() {
    var bx = W * (0.15 + Math.random() * 0.7);
    var by = H * (0.12 + Math.random() * 0.45);
    var count = Math.min(Math.floor(activeN * 0.016), 2400);
    var S = (120 + Math.random() * 150) * DPR;
    var hue = Math.random();
    palColor(hue, tmpC);
    var rr = tmpC[0], gg = tmpC[1], bb = tmpC[2];
    var white = Math.random() < 0.15;
    var ring = Math.random() < 0.6;      // 六成是空心环形绽放,更像真烟花
    for (var k = 0; k < count; k++) {
      var i = burstCursor;
      burstCursor = (burstCursor + 1) % activeN;
      var ang = Math.random() * Math.PI * 2;
      var spd = ring && k < count * 0.72
        ? S * (0.88 + Math.random() * 0.18)
        : S * (0.25 + 0.75 * Math.pow(Math.random(), 0.4));
      px[i] = bx + (Math.random() - 0.5) * 14 * DPR;
      py[i] = by + (Math.random() - 0.5) * 14 * DPR;
      vx[i] = Math.cos(ang) * spd;
      vy[i] = Math.sin(ang) * spd * 0.9;
      fst[i] = 1; fl[i] = 0.9 + Math.random() * 0.35;
      var tw = 0.8 + 0.2 * Math.random();
      colArr[i * 3] = (white ? 1 : rr) * tw;
      colArr[i * 3 + 1] = (white ? 1 : gg) * tw;
      colArr[i * 3 + 2] = (white ? 1 : bb) * tw;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
    gl.bufferData(gl.ARRAY_BUFFER, colArr, gl.DYNAMIC_DRAW);
    sfx.boom();
  }

  function updText(dt) {
    var k = 14, damp = Math.pow(0.0022, dt); // 帧率无关阻尼
    for (var i = 0; i < activeN; i++) {
      if (hasT[i]) {
        var ax = (tx[i] - px[i]) * k, ay = (ty[i] - py[i]) * k;
        vx[i] = (vx[i] + ax * dt) * damp;
        vy[i] = (vy[i] + ay * dt) * damp;
        px[i] += vx[i] * dt; py[i] += vy[i] * dt;
        var dx = tx[i] - px[i], dy = ty[i] - py[i];
        var near = (dx * dx + dy * dy) < 26 * DPR;
        var tw2 = Math.sin(timeSec * 3.1 + seed[i] * 5);
        dyn[i * 4 + 2] = baseSize[i] * (near ? 1.15 + 0.35 * tw2 : 1.05);
        dyn[i * 4 + 3] = near ? 0.75 + 0.25 * tw2 : 0.55;
      } else {
        gth[i] += gw[i] * dt * 0.3;
        polarIdeal(i, tmpP);
        px[i] += (tmpP[0] - px[i]) * Math.min(1, dt * 1.6) + vx[i] * dt;
        py[i] += (tmpP[1] - py[i]) * Math.min(1, dt * 1.6) + vy[i] * dt;
        vx[i] *= 0.9; vy[i] *= 0.9;
        dyn[i * 4 + 2] = baseSize[i] * 0.55;
        dyn[i * 4 + 3] = 0.08;
      }
    }
  }

  /* ---------- 主循环 ---------- */
  var FADE = { galaxy: 0.15, blackhole: 0.16, fireworks: 0.078, text: 0.2 };
  var lastT = 0, fps = 60, fpsAcc = 0, fpsN = 0, fpsShow = 60, lowStreak = 0;

  function frame(t) {
    requestAnimationFrame(frame);
    if (!lastT) { lastT = t; return; }
    var dt = Math.min(0.05, (t - lastT) / 1000);
    lastT = t;
    timeSec += dt;

    /* FPS 统计与自适应降载 */
    fps = 1 / dt;
    fpsAcc += fps; fpsN++;
    if (fpsN >= 30) {
      fpsShow = Math.round(fpsAcc / fpsN);
      fpsAcc = 0; fpsN = 0;
      if (fpsShow < 45) {
        lowStreak++;
        if (lowStreak >= 2 && activeN > (isMobile ? 18000 : 40000)) {
          activeN = Math.floor(activeN * 0.85);
          lowStreak = 0;
        }
      } else lowStreak = 0;
      statEl.textContent = activeN.toLocaleString() + ' 粒子 · ' + fpsShow + ' FPS';
    }

    applyPointer(dt);
    applyWaves();
    if (mode === 'galaxy') updGalaxy(dt);
    else if (mode === 'blackhole') updBlackhole(dt);
    else if (mode === 'fireworks') updFireworks(dt);
    else updText(dt);

    for (var i = 0; i < activeN; i++) {
      dyn[i * 4] = px[i];
      dyn[i * 4 + 1] = py[i];
    }

    /* 拖影淡出层 */
    gl.useProgram(fadeProg);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.enableVertexAttribArray(locQuad);
    gl.vertexAttribPointer(locQuad, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1f(locFade, FADE[mode]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disableVertexAttribArray(locQuad);

    /* 加色粒子层 */
    gl.useProgram(pointProg);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.uniform2f(locRes, W, H);
    gl.bindBuffer(gl.ARRAY_BUFFER, dynBuf);
    gl.bufferData(gl.ARRAY_BUFFER, dyn.subarray(0, activeN * 4), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(locDyn);
    gl.vertexAttribPointer(locDyn, 4, gl.FLOAT, false, 16, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
    gl.enableVertexAttribArray(locCol);
    gl.vertexAttribPointer(locCol, 3, gl.FLOAT, false, 12, 0);
    gl.drawArrays(gl.POINTS, 0, activeN);
  }

  /* ---------- 尺寸 ---------- */
  function resize() {
    W = canvas.width = Math.floor(canvas.clientWidth * DPR);
    H = canvas.height = Math.floor(canvas.clientHeight * DPR);
    CX = W / 2; CY = H / 2;
    MAXR = Math.min(W, H) * 0.46;
    gl.viewport(0, 0, W, H);
    gl.clearColor(0.012, 0.016, 0.035, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    initGalaxy();
    recolor();
    if (mode === 'text' && currentText) setTextTargets(currentText);
  }
  window.addEventListener('resize', resize);

  /* ---------- UI ---------- */
  var statEl = document.getElementById('stat');
  var input = document.getElementById('text-input');
  var hint = document.getElementById('hint');
  var currentText = '';

  function ignite() {
    var v = input.value.trim();
    if (!v) return;
    if (setTextTargets(v)) {
      currentText = v;
      mode = 'text';
      document.querySelectorAll('.mode-btn').forEach(function (b) { b.classList.remove('active'); });
      recolor();
      sfx.ignite();
      input.blur();
    }
  }
  document.getElementById('btn-ignite').addEventListener('click', ignite);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) ignite();
  });

  document.querySelectorAll('.mode-btn').forEach(function (b) {
    b.addEventListener('click', function () { setMode(b.dataset.mode); });
  });

  /* 调色板 */
  var palBox = document.getElementById('palettes');
  PALETTES.forEach(function (p, i) {
    var d = document.createElement('button');
    d.className = 'pal-dot' + (i === 0 ? ' active' : '');
    d.style.background = p.css;
    d.title = p.name;
    d.addEventListener('click', function () {
      palIdx = i;
      recolor();
      palBox.querySelectorAll('.pal-dot').forEach(function (x) { x.classList.remove('active'); });
      d.classList.add('active');
    });
    palBox.appendChild(d);
  });

  /* 音效 / 全屏 */
  document.getElementById('btn-sound').addEventListener('click', function () {
    this.classList.toggle('off', sfx.toggle());
  });
  document.getElementById('btn-full').addEventListener('click', function () {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
  });
  window.addEventListener('pointerdown', function once() {
    sfx.unlock();
    window.removeEventListener('pointerdown', once);
  });

  /* 截图 */
  document.getElementById('btn-shot').addEventListener('click', function () {
    var out = document.createElement('canvas');
    out.width = W; out.height = H;
    var c2 = out.getContext('2d');
    c2.drawImage(canvas, 0, 0);
    c2.textAlign = 'right';
    c2.fillStyle = 'rgba(238,242,255,.5)';
    c2.font = '600 ' + Math.round(15 * DPR) + 'px "PingFang SC","Microsoft YaHei",sans-serif';
    c2.fillText('粒子宇宙 PARTICLE COSMOS', W - 22 * DPR, H - 24 * DPR);
    var url = out.toDataURL('image/png');
    document.getElementById('shot-img').src = url;
    document.getElementById('shot-download').href = url;
    document.getElementById('shot-modal').classList.remove('hidden');
  });
  document.getElementById('shot-close').addEventListener('click', function () {
    document.getElementById('shot-modal').classList.add('hidden');
  });
  document.getElementById('shot-modal').addEventListener('click', function (e) {
    if (e.target === this) this.classList.add('hidden');
  });

  /* 闲置隐藏 UI */
  var idleTimer = null;
  function wake() {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      if (document.activeElement !== input) document.body.classList.add('idle');
    }, 4500);
  }
  ['pointermove', 'pointerdown', 'keydown'].forEach(function (ev) {
    window.addEventListener(ev, wake);
  });

  /* ---------- 开场 ---------- */
  resize();
  for (var j = 0; j < N; j++) {
    px[j] = Math.random() * W;
    py[j] = Math.random() * H;
  }
  currentText = '粒子宇宙';
  setTextTargets(currentText);
  recolor();
  wake();

  setTimeout(function () {
    waves.push({ x: CX, y: CY, t: timeSec });
    setMode('galaxy', true);
    hint.classList.add('gone');
    setTimeout(function () { hint.style.display = 'none'; }, 1500);
  }, 3200);

  requestAnimationFrame(frame);

  /* 调试钩子:无 rAF 环境下手动泵帧用 */
  window.COSMOS = {
    step: frame,
    setMode: setMode,
    ignite: function (s) { input.value = s; ignite(); },
    info: function () { return { mode: mode, activeN: activeN, fps: fpsShow }; }
  };
})();
