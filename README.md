# Golf course optimizer — aim optimizer slice

A vertical slice through the [spec](docs/spec.md): one hardcoded hole, a Monte Carlo aim
optimizer, and a comparison UI. It exists to answer one question before any of the
modelling machinery gets built —

> **Does the aim recommendation ever tell you something you don't already know?**

Everything else in the spec's build order is deferred until that question has an answer.

```bash
npm install
npm run dev          # the app
npm test             # 18 model tests, no browser needed
npx vite-node scripts/inspect.ts      # what the optimizer says about the demo hole
npx vite-node scripts/sensitivity.ts  # how much the answer moves when the inputs move
```

---

## What it found

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

**Throwaway:**

- `src/data/demoHole.ts` — invented coordinates.
- `src/data/clubs.ts` — invented dispersion parameters.
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
