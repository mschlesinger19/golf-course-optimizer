import type { ClubParams } from '../model/types';

/*
 * =====================================================================
 *  INVENTED DISPERSION -- spec section 12, open decision #3
 * =====================================================================
 *
 * These are a plausible mid-handicap bag, not a fitted model and not a
 * handicap-band prior from any published source. The spec calls out this
 * exact file as a place where invented numbers would be laundered into
 * confident output.
 *
 * The point of this build is not that these values are right. It is that the
 * sliders let you sweep them, and watching whether the recommended aim point
 * moves across a plausible range tells you how much precision the real model
 * actually needs. If the aim point is stable across everything below, the
 * hierarchical pooling in spec 4.2 is worth much less than it looks.
 *
 * Shape notes, which are the defensible part:
 *  - Lateral sigma runs wider than longitudinal for full swings.
 *  - The mishit component carries short as well as sideways.
 *  - The mishit bias is one-directional (a left miss here), which is the
 *    asymmetry that pushes an aim point off the pin in the first place.
 */

export const DEFAULT_BAG: ClubParams[] = [
  {
    id: 'driver',
    name: 'Driver',
    family: 'driver',
    meanCarry: 245,
    carrySigmaPct: 0.055,
    lateralSigmaPct: 0.075,
    lateralBiasPct: -0.015,
    mishitWeight: 0.12,
    mishitSigmaMult: 2.4,
    mishitLateralBiasPct: -0.06,
    mishitCarryMult: 0.82,
    rollFairway: 22,
    inBag: true,
  },
  {
    id: '3w',
    name: '3-wood',
    family: 'wood',
    meanCarry: 220,
    carrySigmaPct: 0.05,
    lateralSigmaPct: 0.065,
    lateralBiasPct: -0.012,
    mishitWeight: 0.1,
    mishitSigmaMult: 2.3,
    mishitLateralBiasPct: -0.05,
    mishitCarryMult: 0.84,
    rollFairway: 16,
    inBag: true,
  },
  {
    id: '5w',
    name: '5-wood',
    family: 'wood',
    meanCarry: 202,
    carrySigmaPct: 0.048,
    lateralSigmaPct: 0.06,
    lateralBiasPct: -0.01,
    mishitWeight: 0.09,
    mishitSigmaMult: 2.2,
    mishitLateralBiasPct: -0.045,
    mishitCarryMult: 0.85,
    rollFairway: 13,
    inBag: true,
  },
  {
    id: '4i',
    name: '4-iron',
    family: 'long_iron',
    meanCarry: 185,
    carrySigmaPct: 0.048,
    lateralSigmaPct: 0.057,
    lateralBiasPct: -0.008,
    mishitWeight: 0.1,
    mishitSigmaMult: 2.2,
    mishitLateralBiasPct: -0.04,
    mishitCarryMult: 0.83,
    rollFairway: 10,
    inBag: true,
  },
  {
    id: '6i',
    name: '6-iron',
    family: 'mid_iron',
    meanCarry: 165,
    carrySigmaPct: 0.045,
    lateralSigmaPct: 0.053,
    lateralBiasPct: -0.006,
    mishitWeight: 0.09,
    mishitSigmaMult: 2.1,
    mishitLateralBiasPct: -0.035,
    mishitCarryMult: 0.84,
    rollFairway: 7,
    inBag: true,
  },
];

export function cloneBag(bag: ClubParams[] = DEFAULT_BAG): ClubParams[] {
  return bag.map((c) => ({ ...c }));
}
