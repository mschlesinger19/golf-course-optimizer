# Strokes Gained & Optimal Aim App — Technical Spec

**Status:** Draft for implementation. Sections marked ⚠️ contain open decisions that must be resolved before the affected component is built.

---

## 1. What this is

A course-management app that answers one question well: **given where I am, where should I aim?**

It answers it by combining three things:

1. A learned model of *my* shot dispersion, per club, including my mishit tail.
2. Course geometry as polygons (fairway, green, bunkers, water, OB, rough).
3. A baseline expected-strokes table, so every candidate outcome has a cost.

Secondary output: strokes-gained accounting per round, per category.

Explicit non-goal for v1: this is not a scorecard app or a stat tracker that happens to compute SG. The aim recommendation is the product. Stats are a byproduct.

---

## 2. Architecture

**Recommended stack:** React (or React Native) + Supabase (Postgres + PostGIS + auth). Offline-first is mandatory — cell coverage on courses is unreliable and the app is useless if it can't log a shot or compute an aim point without signal.

Implications:

- Course geometry for the current round must be cached locally at round start.
- The dispersion model and expected-strokes table must live client-side. Aim optimization runs on-device (~5k samples × ~200 candidate points is a few hundred ms in JS; use typed arrays).
- Shot log writes go to a local queue and sync opportunistically.
- Model refit can happen server-side on sync, but the client needs a local approximate update so recommendations reflect the shot you just logged.

PostGIS is worth enabling for the polygon work — `ST_Contains`, `ST_Distance`, and `ST_Area` do a lot of heavy lifting. Client-side point-in-polygon can use a lightweight library (e.g. `point-in-polygon` or a hand-rolled ray-cast) against the cached geometry.

---

## 3. Data model

### 3.1 Courses and geometry

```
courses
  id, name, location (point), source ('osm' | 'traced' | 'imported'), created_by

holes
  id, course_id, number, par, handicap_index,
  tee_locations (jsonb: [{name: 'blue', point}, ...]),
  green_center (point)

hole_features
  id, hole_id,
  feature_type ('fairway'|'green'|'bunker'|'water'|'ob'|'rough'|'trees'|'cart_path'),
  polygon (geography/polygon),
  penalty_strokes (numeric, default 0),  -- 1 for water, 1 for OB w/ stroke+distance handled separately
  penalty_modifier (numeric, default 0)  -- manual cost adjustment on top of feature type

pin_positions
  id, hole_id, round_id, point, recorded_at
```

Notes:

- `rough` is often better represented as **implicit** — anything inside the hole corridor that isn't another feature. Reduces tracing burden substantially. Only trace rough explicitly when there's a meaningful heavy/light distinction.
- **`penalty_modifier` matters more than it looks.** Feature type alone is too coarse — a flat fairway bunker you can advance a mid-iron from and a lipped-out greenside bunker are both `bunker`, and they differ by most of a stroke. Same for trees: some are a chip-out, some are a punch to the green. When tracing a course you actually know, this field captures the local knowledge that satellite imagery can't. Default 0, adjustable per polygon during tracing.
- OB needs care: it's stroke-and-distance, not a simple penalty. In the expected-strokes lookup, an OB outcome should resolve to `E(original position) + 2`, not `E(landing spot) + 1`.
- Pin positions are per-round, tapped by the user on arrival at the green. Fall back to green centroid if not recorded.

### 3.2 Shots and rounds

```
rounds
  id, user_id, course_id, date, tee_played, conditions (jsonb: wind, temp, firmness)

shots
  id, round_id, hole_id, shot_number,
  club_id,
  start_point (point), start_lie (feature_type),
  end_point (point, nullable), end_lie (feature_type),
  intended_target (point, nullable),
  outcome_grid (text, nullable),      -- coarse entry, see §6
  carry_actual (numeric, nullable),   -- if measured
  penalty (int, default 0),
  sg_value (numeric, computed)
```

Two entry fidelities coexist. GPS-tagged start/end points give exact dispersion data. The one-tap `outcome_grid` gives coarse directional data. Both feed the model; they differ only in the variance of the likelihood term.

### 3.3 Club model

```
clubs
  id, user_id, name, family ('driver'|'wood'|'hybrid'|'long_iron'|'mid_iron'|'short_iron'|'wedge'|'putter'),
  loft, in_bag (bool)

club_posteriors
  club_id,
  mean_carry, carry_var,
  sigma_long_pct, sigma_lat_pct,       -- as fraction of carry
  lateral_bias_pct,                     -- signed; negative = leaks left
  mishit_weight,                        -- mixture component probability
  mishit_sigma_multiplier,
  mishit_lateral_bias_pct,
  n_effective,                          -- pseudo-count, drives shrinkage
  updated_at
```

