/*
 * selftest.js - runs the whole pipeline against a synthetic scene with a known
 * ground-truth speed.
 *
 * This validates the software: detection, tracking, sub-frame crossing
 * interpolation and the unit arithmetic. It cannot validate your real-world
 * distance measurement or your camera angle - only a field check against a
 * vehicle travelling at a known speed does that (see docs/METHOD.md).
 *
 * Renders into a plain grayscale typed array with a seeded PRNG, so it is
 * deterministic and runs identically in the browser and in node.
 */
(function (root) {
  'use strict';

  var MotionTracker = root.MotionTracker ||
    (typeof require !== 'undefined' ? require('./tracker.js').MotionTracker : null);
  var SpeedMeterMod = root.SpeedMeter ? root : (typeof require !== 'undefined' ? require('./speedmeter.js') : null);
  var SpeedMeter = root.SpeedMeter || (SpeedMeterMod && SpeedMeterMod.SpeedMeter);
  var FT_TO_M = 0.3048;
  var MPS_TO_MPH = 2.2369362920544;

  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var SCENE = {
    w: 320, h: 180,
    gateAx: 70, gateBx: 250,   // two vertical gates, parallel, across the road
    gateTop: 60, gateBottom: 172,
    distanceFeet: 60,          // ground distance between the gates
    carLengthPx: 45, carHeightPx: 22,
    carY: 112,
    fps: 30,
    noise: 5
  };

  // One frame of a static street with an optional dark vehicle rectangle.
  function renderFrame(buf, scene, rng, carX) {
    var w = scene.w, h = scene.h;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var v;
        if (y < 55) v = 150 - (y * 0.3);            // sky / far background
        else if (y < 68) v = 96 + ((x * 7) % 11);   // hedges and fences
        else {
          v = 120 - (y - 68) * 0.15;                // road surface
          if (y > 150 && ((x + 4) % 44) < 18) v = 150; // lane markings
        }
        v += (rng() - 0.5) * 2 * scene.noise;
        buf[y * w + x] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
    if (carX !== null) {
      var x0 = Math.round(carX - scene.carLengthPx / 2);
      var x1 = x0 + scene.carLengthPx;
      var y0 = Math.round(scene.carY - scene.carHeightPx / 2);
      var y1 = y0 + scene.carHeightPx;
      for (var cy = y0; cy < y1; cy++) {
        if (cy < 0 || cy >= h) continue;
        for (var cx = x0; cx < x1; cx++) {
          if (cx < 0 || cx >= w) continue;
          // Darker body with a lighter roofline, so the blob has structure.
          var body = cy < y0 + 6 ? 70 : 38;
          buf[cy * w + cx] = body + (rng() - 0.5) * 6;
        }
      }
    }
  }

  /*
   * Run one pass at a known speed. Returns the measurements produced plus the
   * ground truth, and optionally the frame captured as the car crosses gate A
   * (for drawing a preview in the UI).
   */
  function runPass(truthMph, opts) {
    var scene = {};
    for (var k in SCENE) scene[k] = SCENE[k];
    if (opts && opts.scene) for (var k2 in opts.scene) scene[k2] = opts.scene[k2];

    var distanceM = scene.distanceFeet * FT_TO_M;
    var gapPx = scene.gateBx - scene.gateAx;
    var metersPerPx = distanceM / gapPx;
    var pxPerSecond = (truthMph / MPS_TO_MPH) / metersPerPx;
    var dtFrame = 1 / scene.fps;

    var tracker = new MotionTracker(scene.w, scene.h);
    var meter = new SpeedMeter({
      gateA: [{ x: scene.gateAx, y: scene.gateTop }, { x: scene.gateAx, y: scene.gateBottom }],
      gateB: [{ x: scene.gateBx, y: scene.gateTop }, { x: scene.gateBx, y: scene.gateBottom }],
      distanceMeters: distanceM,
      // The synthetic distance is exact, so leave out distance error to isolate
      // the software's own timing error.
      distanceSigmaMeters: 0,
      geometrySigmaRel: 0
    });

    var rng = mulberry32(opts && opts.seed !== undefined ? opts.seed : 12345);
    var buf = new Uint8ClampedArray(scene.w * scene.h);
    var t = 0;
    var measurements = [];
    var preview = null;

    // Warm up the background model on an empty street.
    for (var i = 0; i < 25; i++) {
      renderFrame(buf, scene, rng, null);
      tracker.update(buf, t);
      t += dtFrame;
    }

    var carX = -scene.carLengthPx;
    var guard = 0;
    while (carX < scene.w + scene.carLengthPx && guard++ < 2000) {
      renderFrame(buf, scene, rng, carX);
      var res = tracker.update(buf, t);
      var found = meter.update(res.tracks, t);
      for (var m = 0; m < found.length; m++) measurements.push(found[m]);
      if (preview === null && carX >= scene.gateAx) {
        preview = { frame: buf.slice(0), width: scene.w, height: scene.h };
      }
      carX += pxPerSecond * dtFrame;
      t += dtFrame;
    }

    return {
      truthMph: truthMph,
      scene: scene,
      measurements: measurements,
      preview: preview,
      framesBetweenGates: gapPx / (pxPerSecond * dtFrame)
    };
  }

  // A sweep across residential speeds. Returns one row per speed with the
  // measured value and the error against ground truth.
  function run(speeds, opts) {
    var list = speeds || [15, 25, 35, 45];
    var rows = [];
    var preview = null;
    for (var i = 0; i < list.length; i++) {
      var pass = runPass(list[i], opts);
      var best = pass.measurements.length ? pass.measurements[0] : null;
      if (!preview && pass.preview) preview = pass.preview;
      rows.push({
        truthMph: list[i],
        measuredMph: best ? best.speedMph : null,
        errorMph: best ? best.speedMph - list[i] : null,
        errorPct: best ? (best.speedMph - list[i]) / list[i] * 100 : null,
        detections: pass.measurements.length,
        frames: best ? best.frames : null,
        confidence: best ? best.confidence : null,
        flags: best ? best.flags : null
      });
    }
    var worst = 0;
    rows.forEach(function (r) {
      if (r.errorPct === null) worst = Infinity;
      else worst = Math.max(worst, Math.abs(r.errorPct));
    });
    return { rows: rows, worstErrorPct: worst, preview: preview };
  }

  root.SelfTest = { run: run, runPass: runPass, renderFrame: renderFrame, SCENE: SCENE, mulberry32: mulberry32 };
})(typeof module !== 'undefined' && module.exports ? module.exports : this);
