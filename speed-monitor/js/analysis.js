/*
 * analysis.js - session statistics and exports.
 *
 * The statistics here are deliberately the ones traffic engineers already use,
 * so that a citizen report speaks the same language as an official speed study:
 * the 85th percentile speed, the 10mph pace, and compliance with the posted
 * limit.
 */
(function (root) {
  'use strict';

  function percentile(sorted, p) {
    if (!sorted.length) return null;
    if (sorted.length === 1) return sorted[0];
    var idx = (sorted.length - 1) * p;
    var lo = Math.floor(idx), hi = Math.ceil(idx);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }

  // The 10mph-wide band containing the most vehicles. Traffic studies quote the
  // "pace" alongside the percentiles because a tight pace means consistent
  // behaviour, while a wide spread is itself a safety problem.
  function pace(sorted, width) {
    if (!sorted.length) return null;
    width = width || 10;
    var best = { from: sorted[0], to: sorted[0] + width, count: 0 };
    for (var i = 0; i < sorted.length; i++) {
      var from = sorted[i], count = 0;
      for (var j = i; j < sorted.length && sorted[j] < from + width; j++) count++;
      if (count > best.count) best = { from: from, to: from + width, count: count };
    }
    best.share = best.count / sorted.length;
    return best;
  }

  function mean(values) {
    if (!values.length) return null;
    var s = 0;
    for (var i = 0; i < values.length; i++) s += values[i];
    return s / values.length;
  }

  /*
   * measurements: array from SpeedMeter
   * options: { limit, unit: 'mph'|'kph', directionLabels: {'A>B','B>A'},
   *            excludeFlagged: bool }
   */
  function summarize(measurements, options) {
    var o = options || {};
    var unit = o.unit === 'kph' ? 'kph' : 'mph';
    var key = unit === 'kph' ? 'speedKph' : 'speedMph';
    var rows = measurements.filter(function (m) {
      if (o.excludeFlagged && m.confidence === 'low') return false;
      return true;
    });
    var speeds = rows.map(function (m) { return m[key]; });
    var sorted = speeds.slice().sort(function (a, b) { return a - b; });
    var limit = typeof o.limit === 'number' && o.limit > 0 ? o.limit : null;
    var paceWidth = unit === 'kph' ? 16 : 10;

    function countWhere(fn) { return sorted.filter(fn).length; }

    var over = limit === null ? null : countWhere(function (s) { return s > limit; });
    var overBy = unit === 'kph' ? 16 : 10;
    var wayOver = limit === null ? null : countWhere(function (s) { return s > limit + overBy; });

    var heavy = rows.filter(function (m) {
      return m.estClass === 'light-truck' || m.estClass === 'heavy-vehicle';
    }).length;

    var byDirection = {};
    ['A>B', 'B>A'].forEach(function (dir) {
      var ds = rows.filter(function (m) { return m.direction === dir; })
                   .map(function (m) { return m[key]; })
                   .sort(function (a, b) { return a - b; });
      if (!ds.length) return;
      byDirection[dir] = {
        label: (o.directionLabels && o.directionLabels[dir]) || dir,
        n: ds.length,
        mean: mean(ds),
        median: percentile(ds, 0.5),
        p85: percentile(ds, 0.85),
        max: ds[ds.length - 1]
      };
    });

    // Typical measurement uncertainty, carried through to the summary so the
    // headline number is never quoted more precisely than it is known.
    var typicalCi = mean(rows.map(function (m) {
      return unit === 'kph' ? m.ci95Kph : m.ci95Mph;
    }));

    return {
      unit: unit,
      n: rows.length,
      excluded: measurements.length - rows.length,
      limit: limit,
      mean: mean(sorted),
      median: percentile(sorted, 0.5),
      p85: percentile(sorted, 0.85),
      p95: percentile(sorted, 0.95),
      min: sorted.length ? sorted[0] : null,
      max: sorted.length ? sorted[sorted.length - 1] : null,
      pace: pace(sorted, paceWidth),
      paceWidth: paceWidth,
      over: over,
      overShare: over === null ? null : (sorted.length ? over / sorted.length : 0),
      wayOver: wayOver,
      wayOverShare: wayOver === null ? null : (sorted.length ? wayOver / sorted.length : 0),
      overBy: overBy,
      heavy: heavy,
      byDirection: byDirection,
      typicalCi95: typicalCi,
      confidenceCounts: {
        high: rows.filter(function (m) { return m.confidence === 'high'; }).length,
        medium: rows.filter(function (m) { return m.confidence === 'medium'; }).length,
        low: rows.filter(function (m) { return m.confidence === 'low'; }).length
      }
    };
  }

  function csvCell(v) {
    if (v === null || v === undefined) return '';
    var s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function round(v, places) {
    if (v === null || v === undefined || isNaN(v)) return null;
    var f = Math.pow(10, places === undefined ? 1 : places);
    return Math.round(v * f) / f;
  }

  function toCSV(measurements, meta) {
    var m = meta || {};
    var labels = m.directionLabels || {};
    var head = [
      'seq', 'wall_clock', 'video_time_s', 'direction', 'direction_label',
      'speed_mph', 'speed_kph', 'ci95_mph', 'confidence', 'frames_between_gates',
      'est_length_m', 'est_class', 'flags'
    ];
    var lines = [head.join(',')];
    measurements.forEach(function (r) {
      lines.push([
        r.seq, r.wallClock, round(r.videoTime, 3), r.direction,
        labels[r.direction] || '',
        round(r.speedMph, 1), round(r.speedKph, 1), round(r.ci95Mph, 1),
        r.confidence, round(r.frames, 1),
        round(r.estLengthM, 1), r.estClass || '',
        r.flags.join(' ')
      ].map(csvCell).join(','));
    });
    return lines.join('\n') + '\n';
  }

  // "0 minutes" for a short session reads as an error, and hours are clearer
  // than "127 minutes" for a long one.
  function formatDuration(seconds) {
    if (!(seconds > 0)) return null;
    if (seconds < 90) return Math.round(seconds) + ' seconds';
    var mins = seconds / 60;
    if (mins < 90) return (mins < 10 ? round(mins, 1) : Math.round(mins)) + ' minutes';
    return round(mins / 60, 1) + ' hours';
  }

  function fmt(v, places) {
    var r = round(v, places === undefined ? 1 : places);
    return r === null ? 'n/a' : String(r);
  }

  function pct(share) {
    return share === null || share === undefined ? 'n/a' : Math.round(share * 100) + '%';
  }

  /*
   * A report a neighbour can hand to a council member or a traffic engineer.
   * It states the method and the limitations up front, because a citizen report
   * that overstates its precision is easy to dismiss.
   */
  function toMarkdown(measurements, stats, meta) {
    var m = meta || {};
    var u = stats.unit;
    var L = [];
    var when = m.sessionStart ? new Date(m.sessionStart) : new Date();

    L.push('# Neighborhood speed screening report');
    L.push('');
    L.push('- **Location:** ' + (m.location || '_not recorded_'));
    // For an uploaded video the session date is when it was analysed, which is
    // not necessarily when it was filmed. Say which one this is.
    L.push('- **' + (m.isFile ? 'Analysed' : 'Observed') + ':** ' + when.toLocaleString());
    L.push('- **Observation time:** ' + (formatDuration(m.observedSeconds) || '_not recorded_'));
    L.push('- **Source:** ' + (m.source || '_not recorded_'));
    L.push('- **Observer:** ' + (m.observer || '_not recorded_'));
    L.push('- **Posted speed limit:** ' + (stats.limit ? stats.limit + ' ' + u : '_not recorded_'));
    L.push('- **Vehicles measured:** ' + stats.n);
    L.push('- **Method:** two-gate video timing, ' +
      (m.distanceLabel || fmt(m.distanceMeters, 2) + ' m') + ' between gates' +
      (m.fps ? ', ' + fmt(m.fps, 0) + ' fps video' : ''));
    L.push('');

    L.push('## Headline findings');
    L.push('');
    if (stats.n === 0) {
      L.push('No vehicles were measured in this session.');
      return L.join('\n') + '\n';
    }
    L.push('- **85th percentile speed: ' + fmt(stats.p85) + ' ' + u + '**' +
      (stats.limit ? ' (posted limit ' + stats.limit + ' ' + u + ')' : ''));
    L.push('- Median speed: ' + fmt(stats.median) + ' ' + u);
    L.push('- Fastest vehicle recorded: ' + fmt(stats.max) + ' ' + u);
    if (stats.limit) {
      L.push('- Vehicles over the posted limit: ' + stats.over + ' of ' + stats.n +
        ' (' + pct(stats.overShare) + ')');
      L.push('- Vehicles more than ' + stats.overBy + ' ' + u + ' over the limit: ' +
        stats.wayOver + ' of ' + stats.n + ' (' + pct(stats.wayOverShare) + ')');
    }
    if (stats.pace) {
      L.push('- ' + stats.paceWidth + ' ' + u + ' pace: ' + fmt(stats.pace.from) +
        '-' + fmt(stats.pace.to) + ' ' + u + ' (' + pct(stats.pace.share) + ' of vehicles)');
    }
    L.push('- Typical measurement uncertainty: +/- ' + fmt(stats.typicalCi95) + ' ' + u + ' (95% confidence)');
    L.push('');
    L.push('The 85th percentile speed - the speed at or below which 85% of ' +
      'drivers travel - is the figure traffic engineers normally use when ' +
      'evaluating a speed limit or a traffic calming request.');
    L.push('');

    L.push('## Speed distribution');
    L.push('');
    L.push('| Statistic | Value (' + u + ') |');
    L.push('| --- | --- |');
    [['Slowest', stats.min], ['Mean', stats.mean], ['Median (50th pct)', stats.median],
     ['85th percentile', stats.p85], ['95th percentile', stats.p95], ['Fastest', stats.max]
    ].forEach(function (r) { L.push('| ' + r[0] + ' | ' + fmt(r[1]) + ' |'); });
    L.push('');

    var dirs = Object.keys(stats.byDirection);
    if (dirs.length) {
      L.push('## By direction of travel');
      L.push('');
      L.push('| Direction | Vehicles | Median | 85th pct | Fastest |');
      L.push('| --- | --- | --- | --- | --- |');
      dirs.forEach(function (d) {
        var s = stats.byDirection[d];
        L.push('| ' + s.label + ' | ' + s.n + ' | ' + fmt(s.median) + ' | ' +
          fmt(s.p85) + ' | ' + fmt(s.max) + ' |');
      });
      L.push('');
    }

    if (stats.heavy) {
      L.push('Approximately ' + stats.heavy + ' of the ' + stats.n +
        ' measured vehicles were estimated to be trucks or other large ' +
        'vehicles (rough estimate from apparent vehicle length).');
      L.push('');
    }

    L.push('## How these numbers were produced');
    L.push('');
    L.push('Two reference lines were marked across the roadway on a video of ' +
      'the street, and the ground distance between them was measured as ' +
      (m.distanceLabel || fmt(m.distanceMeters, 2) + ' m') + '. Software timed ' +
      'each passing vehicle between the two lines and divided distance by time. ' +
      'Crossing instants are interpolated between video frames, so the timing ' +
      'resolution is finer than one frame.');
    L.push('');
    L.push('## Limitations (please read)');
    L.push('');
    L.push('- This is a **screening study by a resident, not an enforcement ' +
      'measurement and not a certified engineering study.** It is offered as ' +
      'evidence that a formal study is warranted.');
    L.push('- Speeds are not tied to any individual driver or vehicle. No ' +
      'license plates, faces, or video were recorded - the software processes ' +
      'frames in memory and stores only the numbers in this report.');
    L.push('- Accuracy depends most on the measured distance between the two ' +
      'reference lines. The uncertainty quoted above accounts for distance ' +
      'error, video frame rate and viewing geometry.');
    L.push('- Vehicles that were obscured, that changed speed between the two ' +
      'lines, or that passed while another vehicle overlapped them may be less ' +
      'accurate. Measurements flagged as low confidence ' +
      (stats.excluded ? 'were excluded (' + stats.excluded + ' excluded).'
                      : 'are marked in the attached data.'));
    L.push('- The sample covers only the observation period above, which may ' +
      'not represent other times of day.');
    L.push('');

    L.push('## Request');
    L.push('');
    L.push('Based on this screening data, we ask the city to:');
    L.push('');
    L.push('1. Conduct an official speed study on this block, including a ' +
      '24-hour or multi-day count.');
    L.push('2. Evaluate this street for traffic calming measures under the ' +
      'city\'s existing program.');
    L.push('3. Share the results of that study with residents of the street.');
    L.push('');
    if (m.notes) {
      L.push('## Additional notes from the observer');
      L.push('');
      L.push(m.notes);
      L.push('');
    }
    L.push('_Per-vehicle data is available as a CSV file alongside this report._');
    return L.join('\n') + '\n';
  }

  root.Analysis = {
    percentile: percentile,
    pace: pace,
    mean: mean,
    summarize: summarize,
    toCSV: toCSV,
    toMarkdown: toMarkdown,
    formatDuration: formatDuration,
    round: round
  };
})(typeof module !== 'undefined' && module.exports ? module.exports : this);
