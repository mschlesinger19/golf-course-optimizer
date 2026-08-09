# Golf course optimizer

Three pages. **Play** is the app: drag a crosshair anywhere on the hole and it prices the
target. **Trace** draws the course geometry underneath it. **Lab** is the parameter sweep
that decides how much any of the modelling is worth.

```bash
npm install
npm run dev          # the app
npm test             # 66 model tests, no browser needed
npx vite-node scripts/inspect.ts      # what the optimizer says about the demo hole
npx vite-node scripts/sensitivity.ts  # how much the answer moves when the inputs move
```

Everything is local-first: courses live in `localStorage`, nothing calls a server, and the
model runs on-device. Spec §2 makes that non-negotiable — cell coverage on courses is
unreliable and the app is useless if it cannot compute an aim point without signal. The
only network dependency is satellite imagery, and losing it degrades the picture, not the
numbers.

---

## Play — the two-layer crosshair

Drag the crosshair (or tap the map) and you get two numbers, deliberately side by side:

| layer | what it is | needs dispersion? |
|---|---|---|
| **if you hit it exactly here** | `E(strokes)` at the target, versus the baseline where you stand | no |
| **realistic** | the same thing averaged over your miss pattern at that distance | yes |

The first layer is a lookup and answers *what is this spot worth*. It is honest and it is
free. What it cannot do is tell you where to aim, because it prices every target as though
you hit it perfectly — so the pin always wins.

Both yardages are drawn on the map itself — ball-to-target and target-to-pin — not only in the
panel, because standing over the ball you want "how far am I hitting it" and "what's left in"
without looking away from the hole. The opening target is down the centreline at your longest
club rather than at the pin: defaulting to the pin on a 400-yard hole asks the model to
simulate a shot nobody can hit.

The gap between the two layers is the whole argument. On the demo hole, dragging to the pin
from the tee reads **+2.45** perfect and **+0.35** realistic: a two-stroke divergence, and
the realistic column shows 23% trees against 13% green. That gap is the cost of your miss
pattern, and the app calls it out explicitly whenever it exceeds 0.15 strokes.

Dispersion is not optional if the app answers "where should I aim." But per the sweep below
it can be *crude* — the recommendation survived a 4× error in it.

### Dispersion is angular

The miss pattern is a cone from the ball, not a rectangle around the aim line. A 2° push is
3.5 yards offline at 100 yards and 8.7 at 250, so the band of equal distance is an **arc**
struck from the ball — which is why the width marker on the map bows away from you, and why
it widens as you go up the bag. At a fixed 207-yard target the wedge measures 59 yards wide
for a driver and 38 for a 6-iron.

The alternative — sampling a fixed perpendicular offset scaled by the club's mean carry —
gives an ellipse with a flat far edge, and puts the full sideways spread on a strike that
travelled 40 yards less. Wrong in exactly the place it matters: the mishits that decide
whether to bail out. It is also the plainer reading of spec §4.1, where σ is stored as a
fraction of carry — the carry each shot actually had, not the club's average.

One visible consequence: the wedge label reads *less* than the target distance ("206 yd avg"
against a 211-yard target). That is not an arithmetic slip. The mishit component carries
short, so the mean distance the ball travels sits inside the target.

### Guards

A target inside water or OB is priced as taking the penalty rather than as a free lie, and
dragging beyond the longest club in the bag raises a warning instead of quietly simulating a
shot nobody can hit.

## Trace — geometry

Per-hole workflow from spec §9: set tee, green centre and pin, draw the centreline, then
click out polygons from a palette. Rough is deliberately not in the palette — spec §3.1
makes it implicit, so anything untraced resolves to rough and tracing it is wasted work.
Each polygon carries the `penalty_modifier` local-knowledge field, because a flat fairway
bunker and a lipped-out greenside bunker are both `bunker` and differ by most of a stroke.

**Import from OpenStreetMap** is spec §9's second path, and it stays second on purpose: coverage
is patchy and private clubs are systematically the gap. Search by name, or hit "I'm at the
course" and it queries Overpass around your GPS fix. `golf=hole` ways are the skeleton — each
carries the hole number and usually the par, and its geometry is the centreline, so its first
point is the tee and its last is the green. Every polygon is then assigned to the nearest
centreline, because OSM polygons rarely say which hole they belong to.

It reports what it found rather than presenting it as surveyed: features per hole, anything
dropped for sitting more than 200y from every centreline, holes that had no par tag, and — per
§9's bimodal-coverage warning — a plain statement when under two features per hole means the
course came back as an undifferentiated blob and you should trace it.

Courses export and import as JSON. KML (spec §9) is not built yet.

Imagery defaults to **NAIP** — public domain, no attribution requirement, no restriction on
deriving data, ~60cm, which resolves bunker edges and green perimeters cleanly. USGS and
Esri are selectable because NAIP is CONUS-only and refreshes on a multi-year cycle; spec §9
warns that a flyover predating a renovation produces confidently wrong polygons, so the
course record carries an imagery-vintage note.

