/*
 * calibration.js - work out the ground distance between the gates without
 * anyone measuring the road.
 *
 * You cannot get a speed in mph out of a single camera without one real-world
 * length somewhere: monocular video is scale-ambiguous. What you can do is stop
 * requiring that length to be the gate separation itself. This module recovers
 * the geometry of the road plane, so a reference object anywhere in the frame -
 * a parked car, a lane stripe - sets the scale for gates placed anywhere else.
 *
 * Method (projective geometry, exact, no approximation):
 *
 *   1. Two road-direction lines (the kerbs) meet at the vanishing point V1.
 *      Two cross-road lines (the two gates, which are parallel on the ground)
 *      meet at the vanishing point V2.
 *   2. The line through V1 and V2 is the horizon of the road plane.
 *   3. Mapping that horizon to infinity rectifies the plane to an affine copy
 *      of the real road. Under an affine map, RATIOS of lengths measured along
 *      a common direction are exactly preserved.
 *   4. So: (gate separation) / (reference length) is the same on the ground as
 *      it is in the rectified image. One known reference gives the gate
 *      separation, wherever either of them sits in the frame.
 *
 * No focal length, no camera height, no tilt angle, no lens model. The one
 * assumption is that the road is locally flat.
 *
 * Uncertainty is not hand-waved: the tapped points are perturbed by realistic
 * tap error and the calculation is re-run, so an ill-conditioned setup (a tiny
 * reference object, gates near the horizon) honestly reports a wide error bar.
 */
