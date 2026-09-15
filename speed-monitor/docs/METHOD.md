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

### Reference point: it must be on the road

The tracked point is the **bottom-centre of the blob** - where the tyres meet
the road - not its centroid. This matters more than it sounds.

A gate drawn on the video is the image of a line across the tarmac. A point that
lies *on the tarmac* crosses that image line at exactly the moment it crosses the
real line, whatever the camera's height, tilt or lens: the two events are the
same event. A point *above* the road does not. Seen from a raised camera, a point
at height Z crosses the drawn line when the vehicle is at `K·X_gate` rather than
`X_gate`, and because K multiplies both gate positions it does **not** cancel in
the difference - it scales the whole answer.

K is easy to underestimate. For a camera 3 m up looking 20 degrees down at a
9 m road, tracking a point 0.72 m above the tarmac gives K = 0.76, inflating
every speed by about 30%. That is not a rounding error; it is the difference
between "traffic is fine" and "traffic is dangerous". An early version of this
tool tracked the centroid and was wrong by exactly that much - a flat test scene
with no perspective hid it completely, because with no perspective K = 1.

Two useful consequences of using a road-plane point:

- **Lane position does not matter.** Every point on the road plane is unbiased,
  so near-lane and far-lane vehicles are measured alike.
- **Ground shadows do not bias the timing.** A shadow stretching the blob along
  the tarmac moves the tracked point to a different place *on the same plane*,
  which does not shift the crossing instant.

The centroid is still used for two things it is better at: associating blobs
between frames, and fitting vehicle paths for the vanishing point, where its
smoothness matters more than its height.

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

## 3. Setting the scale without measuring the road

The gate distance does not have to be the length you know. Anything of known
length lying along the road will do, anywhere in the frame, because the road's
geometry can be recovered from the picture itself.

1. Two lines that run along the road and are parallel on the ground - the far
   kerb and the centre line, say - meet at the road's **vanishing point V1**.
2. The two gates are parallel on the ground too, so they meet at a second
   vanishing point **V2**.
3. The line through V1 and V2 is the **horizon** of the road plane.
4. Mapping that horizon to infinity rectifies the plane to an affine copy of the
   real road. Under an affine map, *ratios of lengths measured along a common
   direction are exactly preserved*.
5. Therefore `gate separation / reference length` is the same in the rectified
   image as on the ground. One known length gives the other.

No focal length, no camera height, no tilt, no lens model. The only assumption
is that the road is locally flat. Tested against a simulated camera, this
recovers the gate distance to within 0.2% across camera heights of 1-2.4 m,
tilts of 5-26 degrees, wide and telephoto lenses, and yaws up to 25 degrees -
and it degrades correctly to the flat case when there is no perspective at all.

### What actually limits it

The geometry is exact; tap precision is not. Perturbing every tapped point by a
realistic 2 px and re-running the calculation gives, in simulation:

| Change | Reported uncertainty |
| --- | --- |
| Road lines traced over 6 m of road | +/- 40% |
| ...over 27 m | +/- 7% |
| ...over 75 m | +/- 3% |
| Reference object 1.8 m long | +/- 6% |
| ...4.7 m (a car) | +/- 5% |
| ...12.2 m (a stripe cycle) | +/- 3.6% |
| Camera 1 m high, 6 degrees down | +/- 7% |
| Camera 3 m high, 30 degrees down | +/- 2.3% |

So, in order of what to fix first: **trace the road lines as far into the
distance as you can see them**, use the longest reference you have, and get the
camera as high as is practical.

Note the reversal from the tape-measure method: there, wider gates are always
better, because the distance error is fixed and more frames reduce the timing
error. Here, wider gates mean extrapolating further from the reference, so the
distance error *grows* with separation (+/-3% at 6 m, +/-9% at 45 m) while the
timing error shrinks. For a residential street the two cross at roughly
8-15 m (25-50 ft).

### Wheel contact patches

The road direction can also be read from the traffic, and the right feature to
read it from is where the tyres touch the tarmac.

A vehicle's body sits 0.2-0.3 m clear of the road, so only its tyres reach the
bottom of the silhouette: the lower outline of the blob dips at each wheel and
lifts between them. Reading that outline needs no gradients, no circle fitting
and no model - only the mask already computed for tracking - and costs about
4 microseconds per vehicle per frame, which is 0.02% of the frame budget.

Two things come out of it, neither costing the user anything:

- **A road-direction line, on the road surface.** The line through a vehicle's
  front and rear contact points runs along the road and lies in the road plane,
  so it passes through the road's vanishing point. Every frame of every vehicle
  contributes one, which is why a 40-second clip yields ~400 lines rather than
  the dozen paths a per-vehicle method gets.
- **A wheelbase**, which is a known-ish length lying along the road - exactly
  the shape of reference the calibration wants, and unlike vehicle length it is
  bounded by two points the software can actually locate.