## Bag — where the numbers come from

Two sources, in priority order.

**Your clubs.** The bag is user-defined — add, rename, remove, set carries, mark clubs in or
out. Nobody carries the same fourteen, and a fixed list does worse than look wrong: each club
also carries a *family*, and family is what decides whose logged shots pool with whose when a
club has too few of its own. A hardcoded list silently mispools every club you do not happen
to own.

**Logged shots.** Every shot is stored as two dimensionless numbers: the ratio of actual to
intended distance, and the offline angle. Dimensionless is what lets a shot logged at 150
yards inform the pattern drawn at 200 — the same assumption spec §4.1 makes for σ, applied
to observations instead of parameters. The Play page then bootstraps that pool directly
rather than fitting anything to it.

This is what eventually retires most of spec §4.2. Hierarchical shrinkage exists to squeeze
a shape out of very few observations; once the observations are stored, the pattern *is* the
data. Family pooling stops being a shrinkage formula and becomes list concatenation — a
5-wood with no shots of its own borrows the 3-wood's, at a third weight.

The split between logged shots and the prior is §4.2's `n/(n+k)` with k=12, applied per
Monte Carlo sample rather than per parameter. So the pattern takes the *shape* of real shots
as soon as any exist, instead of being averaged into a Gaussian that never had that shape.
At 14 logged shots the readout says "54% from your logged shots" — which is 14/(14+12).

**The questionnaire**, until then. Spec §5: never ask for a σ or an average, because golfers
report their best shot as their average. Ask for counts and directions and infer the rest.

| answer | infers |
|---|---|
| fairways hit out of 14 | driver lateral σ, by inverting a hit rate through a fairway-width strip |
| greens in regulation | iron σ, via a Rayleigh radius on a circular green |
| penalty strokes per round | mishit weight — spec §5 notes this is otherwise unrecoverable |
| one-way or two-way miss | signed bias, or none |
| flush vs thin 7-iron gap | longitudinal σ, treating the gap as the 10th–90th percentile |
| stated carries | mean carry, after knocking the stated figure down from a 75th percentile |

**The answers are yours; the mapping is mine.** Every constant in it — fairway half-width,
green radius, what fraction of mishits become penalties — is a modelling assumption, not a
citation. They are gathered as a single exported `ASSUMPTIONS` object in
`questionnaire.ts` so they can be argued with or replaced, and the Bag page prints the full
derivation of every number it produced.

That is still a real improvement on what came before: the previous bag was invented outright.
It also sidesteps spec §12 open #3 — no published handicap-band prior is needed if the player
reports their own fairway rate.

## Lab — the sweep

The original vertical slice: full aim-angle optimisation over a hardcoded hole, with every
dispersion parameter on a slider.

---

## What the sweep found


On the demo hole — dogleg right, pond exactly where a straight driver finishes, bunker in
the lay-up zone — with a mid-handicap bag:

| | expected strokes |
|---|---|
| Driver, straight down the middle | 5.11 — **45% water** |
| Driver, best available line | 4.92 — 20% water, 21% trees |
| 5-wood / 4-iron, best line | **4.65** |

Two things fall out, and they point in the same direction.

**The decision is club, not aim.** Re-aiming the driver saves 0.19 strokes. Putting the
driver back in the bag saves 0.26 more. For every other club the aim adjustment is worth
under 0.03 strokes — inside the noise of the model that produced it.

**The answer barely moves when the inputs do.** `scripts/sensitivity.ts` sweeps the
parameters the spec proposes spending a lot of machinery on:

| swept | recommended aim | best club |
|---|---|---|
| lateral σ from 3.8% to 15.0% (a 4× range) | +1.3° to +5.8° right of the hole axis | lay-up at every setting |
| mishit weight 0% to 25% | +2.8°, unchanged throughout | lay-up at every setting |
| mishit bias 29y left to 29y right | +2.8°, unchanged throughout | lay-up at every setting |
| skill factor 1.00× to 1.40× | +2.8°, unchanged throughout | lay-up at every setting |
| carry ±20y | +2.8°, unchanged throughout | lay-up at every setting |

The absolute stroke count moves a lot — 4.31 to 5.23 across the skill range — but the
*decision* does not move at all. The driver is wrong on this hole by 0.10 to 0.35 strokes
no matter which plausible dispersion you hand it.

The 5-wood/4-iron flip in that table is not a real change: those two are within 0.02
strokes of each other at every setting, so which one gets the label is Monte Carlo noise.

### What that implies for the build order