(function (root) {
  'use strict';

  var FT_TO_M = 0.3048;

  /* ------------------------------------------------ homogeneous geometry */

  function cross3(a, b) {
    return [a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0]];
  }

  function norm3(v) {
    var n = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) || 1;
    return [v[0] / n, v[1] / n, v[2] / n];
  }

  function lineThrough(p, q) {
    return cross3([p.x, p.y, 1], [q.x, q.y, 1]);
  }

  // Vanishing point of a direction, from two image lines that are parallel on
  // the ground. Returned homogeneous, so a point at infinity (exactly parallel
  // lines in the image, i.e. no perspective) is handled without special cases.
  function vanishingPoint(lineA, lineB) {
    return cross3(lineA, lineB);
  }

  /*
   * The affine rectifying map sends the horizon to the line at infinity:
   *   H = [1 0 0; 0 1 0; h1 h2 h3]
   * A point then lands at (x/w, y/w) with w = h.p. Scaling h scales every
   * rectified point equally, so length ratios - all we use - are unaffected.
   */
  function rectify(horizon, p) {
    var w = horizon[0] * p.x + horizon[1] * p.y + horizon[2];
    return { x: p.x / w, y: p.y / w, w: w };
  }

  function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y }; }
  function dot(a, b) { return a.x * b.x + a.y * b.y; }
  function len(a) { return Math.hypot(a.x, a.y); }

  function unit(a) {
    var l = len(a) || 1;
    return { x: a.x / l, y: a.y / l };
  }

  /* --------------------------------------------------------------- solve */

  /*
   * opts = {
   *   gateA: [p, p], gateB: [p, p],        // the two gates, in processing px
   *   roadLines: [[p, p], [p, p]],         // two lines along the road (kerbs)
   *   reference: { p1, p2, meters }        // a known length along the road
   * }
   */
  function solve(opts) {
    var warnings = [];
    var gA = opts.gateA, gB = opts.gateB, roads = opts.roadLines, ref = opts.reference;
    if (!gA || !gB || gA.length !== 2 || gB.length !== 2) {
      return { ok: false, error: 'Both gates are needed.' };
    }
    var haveRoads = roads && roads.length === 2 &&
      roads[0] && roads[0].length === 2 && roads[1] && roads[1].length === 2;
    if (!haveRoads && !opts.roadVanishingPoint) {
      return { ok: false, error: 'Two lines along the road are needed.' };
    }

    var lGA = lineThrough(gA[0], gA[1]);
    var lGB = lineThrough(gB[0], gB[1]);

    // The road direction comes either from two marked road lines, or from the
    // vanishing point the traffic itself revealed.
    var v1, lR1, lR2;
    if (haveRoads) {
      lR1 = lineThrough(roads[0][0], roads[0][1]);
      lR2 = lineThrough(roads[1][0], roads[1][1]);
      v1 = vanishingPoint(lR1, lR2);
    } else {
      v1 = opts.roadVanishingPoint;
    }
    var v2 = vanishingPoint(lGA, lGB);   // across the road

    if (Math.hypot(v1[0], v1[1], v1[2]) < 1e-12 || Math.hypot(v2[0], v2[1], v2[2]) < 1e-12) {
      return { ok: false, error: 'Those lines are identical - they give no vanishing point.' };
    }

    var horizon = norm3(cross3(v1, v2));
    if (Math.hypot(horizon[0], horizon[1], horizon[2]) < 1e-12) {
      return { ok: false, error: 'Could not determine the road plane from these lines.' };
    }

    // Everything must sit on one side of the horizon: the road in front of the
    // camera. Points straddling it mean a mis-tapped line.
    var probes = [gA[0], gA[1], gB[0], gB[1]];
    if (haveRoads) probes = probes.concat([roads[0][0], roads[0][1], roads[1][0], roads[1][1]]);
    if (ref) probes = probes.concat([ref.p1, ref.p2]);
    var sign = 0, minAbs = Infinity;
    for (var i = 0; i < probes.length; i++) {
      var w = horizon[0] * probes[i].x + horizon[1] * probes[i].y + horizon[2];
      minAbs = Math.min(minAbs, Math.abs(w));
      if (sign === 0) sign = w > 0 ? 1 : -1;
      else if ((w > 0 ? 1 : -1) !== sign) {
        return { ok: false, error: 'The horizon falls between the points you marked - check the road lines.' };
      }
    }
    if (minAbs < 1e-6) {
      return { ok: false, error: 'Some marked points lie on the horizon, where distances cannot be recovered.' };
    }

    // Rectified road direction, averaged over both road lines (they are
    // parallel on the ground, so they are parallel here too).
    /*
     * The rectified direction of travel, exactly.
     *
     * V1 lies on the horizon by construction (the horizon is the line through
     * V1 and V2), so H.V1 = (v1x, v1y, h.V1) = (v1x, v1y, 0): under the
     * rectifying map a vanishing point becomes a pure direction. No
     * dehomogenising, so this is just as valid when the camera is square-on and
     * V1 sits at infinity - the case that has no finite coordinates at all.
     */
    var dir = unit({ x: v1[0], y: v1[1] });
    if (!isFinite(dir.x) || !isFinite(dir.y) || (dir.x === 0 && dir.y === 0)) {
      return { ok: false, error: 'Could not resolve the direction of travel.' };
    }
    if (haveRoads) {
      // Both marked lines should be parallel on the ground; if they are not,
      // one of them was mis-traced and every distance below is suspect.
      var d1 = unit(sub(rectify(horizon, roads[0][1]), rectify(horizon, roads[0][0])));
      var d2 = unit(sub(rectify(horizon, roads[1][1]), rectify(horizon, roads[1][0])));
      if (dot(d1, d2) < 0) d2 = { x: -d2.x, y: -d2.y };
      var skew = Math.acos(Math.max(-1, Math.min(1, dot(d1, d2)))) * 180 / Math.PI;
      if (skew > 4) {
        warnings.push('The two road lines are not parallel on the ground (' +
          skew.toFixed(1) + ' degrees apart after rectification). Re-check them.');
      }
    }

    // Distance between the two gate lines, measured along the road direction.
    var a0 = rectify(horizon, gA[0]), a1 = rectify(horizon, gA[1]);
    var b0 = rectify(horizon, gB[0]), b1 = rectify(horizon, gB[1]);
    var gateSpan = alongDistanceBetweenLines(a0, a1, b0, b1, dir);
    if (gateSpan === null) {
      return { ok: false, error: 'The gates are parallel to the direction of travel - they must cross the road.' };
    }

    var out = {
      ok: true,
      horizon: horizon,
      direction: dir,
      gateSpanRectified: gateSpan,
      warnings: warnings
    };

    if (ref && ref.p1 && ref.p2 && ref.meters > 0) {
      var r0 = rectify(horizon, ref.p1), r1 = rectify(horizon, ref.p2);
      var refVec = sub(r1, r0);
      var refAlong = Math.abs(dot(refVec, dir));
      var refTotal = len(refVec);
      if (refAlong < 1e-9) {
        return { ok: false, error: 'The reference object must lie along the direction of travel.' };
      }
      // A reference that is mostly across the road cannot set the along-road
      // scale; warn well before it becomes nonsense.
      var offAxis = Math.acos(Math.max(-1, Math.min(1, refAlong / (refTotal || 1)))) * 180 / Math.PI;
      if (offAxis > 20) {
        warnings.push('The reference object is ' + offAxis.toFixed(0) +
          ' degrees off the direction of travel. Mark something lying along the road.');
      }
      out.referenceRectified = refAlong;
      out.meters = ref.meters * gateSpan / refAlong;
    }
    return out;
  }

  // Distance between two parallel rectified lines, measured along `dir`.
  function alongDistanceBetweenLines(a0, a1, b0, b1, dir) {
    var bDir = sub(b1, b0);
    var n = { x: -bDir.y, y: bDir.x };          // normal of gate B
    var denom = dot(n, dir);
    if (Math.abs(denom) < 1e-12) return null;   // gate parallel to travel
    var mid = { x: (a0.x + a1.x) / 2, y: (a0.y + a1.y) / 2 };
    var t = dot(n, sub(b0, mid)) / denom;
    return Math.abs(t);                          // dir is a unit vector
  }

  /* ------------------------------------------------------- uncertainty */

  function gaussian(rng) {
    var u = 1 - rng(), v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function jitterPoint(p, sigma, rng) {
    return { x: p.x + gaussian(rng) * sigma, y: p.y + gaussian(rng) * sigma };
  }

  function jitterOpts(opts, sigma, rng) {
    var j = {
      gateA: opts.gateA.map(function (p) { return jitterPoint(p, sigma, rng); }),
      gateB: opts.gateB.map(function (p) { return jitterPoint(p, sigma, rng); })
    };
    if (opts.roadLines) {
      j.roadLines = opts.roadLines.map(function (L) {
        return L.map(function (p) { return jitterPoint(p, sigma, rng); });
      });
    }
    if (opts.roadVanishingPoint) {
      // Draw from the bootstrapped vanishing points so the uncertainty in the
      // road direction is propagated, not silently assumed away.
      j.roadVanishingPoint = (opts.roadVanishingPointSamples && opts.roadVanishingPointSamples.length)
        ? opts.roadVanishingPointSamples[
            Math.floor(rng() * opts.roadVanishingPointSamples.length) %
            opts.roadVanishingPointSamples.length]
        : opts.roadVanishingPoint;
    }
    if (opts.reference) {
      j.reference = {
        p1: jitterPoint(opts.reference.p1, sigma, rng),
        p2: jitterPoint(opts.reference.p2, sigma, rng),
        meters: opts.reference.meters
      };
    }
    return j;
  }

  /*
   * Propagate tap error by simulation rather than by a fudge factor: perturb
   * every tapped point by `tapSigmaPx` and see how much the answer moves. A
   * short reference or gates near the horizon are ill-conditioned, and this
   * reports that honestly instead of hiding it.
   */
  function geometricUncertainty(opts, tapSigmaPx, trials) {
    var base = solve(opts);
    if (!base.ok || !(base.meters > 0)) return null;
    var rng = mulberry32(0x5eed), vals = [];
    for (var i = 0; i < trials; i++) {
      var r = solve(jitterOpts(opts, tapSigmaPx, rng));
      if (r.ok && r.meters > 0 && isFinite(r.meters)) vals.push(r.meters);
    }
    if (vals.length < trials * 0.6) return null; // too unstable to characterise
    var mean = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
    var varc = vals.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) /
      Math.max(1, vals.length - 1);
    return Math.sqrt(varc) / base.meters;
  }

  /*
   * Full result: the gate distance plus an honest relative uncertainty made of
   * the reference object's own uncertainty and the geometry's conditioning.
   */
  function computeGateDistance(opts) {
    var res = solve(opts);
    if (!res.ok) return res;
    if (!(res.meters > 0)) {
      return { ok: false, error: 'A reference object of known length is needed to set the scale.' };
    }
    var tapSigma = opts.tapSigmaPx || 2;
    var geomRel = geometricUncertainty(opts, tapSigma, opts.trials || 96);
    if (geomRel === null) {
      res.warnings.push('This geometry is poorly conditioned - move the gates away from the ' +
        'horizon, or use a longer reference object.');
      geomRel = 0.15;
    }
    var refRel = opts.reference && opts.reference.sigmaMeters
      ? opts.reference.sigmaMeters / opts.reference.meters
      : 0.01; // a looked-up or tape-measured object, say 1%
    // An extra systematic term for a road direction that was inferred rather
    // than marked - see extraSystematicRel at the call site.
    var extra = opts.extraSystematicRel || 0;
    res.relSigma = Math.sqrt(geomRel * geomRel + refRel * refRel + extra * extra);
    res.sigmaMeters = res.meters * res.relSigma;
    res.geometricRelSigma = geomRel;
    if (geomRel > 0.08) {
      res.warnings.push('Tap precision limits this to about ' + Math.round(geomRel * 100) +
        '%. A longer reference object, or one closer to the gates, would tighten it.');
    }
    return res;
  }

  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ------------------------------- vanishing point from the traffic itself */

  // Jacobi eigendecomposition of a symmetric 3x3, enough for the smallest
  // eigenvector of a scatter matrix.
  function smallestEigenvector(M) {
    var a = [M[0].slice(), M[1].slice(), M[2].slice()];
    var v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (var sweep = 0; sweep < 32; sweep++) {
      var off = a[0][1] * a[0][1] + a[0][2] * a[0][2] + a[1][2] * a[1][2];
      if (off < 1e-20) break;
      for (var p = 0; p < 2; p++) {
        for (var q = p + 1; q < 3; q++) {
          if (Math.abs(a[p][q]) < 1e-18) continue;
          var theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
          var t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
          var c = 1 / Math.sqrt(t * t + 1), s2 = t * c;
          for (var k = 0; k < 3; k++) {
            var akp = a[k][p], akq = a[k][q];
            a[k][p] = c * akp - s2 * akq;
            a[k][q] = s2 * akp + c * akq;
          }
          for (var k2 = 0; k2 < 3; k2++) {
            var apk = a[p][k2], aqk = a[q][k2];
            a[p][k2] = c * apk - s2 * aqk;
            a[q][k2] = s2 * apk + c * aqk;
          }
          for (var k3 = 0; k3 < 3; k3++) {
            var vkp = v[k3][p], vkq = v[k3][q];
            v[k3][p] = c * vkp - s2 * vkq;
            v[k3][q] = s2 * vkp + c * vkq;
          }
        }
      }
    }
    var best = 0;
    for (var i = 1; i < 3; i++) if (Math.abs(a[i][i]) < Math.abs(a[best][best])) best = i;
    return [v[0][best], v[1][best], v[2][best]];
  }

  // Total-least-squares line through a set of points, returned homogeneous.
  function fitLineTLS(points) {
    var n = points.length;
    if (n < 2) return null;
    var mx = 0, my = 0, i;
    for (i = 0; i < n; i++) { mx += points[i].x / n; my += points[i].y / n; }
    var sxx = 0, syy = 0, sxy = 0;
    for (i = 0; i < n; i++) {
      var dx = points[i].x - mx, dy = points[i].y - my;
      sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
    }
    var theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    var nx = -Math.sin(theta), ny = Math.cos(theta);   // normal to the fitted direction
    var c = -(nx * mx + ny * my);
    // Perpendicular RMS residual: how straight the path actually is. (Spread
    // ALONG the line is just its length, and says nothing about straightness.)
    var resid = 0;
    for (i = 0; i < n; i++) {
      var e = nx * points[i].x + ny * points[i].y + c;
      resid += e * e;
    }
    return { line: [nx, ny, c], residual: Math.sqrt(resid / n), count: n };
  }

  /*
   * Estimate the road's vanishing point from the paths of vehicles already
   * tracked. Vehicles travel parallel to the road, so their image paths all
   * converge on that point - including when it lies at infinity, which is why
   * this is solved homogeneously rather than by intersecting lines.
   *
   * This replaces tracing the kerbs by hand, and is usually better: the paths
   * are long, there are many of them, and each is already averaged over dozens
   * of frames.
   */
  /*
   * Solve for the point closest to a set of image lines that should all pass
   * through it. Solved homogeneously (smallest eigenvector of the scatter
   * matrix of the lines), so a vanishing point at infinity - a perfectly
   * square-on camera - is representable rather than a division by zero.
   *
   * lines: [{ line: [a, b, c] in image pixels, w: weight }]
   */
  function vanishingPointFromLines(lines, procW, procH, options) {
    var o = options || {};
    var cx = procW / 2, cy = procH / 2, sc = Math.max(procW, procH) / 2;
    if (!lines || lines.length < (o.minLines || 4)) {
      return { ok: false, error: 'Only ' + ((lines && lines.length) || 0) + ' usable lines.' };
    }

    // Into a normalised frame for conditioning: a line l in image coordinates
    // becomes [s*a, s*b, a*cx + b*cy + c].
    var normed = [];
    for (var i = 0; i < lines.length; i++) {
      var L = lines[i].line;
      var n = norm3([L[0] * sc, L[1] * sc, L[0] * cx + L[1] * cy + L[2]]);
      normed.push({ l: n, w: lines[i].w === undefined ? 1 : lines[i].w });
    }

    function solveFrom(list) {
      var M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      for (var k = 0; k < list.length; k++) {
        var L = list[k].l, w = list[k].w;
        for (var r = 0; r < 3; r++) for (var c = 0; c < 3; c++) M[r][c] += w * L[r] * L[c];
      }
      return smallestEigenvector(M);
    }

    var vn = solveFrom(normed);

    // Bootstrap: resample the lines with replacement and re-solve, so the
    // reported uncertainty reflects how well they actually agree.
    var samples = [], rng = mulberry32(0xb007);
    var B = (o.bootstrap === undefined) ? 24 : o.bootstrap;
    for (var b = 0; b < B; b++) {
      var pick = [];
      for (var j = 0; j < normed.length; j++) {
        pick.push(normed[Math.floor(rng() * normed.length) % normed.length]);
      }
      var vb = solveFrom(pick);
      samples.push(norm3([vb[0] * sc + vb[2] * cx, vb[1] * sc + vb[2] * cy, vb[2]]));
    }

    var resid = 0, wsum = 0;
    for (var m = 0; m < normed.length; m++) {
      var d = normed[m].l[0] * vn[0] + normed[m].l[1] * vn[1] + normed[m].l[2] * vn[2];
      resid += d * d * normed[m].w;
      wsum += normed[m].w;
    }
    return {
      ok: true,
      vanishingPoint: norm3([vn[0] * sc + vn[2] * cx, vn[1] * sc + vn[2] * cy, vn[2]]),
      samples: samples,
      linesUsed: normed.length,
      residual: Math.sqrt(resid / Math.max(1e-9, wsum))
    };
  }

  /*
   * The road's vanishing point from wheel contact lines. Every frame in which a
   * vehicle's two contact patches are found contributes one line that lies on
   * the road surface and runs along it - far better evidence than a centroid
   * path, which floats above the road and wanders as the silhouette turns.
   */
  function vanishingPointFromContacts(contactLines, procW, procH, options) {
    var o = options || {};
    var res = vanishingPointFromLines(contactLines, procW, procH, {
      minLines: o.minLines || 12,
      bootstrap: o.bootstrap
    });
    if (res.ok) res.source = 'wheel contact points';
    return res;
  }

  function vanishingPointFromTrails(trails, procW, procH, options) {
    var o = options || {};
    var minPoints = o.minPoints || 8;
    var minSpanPx = o.minSpanPx || Math.max(20, 0.18 * Math.max(procW, procH));
    var cx = procW / 2, cy = procH / 2, sc = Math.max(procW, procH) / 2;
    var lines = [], used = 0;

    for (var t = 0; t < trails.length; t++) {
      var pts = trails[t];
      if (!pts || pts.length < minPoints) continue;
      var span = Math.hypot(pts[pts.length - 1].x - pts[0].x, pts[pts.length - 1].y - pts[0].y);
      if (span < minSpanPx) continue;
      var normed = [];
      for (var i = 0; i < pts.length; i++) {
        normed.push({ x: (pts[i].x - cx) / sc, y: (pts[i].y - cy) / sc });
      }
      var fit = fitLineTLS(normed);
      if (!fit) continue;
      // A path that is not straight is not a vehicle going down the road.
      if (fit.residual > (o.maxResidual || 0.01)) continue;
      lines.push({ l: fit.line, w: Math.min(pts.length, 240) * (span / Math.max(procW, procH)) });
      used++;
    }
    if (used < (o.minTracks || 8)) {
      return { ok: false, error: 'Only ' + used + ' usable vehicle paths so far.', used: used };
    }

    var M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (var k = 0; k < lines.length; k++) {
      var L = lines[k].l, w = lines[k].w;
      for (var r = 0; r < 3; r++) for (var c = 0; c < 3; c++) M[r][c] += w * L[r] * L[c];
    }
    var vn = smallestEigenvector(M);

    /*
     * Bootstrap the vanishing point: resample the paths with replacement and
     * re-estimate. The spread of those estimates is the honest uncertainty in
     * the road direction, which is then carried into the distance calculation.
     * Without this the app would quote a confidence it has not earned.
     */
    var samples = [], bsRng = mulberry32(0xb007);
    var B = (o.bootstrap === undefined) ? 24 : o.bootstrap;
    for (var b = 0; b < B; b++) {
      var Mb = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      for (var pick = 0; pick < lines.length; pick++) {
        var Lb = lines[Math.floor(bsRng() * lines.length) % lines.length];
        for (var rb = 0; rb < 3; rb++) {
          for (var cb = 0; cb < 3; cb++) Mb[rb][cb] += Lb.w * Lb.l[rb] * Lb.l[cb];
        }
      }
      var vb = smallestEigenvector(Mb);
      samples.push(norm3([vb[0] * sc + vb[2] * cx, vb[1] * sc + vb[2] * cy, vb[2]]));
    }
    // Back out of the normalised frame, keeping it homogeneous so a vanishing
    // point at infinity (a perfectly square-on camera) stays representable.
    var v = [vn[0] * sc + vn[2] * cx, vn[1] * sc + vn[2] * cy, vn[2]];

    // Residual: how well the paths actually agree on one vanishing point.
    var resid = 0;
    for (var m = 0; m < lines.length; m++) {
      var d = lines[m].l[0] * vn[0] + lines[m].l[1] * vn[1] + lines[m].l[2] * vn[2];
      resid += d * d * lines[m].w;
    }
    return {
      ok: true,
      vanishingPoint: norm3(v),
      samples: samples,
      tracksUsed: used,
      residual: Math.sqrt(resid / lines.length)
    };
  }

  /* ------------------------------------------- scale from traffic itself */

  /*
   * Last-resort anchor with no user input at all: assume the median vehicle on
   * a residential street is about as long as the median vehicle everywhere, and
   * use the rectified lengths of the traffic already measured. Screening-grade
   * only - the fleet prior is good to roughly 10%, and that error lands on
   * every speed in the session.
   */
  var FLEET_MEDIAN_LENGTH_M = 4.9;   // mixed US car/SUV/light-truck fleet
  var FLEET_PRIOR_REL_SIGMA = 0.10;

  function fleetScale(rectifiedLengths, opts) {
    var o = opts || {};
    var vals = rectifiedLengths.filter(function (v) { return v > 0 && isFinite(v); })
      .sort(function (a, b) { return a - b; });
    if (vals.length < 5) {
      return { ok: false, error: 'Not enough vehicles yet - ' + vals.length + ' of at least 5.' };
    }
    var m = vals.length >> 1;
    var medianRect = vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2;
    var prior = o.priorMeters || FLEET_MEDIAN_LENGTH_M;
    var samplingRel = 1.2 / Math.sqrt(vals.length); // median of a spread-out sample
    return {
      ok: true,
      metersPerRectifiedUnit: prior / medianRect,
      relSigma: Math.sqrt(FLEET_PRIOR_REL_SIGMA * FLEET_PRIOR_REL_SIGMA + samplingRel * samplingRel),
      n: vals.length,
      medianRectified: medianRect,
      priorMeters: prior
    };
  }

  /*
   * Find the clusters in a set of positive measurements, at whatever scale they
   * arrive in. A Gaussian kernel density on a grid, then the local maxima; the
   * bandwidth is relative, so this works on raw ratios with no units.
   */
  function findClusters(values, options) {
    var o = options || {};
    var vals = values.filter(function (v) { return v > 0 && isFinite(v); })
      .sort(function (a, b) { return a - b; });
    var n = vals.length;
    if (n < (o.minPoints || 8)) return [];
    var mid = vals[n >> 1] || 1;
    var bw = (o.bandwidthRel === undefined ? 0.022 : o.bandwidthRel) * mid;
    if (!(bw > 0)) return [];

    var lo = vals[0] - 3 * bw, hi = vals[n - 1] + 3 * bw;
    var steps = o.steps || 220, dens = new Float64Array(steps), xs = new Float64Array(steps);
    for (var i = 0; i < steps; i++) {
      var x = lo + (hi - lo) * i / (steps - 1);
      xs[i] = x;
      var d = 0;
      for (var j = 0; j < n; j++) {
        var u = (x - vals[j]) / bw;
        if (u > -3.5 && u < 3.5) d += Math.exp(-0.5 * u * u);
      }
      dens[i] = d;
    }

    var peaks = [];
    for (var k = 1; k < steps - 1; k++) {
      if (dens[k] >= dens[k - 1] && dens[k] > dens[k + 1]) {
        var centre = xs[k], count = 0;
        for (var m = 0; m < n; m++) if (Math.abs(vals[m] - centre) < 2 * bw) count++;
        peaks.push({ centre: centre, share: count / n, density: dens[k] });
      }
    }
    return peaks;
  }

  /*
   * Set the session scale from the shape of the traffic, not from its average.
   *
   * ratios: each vehicle's wheelbase as a fraction of the gate separation, all
   * in the rectified plane, so they are dimensionless and directly comparable.
   *
   * Why not the median: wheelbase is not smoothly distributed. It forms two
   * clusters - light vehicles around 2.70m (a compact car is 2.68 and a small
   * crossover 2.69, so they are the same population for this purpose) and
   * pickups around 3.62m. The median falls in the sparse gap between them and
   * therefore slides with the local mix: simulation puts it at +3% on a
   * car-heavy street and -12% where half the traffic is pickups. The light
   * cluster, by contrast, sits in the same place everywhere; only its share
   * moves. Locating it holds to about +/-0.2% across realistic mixes.
   */
  var LIGHT_WHEELBASE_M = 2.70;       // the light-vehicle cluster
  var HEAVY_WHEELBASE_M = 3.62;       // pickups; used only to recognise them
  var LIGHT_PRIOR_REL_SIGMA = 0.045;  // how well that cluster's position is known

  function scaleFromClusters(ratios, options) {
    var o = options || {};
    var clean = (ratios || []).filter(function (v) { return v > 0 && isFinite(v); });
    var need = o.minObservations || 10;
    if (clean.length < need) {
      return { ok: false, error: clean.length + ' of ' + need + ' vehicles measured so far.',
               n: clean.length, need: need };
    }
    var peaks = findClusters(clean, o);
    if (!peaks.length) {
      return { ok: false, error: 'No clear vehicle size grouping yet.', n: clean.length };
    }

    /*
     * The lowest grouping holding a real share of the traffic is the light
     * vehicles. A thin one still counts, because on a truck-heavy street the
     * cars are a minority and are exactly what we want to measure against.
     *
     * Two guards stop that generosity backfiring. A grouping must contain a
     * minimum NUMBER of vehicles, not just a share, so two stray detections
     * cannot invent one; and it must not sit far below the bulk of the traffic,
     * which keeps a handful of motorcycles (wheelbase ~1.4m) from being taken
     * for small cars and halving the scale.
     */
    var minShare = o.minShare === undefined ? 0.05 : o.minShare;
    var minCount = o.minCount === undefined ? 3 : o.minCount;
    var sorted = clean.slice().sort(function (a, b) { return a - b; });
    var mid2 = sorted.length >> 1;
    var medianRatio = sorted.length % 2 ? sorted[mid2] : (sorted[mid2 - 1] + sorted[mid2]) / 2;
    var floor = (o.lowestPlausibleRel === undefined ? 0.62 : o.lowestPlausibleRel) * medianRatio;

    var light = null, rejectedLow = 0;
    for (var i = 0; i < peaks.length; i++) {
      if (peaks[i].share * clean.length < minCount) continue;
      if (peaks[i].share < minShare) continue;
      if (peaks[i].centre < floor) { rejectedLow++; continue; }
      light = peaks[i];
      break;
    }
    if (!light) {
      return { ok: false, n: clean.length,
               error: 'No vehicle size grouping large enough to trust yet.' };
    }

    // A second grouping at roughly 3.62/2.70 confirms we are looking at cars
    // and pickups, and therefore that the lower one really is the cars.
    var expected = HEAVY_WHEELBASE_M / LIGHT_WHEELBASE_M;
    var heavy = null;
    for (var j = 0; j < peaks.length; j++) {
      var r = peaks[j].centre / light.centre;
      if (r > expected * 0.82 && r < expected * 1.22 && peaks[j].share >= 0.04) {
        heavy = peaks[j];
        break;
      }
    }

    var meters = LIGHT_WHEELBASE_M / light.centre;
    var samplingRel = 0.03 / Math.sqrt(clean.length);
    var warnings = [];
    var priorRel = LIGHT_PRIOR_REL_SIGMA;

    if (!heavy) {
      /*
       * One grouping only. This is genuinely ambiguous: a street where every
       * vehicle is a pickup produces the same picture as a street of compact
       * cars, scaled. Ordinary cars are much the commoner case, so assume them
       * - but widen the error bar to admit the assumption rather than hide it.
       */
      priorRel = o.ambiguousRelSigma === undefined ? 0.09 : o.ambiguousRelSigma;
      warnings.push('All the traffic measured is one size, so the scale assumes ' +
        'these are ordinary cars. If this street carries mainly pickups or vans, ' +
        'mark a reference object of known length instead.');
    }

    return {
      ok: true,
      meters: meters,
      n: clean.length,
      relSigma: Math.sqrt(priorRel * priorRel + samplingRel * samplingRel),
      lightShare: light.share,
      twoPopulations: !!heavy,
      clusters: peaks.length,
      rejectedLowGroupings: rejectedLow,
      warnings: warnings
    };
  }

  /*
   * Turn many per-vehicle reference segments into ONE scale for the session.
   *
   * This matters more than it looks. Scaling each vehicle by its own assumed
   * wheelbase gives every speed an independent random error, and random error
   * does not cancel in a percentile - it fattens the distribution and pushes
   * the 85th percentile up, making a street look faster than it is. Taking the
   * median across the session converts that into a single systematic scale
   * error, which shrinks as 1/sqrt(N) and shifts every speed proportionally
   * without distorting the shape of the distribution.
   *
   * observations: [{ meters }] - the gate distance each vehicle implies.
   */
  function autoScaleFromReferences(observations, options) {
    var o = options || {};
    var vals = (observations || []).map(function (x) { return x.meters; })
      .filter(function (v) { return v > 0 && isFinite(v); })
      .sort(function (a, b) { return a - b; });
    var need = o.minObservations || 8;
    if (vals.length < need) {
      return { ok: false, error: vals.length + ' of ' + need + ' vehicles measured so far.',
               n: vals.length, need: need };
    }
    var mid = vals.length >> 1;
    var median = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;

    // Spread of the observations themselves, robustly (MAD -> sigma).
    var devs = vals.map(function (v) { return Math.abs(v - median); })
      .sort(function (a, b) { return a - b; });
    var dmid = devs.length >> 1;
    var mad = devs.length % 2 ? devs[dmid] : (devs[dmid - 1] + devs[dmid]) / 2;
    var sigma = 1.4826 * mad;
    // Error in the median, plus the systematic error in the assumed length,
    // which no amount of sampling can reduce.
    var samplingRel = median > 0 ? 1.253 * (sigma / median) / Math.sqrt(vals.length) : 0;
    var priorRel = o.priorRelSigma === undefined ? 0.07 : o.priorRelSigma;
    return {
      ok: true,
      meters: median,
      n: vals.length,
      relSigma: Math.sqrt(samplingRel * samplingRel + priorRel * priorRel),
      samplingRel: samplingRel,
      priorRel: priorRel,
      spreadRel: median > 0 ? sigma / median : null
    };
  }

  /*
   * A sanity check that costs the user nothing: given a calibration, what
   * length does it imply for the typical vehicle? If that is 9 m or 2 m, the
   * distance is wrong - usually feet entered as metres, or a mis-tapped
   * reference. This catches the error before it reaches a council meeting.
   */
  function plausibilityCheck(estimatedLengthsM) {
    var vals = (estimatedLengthsM || []).filter(function (v) { return v > 0 && isFinite(v); })
      .sort(function (a, b) { return a - b; });
    if (vals.length < 5) return { ok: true, enough: false, n: vals.length };
    var m = vals.length >> 1;
    var median = vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2;
    var ratio = median / FLEET_MEDIAN_LENGTH_M;
    var out = { ok: true, enough: true, n: vals.length, medianLengthM: median, ratio: ratio };
    if (ratio > 1.45 || ratio < 0.65) {
      out.ok = false;
      out.message = 'Typical measured vehicle length is ' + median.toFixed(1) + ' m, against ' +
        'about ' + FLEET_MEDIAN_LENGTH_M + ' m for normal traffic. Your distance is probably out ' +
        'by a factor of roughly ' + (ratio > 1 ? ratio.toFixed(1) : (1 / ratio).toFixed(1)) +
        (ratio > 2.9 && ratio < 3.5 ? ' - did you enter feet as metres?' : '') + '.';
    }
    return out;
  }

  /* ------------------------------------------- known reference lengths */

  // Only things whose size is genuinely standardised, or that the user can
  // check themselves. Anything approximate says so.
  // Wheelbase is a length lying ON the road surface between two points the
  // software can find by itself, which makes it the natural automatic
  // reference. Spread across a mixed fleet is wider than tyre diameter, but it
  // is four times the size in pixels, so it measures far more precisely.
  // The MEDIAN wheelbase, because that is the statistic used - not the mean,
  // which a few long pickups drag upwards. This single number is the dominant
  // systematic error in the fully automatic mode and deserves validation
  // against local traffic before anyone leans on it.
  var FLEET_WHEELBASE_M = 2.80;
  var FLEET_WHEELBASE_REL_SIGMA = 0.09;

  var REFERENCES = [
    { id: 'custom', label: 'Something else (enter the length)', meters: null, exact: false },
    { id: 'own-car', label: 'Your own car, measured once in the driveway', meters: null, exact: true,
      note: 'The best option: measure it once, safely off the road, and it is a ruler forever.' },
    { id: 'lane-stripe', label: 'One broken lane stripe (US, MUTCD)', meters: 10 * FT_TO_M, exact: true,
      note: 'US standard: 10 ft painted, 30 ft gap.' },
    { id: 'lane-cycle', label: 'Lane stripe + gap, stripe start to stripe start (US)', meters: 40 * FT_TO_M, exact: true,
      note: 'US standard 40 ft cycle. A long baseline, so a good reference.' },
    { id: 'parking-parallel', label: 'Marked parallel parking bay', meters: 6.4, exact: false,
      note: 'Typically 20-22 ft; varies by city, so check local standards.' },
    { id: 'plywood', label: 'Sheet of plywood (8 ft)', meters: 8 * FT_TO_M, exact: true,
      note: 'Exactly 8 ft, and you can lay it at the kerb.' },
    { id: 'sedan', label: 'Typical mid-size sedan', meters: 4.8, exact: false,
      note: 'Approximate. Look up your own model if you can - it is usually in the manual.' },
    { id: 'pickup', label: 'Typical full-size pickup', meters: 5.9, exact: false,
      note: 'Approximate, and pickups vary a lot by cab and bed.' }
  ];

  root.Calibration = {
    solve: solve,
    computeGateDistance: computeGateDistance,
    geometricUncertainty: geometricUncertainty,
    rectify: rectify,
    lineThrough: lineThrough,
    vanishingPoint: vanishingPoint,
    fleetScale: fleetScale,
    vanishingPointFromTrails: vanishingPointFromTrails,
    vanishingPointFromLines: vanishingPointFromLines,
    vanishingPointFromContacts: vanishingPointFromContacts,
    autoScaleFromReferences: autoScaleFromReferences,
    scaleFromClusters: scaleFromClusters,
    findClusters: findClusters,
    fitLineTLS: fitLineTLS,
    smallestEigenvector: smallestEigenvector,
    plausibilityCheck: plausibilityCheck,
    REFERENCES: REFERENCES,
    FLEET_MEDIAN_LENGTH_M: FLEET_MEDIAN_LENGTH_M,
    FLEET_WHEELBASE_M: FLEET_WHEELBASE_M,
    FLEET_WHEELBASE_REL_SIGMA: FLEET_WHEELBASE_REL_SIGMA,
    LIGHT_WHEELBASE_M: LIGHT_WHEELBASE_M,
    HEAVY_WHEELBASE_M: HEAVY_WHEELBASE_M,
    FT_TO_M: FT_TO_M
  };
})(typeof module !== 'undefined' && module.exports ? module.exports : this);
