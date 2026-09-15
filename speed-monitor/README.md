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
4. **Enter the ground distance** between the two lines, and the posted limit.
5. **Start measuring.** Speeds appear as vehicles pass.
6. **Export** the report (Markdown) and the per-vehicle data (CSV).

The live camera requires an `https` connection because browsers restrict camera
access; a recorded video file works anywhere, including straight off the local
filesystem.

## Getting a measurement you can defend

The method is timing between two lines, so two things matter far more than
anything else: **where you put the lines** and **how well you measure the
distance between them**.

**Siting the camera**

- Film roughly **perpendicular to the road**, not down the length of it. This is
  what makes the geometry cancel out (see [docs/METHOD.md](docs/METHOD.md)).
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
| Synthetic scene, exact ground truth (`npm test`) | worst error **0.24%** across 15–45 mph |
| Rendered video through the real browser UI, end to end | three vehicles at 20/30/40 mph, all within **0.3%**, correct directions |

Those figures are the software's own error with a perfect distance measurement.
In the field, expect your distance measurement to dominate.

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
6. Speed = the measured ground distance ÷ the time between the two crossings.

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
- Detector-based tracking as an optional mode, for heavy or overlapping traffic.
- Vehicle counts by hour, for volume as well as speed.
- Better handling of low light and long shadows.
- A way to merge several sessions into one multi-day report.

## License

No licence file has been added yet. If you want others to reuse or contribute to
this, add one (MIT is a reasonable default for a tool meant to spread).