This is a large improvement on fitting vehicle *centroid* paths. A centroid
floats above the road and shifts as the silhouette turns with the viewing
angle, which bends the path. On a rendered perspective scene with a true 8.00 m
gate separation:

| Road direction from | Recovered |
| --- | --- |
| Traced lines (marked by hand) | 8.00 m (+0.0%) |
| **Wheel contact lines** | **7.96 m (-0.4%)** |
| Vehicle centroid paths | rejected its own data - see below |

On that same scene the centroid method collected 11 vehicle paths and then
found none of them straight enough to fit, so it produced no answer at all. An
earlier, cruder fixture - flat-shaded boxes whose bodies reached the tarmac -
let the centroid method through at about 13% error. Realistic silhouettes make
it worse, not better. It is kept only as a last resort for scenes where no
wheels can be found, and is labelled as rough when it is used.

### Fully automatic scale

With nothing marked at all, each vehicle's own wheelbase stands in for the
reference. The assumed value matters:

- Wheelbase varies across a mixed fleet by roughly +/-14%, against +/-12% for
  tyre diameter and +/-13% for vehicle length.
- But wheelbase is ~88 px in a 320 px processing frame, against ~21 px for a
  tyre. A one-pixel error costs 1.1% instead of 4.7%.
- And both its endpoints lie **on the road plane**, so unlike a tyre's diameter
  (centred 0.37 m up) or a vehicle's centroid, there is no height bias to
  correct.

**Scaling each vehicle by its own wheelbase would be a mistake.** That gives
every speed an independent random error, and random error does not cancel in a
percentile - it fattens the distribution, and the 85th percentile lives in the
fat tail. Simulated on 400 vehicles drawn from N(30, 4) mph:

| Per-vehicle scale error | Shift in the reported 85th percentile |
| --- | --- |
| +/-7% | +0.6 mph |
| +/-12% | +1.5 mph |
| +/-20% | +3.4 mph |

It biases upward - making a street look faster than it is, which is the
direction that gets a citizen report dismissed. So the **median across the
session** sets one scale for every vehicle instead. That converts the random
error into a single systematic one, which shifts all speeds proportionally
without distorting the distribution, and shrinks as 1/sqrt(N): 2.9% at ten
vehicles, 1.9% at twenty-five, 1.4% at fifty.

What does not shrink is the assumed median wheelbase itself, taken here as
**2.80 m** with a 9% systematic.

**That 9% is too optimistic, and the median is the wrong statistic.** Simulating
sessions of 60 vehicles against realistic fleet mixes shows the median tracking
the local mix badly:

| Neighbourhood | Scale error using the median |
| --- | --- |
| Dense urban, few trucks | +3.1% |
| Typical suburban | +1.0% |
| Truck-heavy | **-11.6%** |
| 85% pickups | **-21.6%** |

The median sits in the sparse gap between the light-vehicle cluster (~2.70 m)
and the pickup cluster (~3.62 m), so it slides with the mix. Two better
statistics, and a limit that no statistic can pass, are set out below.

### Locating the light-vehicle cluster instead

Classes barely differ where it matters: a compact car is 2.68 m and a small
crossover 2.69 m. Fine-grained classification buys nothing. What the
distribution really has is two clusters - light vehicles near 2.70 m and
pickups near 3.62 m - and the light cluster sits in the same place in every
neighbourhood. Only its *share* changes.

So estimate the position of the lowest cluster rather than a fixed percentile,
which depends on that share:

| Method | Dense urban | Suburban | Truck-heavy |
| --- | --- | --- | --- |
| Median (as shipped) | +3.1% | +1.0% | -11.6% |
| 10th percentile | +1.0% | +0.4% | -0.4% |
| **Lowest cluster peak** | **+0.2%** | **+0.2%** | **+0.1%** |

The cluster peak is essentially neighbourhood-independent across realistic
mixes, and it is also *less* noisy than the median on short sessions (+/-0.4%
against +/-1.4% at 60 vehicles), because the light cluster is tight while the
median wanders in the gap.

### The limit no statistic can pass

A street where every vehicle is a pickup produces exactly the same picture as a
street where every vehicle is a compact car, scaled. One cluster carries no
information about which cluster it is. At 95% pickups every method above fails
by about 20%, and no amount of cleverness recovers it - the scene is genuinely
ambiguous and needs one real-world length.

What the software *can* do is notice the ambiguity: two clusters separated by a
ratio near 3.62/2.70 = 1.34 are identifiable, a single cluster is not. When
there is only one cluster the honest response is a much wider error bar and a
prompt to mark a reference object, not a confident number.

On the rendered scene, with nothing marked or measured at all, the automatic
mode recovered **7.99 m against 8.00 m true, reporting +/-9%**. The point
estimate is closer than the method deserves - that fixture's median wheelbase
is 2.72 m against the assumed 2.80 m, so ~3% of bias happened to be cancelled
by other small errors. The honest claim is the stated envelope, not the hit.

