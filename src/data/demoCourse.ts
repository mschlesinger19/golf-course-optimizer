import type { GeoCourse, GeoFeature } from '../model/course';
import { makeProjector, type LatLng } from '../model/projection';
import { DEMO_HOLE } from './demoHole';

/**
 * The demo hole, lifted into lat/lng so the drag-and-drop page has something
 * to sit on before any real course has been traced.
 *
 * The origin is an arbitrary point in open farmland, chosen precisely because
 * it is not a golf course -- the geometry is invented (see demoHole.ts) and
 * anchoring it to a real club would make it look like surveyed data. Satellite
 * imagery under it will show fields, which is the honest picture.
 */
const ORIGIN: LatLng = { lat: 38.9, lng: -95.6 };

export function buildDemoCourse(): GeoCourse {
  const proj = makeProjector(ORIGIN);
  const toLL = proj.toLatLng;

  const features: GeoFeature[] = DEMO_HOLE.features.map((f) => ({
    id: f.id,
    type: f.type,
    ring: f.polygon.map(toLL),
    penaltyModifier: f.penaltyModifier,
    label: f.label,
  }));

  return {
    id: 'course-demo-synthetic',
    name: 'Demo course (synthetic)',
    imageryNote:
      'Invented geometry over open farmland. Imagery will not match — that is expected.',
    updatedAt: new Date().toISOString(),
    holes: [
      {
        id: 'demo-1',
        number: 1,
        par: DEMO_HOLE.par,
        tee: toLL(DEMO_HOLE.teePoint),
        green: toLL(DEMO_HOLE.greenCenter),
        pin: toLL(DEMO_HOLE.pin),
        centerline: DEMO_HOLE.centerline.map(toLL),
        features,
      },
    ],
  };
}
