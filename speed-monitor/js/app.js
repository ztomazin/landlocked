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
    gates: { A: [], B: [] }, // normalised [0..1] video coordinates
    active: 'A',
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
    return state.gates.A.length === 2 && state.gates.B.length === 2;
  }

  function procGate(name) {
    return state.gates[name].map(function (p) {
      return { x: p.x * state.procW, y: p.y * state.procH };
    });
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
    'speedUnit', 'location', 'labelAB', 'labelBA', 'observer'];

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
    updateScale();
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
    var g = state.gates[state.active];
    if (g.length >= 2) g.length = 0; // a third tap restarts this gate
    g.push({ x: nx, y: ny });
    if (g.length === 2 && state.active === 'A' && state.gates.B.length < 2) setActive('B');
    refreshGateUI();
  });

  function setActive(name) {
    state.active = name;
    el.btnGateA.classList.toggle('active', name === 'A');
    el.btnGateB.classList.toggle('active', name === 'B');
  }

  function refreshGateUI() {
    el.gaCount.textContent = state.gates.A.length + '/2';
    el.gbCount.textContent = state.gates.B.length + '/2';
    var g = state.gates[state.active];
    var msg;
    if (gatesReady()) msg = 'Both gates placed. Tap a gate button to redraw one.';
    else if (g.length === 0) msg = 'Placing Gate ' + state.active + ': tap the first point, at one kerb.';
    else msg = 'Placing Gate ' + state.active + ': tap the second point, at the far kerb.';
    setStatus(el.gateStatus, msg);
    updateScale();
    el.btnStart.disabled = !(gatesReady() && distanceMeters() > 0);
  }

  el.btnGateA.addEventListener('click', function () { setActive('A'); refreshGateUI(); });
  el.btnGateB.addEventListener('click', function () { setActive('B'); refreshGateUI(); });
  el.btnUndo.addEventListener('click', function () {
    var g = state.gates[state.active];
    if (g.length) g.pop();
    else if (state.active === 'B') { setActive('A'); state.gates.A.pop(); }
    refreshGateUI();
  });
  el.btnClear.addEventListener('click', function () {
    state.gates.A = []; state.gates.B = [];
    setActive('A'); refreshGateUI();
  });

  // Reports the image scale and warns when the gates are too close together to
  // time accurately, which is the most common setup mistake.
  function updateScale() {
    if (!gatesReady() || !state.procW) { el.scaleReadout.textContent = ''; return; }
    var sep = window.SpeedGeometry.gateSeparation(procGate('A'), procGate('B'));
    var d = distanceMeters();
    if (!(d > 0) || !(sep > 0)) { el.scaleReadout.textContent = ''; return; }
    var long = Math.max(state.procW, state.procH);
    var msg = 'Gates are ' + fmt(sep, 0) + ' pixels apart in the image (' +
      fmt(d / sep * 100, 1) + ' cm per pixel).';
    var cls = null;
    if (sep < 0.2 * long) {
      msg += ' That is quite close — move the gates further apart, or film ' +
        'from further back, for better timing resolution.';
      cls = 'bad';
    }
    setStatus(el.scaleReadout, msg, cls);
  }

  ['distance', 'distanceUnit', 'distanceSigma', 'limit', 'speedUnit', 'location',
    'labelAB', 'labelBA', 'observer', 'notes'].forEach(function (k) {
    el[k].addEventListener('input', function () {
      el.sigmaUnit.textContent = el.distanceUnit.value === 'ft' ? 'feet' : 'metres';
      updateScale();
      el.btnStart.disabled = !(gatesReady() && distanceMeters() > 0);
      saveSettings();
      if (state.measurements.length) renderResults();
    });
  });

  /* ------------------------------------------------------------- scrubbing */

  el.scrub.addEventListener('input', function () {
    if (state.running || !isFinite(el.video.duration) || !el.video.duration) return;
    el.video.currentTime = (+el.scrub.value / 1000) * el.video.duration;
    el.scrubLabel.textContent = fmt(el.video.currentTime, 1) + 's';
  });

  /* ------------------------------------------------------------ measuring */

  function startMeasuring() {
    if (!gatesReady() || !(distanceMeters() > 0)) return;
    state.tracker = new window.MotionTracker(state.procW, state.procH);
    state.meter = new window.SpeedMeter({
      gateA: procGate('A'),
      gateB: procGate('B'),
      distanceMeters: distanceMeters(),
      distanceSigmaMeters: distanceSigmaMeters()
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
      'Moving it invalidates the gates.');

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
    var found = state.meter.update(res.tracks, t);
    for (var i = 0; i < found.length; i++) addMeasurement(found[i]);
    state.rejected = state.meter.rejected;
    el.liveFps.textContent = fmt(state.tracker.fps(), 0);
  }

  function addMeasurement(m) {
    state.measurements.push(m);
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
    drawGate('A', state.gates.A, w, h);
    drawGate('B', state.gates.B, w, h);

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

  function drawGate(name, pts, w, h) {
    if (!pts.length) return;
    var color = name === 'A' ? '#4dd4ac' : '#ff7ab6';
    overlayCtx.strokeStyle = color;
    overlayCtx.fillStyle = color;
    overlayCtx.lineWidth = 3;
    pts.forEach(function (p) {
      overlayCtx.beginPath();
      overlayCtx.arc(p.x * w, p.y * h, 5, 0, Math.PI * 2);
      overlayCtx.fill();
    });
    if (pts.length === 2) {
      overlayCtx.beginPath();
      overlayCtx.moveTo(pts[0].x * w, pts[0].y * h);
      overlayCtx.lineTo(pts[1].x * w, pts[1].y * h);
      overlayCtx.stroke();
      var mx = (pts[0].x + pts[1].x) / 2 * w, my = (pts[0].y + pts[1].y) / 2 * h;
      overlayCtx.font = 'bold 14px system-ui, sans-serif';
      overlayCtx.fillText(name, mx + 8, my - 8);
    }
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
      distanceMeters: distanceMeters(),
      distanceLabel: (isNaN(d) ? '?' : d) + ' ' + (el.distanceUnit.value === 'ft' ? 'ft' : 'm'),
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
      cell(fmt(speedOf(m)) + ' ' + unitLabel(), 'num');
      cell('±' + fmt(ciOf(m)), 'num');
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
      gatesNormalised: state.gates,
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

  loadSettings();
  el.sigmaUnit.textContent = el.distanceUnit.value === 'ft' ? 'feet' : 'metres';
  refreshGateUI();
  fitStage();
})();
