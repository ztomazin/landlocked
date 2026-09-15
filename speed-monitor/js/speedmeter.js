/*
 * speedmeter.js - turns tracked blobs into speed measurements.
 *
 * Method: two "gates" (line segments) are drawn across the road on the video,
 * and the user supplies the real ground distance between them. Speed is simply
 * distance / time, where time is the interval between the two gate crossings,
 * interpolated to sub-frame precision.
 *
 * Why this method: it needs no camera calibration, no lens parameters and no
 * perspective model.
 *
 * The one thing it does require is that the point being tracked lies on the
 * ROAD PLANE. A gate drawn on the video is the image of a line painted across
 * the tarmac, and a point on the tarmac crosses that image line exactly when it
 * crosses the real line - whatever the camera's height, tilt or lens. A point
 * ABOVE the road does not: seen from a raised camera it crosses the drawn line
 * early or late, by a factor that does NOT cancel between the two gates. With a
 * camera 3m up looking 20 degrees down, tracking the middle of a vehicle rather
 * than its wheels inflates every speed by about 30%.
 *
 * So the tracked point is the bottom-centre of the blob - where the tyres meet
 * the road - not its centroid. A useful consequence: because every point on the
 * road plane is unbiased, a shadow stretching the blob sideways along the
 * ground does not bias the timing either.
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

  /*
   * The point on the vehicle used for gate crossings: bottom-centre of the
   * bounding box, which approximates where it touches the road. Falls back to
   * the centroid if no box is supplied.
   */
  function groundPoint(tr) {
    if (tr.bx === undefined || tr.by === undefined ||
        tr.bw === undefined || tr.bh === undefined) {
      return { x: tr.cx, y: tr.cy };
    }
    return { x: tr.bx + tr.bw / 2, y: tr.by + tr.bh };
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
    // Gates are required; a known distance is not. Crossing times are recorded
    // either way, and speeds are filled in once the scale arrives.
    if (!this.cfg.gateA || !this.cfg.gateB) return [];
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
        p: groundPoint(tr),
        t: t,
        bw: tr.bw, bh: tr.bh, area: tr.area,
        misses: tr.missesTotal
      };
      if (!st) {
        this.state[tr.id] = { prev: cur, A: null, B: null, invalid: false, frames: 0, lastSeen: t };
        continue;
      }
      st.lastSeen = t;
      if (st.invalid) { st.prev = cur; continue; }
      if (st.A || st.B) {
        st.frames++;
        // A low-contrast vehicle can break into fragments part-way across,
        // which moves the tracked point and skews the timing. Watch the blob's
        // stability between the gates so such a pass can be flagged rather
        // than quietly reported as fact.
        st.minH = st.minH === undefined ? cur.bh : Math.min(st.minH, cur.bh);
        st.maxH = st.maxH === undefined ? cur.bh : Math.max(st.maxH, cur.bh);
        st.minArea = st.minArea === undefined ? cur.area : Math.min(st.minArea, cur.area);
        st.maxArea = st.maxArea === undefined ? cur.area : Math.max(st.maxArea, cur.area);
      }

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
        if (m) out.push(m); else this.rejected++;
        /*
         * Re-arm rather than retiring the track. Two vehicles passing at the
         * edge of the frame can merge into a single blob, handing one track
         * from the outgoing vehicle to the incoming one; a retired track would
         * silently swallow that second vehicle. A vehicle that has genuinely
         * finished its pass never crosses either gate again, so re-arming
         * cannot double-count it.
         */
        st.A = null;
        st.B = null;
        st.frames = 0;
        st.minH = st.maxH = st.minArea = st.maxArea = undefined;
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

    var fi = this.frameInterval();
    var frames = dt / fi;
    if (frames < 2) return null; // too few samples to interpolate meaningfully

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
    if (st.maxH && st.minH > 0 && st.maxH / st.minH > 1.6) flags.push('unstable-blob');
    else if (st.maxArea && st.minArea > 0 && st.maxArea / st.minArea > 2.4) flags.push('unstable-blob');

    var confidence = 'high';
    if (flags.length) confidence = 'medium';
    if (frames < 4 || flags.length > 1 || flags.indexOf('unstable-blob') !== -1) confidence = 'low';

    // Apparent size along the direction of travel, kept in pixels so that the
    // length estimate can be recomputed if the scale changes later.
    var ax = Math.abs(this.axis ? this.axis.x : 1), ay = Math.abs(this.axis ? this.axis.y : 0);
    var extentPx = (ax * st.A.sample.bw + ay * st.A.sample.bh +
                    ax * st.B.sample.bw + ay * st.B.sample.bh) / 2;

    var m = {
      seq: ++this.seq,
      trackId: tr.id,
      direction: first === st.A ? 'A>B' : 'B>A',
      videoTime: first.at.t,
      wallClock: new Date().toISOString(),
      dt: dt,
      frames: frames,
      frameInterval: fi,
      extentPx: extentPx,
      confidence: confidence,
      flags: flags,
      pending: true,
      speedMps: null, speedMph: null, speedKph: null,
      sigmaRel: null, sigmaMph: null, ci95Mph: null, ci95Kph: null,
      estLengthM: null, estClass: null
    };
    return this.applyScale(m) === 'implausible' ? null : m;
  };

  /*
   * Fill in (or refresh) the speed of a measurement from the current distance
   * calibration. Timing is fixed at the moment of the crossing; the scale can
   * arrive later or be refined, so this is kept separate and re-runnable.
   *
   * Returns 'ok', 'pending' (no scale yet) or 'implausible'.
   */
  SpeedMeter.prototype.applyScale = function (m) {
    var D = this.cfg.distanceMeters;
    if (!(D > 0)) {
      m.pending = true;
      m.speedMps = m.speedMph = m.speedKph = null;
      m.sigmaRel = m.sigmaMph = m.ci95Mph = m.ci95Kph = null;
      m.estLengthM = m.estClass = null;
      return 'pending';
    }
    var speedMps = D / m.dt;
    var mph = speedMps * MPS_TO_MPH;
    if (mph < this.cfg.minMph || mph > this.cfg.maxMph) return 'implausible';

    // Error model: distance, crossing-time interpolation, residual geometry.
    // Combined in quadrature. See docs/METHOD.md.
    var relD = this.distanceSigma() / D;
    var relT = (0.45 * m.frameInterval) / m.dt;
    var relG = this.cfg.geometrySigmaRel;
    var rel = Math.sqrt(relD * relD + relT * relT + relG * relG);

    m.pending = false;
    m.speedMps = speedMps;
    m.speedMph = mph;
    m.speedKph = speedMps * MPS_TO_KPH;
    m.sigmaRel = rel;
    m.sigmaMph = mph * rel;
    m.ci95Mph = 1.96 * mph * rel;
    m.ci95Kph = 1.96 * m.speedKph * rel;

    // Rough object length: perspective makes this approximate, enough to tell a
    // pedestrian from a lorry and no more.
    var mpp = this.metersPerPixel();
    if (mpp) {
      m.estLengthM = m.extentPx * mpp;
      m.estClass = m.estLengthM < 1.3 ? 'pedestrian'
                 : m.estLengthM < 2.7 ? 'two-wheeler'
                 : m.estLengthM < 6.0 ? 'car'
                 : m.estLengthM < 9.0 ? 'light-truck'
                 : 'heavy-vehicle';
    }
    return 'ok';
  };

  /*
   * Re-price a whole session after the calibration changes - which happens
   * every time the traffic refines the scale. Returns the surviving
   * measurements and how many became implausible.
   */
  SpeedMeter.prototype.rescaleAll = function (measurements) {
    var kept = [], dropped = 0;
    for (var i = 0; i < measurements.length; i++) {
      if (this.applyScale(measurements[i]) === 'implausible') dropped++;
      else kept.push(measurements[i]);
    }
    return { kept: kept, dropped: dropped };
  };

  root.SpeedMeter = SpeedMeter;
  root.SpeedGeometry = {
    groundPoint: groundPoint,
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
