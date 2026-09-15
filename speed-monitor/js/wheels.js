/*
 * wheels.js - find where a vehicle's tyres touch the road.
 *
 * Why bother: everything hard about this tool comes back to needing points that
 * lie on the ROAD PLANE. A blob's centroid floats above it and drifts as the
 * silhouette turns with the viewing angle, which is what bends the estimated
 * road direction. Tyre contact patches are on the plane by definition.
 *
 * Two things fall out of finding them, and both are free of the user:
 *
 *   1. The line through a vehicle's front and rear contact points runs along
 *      the road, on the road surface. Every frame of every vehicle therefore
 *      contributes one line through the road's vanishing point.
 *   2. The distance between those points is the wheelbase - a known-ish length
 *      lying along the road, which is exactly the shape of reference the
 *      calibration wants.
 *
 * Method: the silhouette's lower outline. A vehicle's body sits ~0.2-0.3m clear
 * of the tarmac, so only the tyres reach the bottom of the silhouette; the
 * outline dips at each wheel and lifts between them. Reading that outline needs
 * no gradients, no circle fitting and no model - just the mask already computed
 * for tracking.
 */
(function (root) {
  'use strict';

  var DEFAULTS = {
    depthTolFrac: 0.07,   // how close to the lowest row still counts as touching
    minGroupFrac: 0.03,   // narrowest run of touching columns worth keeping
    maxGroupFrac: 0.34,   // a wheel is small next to the whole vehicle
    minSpanFrac: 0.30,    // wheelbase as a fraction of the silhouette's width
    maxSpanFrac: 0.92,
    minAspect: 1.4,       // side-on vehicles only; square blobs are not vehicles
    minWidthPx: 24
  };

  /*
   * mask: Uint8Array foreground mask, w x h
   * box:  { x, y, w, h } bounding box of one tracked blob, in the same pixels
   *
   * Returns { front, rear, spanPx, groups } in absolute mask pixels, or null.
   * "front" and "rear" are simply the leading and trailing contact points in x;
   * which is which does not matter, only the line and the distance between them.
   */
  function findContactPoints(mask, w, h, box, options) {
    var o = {};
    for (var k in DEFAULTS) o[k] = DEFAULTS[k];
    if (options) for (var k2 in options) o[k2] = options[k2];

    if (!box || box.w < o.minWidthPx || box.h < 4) return null;
    if (box.w / box.h < o.minAspect) return null;

    // Lowest foreground row in each column: the silhouette's lower outline.
    var bottom = new Int32Array(box.w);
    var deepest = -1, i, x, y;
    for (i = 0; i < box.w; i++) {
      x = box.x + i;
      var low = -1;
      if (x >= 0 && x < w) {
        for (y = Math.min(h - 1, box.y + box.h - 1); y >= Math.max(0, box.y); y--) {
          if (mask[y * w + x]) { low = y; break; }
        }
      }
      bottom[i] = low;
      if (low > deepest) deepest = low;
    }
    if (deepest < 0) return null;

    // Columns that reach (nearly) the lowest row are touching the road.
    var tol = Math.max(1, Math.round(box.h * o.depthTolFrac));
    var minGroup = Math.max(1, Math.round(box.w * o.minGroupFrac));
    var maxGroup = Math.round(box.w * o.maxGroupFrac);
    var groups = [], cur = null;
    for (i = 0; i < box.w; i++) {
      if (bottom[i] >= 0 && bottom[i] >= deepest - tol) {
        if (!cur) cur = { i0: i, i1: i, sx: 0, sy: 0, n: 0 };
        cur.i1 = i; cur.sx += i; cur.sy += bottom[i]; cur.n++;
      } else if (cur) {
        if (cur.n >= minGroup && cur.n <= maxGroup) groups.push(cur);
        cur = null;
      }
    }
    if (cur && cur.n >= minGroup && cur.n <= maxGroup) groups.push(cur);

    // A vehicle standing on two wheels gives two separated runs. One run means
    // the outline is flat - a shadow filling the gap, or a blob that is not a
    // side-on vehicle - and is not usable.
    if (groups.length < 2) return null;

    var first = groups[0], last = groups[groups.length - 1];
    var front = { x: box.x + first.sx / first.n, y: first.sy / first.n };
    var rear = { x: box.x + last.sx / last.n, y: last.sy / last.n };
    var spanPx = Math.abs(rear.x - front.x);
    if (spanPx < box.w * o.minSpanFrac || spanPx > box.w * o.maxSpanFrac) return null;

    return { front: front, rear: rear, spanPx: spanPx, groups: groups.length };
  }

  // Homogeneous image line through the two contact points. It lies on the road
  // surface and runs along the road, so it passes through the road's vanishing
  // point.
  function contactLine(contacts) {
    var p = contacts.front, q = contacts.rear;
    var a = p.y - q.y, b = q.x - p.x, c = p.x * q.y - q.x * p.y;
    var n = Math.hypot(a, b) || 1;
    return [a / n, b / n, c / n];
  }

  root.Wheels = {
    findContactPoints: findContactPoints,
    contactLine: contactLine,
    DEFAULTS: DEFAULTS
  };
})(typeof module !== 'undefined' && module.exports ? module.exports : this);
