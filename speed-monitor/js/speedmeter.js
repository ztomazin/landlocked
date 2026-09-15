/*
 * speedmeter.js - turns tracked blobs into speed measurements.
 *
 * Method: two "gates" (line segments) are drawn across the road on the video,
 * and the user supplies the real ground distance between them. Speed is simply
 * distance / time, where time is the interval between the two gate crossings,
 * interpolated to sub-frame precision.
 *
 * Why this method: it needs no camera calibration, no lens parameters and no
 * perspective model. It also cancels most systematic error, because the same
 * reference point on the vehicle (the blob centroid) is used at both gates, so
 * a constant offset between that point and the true road-plane contact point
 * subtracts out of the time difference.
 *
 * Every measurement carries an uncertainty estimate. A speed number without an
 * error bar is not much use in front of a city council.
 */
(function (root) {
  'use strict';

  var MPS_TO_MPH = 2.2369362920544;
  var MPS_TO_KPH = 3.6;
  var FT_TO_M = 0.3048;

  // Signed perpendicular distance from p to the infinite line through the gate,
  // in the same pixel units as the gate. Sign tells us which side we are on.
  function signedDistance(gate, p) {
    var dx = gate[1].x - gate[0].x, dy = gate[1].y - gate[0].y;
    var len = Math.hypot(dx, dy) || 1;
    return ((p.x - gate[0].x) * dy - (p.y - gate[0].y) * dx) / len;
  }

  // Position along the gate segment: 0 at the first point, 1 at the second.
  function alongParam(gate, p) {
    var dx = gate[1].x - gate[0].x, dy = gate[1].y - gate[0].y;
    var l2 = dx * dx + dy * dy || 1;
    return ((p.x - gate[0].x) * dx + (p.y - gate[0].y) * dy) / l2;
  }

  function midpoint(gate) {
    return { x: (gate[0].x + gate[1].x) / 2, y: (gate[0].y + gate[1].y) / 2 };
  }

  // Perpendicular separation of the two gate lines in pixels. Averaged both
  // ways so that slightly non-parallel gates degrade gracefully.
  function gateSeparation(gateA, gateB) {
    return (Math.abs(signedDistance(gateA, midpoint(gateB))) +
            Math.abs(signedDistance(gateB, midpoint(gateA)))) / 2;
  }

  // Unit vector along the direction of travel, i.e. normal to the gates.
  function travelAxis(gateA, gateB) {
    var from = midpoint(gateA), to = midpoint(gateB);
    var dx = to.x - from.x, dy = to.y - from.y;
    var len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
  }

  function SpeedMeter(config) {
    this.cfg = {
      minMph: 3,
      maxMph: 120,
      geometrySigmaRel: 0.02, // residual geometry/parallax bias, see docs/METHOD.md
      distanceMeters: 0,
      distanceSigmaMeters: null,
      gateA: null,
      gateB: null
    };
    this.configure(config || {});
    this.reset();
  }

  SpeedMeter.prototype.configure = function (config) {
    for (var k in config) if (config[k] !== undefined) this.cfg[k] = config[k];
    if (this.cfg.gateA && this.cfg.gateB) {
      this.separationPx = gateSeparation(this.cfg.gateA, this.cfg.gateB);
      this.axis = travelAxis(this.cfg.gateA, this.cfg.gateB);
    }
    return this;
  };

  SpeedMeter.prototype.reset = function () {
    this.state = {};
    this.intervals = [];
    this.lastT = null;
    this.seq = 0;
    this.rejected = 0;
  };

  // Rough metres per pixel along the direction of travel, from the known ground
  // distance between the gates. Only used for the approximate object-length
  // estimate - the speed calculation never needs it.
  SpeedMeter.prototype.metersPerPixel = function () {
    if (!this.separationPx) return null;
    return this.cfg.distanceMeters / this.separationPx;
  };

  SpeedMeter.prototype.frameInterval = function () {
    if (!this.intervals.length) return 1 / 30;
    var s = this.intervals.slice().sort(function (a, b) { return a - b; });
    var m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  SpeedMeter.prototype.distanceSigma = function () {
    var d = this.cfg.distanceMeters;
    if (this.cfg.distanceSigmaMeters !== null && this.cfg.distanceSigmaMeters !== undefined) {
      return this.cfg.distanceSigmaMeters;
    }
    return Math.max(0.15, 0.02 * d); // default: 2% of the distance, floor 15cm
  };

  // Detect a crossing between two consecutive samples of one track.
  function crossing(gate, prev, cur) {
    var s0 = signedDistance(gate, prev.p);
    var s1 = signedDistance(gate, cur.p);
    if ((s0 < 0 && s1 < 0) || (s0 >= 0 && s1 >= 0)) return null;
    var f = s0 / (s0 - s1); // sub-frame interpolation of the crossing instant
    var x = prev.p.x + f * (cur.p.x - prev.p.x);
    var y = prev.p.y + f * (cur.p.y - prev.p.y);
    var u = alongParam(gate, { x: x, y: y });
    // Crossed the gate's infinite extension rather than the drawn segment:
    // something moving past the end of the line, not across the road.
    if (u < -0.08 || u > 1.08) return null;
    return { t: prev.t + f * (cur.t - prev.t), u: u, x: x, y: y };
  }

  /*
   * Feed the tracks that were updated on this frame. Returns the measurements
   * that completed on this frame (usually none).
   */
  SpeedMeter.prototype.update = function (tracks, t) {
    if (!this.cfg.gateA || !this.cfg.gateB || !(this.cfg.distanceMeters > 0)) return [];
    if (this.lastT !== null && t > this.lastT) {
      this.intervals.push(t - this.lastT);
      if (this.intervals.length > 90) this.intervals.shift();
    }
    this.lastT = t;

    var out = [];
    for (var i = 0; i < tracks.length; i++) {
      var tr = tracks[i];
      var st = this.state[tr.id];
      var cur = {
        p: { x: tr.cx, y: tr.cy },
        t: t,
        bw: tr.bw, bh: tr.bh, area: tr.area,
        misses: tr.missesTotal
      };
      if (!st) {
        this.state[tr.id] = { prev: cur, A: null, B: null, invalid: false, done: false, frames: 0, lastSeen: t };
        continue;
      }
      st.lastSeen = t;
      if (st.done || st.invalid) { st.prev = cur; continue; }
      if (st.A || st.B) st.frames++;

      var hitA = crossing(this.cfg.gateA, st.prev, cur);
      var hitB = crossing(this.cfg.gateB, st.prev, cur);

      if (hitA) {
        if (st.A) st.invalid = true; // re-crossed the same gate: not a clean pass
        else st.A = { at: hitA, sample: cur, missesAt: cur.misses };
      }
      if (hitB && !st.invalid) {
        if (st.B) st.invalid = true;
        else st.B = { at: hitB, sample: cur, missesAt: cur.misses };
      }

      if (st.A && st.B && !st.invalid) {
        var m = this.measure(st, tr);
        st.done = true;
        if (m) out.push(m); else this.rejected++;
      }
      st.prev = cur;
    }

    this.prune(t);
    return out;
  };

  SpeedMeter.prototype.prune = function (t) {
    var ids = Object.keys(this.state);
    if (ids.length < 64) return;
    for (var i = 0; i < ids.length; i++) {
      if (t - this.state[ids[i]].lastSeen > 3) delete this.state[ids[i]];
    }
  };

  SpeedMeter.prototype.measure = function (st, tr) {
    var first = st.A.at.t <= st.B.at.t ? st.A : st.B;
    var second = first === st.A ? st.B : st.A;
    var dt = second.at.t - first.at.t;
    if (!(dt > 0)) return null;

    var D = this.cfg.distanceMeters;
    var speedMps = D / dt;
    var mph = speedMps * MPS_TO_MPH;
    if (mph < this.cfg.minMph || mph > this.cfg.maxMph) return null;

    var fi = this.frameInterval();
    var frames = dt / fi;
    if (frames < 2) return null; // too few samples to interpolate meaningfully

    // Error model: distance measurement, crossing-time interpolation, and a
    // residual geometry term. Combined in quadrature. See docs/METHOD.md.
    var relD = this.distanceSigma() / D;
    var sigmaT = 0.45 * fi; // two interpolated crossings, combined
    var relT = sigmaT / dt;
    var relG = this.cfg.geometrySigmaRel;
    var rel = Math.sqrt(relD * relD + relT * relT + relG * relG);

    var flags = [];
    if (frames < 5) flags.push('few-frames');
    var gap = second.missesAt - first.missesAt;
    if (gap > 1) flags.push('occluded');
    var aA = st.A.sample.area, aB = st.B.sample.area;
    var ratio = Math.max(aA, aB) / Math.max(1, Math.min(aA, aB));
    if (ratio > 2.5) flags.push('size-change'); // likely a merge with another object
    if (st.A.at.u < 0.06 || st.A.at.u > 0.94 || st.B.at.u < 0.06 || st.B.at.u > 0.94) {
      flags.push('gate-edge');
    }

    var confidence = 'high';
    if (flags.length) confidence = 'medium';
    if (frames < 4 || flags.length > 1) confidence = 'low';

    // Approximate object length: the bounding box extent along the direction of
    // travel, scaled by the average metres-per-pixel. Perspective makes this a
    // rough figure, useful for telling a pedestrian from a bus, nothing more.
    var mpp = this.metersPerPixel();
    var estLength = null, estClass = null;
    if (mpp) {
      var ax = Math.abs(this.axis.x), ay = Math.abs(this.axis.y);
      var extentA = ax * st.A.sample.bw + ay * st.A.sample.bh;
      var extentB = ax * st.B.sample.bw + ay * st.B.sample.bh;
      estLength = (extentA + extentB) / 2 * mpp;
      estClass = estLength < 1.3 ? 'pedestrian'
               : estLength < 2.7 ? 'two-wheeler'
               : estLength < 6.0 ? 'car'
               : estLength < 9.0 ? 'light-truck'
               : 'heavy-vehicle';
    }

    return {
      seq: ++this.seq,
      trackId: tr.id,
      direction: first === st.A ? 'A>B' : 'B>A',
      videoTime: first.at.t,
      wallClock: new Date().toISOString(),
      dt: dt,
      frames: frames,
      speedMps: speedMps,
      speedMph: mph,
      speedKph: speedMps * MPS_TO_KPH,
      sigmaRel: rel,
      sigmaMph: mph * rel,
      ci95Mph: 1.96 * mph * rel,
      ci95Kph: 1.96 * speedMps * MPS_TO_KPH * rel,
      estLengthM: estLength,
      estClass: estClass,
      confidence: confidence,
      flags: flags
    };
  };

  root.SpeedMeter = SpeedMeter;
  root.SpeedGeometry = {
    signedDistance: signedDistance,
    alongParam: alongParam,
    gateSeparation: gateSeparation,
    travelAxis: travelAxis,
    midpoint: midpoint,
    crossing: crossing,
    MPS_TO_MPH: MPS_TO_MPH,
    MPS_TO_KPH: MPS_TO_KPH,
    FT_TO_M: FT_TO_M
  };
})(typeof module !== 'undefined' && module.exports ? module.exports : this);
