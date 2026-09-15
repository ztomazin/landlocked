# Method and error model

This document describes exactly how a speed number is produced, what its
uncertainty is made of, and where the method fails. It is written so that a
sceptical traffic engineer can check the reasoning, and so that a resident using
the tool does not overstate what they have.

## 1. The measurement

Two line segments ("gates") are drawn on the video frame, across the roadway.
The user supplies **D**, the real ground distance between them, measured along
the direction of travel. For each tracked object the software records the
instant it crosses each gate, and reports

```
speed = D / (t_B - t_A)
```

That is the whole measurement. Note what it does *not* require:

- no camera calibration, focal length or sensor size
- no lens distortion model
- no perspective transform or homography
- no assumption about how far away the road is, or at what height the camera sits

The image geometry is used only to decide *when* a crossing happened, never to
convert pixels into metres. This is why the method survives being handed to
someone with an unknown phone at an unknown angle.

## 2. Detection and tracking

Per frame, at a reduced resolution (long side 320px):

1. **Grayscale + 3×3 box blur.** Suppresses sensor noise so the threshold can
   stay low enough to catch dark vehicles in poor light.
2. **Background model.** An exponential moving average per pixel,
   `bg += α(frame − bg)`. Pixels currently classified as foreground adapt far
   more slowly (α = 0.003 rather than 0.06) so a vehicle stopped at a junction
   is not absorbed into the background.
3. **Foreground mask.** `|frame − bg| > 20` gray levels.
4. **Morphological cleanup.** Erode radius 1 (removes speckle), then dilate
   radius 2 (reconnects a vehicle split by a window or a light-coloured panel).
   Both are computed with an integral image, so cost is independent of radius.
5. **Connected components,** 8-connected, filtered by area.
6. **Tracking.** Greedy nearest-neighbour association against a constant
   velocity prediction, with a match radius that scales with the frame interval.
   Tracks are confirmed after 2 hits and survive 8 missed frames.

If more than 45% of the frame becomes foreground at once — an exposure change,
a cloud, headlights sweeping across — the background is re-seeded and that frame
produces no measurements, rather than a frame full of phantom vehicles.

### Reference point

The **blob centroid** is used as the tracked point at both gates. It is the most
stable statistic available: it averages over the whole blob and so is far less
jittery than an edge, which moves as the vehicle's silhouette changes.

The centroid sits roughly at mid-vehicle-height rather than on the road surface,
so its image position is displaced from the true tyre contact point. This matters
much less than it first appears, for two reasons:

1. When the camera looks **roughly perpendicular to the road**, that displacement
   is almost entirely *across* the direction of travel, not along it — so it
   barely shifts the crossing instant at all.
2. Whatever displacement remains is **similar at both gates**, and the
   measurement depends only on the *difference* `t_B − t_A`, so a constant offset
   subtracts out.

This is the reason the instructions insist on a perpendicular view. Filming down
the length of the road breaks assumption (1) and introduces a real bias.

### Sub-frame crossing times

A crossing is detected when the signed perpendicular distance from the centroid
to the gate line changes sign between two consecutive samples. The crossing
instant is then linearly interpolated:

```
f   = s_prev / (s_prev − s_curr)
t   = t_prev + f · (t_curr − t_prev)
```

so timing resolution is better than one frame. Frame timestamps come from
`requestVideoFrameCallback`'s `mediaTime` where available — the frame's exact
presentation time on the media timeline — falling back to `currentTime` sampled
per animation frame.

A crossing is only accepted if it occurs **within the drawn segment** (with an
8% margin), so an object passing beyond the end of the line is ignored rather
than counted.

## 3. Error model

Reported uncertainty combines three independent relative errors in quadrature:

```
σ/v = sqrt( (σ_D/D)² + (σ_t/Δt)² + σ_geom² )
```

| Term | What it is | Default |
| --- | --- | --- |
| `σ_D/D` | Error in the measured ground distance | user-supplied; else max(2% of D, 15 cm) |
| `σ_t/Δt` | Crossing-time interpolation error, both gates | `σ_t = 0.45 × frame interval` |
| `σ_geom` | Residual parallax and non-parallel gates | 2% |

Results are displayed as a 95% interval (1.96σ).

**Which term dominates.** At 30 mph with gates 60 ft apart and 30 fps video,
Δt ≈ 1.4 s ≈ 41 frames, so the timing term is about 1%. A distance measured to
±1 ft in 60 ft is 1.7%. Geometry contributes 2%. Total ≈ 2.8%, or about
±0.8 mph at 30 mph. Pace out the distance instead of measuring it — say ±5 ft —
and the distance term becomes 8%, swamping everything else.

**The practical consequence:** measure the distance carefully and place the gates
far apart. Nothing else you can do matters as much.

## 4. Quality flags

Each measurement carries flags, and a confidence of high / medium / low:

| Flag | Meaning |
| --- | --- |
| `few-frames` | Fewer than 5 frames between gates; timing is coarse |
| `occluded` | The track was lost for one or more frames between the gates |
| `size-change` | Blob area changed by more than 2.5× — often two vehicles merging into one blob |
| `gate-edge` | Crossed very near the end of a gate, where the geometry is least reliable |

Measurements outside 3–120 mph are discarded outright and counted separately, so
the rejection is visible rather than silent.

An object that crosses the same gate twice (a pedestrian pacing, a vehicle
reversing) invalidates its own track rather than producing a nonsense speed.

## 5. Object length estimate

Metres-per-pixel is inferred from the gate separation (`D` ÷ perpendicular pixel
separation) and multiplied by the bounding box extent along the direction of
travel. Unlike the speed, **this estimate does depend on perspective** and is
only approximate — enough to separate a pedestrian from a car from a lorry, not
enough to quote. It is labelled as an estimate everywhere it appears.

## 6. Known failure modes

| Situation | Effect | Mitigation |
| --- | --- | --- |
| Camera moves during a session | Gates no longer align with the road; all later speeds wrong | Brace or mount the camera; restart if it is bumped |
| Filming along the road rather than across it | Systematic bias from centroid parallax | Film perpendicular |
| Two vehicles overlapping in frame | Merged into one blob; `size-change` flag, possibly one missed vehicle | Film from an angle where lanes separate; check flagged rows |
| Low sun casting long shadows | Shadow joins the vehicle blob, shifting the centroid | Largely cancels between gates; prefer overcast or high sun |
| Night, headlights only | Blob is the light pool, not the vehicle | Not currently reliable — a known limitation |
| Heavy rain, wipers, foliage in wind | Spurious blobs | Min-area filter and the 3–120 mph range remove most; check the log |
| Vehicle accelerating or braking between gates | Reports the *average* speed over the gate separation | True by definition; note it when reporting |
| Very low frame rate (below ~15 fps) | Timing term grows | The app displays measured fps; place gates further apart |

## 7. Validating a setup

The synthetic self-test in the app validates the *software* (worst error 0.24%
across 15–45 mph). It says nothing about your distance measurement or camera
placement. To validate those:

1. Set up as you would for a real session.
2. Have someone drive past several times at a steady speed, reading their
   speedometer or a GPS speed app. Ask for both directions.
3. Compare. Speedometers typically over-read by a few percent and GPS is the
   better reference.
4. If there is a consistent bias, re-check the distance measurement first — it
   is almost always the culprit — then the camera angle.

Doing this once per camera position converts "we think cars speed here" into a
number you can stand behind when someone pushes back.
