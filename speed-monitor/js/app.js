/*
 * app.js - UI wiring for the Neighborhood Speed Monitor.
 *
 * Responsibilities: get a video source, let the user draw two gates on it,
 * pump frames through the tracker and the speed meter, and render results.
 * All measurement logic lives in tracker.js / speedmeter.js / analysis.js.
 */
(function () {
  'use strict';

  var PROC_LONG_SIDE = 320; // processing resolution: long side, in pixels
  var FT_TO_M = 0.3048;
  var STORE_KEY = 'nsm.settings.v1';

  var $ = function (id) { return document.getElementById(id); };

  var el = {
    btnCamera: $('btn-camera'), fileInput: $('file-input'), btnSelfTest: $('btn-selftest'),
    sourceStatus: $('source-status'), selfTestOut: $('selftest-out'),
    cardGates: $('card-gates'), cardSetup: $('card-setup'), cardMeasure: $('card-measure'),
    cardResults: $('card-results'),
    stage: $('stage'), video: $('video'), overlay: $('overlay'), work: $('work'),
    scrubRow: $('scrub-row'), scrub: $('scrub'), scrubLabel: $('scrub-label'),
    btnGateA: $('btn-gate-a'), btnGateB: $('btn-gate-b'), gaCount: $('ga-count'),
    gbCount: $('gb-count'), btnUndo: $('btn-undo'), btnClear: $('btn-clear'),
    gateStatus: $('gate-status'),
    scaleModes: $('scale-modes'), scaleReference: $('scale-reference'),
    scaleMeasured: $('scale-measured'), scaleStatus: $('scale-status'),
    btnRef: $('btn-ref'), refCount: $('ref-count'), btnUndoRef: $('btn-undo-ref'),
    refPreset: $('ref-preset'), refLength: $('ref-length'), refUnit: $('ref-unit'),
    refNote: $('ref-note'), btnRoad1: $('btn-road1'), btnRoad2: $('btn-road2'),
    r1Count: $('r1-count'), r2Count: $('r2-count'), btnClearRoad: $('btn-clear-road'),
    plausibility: $('plausibility'),
    distance: $('distance'), distanceUnit: $('distance-unit'), distanceSigma: $('distance-sigma'),
    sigmaUnit: $('sigma-unit'), limit: $('limit'), speedUnit: $('speed-unit'),
    location: $('location'), labelAB: $('label-ab'), labelBA: $('label-ba'),
    observer: $('observer'), notes: $('notes'), scaleReadout: $('scale-readout'),
    btnStart: $('btn-start'), btnStop: $('btn-stop'), chkBoxes: $('chk-boxes'),
    chkMask: $('chk-mask'), rateWrap: $('rate-wrap'), rate: $('rate'),
    liveSpeed: $('live-speed'), liveMeta: $('live-meta'), liveCount: $('live-count'),
    liveP85: $('live-p85'), liveFps: $('live-fps'), measureStatus: $('measure-status'),
    stats: $('stats'), logBody: document.querySelector('#log tbody'),
    btnReport: $('btn-report'), btnReportDl: $('btn-report-dl'), btnCsv: $('btn-csv'),
    btnJson: $('btn-json'), btnReset: $('btn-reset'), exportStatus: $('export-status')
  };

  var state = {
    source: null,          // 'camera' | 'file'
    stream: null,
    fileName: null,
    procW: 0, procH: 0,
    // Every tapped shape, in normalised [0..1] video coordinates.
    shapes: { gateA: [], gateB: [], ref: [], road1: [], road2: [] },
    active: 'gateA',
    scaleMode: 'reference',
    calibration: null,       // last computed scale {meters, relSigma, source}
    trails: [],              // finished vehicle paths, for the vanishing point
    liveTrails: {},          // paths still being tracked, keyed by track id
    roadVP: null,            // vanishing point derived from the traffic
    trailsAtLastVP: 0,
    contactLines: [],        // per-frame wheel-contact lines, on the road plane
    contactsAtLastVP: 0,
    wheelRefs: {},           // best wheel segment seen per track
    autoScale: null,
    droppedOnRescale: 0,
    tracker: null,
    meter: null,
    running: false,
    lastResult: null,
    lastFrameT: null,
    measurements: [],
    rejected: 0,
    flashes: [],
    sessionStart: null,
    sessionEnd: null,
    drawing: false
  };

  var workCtx = el.work.getContext('2d', { willReadFrequently: true });
  var overlayCtx = el.overlay.getContext('2d');

  /* ---------------------------------------------------------------- utils */

  function unit() { return el.speedUnit.value === 'kph' ? 'kph' : 'mph'; }
  function unitLabel() { return unit() === 'kph' ? 'km/h' : 'mph'; }
  function speedOf(m) { return unit() === 'kph' ? m.speedKph : m.speedMph; }
  function ciOf(m) { return unit() === 'kph' ? m.ci95Kph : m.ci95Mph; }

  function distanceMeters() {
    var v = parseFloat(el.distance.value);
    if (!(v > 0)) return 0;
    return el.distanceUnit.value === 'ft' ? v * FT_TO_M : v;
  }

  function distanceSigmaMeters() {
    var raw = el.distanceSigma.value;
    if (raw === '' || raw === null) return null;
    var v = parseFloat(raw);
    if (!(v >= 0)) return null;
    return el.distanceUnit.value === 'ft' ? v * FT_TO_M : v;
  }

  function fmt(v, places) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    var f = Math.pow(10, places === undefined ? 1 : places);
    return String(Math.round(v * f) / f);
  }

  function gatesReady() {
    return state.shapes.gateA.length === 2 && state.shapes.gateB.length === 2;
  }

  function procShape(name) {
    return state.shapes[name].map(function (p) {
      return { x: p.x * state.procW, y: p.y * state.procH };
    });
  }

  function refMeters() {
    var v = parseFloat(el.refLength.value);
    if (!(v > 0)) return 0;
    return el.refUnit.value === 'ft' ? v * FT_TO_M : v;
  }

  // The scale is usable once we have a distance, however it was obtained.
  function scaleReady() {
    return !!(state.calibration && state.calibration.meters > 0);
  }

  function setStatus(node, text, cls) {
    node.textContent = text || '';
    node.className = 'hint' + (cls ? ' ' + cls : '');
  }

  function download(filename, text, mime) {
    var blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function slug(s) {
    return (s || 'session').toLowerCase().replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '').slice(0, 40) || 'session';
  }

  /* ------------------------------------------------------------- settings */

  var SETTING_FIELDS = ['distance', 'distanceUnit', 'distanceSigma', 'limit',
    'speedUnit', 'location', 'labelAB', 'labelBA', 'observer', 'refLength', 'refUnit'];

  function saveSettings() {
    try {
      var out = {};
      SETTING_FIELDS.forEach(function (k) { out[k] = el[k].value; });
      localStorage.setItem(STORE_KEY, JSON.stringify(out));
    } catch (e) { /* private browsing, blocked storage: not important */ }
  }

  function loadSettings() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var saved = JSON.parse(raw);
      SETTING_FIELDS.forEach(function (k) {
        if (saved[k] !== undefined && saved[k] !== null) el[k].value = saved[k];
      });
    } catch (e) { /* ignore corrupt or unavailable storage */ }
  }

  /* --------------------------------------------------------- video source */

  function useCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus(el.sourceStatus, 'This browser cannot open the camera. Record a ' +
        'video and use "Choose a video file" instead.', 'bad');
      return;
    }
    setStatus(el.sourceStatus, 'Requesting camera…');
    navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 }, height: { ideal: 1080 },
        frameRate: { ideal: 60 }
      },
      audio: false
    }).then(function (stream) {
      stopStream();
      state.stream = stream;
      state.source = 'camera';
      state.fileName = null;
      el.video.srcObject = stream;
      el.video.removeAttribute('src');
      el.video.play();
      el.scrubRow.hidden = true;
      el.rateWrap.hidden = true;
      setStatus(el.sourceStatus, 'Camera live. Hold the phone still — prop it ' +
        'or use a tripod, since the gates are fixed to the frame.');
      onSourceReady();
    }).catch(function (err) {
      var msg = 'Could not open the camera (' + (err && err.name ? err.name : 'error') + '). ';
      if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
        msg += 'Browsers only allow camera access over https. ';
      }
      setStatus(el.sourceStatus, msg + 'You can still record a video and upload it here.', 'bad');
    });
  }

  function useFile(file) {
    if (!file) return;
    stopStream();
    state.source = 'file';
    state.fileName = file.name;
    el.video.srcObject = null;
    el.video.src = URL.createObjectURL(file);
    el.video.load();
    el.scrubRow.hidden = false;
    el.rateWrap.hidden = false;
    setStatus(el.sourceStatus, 'Loaded ' + file.name + '. Scrub to a frame where the ' +
      'road is clear, then draw the gates.');
    onSourceReady();
  }

  function stopStream() {
    if (state.stream) {
      state.stream.getTracks().forEach(function (t) { t.stop(); });
      state.stream = null;
    }
  }

  function onSourceReady() {
    el.cardGates.hidden = false;
    el.cardSetup.hidden = false;
    el.cardMeasure.hidden = false;
    if (!state.drawing) { state.drawing = true; requestAnimationFrame(drawLoop); }
  }

  el.video.addEventListener('loadedmetadata', function () {
    fitStage();
    var vw = el.video.videoWidth, vh = el.video.videoHeight;
    if (vw >= vh) {
      state.procW = PROC_LONG_SIDE;
      state.procH = Math.max(90, Math.round(PROC_LONG_SIDE * vh / vw));
    } else {
      state.procH = PROC_LONG_SIDE;
      state.procW = Math.max(90, Math.round(PROC_LONG_SIDE * vw / vh));
    }
    el.work.width = state.procW;
    el.work.height = state.procH;
    el.scrub.disabled = !isFinite(el.video.duration);
    state.tracker = null;
    recomputeCalibration();
    updateReadout();
  });

  el.video.addEventListener('ended', function () { if (state.running) stopMeasuring('Video finished.'); });
  el.video.addEventListener('timeupdate', function () {
    if (state.source !== 'file' || !isFinite(el.video.duration) || !el.video.duration) return;
    if (!state.running) return;
    el.scrub.value = String(Math.round(el.video.currentTime / el.video.duration * 1000));
    el.scrubLabel.textContent = fmt(el.video.currentTime, 1) + 's';
  });

  window.addEventListener('resize', fitStage);

  function fitStage() {
    var vw = el.video.videoWidth || 16, vh = el.video.videoHeight || 9;
    var maxW = el.cardGates.clientWidth - 2.2 * 16;
    if (!(maxW > 0)) maxW = 320;
    var maxH = Math.max(220, Math.min(window.innerHeight * 0.6, 640));
    var w = maxW, h = w * vh / vw;
    if (h > maxH) { h = maxH; w = h * vw / vh; }
    el.stage.style.width = Math.round(w) + 'px';
    el.stage.style.height = Math.round(h) + 'px';
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    el.overlay.width = Math.round(w * dpr);
    el.overlay.height = Math.round(h * dpr);
    overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ------------------------------------------------------- gate placement */

  el.overlay.addEventListener('pointerdown', function (ev) {
    ev.preventDefault();
    var r = el.overlay.getBoundingClientRect();
    var nx = (ev.clientX - r.left) / r.width;
    var ny = (ev.clientY - r.top) / r.height;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;
    var g = state.shapes[state.active];
    if (g.length >= 2) g.length = 0; // a third tap restarts this shape
    g.push({ x: nx, y: ny });
    if (g.length === 2 && state.active === 'gateA' && state.shapes.gateB.length < 2) {
      setActive('gateB');
    } else if (g.length === 2 && state.active === 'road1' && state.shapes.road2.length < 2) {
      setActive('road2');
    }
    refreshGateUI();
  });

  var SHAPE_BUTTONS = {
    gateA: 'btnGateA', gateB: 'btnGateB', ref: 'btnRef',
    road1: 'btnRoad1', road2: 'btnRoad2'
  };

  function setActive(name) {
    state.active = name;
    Object.keys(SHAPE_BUTTONS).forEach(function (k) {
      var b = el[SHAPE_BUTTONS[k]];
      if (b) b.classList.toggle('active', k === name);
    });
  }

  var SHAPE_LABELS = {
    gateA: 'Gate A', gateB: 'Gate B', ref: 'the reference object',
    road1: 'road line 1', road2: 'road line 2'
  };

  function refreshGateUI() {
    el.gaCount.textContent = state.shapes.gateA.length + '/2';
    el.gbCount.textContent = state.shapes.gateB.length + '/2';
    el.refCount.textContent = state.shapes.ref.length + '/2';
    el.r1Count.textContent = state.shapes.road1.length + '/2';
    el.r2Count.textContent = state.shapes.road2.length + '/2';

    var g = state.shapes[state.active];
    var label = SHAPE_LABELS[state.active];
    var msg;
    if (state.active === 'gateA' || state.active === 'gateB') {
      if (gatesReady()) msg = 'Both gates placed. Tap a gate button to redraw one.';
      else if (g.length === 0) msg = 'Placing ' + label + ': tap the first point, at one kerb.';
      else msg = 'Placing ' + label + ': tap the second point, at the far kerb.';
    } else if (state.active === 'ref') {
      msg = g.length === 0
        ? 'Tap one end of the reference object, at ground level.'
        : (g.length === 1 ? 'Now tap its other end.' : 'Reference marked.');
    } else {
      msg = g.length < 2
        ? 'Trace ' + label + ': tap a point near you, then one as far down the road as you can see.'
        : label + ' traced.';
    }
    setStatus(el.gateStatus, msg);
    recomputeCalibration();
    updateReadout();
    // Timing works without a scale, so measuring only needs the gates.
    el.btnStart.disabled = !gatesReady();
  }

  Object.keys(SHAPE_BUTTONS).forEach(function (name) {
    var b = el[SHAPE_BUTTONS[name]];
    if (b) b.addEventListener('click', function () { setActive(name); refreshGateUI(); });
  });
  el.btnUndo.addEventListener('click', function () {
    var g = state.shapes[state.active];
    if (g.length) g.pop();
    else if (state.active === 'gateB') { setActive('gateA'); state.shapes.gateA.pop(); }
    refreshGateUI();
  });
  el.btnUndoRef.addEventListener('click', function () {
    if (state.shapes.ref.length) state.shapes.ref.pop();
    setActive('ref');
    refreshGateUI();
  });
  el.btnClear.addEventListener('click', function () {
    state.shapes.gateA = []; state.shapes.gateB = [];
    setActive('gateA'); refreshGateUI();
  });
  el.btnClearRoad.addEventListener('click', function () {
    state.shapes.road1 = []; state.shapes.road2 = [];
    setActive('road1'); refreshGateUI();
  });

  /*
   * Work out the ground distance between the gates.
   *
   * Either the user measured it, or it is recovered from the road's geometry:
   * the vanishing point (from the paths of passing vehicles, or from traced
   * road lines) plus a reference object of known length. See calibration.js.
   */
  function recomputeCalibration() {
    var before = state.calibration ? state.calibration.meters : null;
    var next = null;

    if (state.scaleMode === 'measured') {
      var d = distanceMeters();
      if (d > 0) {
        next = { meters: d, sigmaMeters: distanceSigmaMeters(), source: 'measured', warnings: [] };
      }
    } else if (gatesReady() && state.shapes.ref.length !== 2 && state.roadVP && state.procW) {
      // Nothing marked: run entirely on what the traffic itself reveals.
      var auto = recomputeAutoScale();
      state.autoScale = auto;
      if (auto && auto.ok) {
        var fromWheels = state.roadVP.source === 'wheel contact points';
        var extra = fromWheels ? 0 : 0.15;
        var rel = Math.sqrt(auto.relSigma * auto.relSigma + extra * extra);
        next = {
          meters: auto.meters,
          relSigma: rel,
          sigmaMeters: auto.meters * rel,
          source: fromWheels ? 'wheelbases and wheel paths' : 'vehicle paths (rough)',
          automatic: true,
          vehicles: auto.n,
          warnings: []
        };
      }
    } else if (gatesReady() && state.shapes.ref.length === 2 && refMeters() > 0 && state.procW) {
      var opts = {
        gateA: procShape('gateA'),
        gateB: procShape('gateB'),
        reference: { p1: procShape('ref')[0], p2: procShape('ref')[1], meters: refMeters() },
        tapSigmaPx: 2
      };
      var haveRoads = state.shapes.road1.length === 2 && state.shapes.road2.length === 2;
      if (haveRoads) {
        opts.roadLines = [procShape('road1'), procShape('road2')];
      } else if (state.roadVP) {
        opts.roadVanishingPoint = state.roadVP.vanishingPoint;
        opts.roadVanishingPointSamples = state.roadVP.samples;
        /*
         * A road direction inferred from the traffic is convenient but only
         * approximate: a blob's centroid shifts as the vehicle's silhouette
         * turns with the viewing angle, which bends the path slightly and
         * biases the vanishing point. Measured at about 13% on a test scene
         * where marked road lines were exact, so it is carried as a systematic
         * term rather than quietly ignored.
         */
        opts.extraSystematicRel = 0.15;
      }
      if (haveRoads || state.roadVP) {
        var r = window.Calibration.computeGateDistance(opts);
        if (r.ok) {
          next = {
            meters: r.meters,
            sigmaMeters: r.sigmaMeters,
            relSigma: r.relSigma,
            source: haveRoads ? 'traced road lines' : 'vehicle paths',
            tracksUsed: state.roadVP ? state.roadVP.tracksUsed : 0,
            warnings: r.warnings || []
          };
        } else {
          next = { error: r.error, warnings: [] };
        }
      }
    }

    var changed = !next !== !state.calibration ||
      (next && next.meters && Math.abs((next.meters || 0) - (before || 0)) > 1e-6);
    state.calibration = next;
    if (changed) applyCalibration();
    renderScaleStatus();
  }

  // Push the current scale into the meter and re-price everything already
  // measured, so speeds recorded before the scale settled are not lost.
  function applyCalibration() {
    if (!state.meter) return;
    var c = state.calibration;
    state.meter.configure({
      distanceMeters: c && c.meters > 0 ? c.meters : 0,
      distanceSigmaMeters: c ? (c.sigmaMeters !== undefined ? c.sigmaMeters : null) : null
    });
    var res = state.meter.rescaleAll(state.measurements);
    state.droppedOnRescale += res.dropped;
    state.measurements = res.kept;
    renderResults();
  }

  function renderScaleStatus() {
    var c = state.calibration, box = el.scaleStatus;
    box.className = 'scale-status';
    if (state.scaleMode === 'measured') { box.hidden = true; return; }
    box.hidden = false;

    if (state.shapes.ref.length < 2) {
      if (c && c.automatic && c.meters > 0) {
        box.className = 'scale-status warn-box';
        box.innerHTML = 'Gate distance: <strong>' + fmt(c.meters / FT_TO_M, 1) + ' ft</strong> (' +
          fmt(c.meters, 1) + ' m) &middot; &plusmn;' + Math.round(c.relSigma * 100) +
          '% &middot; worked out entirely from the traffic, using ' + c.vehicles +
          ' vehicles&rsquo; wheelbases.<br><span class="hint">Nothing was marked or measured. ' +
          'Marking a reference of known length above would tighten this a lot, because the ' +
          'assumed average wheelbase is what limits it.</span>';
        return;
      }
      box.textContent = state.roadVP
        ? 'Reading the road from the traffic\u2026 mark a reference above for a tighter result.'
        : 'Mark a reference object, or just press Start and let the traffic set the scale.';
      return;
    }
    if (!(refMeters() > 0)) {
      box.textContent = 'Now enter how long that object really is.';
      return;
    }
    if (!gatesReady()) { box.textContent = 'Draw both gates to compute the scale.'; return; }

    if (c && c.error) {
      box.className = 'scale-status bad';
      box.textContent = c.error;
      return;
    }
    if (!c) {
      var seen = state.trails.length;
      box.textContent = 'Waiting for the traffic to reveal the road direction \u2014 ' +
        seen + ' vehicle path' + (seen === 1 ? '' : 's') + ' so far, 8 needed. ' +
        'You can start measuring now; speeds will fill in once the scale is known.';
      return;
    }

    var ft = c.meters / FT_TO_M;
    var pct = c.relSigma ? Math.round(c.relSigma * 100) : null;
    var parts = ['Gate distance: <strong>' + fmt(ft, 1) + ' ft</strong> (' + fmt(c.meters, 1) + ' m)'];
    if (pct !== null) parts.push('&plusmn;' + pct + '%');
    parts.push('from ' + c.source + (c.tracksUsed ? ' (' + c.tracksUsed + ' paths)' : ''));
    box.innerHTML = parts.join(' &middot; ') + ' &mdash; no measuring required.';
    if (c.source === 'vehicle paths') {
      box.className = 'scale-status warn-box';
      box.innerHTML += '<br><span class="hint">This road direction was inferred from ' +
        'the traffic, which is rough. <strong>Trace two road lines above</strong> for a ' +
        'markedly better figure &mdash; it is the single best thing you can do for accuracy.</span>';
    }
    if (c.warnings && c.warnings.length) {
      box.className = 'scale-status warn-box';
      box.innerHTML += '<br><span class="hint">' + c.warnings.map(escapeHtml).join(' ') + '</span>';
    }
  }

  function escapeHtml(t) {
    return String(t).replace(/[&<>"]/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
    });
  }

  // Image scale, plus the warning about gates too close together to time well.
  function updateReadout() {
    if (!gatesReady() || !state.procW || !scaleReady()) { el.scaleReadout.textContent = ''; return; }
    var sep = window.SpeedGeometry.gateSeparation(procShape('gateA'), procShape('gateB'));
    var d = state.calibration.meters;
    if (!(d > 0) || !(sep > 0)) { el.scaleReadout.textContent = ''; return; }
    var long = Math.max(state.procW, state.procH);
    var msg = 'Gates are ' + fmt(sep, 0) + ' pixels apart in the image (' +
      fmt(d / sep * 100, 1) + ' cm per pixel).';
    var cls = null;
    if (sep < 0.2 * long) {
      msg += ' That is quite close \u2014 move the gates further apart, or film ' +
        'from further back, for better timing resolution.';
      cls = 'bad';
    }
    setStatus(el.scaleReadout, msg, cls);
  }

  /* ------------------------------------------- the road, from the traffic */

  /*
   * A track's history, cleaned for vanishing-point fitting.
   *
   * Uses the centroid rather than the ground point: a vehicle's centroid also
   * travels a straight line parallel to the road, so it gives the same
   * vanishing point, but it is far smoother - the bottom of the box jitters as
   * the lowest corner of the silhouette switches from one end to the other.
   * Frames where the box touches the edge of the picture are dropped, since a
   * clipped box reports a false centre and bends the path.
   */
  function cleanPath(trail) {
    var out = [], m = 2;
    for (var i = 0; i < trail.length; i++) {
      var s = trail[i];
      if (s.bx !== undefined &&
          (s.bx <= m || s.by <= m ||
           s.bx + s.bw >= state.procW - m || s.by + s.bh >= state.procH - m)) continue;
      out.push({ x: s.x, y: s.y });
    }
    return out;
  }

  // Vehicles travel parallel to the road, so their paths converge on the road's
  // vanishing point. Collect finished paths and re-estimate as they accumulate.
  /*
   * Wheel contact patches, from the mask we already have.
   *
   * Two things come out of them, neither costing the user anything: the line
   * through a vehicle's two contact points runs along the road ON the road
   * surface, so it points at the road's vanishing point; and the distance
   * between them is a wheelbase - a known-ish length lying along the road,
   * which is exactly the shape of reference the calibration wants.
   */
  function harvestWheels(tracks, mask) {
    if (!mask || !window.Wheels) return;
    for (var i = 0; i < tracks.length; i++) {
      var tr = tracks[i];
      var c = window.Wheels.findContactPoints(mask, state.procW, state.procH,
        { x: tr.bx, y: tr.by, w: tr.bw, h: tr.bh });
      if (!c) continue;
      state.contactLines.push({ line: window.Wheels.contactLine(c), w: c.spanPx });
      // Keep the widest view of each vehicle's wheelbase: the least
      // foreshortened, so the best reference segment it will ever offer.
      var best = state.wheelRefs[tr.id];
      if (!best || c.spanPx > best.spanPx) {
        state.wheelRefs[tr.id] = { p1: c.front, p2: c.rear, spanPx: c.spanPx };
      }
    }
    if (state.contactLines.length > 1200) {
      state.contactLines.splice(0, state.contactLines.length - 1200);
    }
    if (state.contactLines.length >= 12 &&
        state.contactLines.length >= state.contactsAtLastVP + 8) {
      state.contactsAtLastVP = state.contactLines.length;
      var vp = window.Calibration.vanishingPointFromContacts(
        state.contactLines, state.procW, state.procH);
      if (vp.ok) {
        state.roadVP = vp;
        recomputeCalibration();
      }
    }
  }

  /*
   * With nothing marked at all, each vehicle's own wheelbase stands in for a
   * reference. Scaling each vehicle by its own would give every speed an
   * independent random error, which fattens the distribution and pushes the
   * 85th percentile up; so the median across the session sets ONE scale.
   */
  function recomputeAutoScale() {
    if (!gatesReady() || !state.roadVP || !state.procW) return null;
    var ids = Object.keys(state.wheelRefs);
    if (ids.length < 5) return null;
    var obs = [];
    for (var i = 0; i < ids.length; i++) {
      var ref = state.wheelRefs[ids[i]];
      var r = window.Calibration.solve({
        gateA: procShape('gateA'),
        gateB: procShape('gateB'),
        roadVanishingPoint: state.roadVP.vanishingPoint,
        reference: { p1: ref.p1, p2: ref.p2, meters: window.Calibration.FLEET_WHEELBASE_M }
      });
      if (r.ok && r.meters > 0 && isFinite(r.meters)) obs.push({ meters: r.meters });
    }
    return window.Calibration.autoScaleFromReferences(obs, {
      minObservations: 5,
      priorRelSigma: window.Calibration.FLEET_WHEELBASE_REL_SIGMA
    });
  }

  function harvestTrails(tracks, t) {
    var i;
    for (i = 0; i < tracks.length; i++) {
      var tr = tracks[i];
      state.liveTrails[tr.id] = { pts: cleanPath(tr.trail), lastT: t };
    }
    var ids = Object.keys(state.liveTrails);
    for (i = 0; i < ids.length; i++) {
      var entry = state.liveTrails[ids[i]];
      if (t - entry.lastT > 0.8) {                 // the vehicle has gone
        if (entry.pts.length >= 10) state.trails.push(entry.pts);
        delete state.liveTrails[ids[i]];
      }
    }
    if (state.trails.length > 120) state.trails.splice(0, state.trails.length - 120);

    // Only fall back to centroid paths if the wheels have not already supplied
    // a vanishing point: centroids float above the road and drift as the
    // silhouette turns, which bends the estimate.
    if (state.roadVP && state.roadVP.source === 'wheel contact points') return;
    if (state.trails.length >= 8 && state.trails.length >= state.trailsAtLastVP + 2) {
      state.trailsAtLastVP = state.trails.length;
      var vp2 = window.Calibration.vanishingPointFromTrails(
        state.trails, state.procW, state.procH);
      if (vp2.ok) {
        state.roadVP = vp2;
        if (state.scaleMode === 'reference') recomputeCalibration();
      }
    }
  }

  ['distance', 'distanceUnit', 'distanceSigma', 'limit', 'speedUnit', 'location',
    'labelAB', 'labelBA', 'observer', 'notes', 'refLength', 'refUnit'].forEach(function (k) {
    el[k].addEventListener('input', function () {
      el.sigmaUnit.textContent = el.distanceUnit.value === 'ft' ? 'feet' : 'metres';
      recomputeCalibration();
      updateReadout();
      el.btnStart.disabled = !gatesReady();
      saveSettings();
      if (state.measurements.length) renderResults();
    });
  });

  /* ----------------------------------------------- scale mode and presets */

  el.scaleModes.addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-scale-mode]');
    if (!b) return;
    state.scaleMode = b.getAttribute('data-scale-mode');
    Array.prototype.forEach.call(el.scaleModes.children, function (c) {
      c.classList.toggle('active', c === b);
    });
    el.scaleReference.hidden = state.scaleMode !== 'reference';
    el.scaleMeasured.hidden = state.scaleMode !== 'measured';
    recomputeCalibration();
    updateReadout();
    saveSettings();
  });

  (function initReferencePresets() {
    window.Calibration.REFERENCES.forEach(function (r) {
      var o = document.createElement('option');
      o.value = r.id;
      o.textContent = r.label + (r.meters ? ' \u2014 ' + fmt(r.meters / FT_TO_M, 1) + ' ft' : '');
      el.refPreset.appendChild(o);
    });
    el.refPreset.addEventListener('change', function () {
      var r = window.Calibration.REFERENCES.filter(function (x) {
        return x.id === el.refPreset.value;
      })[0];
      if (!r) return;
      if (r.meters) {
        el.refUnit.value = 'm';
        el.refLength.value = String(Math.round(r.meters * 1000) / 1000);
      }
      setStatus(el.refNote, (r.note || '') + (r.exact ? '' : ' Treat this as approximate.'));
      recomputeCalibration();
      saveSettings();
    });
  })();

  /* ------------------------------------------------------------- scrubbing */

  el.scrub.addEventListener('input', function () {
    if (state.running || !isFinite(el.video.duration) || !el.video.duration) return;
    el.video.currentTime = (+el.scrub.value / 1000) * el.video.duration;
    el.scrubLabel.textContent = fmt(el.video.currentTime, 1) + 's';
  });

  /* ------------------------------------------------------------ measuring */

  function startMeasuring() {
    if (!gatesReady()) return;
    var c = state.calibration;
    state.tracker = new window.MotionTracker(state.procW, state.procH);
    state.meter = new window.SpeedMeter({
      gateA: procShape('gateA'),
      gateB: procShape('gateB'),
      distanceMeters: c && c.meters > 0 ? c.meters : 0,
      distanceSigmaMeters: c && c.sigmaMeters !== undefined ? c.sigmaMeters : null
    });
    state.running = true;
    state.lastFrameT = null;
    state.rejected = 0;
    if (!state.sessionStart) state.sessionStart = Date.now();
    el.btnStart.hidden = true;
    el.btnStop.hidden = false;
    el.scrub.disabled = true;
    el.cardResults.hidden = false;
    setStatus(el.measureStatus, 'Measuring… keep the camera perfectly still. ' +
      'Moving it invalidates the gates.' + (scaleReady() ? ''
        : ' The scale is not set yet, so speeds will appear once it is.'));

    if (state.source === 'file') {
      el.video.playbackRate = parseFloat(el.rate.value) || 1;
      el.video.currentTime = 0;
    }
    var p = el.video.play();
    if (p && p.catch) p.catch(function () {});
    pump();
  }

  function stopMeasuring(why) {
    state.running = false;
    state.sessionEnd = Date.now();
    el.btnStart.hidden = false;
    el.btnStop.hidden = true;
    el.scrub.disabled = false;
    if (state.source === 'file') el.video.pause();
    setStatus(el.measureStatus, (why ? why + ' ' : '') +
      (state.measurements.length
        ? state.measurements.length + ' vehicles measured. Results are below.'
        : 'No vehicles measured. Check that the gates span the travelled lanes.'));
    renderResults();
  }

  var hasRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

  function pump() {
    if (!state.running) return;
    if (hasRVFC) {
      el.video.requestVideoFrameCallback(function (now, meta) {
        // mediaTime is the frame's exact presentation time on the media
        // timeline - far better than sampling currentTime from a rAF.
        processFrame(meta && meta.mediaTime !== undefined ? meta.mediaTime : el.video.currentTime);
        pump();
      });
    } else {
      requestAnimationFrame(function () {
        var t = el.video.currentTime;
        if (t !== state.lastFrameT) processFrame(t);
        pump();
      });
    }
  }

  function processFrame(t) {
    if (!state.running || !state.tracker) return;
    if (state.lastFrameT !== null && t <= state.lastFrameT) return; // duplicate or seek back
    state.lastFrameT = t;
    if (!el.video.videoWidth) return;

    workCtx.drawImage(el.video, 0, 0, state.procW, state.procH);
    var img;
    try {
      img = workCtx.getImageData(0, 0, state.procW, state.procH);
    } catch (e) {
      stopMeasuring('Cannot read frames from this video (browser security restriction).');
      return;
    }
    var res = state.tracker.updateFromImageData(img, t);
    state.lastResult = res;
    if (res.illuminationReset) {
      setStatus(el.measureStatus, 'Lighting changed sharply — re-learning the ' +
        'background. Measurements resume in a moment.');
    }
    if (window.__traceOn && window.__trace && window.__trace.length < 4000) {
      window.__trace.push({
        t: t, blobs: res.blobs.length, tracks: res.tracks.length,
        b: res.blobs.map(function (x) {
          return [Math.round(x.x), Math.round(x.y), Math.round(x.w), Math.round(x.h)];
        }),
        k: res.tracks.map(function (x) { return [x.id, Math.round(x.cx), Math.round(x.cy), x.hits]; })
      });
    }
    harvestWheels(res.tracks, res.mask);
    harvestTrails(res.tracks, t);
    var found = state.meter.update(res.tracks, t);
    for (var i = 0; i < found.length; i++) addMeasurement(found[i]);
    state.rejected = state.meter.rejected;
    el.liveFps.textContent = fmt(state.tracker.fps(), 0);
  }

  function addMeasurement(m) {
    state.measurements.push(m);
    if (m.pending) {
      // Timed but not yet scaled: hold it, and fill it in when the scale lands.
      el.liveSpeed.textContent = '—';
      el.liveSpeed.classList.remove('over');
      el.liveMeta.textContent = 'Timed, waiting for the scale · ' +
        state.measurements.length + ' vehicle' +
        (state.measurements.length === 1 ? '' : 's') + ' held';
      renderResults();
      return;
    }
    var s = speedOf(m), lim = parseFloat(el.limit.value);
    el.liveSpeed.textContent = fmt(s, 0);
    el.liveSpeed.classList.toggle('over', !!(lim > 0 && s > lim));
    var dirLabel = directionLabels()[m.direction] || m.direction;
    el.liveMeta.textContent = unitLabel() + ' · ' + dirLabel + ' · ±' +
      fmt(ciOf(m), 1) + ' · ' + m.confidence + ' confidence';
    state.flashes.push({ m: m, until: performance.now() + 2500 });
    renderResults();
  }

  el.btnStart.addEventListener('click', startMeasuring);
  el.btnStop.addEventListener('click', function () { stopMeasuring('Stopped.'); });

  /* -------------------------------------------------------------- drawing */

  function drawLoop() {
    drawOverlay();
    requestAnimationFrame(drawLoop);
  }

  function drawOverlay() {
    var w = el.overlay.width / (Math.min(2, window.devicePixelRatio || 1));
    var h = el.overlay.height / (Math.min(2, window.devicePixelRatio || 1));
    overlayCtx.clearRect(0, 0, w, h);

    if (el.chkMask.checked && state.lastResult && state.lastResult.mask) drawMask(w, h);
    drawShape('A', state.shapes.gateA, w, h, '#4dd4ac');
    drawShape('B', state.shapes.gateB, w, h, '#ff7ab6');
    if (state.scaleMode === 'reference') {
      drawShape('ref', state.shapes.ref, w, h, '#ffb454', true);
      drawShape('road 1', state.shapes.road1, w, h, '#8fb3ff', false, true);
      drawShape('road 2', state.shapes.road2, w, h, '#8fb3ff', false, true);
    }

    if (el.chkBoxes.checked && state.lastResult) {
      var sx = w / state.procW, sy = h / state.procH;
      overlayCtx.lineWidth = 2;
      overlayCtx.strokeStyle = 'rgba(255,180,84,0.9)';
      state.lastResult.tracks.forEach(function (tr) {
        overlayCtx.strokeRect(tr.bx * sx, tr.by * sy, tr.bw * sx, tr.bh * sy);
        if (tr.trail.length > 1) {
          overlayCtx.beginPath();
          overlayCtx.moveTo(tr.trail[0].x * sx, tr.trail[0].y * sy);
          for (var i = 1; i < tr.trail.length; i++) {
            overlayCtx.lineTo(tr.trail[i].x * sx, tr.trail[i].y * sy);
          }
          overlayCtx.strokeStyle = 'rgba(255,180,84,0.45)';
          overlayCtx.stroke();
          overlayCtx.strokeStyle = 'rgba(255,180,84,0.9)';
        }
      });
    }
    drawFlashes(w, h);
  }

  function drawMask(w, h) {
    var mask = state.lastResult.mask;
    var pw = state.procW, ph = state.procH;
    var img = overlayCtx.createImageData(pw, ph);
    for (var i = 0; i < mask.length; i++) {
      if (mask[i]) {
        img.data[i * 4] = 77; img.data[i * 4 + 1] = 212;
        img.data[i * 4 + 2] = 172; img.data[i * 4 + 3] = 110;
      }
    }
    // Round-trip through a small canvas so the mask scales to the overlay.
    var tmp = document.createElement('canvas');
    tmp.width = pw; tmp.height = ph;
    tmp.getContext('2d').putImageData(img, 0, 0);
    overlayCtx.imageSmoothingEnabled = false;
    overlayCtx.drawImage(tmp, 0, 0, w, h);
    overlayCtx.imageSmoothingEnabled = true;
  }

  function drawShape(name, pts, w, h, color, ticked, dashed) {
    if (!pts.length) return;
    overlayCtx.save();
    if (dashed) overlayCtx.setLineDash([7, 5]);
    overlayCtx.strokeStyle = color;
    overlayCtx.fillStyle = color;
    overlayCtx.lineWidth = 3;
    pts.forEach(function (p) {
      overlayCtx.beginPath();
      overlayCtx.arc(p.x * w, p.y * h, 5, 0, Math.PI * 2);
      overlayCtx.fill();
    });
    if (pts.length === 2) {
      var x0 = pts[0].x * w, y0 = pts[0].y * h, x1 = pts[1].x * w, y1 = pts[1].y * h;
      overlayCtx.beginPath();
      overlayCtx.moveTo(x0, y0);
      overlayCtx.lineTo(x1, y1);
      overlayCtx.stroke();
      if (ticked) {   // end caps, so a reference reads as a measured length
        var dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1;
        var nx = -dy / L * 8, ny = dx / L * 8;
        overlayCtx.setLineDash([]);
        [[x0, y0], [x1, y1]].forEach(function (pt) {
          overlayCtx.beginPath();
          overlayCtx.moveTo(pt[0] - nx, pt[1] - ny);
          overlayCtx.lineTo(pt[0] + nx, pt[1] + ny);
          overlayCtx.stroke();
        });
      }
      overlayCtx.setLineDash([]);
      overlayCtx.font = 'bold 14px system-ui, sans-serif';
      overlayCtx.fillText(name, (x0 + x1) / 2 + 8, (y0 + y1) / 2 - 8);
    }
    overlayCtx.restore();
  }

  function drawFlashes(w, h) {
    var now = performance.now();
    state.flashes = state.flashes.filter(function (f) { return f.until > now; });
    if (!state.flashes.length) return;
    overlayCtx.font = 'bold 16px system-ui, sans-serif';
    state.flashes.forEach(function (f, i) {
      var alpha = Math.min(1, (f.until - now) / 800);
      overlayCtx.fillStyle = 'rgba(255,255,255,' + alpha.toFixed(2) + ')';
      overlayCtx.fillText(fmt(speedOf(f.m), 0) + ' ' + unitLabel(), 10, 24 + i * 22);
    });
  }

  /* -------------------------------------------------------------- results */

  function directionLabels() {
    return {
      'A>B': el.labelAB.value.trim() || 'A → B',
      'B>A': el.labelBA.value.trim() || 'B → A'
    };
  }

  function currentStats() {
    return window.Analysis.summarize(state.measurements, {
      unit: unit(),
      limit: parseFloat(el.limit.value),
      directionLabels: directionLabels()
    });
  }

  function meta() {
    var start = state.sessionStart || Date.now();
    var end = state.sessionEnd || Date.now();
    var d = parseFloat(el.distance.value);
    var isFile = state.source === 'file';
    // For a recorded video the observation window is the video's own length,
    // not how long the analysis took (which changes with playback speed).
    var observedSeconds = (isFile && isFinite(el.video.duration) && el.video.duration > 0)
      ? el.video.duration
      : (end - start) / 1000;
    return {
      location: el.location.value.trim(),
      observer: el.observer.value.trim(),
      notes: el.notes.value.trim(),
      sessionStart: start,
      observedSeconds: Math.max(0, observedSeconds),
      isFile: isFile,
      distanceMeters: state.calibration ? state.calibration.meters : 0,
      distanceLabel: state.calibration && state.calibration.meters
        ? (Math.round(state.calibration.meters / FT_TO_M * 10) / 10) + ' ft'
        : ((isNaN(d) ? '?' : d) + ' ' + (el.distanceUnit.value === 'ft' ? 'ft' : 'm')),
      scaleSource: state.calibration ? state.calibration.source : 'not set',
      scaleRelSigma: state.calibration ? state.calibration.relSigma : null,
      directionLabels: directionLabels(),
      fps: state.tracker ? state.tracker.fps() : null,
      source: isFile ? ('recorded video (' + state.fileName + ')') : 'live camera',
      unit: unit()
    };
  }

  function statCard(k, v, note, headline) {
    var d = document.createElement('div');
    d.className = 'stat' + (headline ? ' headline' : '');
    var kk = document.createElement('div'); kk.className = 'k'; kk.textContent = k;
    var vv = document.createElement('div'); vv.className = 'v'; vv.textContent = v;
    d.appendChild(kk); d.appendChild(vv);
    if (note) { var nn = document.createElement('div'); nn.className = 'n'; nn.textContent = note; d.appendChild(nn); }
    return d;
  }

  function renderResults() {
    if (state.measurements.length) el.cardResults.hidden = false;
    renderPlausibility();
    var s = currentStats();
    var u = unitLabel();
    el.liveCount.textContent = String(s.n);
    el.liveP85.textContent = s.p85 === null ? '—' : fmt(s.p85, 0);

    el.stats.textContent = '';
    if (!s.n) {
      el.stats.appendChild(statCard('Vehicles', '0', 'nothing measured yet'));
    } else {
      el.stats.appendChild(statCard('85th percentile', fmt(s.p85) + ' ' + u,
        s.limit ? 'posted ' + s.limit + ' ' + u : 'the engineering benchmark', true));
      el.stats.appendChild(statCard('Median', fmt(s.median) + ' ' + u, 'half are faster'));
      el.stats.appendChild(statCard('Fastest', fmt(s.max) + ' ' + u, 'single vehicle'));
      if (s.limit) {
        el.stats.appendChild(statCard('Over limit',
          Math.round(s.overShare * 100) + '%', s.over + ' of ' + s.n + ' vehicles'));
        el.stats.appendChild(statCard('Over by ' + s.overBy + '+',
          Math.round(s.wayOverShare * 100) + '%', s.wayOver + ' of ' + s.n + ' vehicles'));
      }
      el.stats.appendChild(statCard('Vehicles', String(s.n),
        s.pace ? s.paceWidth + '-' + u + ' pace ' + fmt(s.pace.from, 0) + '–' + fmt(s.pace.to, 0) : ''));
      el.stats.appendChild(statCard('Typical ±', fmt(s.typicalCi95) + ' ' + u, '95% confidence'));
      if (state.rejected) {
        el.stats.appendChild(statCard('Discarded', String(state.rejected), 'implausible passes'));
      }
    }
    renderLog();
  }

  /*
   * A free sanity check: given the current scale, how long is the typical
   * vehicle? If the answer is 12 m or 1.5 m, the distance is wrong - far better
   * to learn that here than at a council meeting.
   */
  function renderPlausibility() {
    var lengths = state.measurements.map(function (m) { return m.estLengthM; })
      .filter(function (v) { return v !== null && v !== undefined; });
    var r = window.Calibration.plausibilityCheck(lengths);
    if (r.ok || !r.enough) { el.plausibility.hidden = true; return; }
    el.plausibility.hidden = false;
    el.plausibility.className = 'scale-status bad';
    el.plausibility.textContent = 'Check the scale: ' + r.message;
  }

  function renderLog() {
    el.logBody.textContent = '';
    var labels = directionLabels();
    var rows = state.measurements.slice().reverse();
    rows.forEach(function (m) {
      var tr = document.createElement('tr');
      if (m.confidence === 'low') tr.className = 'low';
      function cell(text, cls) {
        var td = document.createElement('td');
        if (cls) td.className = cls;
        td.textContent = text;
        tr.appendChild(td);
        return td;
      }
      cell(String(m.seq));
      cell(fmt(m.videoTime, 1) + 's');
      cell(labels[m.direction] || m.direction);
      cell(m.pending ? 'awaiting scale' : fmt(speedOf(m)) + ' ' + unitLabel(), 'num');
      cell(m.pending ? '—' : '±' + fmt(ciOf(m)), 'num');
      var conf = document.createElement('td');
      var pill = document.createElement('span');
      pill.className = 'pill ' + m.confidence;
      pill.textContent = m.confidence;
      conf.appendChild(pill);
      tr.appendChild(conf);
      cell(m.estLengthM === null ? '—' : fmt(m.estLengthM, 1) + ' m', 'num');
      cell((m.estClass || '') + (m.flags.length ? ' · ' + m.flags.join(', ') : ''));
      var last = document.createElement('td');
      var x = document.createElement('button');
      x.className = 'x';
      x.title = 'Remove this measurement';
      x.setAttribute('aria-label', 'Remove measurement ' + m.seq);
      x.textContent = '×';
      x.addEventListener('click', function () {
        state.measurements = state.measurements.filter(function (o) { return o !== m; });
        renderResults();
      });
      last.appendChild(x);
      tr.appendChild(last);
      el.logBody.appendChild(tr);
    });
  }

  /* -------------------------------------------------------------- exports */

  el.btnCsv.addEventListener('click', function () {
    if (!state.measurements.length) return;
    download('speed-data-' + slug(el.location.value) + '.csv',
      window.Analysis.toCSV(state.measurements, meta()), 'text/csv');
    setStatus(el.exportStatus, 'CSV downloaded.');
  });

  el.btnReportDl.addEventListener('click', function () {
    download('speed-report-' + slug(el.location.value) + '.md',
      window.Analysis.toMarkdown(state.measurements, currentStats(), meta()), 'text/markdown');
    setStatus(el.exportStatus, 'Report downloaded.');
  });

  el.btnJson.addEventListener('click', function () {
    var payload = {
      tool: 'Neighborhood Speed Monitor',
      method: 'two-gate video timing',
      meta: meta(),
      gatesNormalised: state.shapes,
      stats: currentStats(),
      measurements: state.measurements,
      rejected: state.rejected
    };
    download('speed-session-' + slug(el.location.value) + '.json',
      JSON.stringify(payload, null, 2), 'application/json');
    setStatus(el.exportStatus, 'Session downloaded. It contains no images or video.');
  });

  el.btnReport.addEventListener('click', function () {
    var text = window.Analysis.toMarkdown(state.measurements, currentStats(), meta());
    window.__lastReport = text; // also handy when scripting the page in tests
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        setStatus(el.exportStatus, 'Report copied to the clipboard.');
      }).catch(function () { fallbackCopy(text); });
    } else fallbackCopy(text);
  });

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    setStatus(el.exportStatus, ok ? 'Report copied to the clipboard.'
      : 'Could not copy automatically — use "Download report" instead.', ok ? null : 'bad');
  }

  el.btnReset.addEventListener('click', function () {
    if (state.measurements.length &&
        !confirm('Delete all ' + state.measurements.length + ' measurements in this session?')) return;
    state.measurements = [];
    state.rejected = 0;
    state.sessionStart = state.sessionEnd = null;
    if (state.meter) state.meter.reset();
    el.liveSpeed.textContent = '—';
    el.liveSpeed.classList.remove('over');
    el.liveMeta.textContent = 'Waiting for the first vehicle…';
    setStatus(el.exportStatus, 'Measurements cleared.');
    renderResults();
  });

  /* ------------------------------------------------------------ self test */

  el.btnSelfTest.addEventListener('click', function () {
    var out = el.selfTestOut;
    out.hidden = false;
    out.textContent = 'Running…';
    // Yield once so the "Running" text paints before the synchronous sweep.
    setTimeout(function () {
      var res = window.SelfTest.run([15, 25, 35, 45]);
      out.textContent = '';
      var h = document.createElement('p');
      h.innerHTML = '<strong>Accuracy check against a simulated street</strong>';
      out.appendChild(h);

      var p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'A synthetic vehicle is driven past two gates at known ' +
        'speeds and put through exactly the same detection, tracking and timing ' +
        'code your video uses. This checks the software, not your tape measure ' +
        'or camera angle.';
      out.appendChild(p);

      var table = document.createElement('table');
      table.innerHTML = '<thead><tr><th>True speed</th><th class="num">Measured</th>' +
        '<th class="num">Error</th><th class="num">Frames</th></tr></thead>';
      var tb = document.createElement('tbody');
      res.rows.forEach(function (r) {
        var tr = document.createElement('tr');
        function td(t, cls) {
          var c = document.createElement('td');
          if (cls) c.className = cls;
          c.textContent = t;
          tr.appendChild(c);
        }
        td(r.truthMph + ' mph');
        td(r.measuredMph === null ? 'not detected' : fmt(r.measuredMph, 2) + ' mph', 'num');
        td(r.errorPct === null ? '—' : (r.errorPct >= 0 ? '+' : '') + fmt(r.errorPct, 2) + '%', 'num');
        td(r.frames === null ? '—' : fmt(r.frames, 0), 'num');
        tb.appendChild(tr);
      });
      table.appendChild(tb);
      out.appendChild(table);

      var verdict = document.createElement('p');
      var good = res.worstErrorPct < 2;
      verdict.className = good ? 'ok' : 'bad';
      verdict.textContent = good
        ? 'Passed — worst error ' + fmt(res.worstErrorPct, 2) +
          '%, well inside the tool’s stated uncertainty.'
        : 'Unexpected: worst error ' + fmt(res.worstErrorPct, 2) +
          '%. Please report this along with your browser version.';
      out.appendChild(verdict);

      if (res.preview) {
        var cv = document.createElement('canvas');
        cv.width = res.preview.width;
        cv.height = res.preview.height;
        var cx = cv.getContext('2d');
        var img = cx.createImageData(cv.width, cv.height);
        for (var i = 0; i < res.preview.frame.length; i++) {
          var v = res.preview.frame[i];
          img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
          img.data[i * 4 + 3] = 255;
        }
        cx.putImageData(img, 0, 0);
        var S = window.SelfTest.SCENE;
        [[S.gateAx, '#4dd4ac'], [S.gateBx, '#ff7ab6']].forEach(function (g) {
          cx.strokeStyle = g[1];
          cx.lineWidth = 2;
          cx.beginPath();
          cx.moveTo(g[0], S.gateTop);
          cx.lineTo(g[0], S.gateBottom);
          cx.stroke();
        });
        var cap = document.createElement('p');
        cap.className = 'hint';
        cap.textContent = 'The simulated scene, with its two gates.';
        out.appendChild(cv);
        out.appendChild(cap);
      }
    }, 30);
  });

  /* ----------------------------------------------------------------- init */

  el.btnCamera.addEventListener('click', useCamera);
  el.fileInput.addEventListener('change', function (ev) { useFile(ev.target.files[0]); });

  // Debug hook for the automated tests; harmless in normal use.
  window.__dbg = function () { return state.measurements; };
  // Test hooks. The per-frame trace stays off unless a harness turns it on:
  // it is a diagnostic, not something to accumulate during a real session.
  window.__trace = [];
  window.__traceOn = false;
  window.__trailsDump = function () { return state.trails; };
  window.__cal = function () {
    return {
      calibration: state.calibration,
      shapes: {
        gateA: state.shapes.gateA.length, gateB: state.shapes.gateB.length,
        ref: state.shapes.ref.length,
        road1: state.shapes.road1.length, road2: state.shapes.road2.length
      },
      refMeters: refMeters(),
      trails: state.trails.length,
      contactLines: state.contactLines.length,
      wheelRefs: Object.keys(state.wheelRefs).length,
      autoScale: state.autoScale,
      vp: state.roadVP ? { source: state.roadVP.source || 'vehicle paths',
                           used: state.roadVP.tracksUsed || state.roadVP.linesUsed,
                           residual: state.roadVP.residual } : null
    };
  };

  loadSettings();
  setActive('gateA');
  el.sigmaUnit.textContent = el.distanceUnit.value === 'ft' ? 'feet' : 'metres';
  refreshGateUI();
  fitStage();
})();
