/*
 * tracker.js - motion detection and blob tracking.
 *
 * No dependencies and no model download: an exponential-moving-average
 * background model, a cleaned-up foreground mask, connected components, and a
 * nearest-neighbour tracker with constant-velocity prediction. Everything runs
 * on a small (long side 320px) grayscale copy of each frame so that a phone can
 * keep up with a 30-60fps camera in real time.
 *
 * Pure arithmetic on typed arrays - no DOM - so the same code runs in node for
 * the test suite.
 */
(function (root) {
  'use strict';

  var DEFAULTS = {
    threshold: 20,        // gray levels a pixel must differ from the background
    bgAlpha: 0.06,        // background adaptation rate for background pixels
    bgAlphaFg: 0.003,     // ...and for pixels currently seen as foreground
    minAreaFrac: 0.0015,  // ignore blobs smaller than this fraction of the frame
    maxAreaFrac: 0.55,    // ignore blobs larger than this (lighting artefacts)
    erode: 1,             // mask cleanup: erode radius, then dilate radius
    dilate: 2,
    confirmHits: 2,       // frames a track must be seen before it is reported
    maxMisses: 8,         // frames a track survives without a match
    resetFgFrac: 0.45,    // above this foreground fraction, re-seed the background
    trailLimit: 120
  };

  // 3x3 box blur, separable. Knocks down sensor noise so the threshold below
  // can stay low enough to catch dark vehicles at dusk.
  function boxBlur(src, dst, w, h, tmp) {
    for (var y = 0; y < h; y++) {
      var o = y * w;
      for (var x = 0; x < w; x++) {
        var xm = x > 0 ? x - 1 : 0;
        var xp = x < w - 1 ? x + 1 : w - 1;
        tmp[o + x] = (src[o + xm] + src[o + x] + src[o + xp]) / 3;
      }
    }
    for (var y2 = 0; y2 < h; y2++) {
      var r0 = (y2 > 0 ? y2 - 1 : 0) * w;
      var r1 = y2 * w;
      var r2 = (y2 < h - 1 ? y2 + 1 : h - 1) * w;
      for (var x2 = 0; x2 < w; x2++) {
        dst[r1 + x2] = (tmp[r0 + x2] + tmp[r1 + x2] + tmp[r2 + x2]) / 3;
      }
    }
  }

  // Binary erode/dilate over a (2r+1)^2 window, counted with an integral image
  // so the cost is independent of the radius.
  function morph(src, dst, w, h, r, mode, I) {
    var iw = w + 1;
    for (var x = 0; x < iw; x++) I[x] = 0;
    for (var y = 0; y < h; y++) {
      var row = 0, o = y * w, io = (y + 1) * iw, ip = y * iw;
      I[io] = 0;
      for (var xx = 0; xx < w; xx++) {
        row += src[o + xx] ? 1 : 0;
        I[io + xx + 1] = I[ip + xx + 1] + row;
      }
    }
    var dilate = mode === 'dilate';
    for (var y2 = 0; y2 < h; y2++) {
      var y0 = y2 - r < 0 ? 0 : y2 - r;
      var y1 = y2 + r > h - 1 ? h - 1 : y2 + r;
      var rowA = y0 * iw, rowB = (y1 + 1) * iw, wh = y1 - y0 + 1;
      for (var x3 = 0; x3 < w; x3++) {
        var x0 = x3 - r < 0 ? 0 : x3 - r;
        var x1 = x3 + r > w - 1 ? w - 1 : x3 + r;
        var count = I[rowB + x1 + 1] - I[rowA + x1 + 1] - I[rowB + x0] + I[rowA + x0];
        dst[y2 * w + x3] = dilate ? (count > 0 ? 1 : 0)
                                  : (count === wh * (x1 - x0 + 1) ? 1 : 0);
      }
    }
  }

  // 8-connected components, flood filled with an explicit stack.
  function components(mask, w, h, minArea, maxArea, visited, stack) {
    var n = w * h;
    visited.fill(0);
    var blobs = [];
    for (var i = 0; i < n; i++) {
      if (!mask[i] || visited[i]) continue;
      var sp = 0;
      stack[sp++] = i;
      visited[i] = 1;
      var area = 0, sx = 0, sy = 0, minX = w, maxX = -1, minY = h, maxY = -1;
      while (sp > 0) {
        var p = stack[--sp];
        var py = (p / w) | 0, px = p - py * w;
        area++; sx += px; sy += py;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
        for (var dy = -1; dy <= 1; dy++) {
          var ny = py + dy;
          if (ny < 0 || ny >= h) continue;
          for (var dx = -1; dx <= 1; dx++) {
            var nx = px + dx;
            if (nx < 0 || nx >= w) continue;
            var q = ny * w + nx;
            if (mask[q] && !visited[q]) { visited[q] = 1; stack[sp++] = q; }
          }
        }
      }
      if (area >= minArea && area <= maxArea) {
        blobs.push({
          x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1,
          area: area, cx: sx / area, cy: sy / area
        });
      }
    }
    return blobs;
  }

  function median(values) {
    if (!values.length) return null;
    var s = values.slice().sort(function (a, b) { return a - b; });
    var m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function MotionTracker(width, height, options) {
    var o = {};
    for (var k in DEFAULTS) o[k] = DEFAULTS[k];
    if (options) for (var k2 in options) o[k2] = options[k2];
    this.opts = o;
    this.w = width;
    this.h = height;
    var n = width * height;
    this.gray = new Uint8ClampedArray(n);
    this.smooth = new Uint8ClampedArray(n);
    this.tmp16 = new Uint16Array(n);
    this.bg = new Float32Array(n);
    this.fg = new Uint8Array(n);
    this.fgTmp = new Uint8Array(n);
    this.mask = new Uint8Array(n);
    this.visited = new Uint8Array(n);
    this.stack = new Int32Array(n);
    this.integral = new Int32Array((width + 1) * (height + 1));
    this.reset();
  }

  MotionTracker.prototype.reset = function () {
    this.bgReady = false;
    this.tracks = [];
    this.nextId = 1;
    this.lastT = null;
    this.frames = 0;
    this.intervals = [];
    this.mask.fill(0);
  };

  // Median frame interval in seconds - the timing resolution of everything
  // downstream, so the UI and the uncertainty model both want it.
  MotionTracker.prototype.frameInterval = function () {
    return median(this.intervals) || 1 / 30;
  };

  MotionTracker.prototype.fps = function () {
    var fi = this.frameInterval();
    return fi > 0 ? 1 / fi : 0;
  };

  MotionTracker.prototype.updateFromImageData = function (imageData, t) {
    var src = imageData.data, gray = this.gray, n = gray.length;
    for (var i = 0, j = 0; i < n; i++, j += 4) {
      // Rec.601 luma in fixed point.
      gray[i] = (src[j] * 77 + src[j + 1] * 150 + src[j + 2] * 29) >> 8;
    }
    return this.update(gray, t);
  };

  MotionTracker.prototype.update = function (gray, t) {
    var w = this.w, h = this.h, n = w * h, opts = this.opts;
    if (gray !== this.gray) this.gray.set(gray);
    boxBlur(this.gray, this.smooth, w, h, this.tmp16);

    var dt = 1 / 30;
    if (this.lastT !== null) {
      var raw = t - this.lastT;
      this.intervals.push(raw);
      if (this.intervals.length > 90) this.intervals.shift();
      dt = Math.min(0.5, Math.max(1 / 240, raw));
    }
    this.lastT = t;
    this.frames++;

    if (!this.bgReady) {
      for (var i = 0; i < n; i++) this.bg[i] = this.smooth[i];
      this.bgReady = true;
      return { blobs: [], tracks: [], mask: this.mask, illuminationReset: false };
    }

    var thr = opts.threshold, fgCount = 0;
    for (var p = 0; p < n; p++) {
      var d = this.smooth[p] - this.bg[p];
      var v = (d < 0 ? -d : d) > thr ? 1 : 0;
      this.fg[p] = v;
      fgCount += v;
    }

    // A global exposure or white-balance shift lights up most of the frame.
    // Re-seed rather than emit a frame full of phantom vehicles.
    if (fgCount > n * opts.resetFgFrac) {
      for (var q = 0; q < n; q++) this.bg[q] = this.smooth[q];
      this.mask.fill(0);
      this.tracks = [];
      return { blobs: [], tracks: [], mask: this.mask, illuminationReset: true };
    }

    morph(this.fg, this.fgTmp, w, h, opts.erode, 'erode', this.integral);
    morph(this.fgTmp, this.mask, w, h, opts.dilate, 'dilate', this.integral);

    // Adapt the background, but far more slowly where something is moving, so
    // a vehicle waiting at a stop sign is not absorbed into the background.
    var a = opts.bgAlpha, af = opts.bgAlphaFg;
    for (var r = 0; r < n; r++) {
      var al = this.mask[r] ? af : a;
      this.bg[r] += al * (this.smooth[r] - this.bg[r]);
    }

    var blobs = components(
      this.mask, w, h,
      Math.max(4, opts.minAreaFrac * n), opts.maxAreaFrac * n,
      this.visited, this.stack
    );
    var tracks = this.associate(blobs, t, dt);
    return { blobs: blobs, tracks: tracks, mask: this.mask, illuminationReset: false };
  };

  // How far a track is allowed to move between frames, in processing pixels.
  MotionTracker.prototype.matchRadius = function (dt) {
    var scale = Math.max(1, dt * 30);
    return Math.min(0.35 * this.w, Math.max(0.07 * this.w, 0.07 * this.w * scale));
  };

  MotionTracker.prototype.associate = function (blobs, t, dt) {
    var tracks = this.tracks, pairs = [], i, j;
    for (i = 0; i < tracks.length; i++) {
      var tr = tracks[i];
      // Predict with the current velocity: a car at 40mph moves ~10px per frame
      // here, and prediction keeps the association stable at that speed.
      var px = tr.cx + tr.vx * dt, py = tr.cy + tr.vy * dt;
      for (j = 0; j < blobs.length; j++) {
        var b = blobs[j];
        pairs.push({ i: i, j: j, d: Math.hypot(b.cx - px, b.cy - py) });
      }
    }
    pairs.sort(function (x, y) { return x.d - y.d; });

    var radius = this.matchRadius(dt);
    var takenTrack = {}, takenBlob = {};
    for (var k = 0; k < pairs.length; k++) {
      var pr = pairs[k];
      if (pr.d > radius) break;
      if (takenTrack[pr.i] || takenBlob[pr.j]) continue;
      takenTrack[pr.i] = takenBlob[pr.j] = true;
      this.advance(tracks[pr.i], blobs[pr.j], t, dt);
    }

    for (j = 0; j < blobs.length; j++) {
      if (!takenBlob[j]) tracks.push(this.spawn(blobs[j], t));
    }

    var live = [], reported = [];
    for (i = 0; i < tracks.length; i++) {
      var tk = tracks[i];
      if (tk.t !== t) { tk.misses++; tk.missesTotal++; }
      if (tk.misses <= this.opts.maxMisses) live.push(tk);
      if (tk.t === t && tk.hits >= this.opts.confirmHits) reported.push(tk);
    }
    this.tracks = live;
    return reported;
  };

  MotionTracker.prototype.spawn = function (b, t) {
    return {
      id: this.nextId++,
      cx: b.cx, cy: b.cy, vx: 0, vy: 0,
      bx: b.x, by: b.y, bw: b.w, bh: b.h, area: b.area,
      hits: 1, misses: 0, missesTotal: 0,
      firstT: t, t: t,
      trail: [{ x: b.cx, y: b.cy, t: t }]
    };
  };

  MotionTracker.prototype.advance = function (tr, b, t, dt) {
    var gap = Math.max(1e-4, t - tr.t);
    var vx = (b.cx - tr.cx) / gap, vy = (b.cy - tr.cy) / gap;
    if (tr.hits === 1) { tr.vx = vx; tr.vy = vy; }
    else { tr.vx = 0.6 * tr.vx + 0.4 * vx; tr.vy = 0.6 * tr.vy + 0.4 * vy; }
    tr.cx = b.cx; tr.cy = b.cy;
    tr.bx = b.x; tr.by = b.y; tr.bw = b.w; tr.bh = b.h;
    tr.area = b.area;
    tr.hits++;
    tr.misses = 0;
    tr.t = t;
    tr.trail.push({ x: b.cx, y: b.cy, t: t });
    if (tr.trail.length > this.opts.trailLimit) tr.trail.shift();
  };

  root.MotionTracker = MotionTracker;
  root.trackerInternals = { boxBlur: boxBlur, morph: morph, components: components, median: median };
})(typeof module !== 'undefined' && module.exports ? module.exports : this);