### Two ways to get the road direction

The road lines can be traced by hand, or inferred from the traffic: vehicles
travel parallel to the road, so their paths converge on V1, and that needs no
input at all. The app uses the traffic when no lines are traced, and bootstraps
over the observed paths to report how much the vanishing point is actually
pinned down.

**Traced lines are markedly better.** On a rendered perspective scene with a
known 8.00 m gate separation, traced lines recovered 8.000 m while the
traffic-derived direction came out about 13% short. The reason is that a blob's
centroid shifts as the vehicle's silhouette turns with the viewing angle, which
bends the path slightly and drags the vanishing point with it. The
traffic-derived estimate therefore carries an extra 15% systematic term and the
app recommends tracing the lines.

## 4. Error model

Reported uncertainty combines independent relative errors in quadrature:

```
sigma/v = sqrt( (sigma_D/D)^2 + (sigma_t/dt)^2 + sigma_geom^2 )
```

| Term | What it is | Default |
| --- | --- | --- |
| `sigma_D/D` | Error in the gate distance | measured: user-supplied, else max(2% of D, 15 cm). Recovered: from the simulation described above |
| `sigma_t/dt` | Crossing-time interpolation, both gates | `sigma_t = 0.45 x frame interval` |
| `sigma_geom` | Residual geometry | 2%, plus 15% when the road direction came from the traffic rather than marked lines |

Results are displayed as a 95% interval (1.96 sigma).

**Which term dominates.** At 30 mph with gates 60 ft apart and 30 fps video,
dt is about 1.4 s (41 frames), so the timing term is around 1%. A distance
measured to +/-1 ft in 60 ft is 1.7%. Pace the distance out instead - say
+/-5 ft - and the distance term becomes 8%, swamping everything else. When the
distance is recovered rather than measured, its uncertainty is computed by
simulation and is typically 3-13%, so it dominates too.

**The practical consequence:** whichever way you set the scale, the scale is
what limits you. Measure the reference carefully, trace the road lines long, and
place the gates sensibly. Nothing else you can do matters as much.

## 5. Quality flags

Each measurement carries flags, and a confidence of high / medium / low:

| Flag | Meaning |
| --- | --- |
| `few-frames` | Fewer than 5 frames between gates; timing is coarse |
| `occluded` | The track was lost for one or more frames between the gates |
| `size-change` | Blob area changed by more than 2.5× — often two vehicles merging into one blob |
| `gate-edge` | Crossed very near the end of a gate, where the geometry is least reliable |
| `unstable-blob` | The blob's size changed markedly during the pass, usually a low-contrast vehicle breaking into fragments; the timing is not trustworthy |

Measurements outside 3–120 mph are discarded outright and counted separately, so
the rejection is visible rather than silent.

An object that crosses the same gate twice (a pedestrian pacing, a vehicle
reversing) invalidates its own track rather than producing a nonsense speed.

## 6. Object length estimate

Metres-per-pixel is inferred from the gate separation (`D` ÷ perpendicular pixel
separation) and multiplied by the bounding box extent along the direction of
travel. Unlike the speed, **this estimate does depend on perspective** and is
only approximate — enough to separate a pedestrian from a car from a lorry, not
enough to quote. It is labelled as an estimate everywhere it appears.

## 7. Known failure modes

| Situation | Effect | Mitigation |
| --- | --- | --- |
| Camera moves during a session | Gates no longer align with the road; all later speeds wrong | Brace or mount the camera; restart if it is bumped |
| Filming along the road rather than across it | Systematic bias from centroid parallax | Film perpendicular |
| Two vehicles overlapping in frame | Merged into one blob; `size-change` flag, possibly one missed vehicle | Film from an angle where lanes separate; check flagged rows |
| Low sun casting long shadows | Shadow joins the vehicle blob, shifting the centroid | Largely cancels between gates; prefer overcast or high sun |
| Night, headlights only | Blob is the light pool, not the vehicle | Not currently reliable — a known limitation |
| Heavy rain, wipers, foliage in wind | Spurious blobs | Min-area filter and the 3–120 mph range remove most; check the log |
| Vehicle accelerating or braking between gates | Reports the *average* speed over the gate separation | True by definition; note it when reporting |
| Low-contrast vehicle (grey car, grey tarmac) | Blob fragments part-way across, moving the tracked point; timing can be off by 10-15% | Detected and flagged `unstable-blob`, confidence dropped to low |
| Two vehicles overlapping at the edge of frame | One track can be handed from the outgoing vehicle to the incoming one | Tracks are dropped the moment they vanish at an edge, and a track re-arms after each completed pass so the second vehicle is still measured |
| Very low frame rate (below ~15 fps) | Timing term grows | The app displays measured fps; place gates further apart |

## 8. Validating a setup

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
