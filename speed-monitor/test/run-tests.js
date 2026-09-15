#!/usr/bin/env node
/*
 * Test suite for the Neighborhood Speed Monitor. No dependencies:
 *
 *   node test/run-tests.js
 *
 * The headline test drives a synthetic vehicle past the gates at known speeds
 * and checks the measured speed against ground truth, exercising the whole
 * pipeline: background subtraction, blob detection, tracking, sub-frame gate
 * interpolation and the unit arithmetic.
 */
'use strict';

var path = require('path');
var dir = path.join(__dirname, '..', 'js');
var SpeedMeter = require(path.join(dir, 'speedmeter.js')).SpeedMeter;
var G = require(path.join(dir, 'speedmeter.js')).SpeedGeometry;
var Analysis = require(path.join(dir, 'analysis.js')).Analysis;
var SelfTest = require(path.join(dir, 'selftest.js')).SelfTest;

var passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (err) {
    failed++;
    console.log('  FAIL ' + name);
    console.log('       ' + err.message);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function close(actual, expected, tol, msg) {
  if (Math.abs(actual - expected) > tol) {
    throw new Error((msg || 'value') + ': expected ' + expected + ' +/- ' + tol +
      ', got ' + actual);
  }
}

console.log('\ngate geometry');

test('gate separation is the perpendicular distance', function () {
  var A = [{ x: 70, y: 0 }, { x: 70, y: 100 }];
  var B = [{ x: 250, y: 0 }, { x: 250, y: 100 }];
  close(G.gateSeparation(A, B), 180, 1e-9, 'separation');
});

test('separation is orientation independent', function () {
  var A = [{ x: 0, y: 70 }, { x: 100, y: 70 }];
  var B = [{ x: 0, y: 250 }, { x: 100, y: 250 }];
  close(G.gateSeparation(A, B), 180, 1e-9, 'separation');
});

test('crossing time is interpolated between frames', function () {
  var gate = [{ x: 100, y: 0 }, { x: 100, y: 200 }];
  // Sample 1px before and 3px after: the crossing is 25% into the interval.
  var hit = G.crossing(gate, { p: { x: 99, y: 50 }, t: 1.0 }, { p: { x: 103, y: 50 }, t: 1.1 });
  assert(hit, 'expected a crossing');
  close(hit.t, 1.025, 1e-9, 'crossing time');
});

test('crossing past the end of the segment is ignored', function () {
  var gate = [{ x: 100, y: 0 }, { x: 100, y: 100 }];
  assert(G.crossing(gate, { p: { x: 98, y: 180 }, t: 0 }, { p: { x: 102, y: 180 }, t: 0.1 }) === null,
    'a pass beyond the gate ends must not count');
});

test('no crossing when the object stays on one side', function () {
  var gate = [{ x: 100, y: 0 }, { x: 100, y: 100 }];
  assert(G.crossing(gate, { p: { x: 80, y: 50 }, t: 0 }, { p: { x: 95, y: 50 }, t: 0.1 }) === null,
    'approaching the gate is not crossing it');
});

console.log('\nspeed arithmetic');

test('speed is distance over interpolated time', function () {
  // 20m apart, gates 200px apart, object moving 100px/s => 10 m/s => 22.37mph
  var meter = new SpeedMeter({
    gateA: [{ x: 100, y: 0 }, { x: 100, y: 200 }],
    gateB: [{ x: 300, y: 0 }, { x: 300, y: 200 }],
    distanceMeters: 20,
    distanceSigmaMeters: 0,
    geometrySigmaRel: 0
  });
  var out = [], t = 0, dt = 1 / 30, x = 50;
  while (x < 350) {
    var found = meter.update([{
      id: 7, cx: x, cy: 100, bw: 40, bh: 20, area: 800, missesTotal: 0
    }], t);
    found.forEach(function (m) { out.push(m); });
    x += 100 * dt;
    t += dt;
  }
  assert(out.length === 1, 'expected exactly one measurement, got ' + out.length);
  close(out[0].speedMps, 10, 0.02, 'speed m/s');
  close(out[0].speedMph, 22.369, 0.05, 'speed mph');
  assert(out[0].direction === 'A>B', 'direction should be A>B');
});

test('direction is reported for the reverse pass', function () {
  var meter = new SpeedMeter({
    gateA: [{ x: 100, y: 0 }, { x: 100, y: 200 }],
    gateB: [{ x: 300, y: 0 }, { x: 300, y: 200 }],
    distanceMeters: 20, distanceSigmaMeters: 0
  });
  var out = [], t = 0, dt = 1 / 30, x = 350;
  while (x > 50) {
    meter.update([{ id: 3, cx: x, cy: 100, bw: 40, bh: 20, area: 800, missesTotal: 0 }], t)
      .forEach(function (m) { out.push(m); });
    x -= 100 * dt;
    t += dt;
  }
  assert(out.length === 1, 'expected one measurement');
  assert(out[0].direction === 'B>A', 'direction should be B>A, got ' + out[0].direction);
});

test('an object that turns back is not measured', function () {
  var meter = new SpeedMeter({
    gateA: [{ x: 100, y: 0 }, { x: 100, y: 200 }],
    gateB: [{ x: 300, y: 0 }, { x: 300, y: 200 }],
    distanceMeters: 20, distanceSigmaMeters: 0
  });
  var out = [], t = 0, dt = 1 / 30;
  // Cross gate A, turn around before B, cross A again.
  [80, 95, 110, 130, 150, 130, 110, 95, 80].forEach(function (x) {
    meter.update([{ id: 5, cx: x, cy: 100, bw: 40, bh: 20, area: 800, missesTotal: 0 }], t)
      .forEach(function (m) { out.push(m); });
    t += dt;
  });
  assert(out.length === 0, 'a vehicle that never reached gate B must not be measured');
});

test('implausible speeds are rejected, not reported', function () {
  var meter = new SpeedMeter({
    gateA: [{ x: 100, y: 0 }, { x: 100, y: 200 }],
    gateB: [{ x: 300, y: 0 }, { x: 300, y: 200 }],
    distanceMeters: 20, distanceSigmaMeters: 0, maxMph: 100
  });
  var out = [], t = 0, dt = 1 / 30, x = 50;
  while (x < 600) { // 3000 px/s => ~670 mph; run past gate B so it is timed at all
    meter.update([{ id: 9, cx: x, cy: 100, bw: 40, bh: 20, area: 800, missesTotal: 0 }], t)
      .forEach(function (m) { out.push(m); });
    x += 3000 * dt;
    t += dt;
  }
  assert(out.length === 0, 'expected rejection, got ' + out.length + ' measurement(s)');
  assert(meter.rejected > 0, 'rejection should be counted for transparency');
});

test('uncertainty grows as the measured distance gets less certain', function () {
  function sigmaFor(distSigma) {
    var meter = new SpeedMeter({
      gateA: [{ x: 100, y: 0 }, { x: 100, y: 200 }],
      gateB: [{ x: 300, y: 0 }, { x: 300, y: 200 }],
      distanceMeters: 20, distanceSigmaMeters: distSigma, geometrySigmaRel: 0
    });
    var out = [], t = 0, dt = 1 / 30, x = 50;
    while (x < 350) {
      meter.update([{ id: 1, cx: x, cy: 100, bw: 40, bh: 20, area: 800, missesTotal: 0 }], t)
        .forEach(function (m) { out.push(m); });
      x += 100 * dt;
      t += dt;
    }
    return out[0].sigmaRel;
  }
  var tight = sigmaFor(0.1), loose = sigmaFor(2.0);
  assert(loose > tight * 3, 'a 10% distance error must dominate the error budget');
  close(loose, Math.sqrt(0.1 * 0.1 + Math.pow(sigmaFor(0) , 2)), 0.02, 'error combines in quadrature');
});

console.log('\nstatistics');

test('percentiles interpolate', function () {
  close(Analysis.percentile([10, 20, 30, 40, 50], 0.5), 30, 1e-9, 'median');
  close(Analysis.percentile([10, 20, 30, 40, 50], 0.85), 44, 1e-9, 'p85');
  assert(Analysis.percentile([], 0.5) === null, 'empty input gives null');
  close(Analysis.percentile([42], 0.85), 42, 1e-9, 'single sample');
});

test('pace finds the densest 10mph band', function () {
  var p = Analysis.pace([20, 21, 22, 23, 40, 41], 10);
  close(p.from, 20, 1e-9, 'pace start');
  assert(p.count === 4, 'pace should hold 4 vehicles, got ' + p.count);
});

test('summary reports compliance against the posted limit', function () {
  var rows = [26, 27, 31, 24, 40].map(function (mph, i) {
    return {
      seq: i + 1, speedMph: mph, speedKph: mph * 1.609, ci95Mph: 1, ci95Kph: 1.6,
      direction: i % 2 ? 'A>B' : 'B>A', confidence: 'high', flags: [],
      estClass: 'car', estLengthM: 4.5, frames: 20, videoTime: i, wallClock: ''
    };
  });
  var s = Analysis.summarize(rows, { unit: 'mph', limit: 25 });
  assert(s.n === 5, 'n');
  assert(s.over === 4, 'four vehicles exceed 25mph, got ' + s.over);
  assert(s.wayOver === 1, 'one vehicle exceeds 35mph, got ' + s.wayOver);
  close(s.max, 40, 1e-9, 'max');
});

test('report states the method and the limitations', function () {
  var rows = [{
    seq: 1, speedMph: 32, speedKph: 51.5, ci95Mph: 1.2, ci95Kph: 1.9,
    direction: 'A>B', confidence: 'high', flags: [], estClass: 'car',
    estLengthM: 4.4, frames: 22, videoTime: 3.2, wallClock: new Date().toISOString()
  }];
  var stats = Analysis.summarize(rows, { unit: 'mph', limit: 25 });
  var md = Analysis.toMarkdown(rows, stats, {
    location: 'Elm St', distanceMeters: 18.29, distanceLabel: '60 ft',
    sessionStart: Date.now(), observedSeconds: 1800, source: 'live camera'
  });
  ['85th percentile', 'not an enforcement', 'Limitations', 'Elm St', '60 ft',
   'license plates'].forEach(function (needle) {
    assert(md.indexOf(needle) !== -1, 'report should mention "' + needle + '"');
  });
  assert(md.indexOf('undefined') === -1, 'report must not contain "undefined"');
  assert(md.indexOf('NaN') === -1, 'report must not contain "NaN"');
});

test('short and long sessions are both described sensibly', function () {
  assert(Analysis.formatDuration(14) === '14 seconds',
    'a 14 second session must not read as "0 minutes", got ' + Analysis.formatDuration(14));
  assert(Analysis.formatDuration(1800) === '30 minutes', 'half an hour');
  assert(Analysis.formatDuration(7200) === '2 hours', 'two hours');
  assert(Analysis.formatDuration(0) === null, 'no duration recorded');
});

test('empty session produces a report rather than an error', function () {
  var stats = Analysis.summarize([], { unit: 'mph', limit: 25 });
  var md = Analysis.toMarkdown([], stats, { location: 'Elm St' });
  assert(md.indexOf('No vehicles were measured') !== -1, 'should say nothing was measured');
});

test('CSV escapes separators in free text', function () {
  var rows = [{
    seq: 1, speedMph: 30, speedKph: 48, ci95Mph: 1, direction: 'A>B',
    confidence: 'high', flags: ['few-frames'], estClass: 'car', estLengthM: 4,
    frames: 10, videoTime: 1, wallClock: '2026-01-01T00:00:00.000Z'
  }];
  var csv = Analysis.toCSV(rows, { directionLabels: { 'A>B': 'north, bound' } });
  assert(csv.indexOf('"north, bound"') !== -1, 'a comma in a label must be quoted');
  assert(csv.trim().split('\n').length === 2, 'header plus one row');
});

console.log('\nend-to-end against a synthetic street (the accuracy claim)');

var sweep = SelfTest.run([15, 25, 35, 45]);
sweep.rows.forEach(function (r) {
  test('measures a ' + r.truthMph + ' mph vehicle to within 2%', function () {
    assert(r.measuredMph !== null, 'vehicle was not detected at all');
    assert(r.detections === 1, 'expected 1 measurement, got ' + r.detections +
      ' (a vehicle counted twice would inflate a real study)');
    assert(Math.abs(r.errorPct) < 2,
      'error ' + r.errorPct.toFixed(2) + '% exceeds 2% (measured ' +
      r.measuredMph.toFixed(2) + ' mph vs ' + r.truthMph + ' mph truth)');
  });
});

test('an empty street produces no measurements', function () {
  var pass = SelfTest.runPass(25, { scene: { carLengthPx: 0, carHeightPx: 0 } });
  assert(pass.measurements.length === 0,
    'phantom detections on an empty road: ' + pass.measurements.length);
});

test('results are deterministic for a given seed', function () {
  var a = SelfTest.runPass(30, { seed: 99 }).measurements[0];
  var b = SelfTest.runPass(30, { seed: 99 }).measurements[0];
  close(a.speedMph, b.speedMph, 1e-12, 'same seed, same answer');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
console.log('worst synthetic error: ' + sweep.worstErrorPct.toFixed(3) + '%\n');
process.exit(failed ? 1 : 0);
