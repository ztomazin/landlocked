# Neighborhood Speed Monitor

**Measure how fast traffic actually moves on your street, using a phone video,
and turn it into the kind of data a city council can act on.**

Residents almost always know their street has a speeding problem before the
city does. What they usually lack is evidence in the form traffic engineers
recognise. This tool closes that gap: film the street, mark two lines across
the road, enter the distance between them, and get per-vehicle speeds plus the
85th-percentile statistics that speed studies are built on.

Everything runs in the browser on your own device. There is no server, no
account, and no upload — the video never leaves your phone.

## Quick start

1. Open `index.html` (or the deployed site) on your phone.
2. **Choose a source** — the live camera, or a video you already recorded.
3. **Draw two gates** by tapping two points for each line across the road.
4. **Set the scale.** Either mark something of known length and trace the road
   direction (no tape measure — see below), or enter a distance you measured.
5. **Start measuring.** Speeds appear as vehicles pass.
6. **Export** the report (Markdown) and the per-vehicle data (CSV).

## Setting the scale without a tape measure

**The short version: draw two gates, press Start, and let the traffic do the
rest.** The app finds where each vehicle's tyres touch the road, which gives it
both the direction of the road and a wheelbase to measure against. Nothing to
mark, nothing to measure — at the cost of a wider error bar, because it has to
assume an average wheelbase.

Mark a reference of known length and trace the road edges when you want that
error bar tightened. The rest of this section explains why.

A camera cannot know how big anything is: the same picture fits a small object
nearby or a large one far away. One real-world length has to come from
somewhere — that is geometry, not a missing feature. What it does *not* have to
be is the distance between the gates, and you never have to step into the road.

Three ways to supply it, in increasing effort and accuracy:

1. **Nothing at all.** The app finds each vehicle's tyre contact patches. The
   line between a vehicle's front and rear contact points runs along the road
   *on the road surface*, so the traffic reveals the road's geometry; and the
   distance between them is a wheelbase, which stands in as the known length.
2. **Mark something you know the length of**, lying along the road — a parked
   car, a painted lane stripe, a sheet of plywood at the kerb. Anywhere in the
   frame; it does not need to be near the gates.
3. **Also trace two lines that run along the road** and are parallel on the
   ground — the far kerb and the centre line usually work best.

That is enough to recover the geometry of the road surface and compute the gate
distance itself. No lens data, no camera height, no tilt angle. Against a
simulated camera the recovered distance is exact to within 0.2% across a wide
range of heights, angles, lenses and viewing directions.

The best reference of all is **your own car, measured once with a tape in your
driveway** — safely off the road. After that it is a ruler you can park anywhere.

Two things dominate the accuracy, both free to improve:

- **Trace the road lines as far into the distance as you can see them.** A 6 m
  trace gives ±40%; a 75 m trace gives ±3%. This is the single biggest factor.
- **Use the longest reference you can.** A 12 m lane-stripe cycle beats a 4.7 m
  car, which beats a 1.8 m bicycle.

If you skip the road lines, the app falls back to inferring the road direction
from the paths of passing vehicles, which needs no input at all but is
noticeably rougher (about 15% systematic, and it says so on screen). Measuring
can begin before the scale is set: crossings are timed either way, and the
speeds fill in — and refine — once it is known.

The live camera requires an `https` connection because browsers restrict camera
access; a recorded video file works anywhere, including straight off the local
filesystem.

## Getting a measurement you can defend

The method is timing between two lines, so two things matter far more than
anything else: **where you put the lines** and **how well you measure the
distance between them**.

**Siting the camera**

- Film roughly **perpendicular to the road**, not down the length of it.
- **Higher is better.** A camera 3 m up looking down at 30° is about three times
  more accurate than one at 1 m looking along the road at 6°.
- **Keep the camera completely still** — prop it, brace it, or use a tripod. The
  gates are fixed to the video frame, so if the camera moves, the gates no
  longer line up with the road and every measurement after that is wrong.
- Stand well back from moving traffic, on a pavement, driveway or private
  property. Never in the roadway.
- Put both gates where vehicles are unobstructed, and make them long enough to
  span every lane you want to measure.
- Further apart is better: more distance means more frames between crossings and
  a smaller timing error. The app warns you if the gates are too close together.

**Measuring the distance**

A 5% error here becomes a 5% error in every speed you report, so use one of:

- A tape measure or measuring wheel along the kerb (best).
- The "measure distance" tool in a satellite map, clicking the same two ground
  features you used for the gates (good, and safe — no standing in the road).
- A known reference such as marked parking stalls, at a pinch.

Enter how precisely you measured it in the `±` field, and that uncertainty is
carried through into every reported speed.

**Validating your setup**

Have someone drive past at a steady speed while watching their speedometer or a
GPS speed app, and compare. Do this once for a given camera position and you
know what your setup is worth. The **Check accuracy** button separately verifies
the software itself against a simulated street with known speeds — that tests
the code, not your tape measure or camera angle.

## Accuracy

Each measurement is reported with a 95% confidence interval combining three
sources of error: your distance measurement, the video frame rate, and residual
viewing geometry. The full error model is in [docs/METHOD.md](docs/METHOD.md).

Verified two ways:

| Check | Result |
| --- | --- |
| Synthetic scene, exact ground truth (`npm test`) | worst error **0.22%** across 15–45 mph |
| Flat rendered video through the real browser UI | three vehicles at 20/30/40 mph, all within **0.3%** |
| **Perspective** video, browser UI, reference marked + road traced | gate distance **8.000 m against 8.000 m true**; all 14 vehicles detected; every high-confidence speed within **8.9%**, most within 3% |
| Same video, road direction from **wheel contact patches** | **7.96 m (−0.4%)** |
| Same video, **nothing marked or measured at all** | **7.99 m (−0.1%)**, self-reported ±9% |
| Projective geometry against a simulated camera | exact to **0.2%** across heights 1–2.4 m, tilts 5–26°, wide and telephoto lenses, yaw to 25° |