---

## 4. The dispersion model

### 4.1 Shape

Each club's shot outcome is a 2D mixture in (longitudinal, lateral) coordinates relative to the aim line:

```
p(shot) = (1 - w) · N(μ_normal, Σ_normal) + w · N(μ_mishit, Σ_mishit)
```

- `Σ` is diagonal (long and lateral treated as independent). This is a simplification — real shots have mild correlation (the thin fade) — but it's not worth the parameters at v1 sample sizes.
- σ scales **proportionally** with carry distance, stored as a percentage. This is what lets a 7-iron's data inform a 6-iron.
- `w` is typically 0.05–0.15. The mishit component has 2–3× the σ and usually a directional bias (most players' bad miss is one-directional even when their good miss is centered).

**The mixture is not optional.** A single Gaussian fit to real shot data will underestimate the tail badly, and the tail is precisely what drives the difference between "aim at the pin" and "aim at the fat side." If the model can't represent the snap hook, it can't tell you to bail right.

### 4.2 Hierarchical pooling

Individual clubs get few samples per round (driver ~14, a given mid-iron ~2–3). Fit at two levels:

1. **Family level:** pool all clubs in a family, fit proportional σ, bias, and mishit weight across the family.
2. **Club level:** each club shrinks toward its family fit.

```
θ_club = (n / (n + k)) · θ_observed + (k / (n + k)) · θ_family
```

with `k ≈ 15`. A club with 15 logged shots weights its own data 50/50 against the family; at 60 shots it's ~80% its own.

Families themselves shrink toward the global/handicap prior by the same mechanism.

### 4.3 Cold start

Three onboarding paths, all producing the same object — a posterior with a pseudo-count that sets how strongly it's held:

| Path | Seeds | `n_effective` |
|---|---|---|
| Handicap only | Published dispersion by handicap band | ~3 per club |
| Questionnaire | See §5 | ~10 per club |
| Launch monitor CSV | Direct fit, inflated (see below) | ~30 per club, capped |

⚠️ **Open:** source for handicap-band dispersion priors. Options: derived from Broadie's published distributions, Arccos aggregate data if publicly citable, or hand-constructed from fairway/GIR rates by handicap. Needs to be settled with an actual citation rather than invented numbers.

### 4.4 Simulator data correction

Launch monitor data from mat/simulator sessions is systematically tighter than on-course performance:

- Perfect lie, no slope, no consequence, immediate re-hit.
- Sessions rarely contain the shots that actually cost strokes — people stop tracking after a shank.

Apply a default inflation on import: **lateral σ × 1.2, mishit weight × 1.5**, and expose it as a tunable. Once on-course logging accumulates, weight on-course shots ~3× per-shot against imported sim shots in the likelihood.

Carry distances from sim data are more trustworthy than dispersion, but still check whether the unit reports carry or total, and whether it's normalizing to standard atmospheric conditions.

---

## 5. Questionnaire onboarding

Do **not** ask for σ, or for "average" distances — golfers report their best shot as their average, typically 8–12 yards long.

Ask for counts and directions, which people report accurately:

1. **Fairways hit out of 14** → back out lateral σ given typical fairway width and driving distance.
2. **Penalty or OB strokes in a typical round** → sets mishit weight. This parameter is otherwise unrecoverable from aggregate stats.
3. **Greens in regulation** → calibrates iron family dispersion.
4. **"Is your miss one-way or two-way?"** and which way → sets `lateral_bias` vs. centered. Large effect on recommended aim points.
5. **Per-club carry**, with the stated value treated as roughly the **75th percentile**, not the mean. Apply the correction silently; don't argue with the user about their 7-iron.
6. **Dispersion framing question:** "When you flush a 7-iron versus catch it thin, what's the yardage gap?" People answer this better than they answer for a mean or a spread.

---

## 6. Shot logging

Aggregate stats (fairways hit, GIR) are scalars — they give a hit rate but require assuming the distribution's shape. **Directional miss data gives the shape directly**, which is the whole point. Log direction, always.

**Tee/approach entry — one tap, 3×3 grid:**

```
long-left    long     long-right
left        TARGET        right
short-left   short    short-right
```

Plus a separate explicit flag for **penalty / reload**, since that's the tail component and it's rare enough to need its own capture path rather than being buried in "left."

**GPS enhancement:** if the phone has a fix, capture the point when the user walks to the ball. That upgrades a coarse grid entry into an exact (long, lat) offset. Design the logging so GPS is a bonus, never a requirement — the round has to be loggable in airplane mode.

**Friction budget:** two taps per shot, maximum. If logging a shot takes longer than putting the phone back in the pocket, the app dies in week three. Consider a "log at the ball" pattern where the app knows the previous shot's origin and just needs the current position.

### Grint import

⚠️ **Open:** check what The Grint's export actually produces. If it's a clean CSV with per-hole fairway/GIR/putts, it's worth parsing — it sets true magnitudes on day one (real fairway rate, not self-reported) even though it lacks direction. If it requires scraping, it likely doesn't earn its build cost. Verify before scheduling.

---

## 7. Expected strokes baseline

Every outcome needs a cost. Required: `E(strokes | distance_to_hole, lie)`.

Lies to cover: tee, fairway, rough, sand, recovery/trees, green (by feet).

Shape of the function is smooth and roughly logarithmic in distance for full shots, with lie adding an offset that shrinks with distance (a bad lie hurts far more at 60 yards than at 220).

⚠️ **Open and important:** the baseline must be **skill-appropriate**. PGA Tour baselines will tell a 5-handicap he's losing two strokes a round to the field — technically true, entirely useless for decision-making. Options:

- **(a)** Use a scratch or handicap-indexed baseline table for the SG *reporting*.
- **(b)** Use the player's *own* fitted expected-strokes curve, derived from their logged history, for the *aim optimization*.

These serve different purposes and **(b)** is the one that matters for recommendations — the optimal aim point depends on your own recovery ability, not the Tour's. Build (b) as the optimizer's cost function and (a) as the reporting layer. Until enough personal data exists, (b) falls back to a handicap-indexed table.

Source the table from published work (Broadie, *Every Shot Counts*, has the canonical tables) rather than reconstructing from memory. Store as a fitted function plus lie offsets, not a giant lookup grid.

---

## 8. Aim optimization

For a given shot (start point, lie, hole geometry, club selection):

```
for each candidate aim point on a ~5-yard grid over reachable area:
    sample N = 5000 shots from the club's mixture distribution
    for each sample:
        resolve landing point
        determine lie via point-in-polygon
        handle OB as stroke-and-distance from origin
        compute distance to pin
        cost = E(strokes | distance, lie) + penalty_strokes
    expected_cost = mean(cost)
return argmin(expected_cost)
```

**Output to the user should be more than a point.** Show:

- Recommended aim point and how it differs from "at the pin."
- The expected-strokes gain from taking the recommendation.
- The risk breakdown — "aiming at the pin: 18% water. Aiming 12 yards left: 3% water, costs you 0.1 strokes on the good outcome, saves 0.35 overall."

The comparison is what makes it persuasive. A bare arrow gets ignored.

**Club selection** falls out of the same machinery: run the optimizer per plausible club, compare minima. This is where the app earns its keep on par 5s and drivable par 4s.

**Wind and elevation:** v1 can apply a simple carry adjustment (elevation: ~2 yards per foot of rise/fall as a first approximation; wind: a percentage per mph with headwinds hurting more than tailwinds help). Wind also *increases* dispersion, particularly into the wind — worth a σ multiplier, not just a mean shift.

---

## 9. Course geometry pipeline

**The tracer is the primary path. OSM is an optimization that sometimes saves work.**

This inverts an earlier assumption. Spot-checking real target courses found OSM coverage patchy, and private clubs are systematically the gap — enthusiast mappers cover what they can walk or clearly see. Assume any given course needs tracing and treat OSM coverage as a pleasant surprise.

### Tracing tool (build first)

A canvas over a satellite tile layer. Click to drop polygon vertices, tag the feature type, set a penalty modifier if warranted, move on. Roughly a day of work and it's what makes the app usable at *any* course. Include:

- Per-hole workflow (tee → fairway → hazards → green) rather than free-form, so nothing gets missed.
- Snap-to-previous-vertex for adjacent polygons.
- KML import/export — it's the interchange format the existing open golf-geo tooling speaks, and it keeps the door open to Google Earth as a tracing surface if that's more comfortable than a custom canvas.
- Per-feature `penalty_modifier` entry, since courses you know personally are where this data is most valuable.

**Tile source: NAIP** (USDA National Agriculture Imagery Program). Public domain, no attribution requirement, no ToS restriction on deriving data, ~60cm resolution, full CONUS coverage on a multi-year refresh. 60cm resolves bunker edges and green perimeters cleanly. Available via USGS and Esri-hosted tile services.

Check imagery vintage per course before tracing — a flyover predating a bunker renovation will produce confidently wrong polygons. Where NAIP is stale for a specific course, fall back to whatever imagery is current; for personal-use-only scope the licensing question is moot, and NAIP is the default mainly so nothing needs re-tracing if scope ever expands.

### OSM path (build second)

Query Overpass API by bounding box for `golf=*` tagged ways within `leisure=golf_course`. Relevant tags: `golf=green`, `golf=fairway`, `golf=bunker`, `golf=tee`, `golf=rough`, `golf=water_hazard`, `golf=lateral_water_hazard`, `golf=hole` (the centerline way, which gives hole number and par).

Coverage is bimodal: a course is either fully traced or it's a single undifferentiated blob. Detect this — if a course returns fewer than ~2 features per hole, treat it as unmapped and route to the tracer. Imported OSM polygons should land in the tracer as editable, since they'll lack penalty modifiers and may be coarse.

### Scorecard metadata (separate concern)

Par, stroke index, and tee yardages are available from commercial scorecard APIs (golfcourseapi.com, golfapi.io, and similar) on free tiers with low daily request caps. That's fine — course metadata is fetched once and cached permanently. These APIs do **not** provide polygons; where they offer "coordinates" it's points of interest, which the optimizer can't use. Use them to avoid hand-entering 18 holes × 4 tees, nothing more.

---

## 10. Strokes gained accounting

```
SG = E(strokes | start) − E(strokes | end) − 1 − penalties_incurred
```

Categories: off-the-tee, approach, around-the-green, putting. Standard definitions — OTT is any tee shot on a par 4 or 5; approach is any shot from >30 yards that isn't a tee shot; ATG is inside 30 yards off the green; putting is on the green.

Report per round and as a rolling trend. The interesting view is **SG vs. decision quality** — did the shot lose strokes because of execution, or because the aim point was bad? The app uniquely knows both, since it knows what it recommended and what the user actually did. That's a differentiator worth building: "you executed fine; you were aimed at the wrong place."

---

## 11. Build order

1. **Club model + questionnaire onboarding + local storage.** No course data yet. Verifiable by checking that fitted dispersion looks sane.
2. **Expected-strokes table + SG computation** on manually entered shots. Validates the math against known cases.
3. **Tracer tool + geometry schema.** The primary geometry path. Trace one known course end to end as the test case.
4. **OSM ingest.** Optimization layer — saves tracing on covered courses, feeds into the tracer as editable polygons.
5. **Aim optimizer + recommendation UI.** The actual product; everything above is scaffolding.
6. **On-course logging + Bayesian update loop.** Closes the cycle.
7. **Grint import, sim CSV import.** Nice-to-have accelerators, not blockers.
8. **SG reporting / decision-quality analysis.**

Steps 1–2 are testable in isolation with synthetic data and should be, before any map is involved.

---

## 12. Open decisions summary

| # | Decision | Status |
|---|---|---|
| 1 | OSM coverage at target courses | ✅ **Resolved** — partial, private clubs missing. Tracer is primary path. |
| 2 | Satellite tile provider + license | ✅ **Resolved** — NAIP default; scope is personal use so licensing is not binding. |
| 3 | Source for handicap-band dispersion priors | ⚠️ Open — blocks cold-start quality |
| 4 | Expected-strokes table source | ⚠️ Open — blocks SG accuracy and optimizer cost function |
| 5 | Grint export format | ⚠️ Open — determines whether import is worth building |
| 6 | Launch monitor export schema (carry vs. total, normalization) | ⚠️ Open — blocks CSV importer |
| 7 | Does v1 include putting/short game, or full shots only? | ⚠️ Open — scope |

**#3 and #4 are the ones to guard.** They're the only remaining opens where a coding agent will happily invent plausible numbers rather than flag the gap, and the app will still run and still produce confident output built on fabricated baselines. Require a cited source for both, or explicit `TODO` constants that fail loudly.

On #7 — a defensible v1 scope is **full shots only**. Putting SG requires green contours to be interesting, and green reading is a separate product. Track putts for scoring, don't model them.