Spec §4.2 proposes hierarchical pooling with shrinkage toward a family fit, and §5 designs
a questionnaire around recovering `lateral_bias` because it has a "large effect on
recommended aim points." On this hole it has a 0.02-stroke effect and does not move the
aim point at all. Meanwhile the things that *did* move the answer were the hole geometry
and the carry distances.

That is one hole with invented coordinates, so it is a hypothesis rather than a result. But
it is a cheap and testable one, and it suggests the ordering is: **geometry accuracy and
honest carry numbers first, dispersion precision much later.**

The obvious way to break this finding is a hole where the hazard sits at the *edge* of the
dispersion rather than squarely in the middle of it — a tee shot where 7% σ carries the
corner and 9% does not. If you have a hole like that, it is the next one to encode.

---

## What is real and what is scaffolding

Per the spec's own framing of this slice:

**Load-bearing, keep:**

- `src/model/optimizer.ts` — the Monte Carlo sweep, outcome accounting, OB as
  stroke-and-distance, water relief, roll-after-landing.
- `src/model/geometry.ts` — the polygon format, priority-based lie resolution, implicit
  rough. This is the shape the tracer needs to emit.
- `src/model/dispersion.ts` — the 2D mixture sampler and the shared noise bank.
- The comparison UI — expected-strokes deltas, outcome shares, the cost-by-angle curve.
- `src/model/projection.ts` and `src/model/course.ts` — lat/lng traced geometry, projected
  into the optimizer's flat-yard frame about the tee. Accurate to centimetres over a hole,
  which is far below the noise floor of everything else here.
- `src/pages/Trace.tsx` — the tracer, which spec §9 calls the primary geometry path.

**Throwaway:**

- `src/data/demoHole.ts` — invented coordinates.
- `src/data/clubs.ts` — invented dispersion parameters. Only used as the fallback bag
  before the questionnaire is answered; the Bag page replaces it outright.
- `src/model/expectedStrokes.ts` — invented baseline (see below).

---

## The guarded numbers

Spec §12 flags decisions #3 (handicap-band dispersion priors) and #4 (expected-strokes
table) as the two places where "a coding agent will happily invent plausible numbers rather
than flag the gap, and the app will still run and still produce confident output built on
fabricated baselines."

**Both are invented here.** They are marked `PROVISIONAL` in source, the app renders a
banner saying so, and the affected files carry a header explaining what would replace them:

- `src/model/expectedStrokes.ts` — anchor tables shaped like the published PGA Tour
  benchmarks but not transcribed from them. Replace the anchor arrays with the real tables
  from Broadie, *Every Shot Counts*; the interpolation and all calling code are unchanged.
- `src/data/clubs.ts` — a plausible mid-handicap bag, not a fitted model and not a
  published prior.

The sensitivity sweep above is the mitigation that matters: the recommendation survives a
4× error in these numbers. Absolute stroke counts do not, and should not be reported.

---

## Deliberate deviations from the spec

**1D angle sweep instead of a 2D aim-point grid (§8).** For a full shot with a chosen club
the carry is set by the club, so an aim point has only one free parameter — direction. The
search is identical, roughly 40× cheaper, and it yields a cost-versus-angle curve, which is
what shows whether the recommendation is sharply defined or a flat basin. Club choice
supplies the second dimension by running the sweep per club, exactly as §8 describes.

**A centreline on the `Hole` type.** The spec compares the recommendation against "at the
pin." On a dogleg, aiming at the pin means aiming into the trees — a 93%-trees straw man
that makes any recommendation look brilliant. The honest comparison is against straight
down the middle, which requires knowing where the middle is. OSM already supplies this as
the `golf=hole` way (§9); the tracer should capture it too.

**Roll after landing, and roll depends on the surface.** Not in the §8 pseudocode, but
without it a drive cannot carry a bunker and run into it, and the water on this hole stops
being reachable in the way it actually is.

**A `mishitCarryMult` on `club_posteriors` (§3.3).** Mishits come up short as well as
sideways. Without this the model puts every thin and heavy strike at full distance.

---

## Known gaps

- Water relief walks back along the flight line to the last dry point. That is not the
  Rules of Golf and does not model the player's relief options.
- Trees are priced as a lie, not as an obstruction — a ball flying *over* a corner of the
  tree polygon is unaffected, which is right, but a ball whose *line* is blocked is not
  penalised, which is wrong.
- No wind, no elevation (§8 defers these to a carry adjustment plus a σ multiplier).
- Start position is fixed at the tee. The optimizer takes an arbitrary start point and lie,
  so approach shots work — nothing in the UI exposes it yet.
- One hole. No tracer, no OSM ingest, no shot logging, no strokes-gained accounting.

---

## Deploying

`.github/workflows/deploy.yml` builds and publishes to GitHub Pages on every push to
`main`. It needs Pages switched on once, by hand: **Settings → Pages → Source → GitHub
Actions**. After that the app lives at
`https://mschlesinger19.github.io/golf-course-optimizer/`.