The fully automatic figure is better than the method deserves: that scene's
median wheelbase is 2.72 m against the 2.80 m the app assumes, so a few percent
of bias happened to cancel. **The ±9% is the honest claim, not the hit** — and
the assumed wheelbase is neighbourhood-dependent, so it wants validating against
local traffic before anyone leans on it.

Those figures are the software's own error. In the field, expect the scale —
however you set it — to dominate, which is why every measurement is reported
with an error bar and why the tool tells you which input to improve.

## Privacy and ethics

- **Nothing is uploaded.** There is no backend. Frames are processed in memory
  and discarded; only speeds, times and your own notes are kept.
- **No identification.** The tool detects moving blobs, not vehicles, plates or
  people. It cannot tell you who was driving, and it is not built to.
- **Not enforcement.** These numbers cannot ticket anyone and are not an
  enforcement-grade measurement. They are a screening study whose purpose is to
  show that an official one is warranted.
- **Not for confrontation.** Aggregate data at a council meeting changes
  streets. Roadside confrontations do not, and put people at risk.
- Rules on recording in public vary by jurisdiction — check your local ones, and
  do not film into private homes or yards.

## Using the results for policy

The number to lead with is the **85th percentile speed**: the speed at or below
which 85% of drivers travel. It is the figure traffic engineers use when
evaluating speed limits and traffic calming requests, which makes a report built
around it hard to wave away.

A practical approach:

1. Measure for at least 30–60 minutes at a time.
2. Repeat at different times of day and on different days — school run, evening
   commute, weekend.
3. Export the report and the CSV for each session.
4. Bring them to whoever runs your city's traffic calming or Vision Zero
   programme, and ask for an official speed study on the block.

The generated report already states the method, the uncertainty and the
limitations up front, and ends with that request. Overstating precision is the
fastest way to get a citizen report dismissed, so it deliberately does not.

## How it works

Classical computer vision, not a neural network — which means no model
download, no network access, and it runs on an old phone:

1. Each frame is reduced to a small grayscale image (long side 320px).
2. An exponential-moving-average background model flags pixels that changed.
3. The mask is cleaned with an erode/dilate pass and split into blobs.
4. Blobs are linked frame to frame into tracks with velocity prediction.
5. When a track crosses a gate, the exact crossing instant is interpolated
   *between* frames, so timing is finer than the frame rate.
6. Speed = the ground distance ÷ the time between the two crossings.

The tracked point is the **bottom of the blob**, where the tyres meet the road,
not its centre. A point on the road surface crosses the drawn gate at exactly
the moment it crosses the real line; a point above the road does not, and the
error does not cancel between the gates. Tracking the middle of a vehicle
instead inflates every speed by about 30% for a typical elevated camera — a
mistake this project made, and which only a perspective test caught, because a
flat test scene hides it completely.

A detector-based mode (vehicle classification, better handling of overlapping
traffic) is the obvious next step, but it would require a model download and
break the offline guarantee, so it is not in this version.

## Project layout

```
speed-monitor/
├── index.html          the app
├── styles.css
├── js/
│   ├── tracker.js      background model, blob detection, tracking
│   ├── speedmeter.js   gate geometry, speed, uncertainty
│   ├── wheels.js       where the tyres touch the road
│   ├── calibration.js  recovering the scale without measuring
│   ├── analysis.js     statistics, CSV and report generation
│   ├── selftest.js     synthetic scene with known ground truth
│   └── app.js          UI wiring
├── test/run-tests.js   test suite (no dependencies)
├── docs/METHOD.md      the method, error model and failure modes
└── netlify.toml        standalone deployment config
```

No build step and no dependencies. The measurement modules are free of DOM
access, so the same code runs in node for the tests.

## Development

```sh
npm test            # or: node test/run-tests.js
```

To run the app locally with the camera enabled, serve it over `http://localhost`
(browsers treat localhost as secure):

```sh
python3 -m http.server 8777    # then open http://localhost:8777
```

## Deployment

This folder is self-contained — it references nothing outside itself — so it
deploys as its own site. On Netlify: create a **new site** from this repository
and set the **base directory** to `speed-monitor`; `netlify.toml` here supplies
the rest, including a content-security policy that blocks outbound connections.
Any other project in the repository keeps its own separate site.

Moving it to its own repository later needs no code changes: copy the folder, or
`git subtree split -P speed-monitor`.

## Status and roadmap

Working and verified, but young. Worth doing next:

- Field validation against a GPS-verified vehicle across several camera setups.
- **Validating the assumed 2.80 m median wheelbase against real traffic.** It is
  the floor on the fully automatic mode's accuracy and the most valuable single
  number to pin down.
- Wheel detection in poor conditions: heavy shadow under a vehicle fills the
  clearance gap and the contact patches become unfindable (the code detects this
  and declines rather than guessing).
- Detector-based tracking as an optional mode, to stop low-contrast vehicles
  fragmenting.
- A magnifier when placing points, to cut tap error — the limit on the
  marked-reference path.
- Vehicle counts by hour, for volume as well as speed.
- Better handling of low light and long shadows.
- A way to merge several sessions into one multi-day report.

## License

No licence file has been added yet. If you want others to reuse or contribute to
this, add one (MIT is a reasonable default for a tool meant to spread).
