import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef, useState } from 'react';
import type { GeoFeature } from '../model/course';
import type { LatLng } from '../model/projection';
import type { FeatureType } from '../model/types';

/**
 * Tile sources. NAIP is the spec 9 default: public domain, no attribution
 * requirement, no restriction on deriving data from it, ~60cm which resolves
 * bunker edges and green perimeters cleanly.
 *
 * Esri World Imagery is offered as a fallback because NAIP is CONUS-only and
 * its refresh is multi-year -- spec 9 warns that a flyover predating a bunker
 * renovation produces confidently wrong polygons, so being able to switch and
 * compare is worth the toggle.
 */
export const TILE_SOURCES = {
  naip: {
    label: 'NAIP (USDA)',
    url: 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/tile/{z}/{y}/{x}',
    attribution: 'USDA NAIP via USGS',
    maxZoom: 19,
  },
  usgs: {
    label: 'USGS Imagery',
    url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
    attribution: 'USGS The National Map',
    maxZoom: 19,
  },
  esri: {
    label: 'Esri World Imagery',
    url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Esri, Maxar, Earthstar Geographics',
    maxZoom: 21,
  },
  none: { label: 'No imagery', url: '', attribution: '', maxZoom: 22 },
} as const;

export type TileSourceKey = keyof typeof TILE_SOURCES;

export const FEATURE_STYLE: Record<FeatureType, { color: string; fill: string }> = {
  fairway: { color: '#7ee08a', fill: '#4fa85a' },
  green: { color: '#c8ffcf', fill: '#8ddf94' },
  bunker: { color: '#f0e2b4', fill: '#d9c48f' },
  water: { color: '#7fc4ff', fill: '#2f6f9f' },
  ob: { color: '#e59ccb', fill: '#8d3f6d' },
  trees: { color: '#4b7a58', fill: '#1c3524' },
  rough: { color: '#8fae91', fill: '#3f6b46' },
  tee: { color: '#ffffff', fill: '#9fc6ae' },
};

export interface MapViewProps {
  center: LatLng;
  zoom?: number;
  features: GeoFeature[];
  /** Fit to these points when they change identity, e.g. on hole switch. */
  fitTo?: LatLng[];
  tileSource: TileSourceKey;
  onMapClick?: (p: LatLng) => void;
  onReady?: (map: L.Map, overlay: L.LayerGroup) => void;
  className?: string;
}

/**
 * Leaflet wrapper. Pages draw their own transient layers (crosshair, scatter,
 * in-progress polygon) into the `overlay` group handed back by `onReady`;
 * this component owns only the tiles and the saved features.
 */
export function MapView({
  center,
  zoom = 17,
  features,
  fitTo,
  tileSource,
  onMapClick,
  onReady,
  className,
}: MapViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileRef = useRef<L.TileLayer | null>(null);
  const featureRef = useRef<L.LayerGroup | null>(null);
  const overlayRef = useRef<L.LayerGroup | null>(null);
  const clickRef = useRef(onMapClick);
  clickRef.current = onMapClick;

  const [tileError, setTileError] = useState(false);

  useEffect(() => {
    if (!hostRef.current || mapRef.current) return;
    const map = L.map(hostRef.current, {
      center: [center.lat, center.lng],
      zoom,
      zoomControl: true,
      attributionControl: true,
      // The whole interaction is drag-a-crosshair; letting the map pan under
      // a drag makes the target impossible to place precisely on a phone.
      doubleClickZoom: false,
    });
    featureRef.current = L.layerGroup().addTo(map);
    overlayRef.current = L.layerGroup().addTo(map);
    map.on('click', (e: L.LeafletMouseEvent) => {
      clickRef.current?.({ lat: e.latlng.lat, lng: e.latlng.lng });
    });
    mapRef.current = map;
    onReady?.(map, overlayRef.current);
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // Mount once. Center/zoom changes are handled by the fitTo effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tile layer, swapped when the source changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (tileRef.current) {
      map.removeLayer(tileRef.current);
      tileRef.current = null;
    }
    setTileError(false);
    const src = TILE_SOURCES[tileSource];
    if (!src.url) return;
    const layer = L.tileLayer(src.url, {
      attribution: src.attribution,
      maxZoom: src.maxZoom,
      maxNativeZoom: src.maxZoom,
      crossOrigin: true,
    });
    layer.on('tileerror', () => setTileError(true));
    layer.addTo(map);
    layer.bringToBack();
    tileRef.current = layer;
  }, [tileSource]);

  // Saved features.
  useEffect(() => {
    const group = featureRef.current;
    if (!group) return;
    group.clearLayers();
    for (const f of features) {
      if (f.ring.length < 3) continue;
      const style = FEATURE_STYLE[f.type];
      L.polygon(
        f.ring.map((p) => [p.lat, p.lng] as [number, number]),
        {
          color: style.color,
          fillColor: style.fill,
          fillOpacity: f.type === 'ob' ? 0.25 : 0.45,
          weight: 1.5,
        },
      )
        .bindTooltip(`${f.label ?? f.type}${f.penaltyModifier ? ` (${f.penaltyModifier > 0 ? '+' : ''}${f.penaltyModifier})` : ''}`)
        .addTo(group);
    }
  }, [features]);

  // Refit when the caller hands over a new set of anchor points.
  const fitKey = fitTo?.map((p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`).join('|') ?? '';
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !fitTo || fitTo.length === 0) return;
    if (fitTo.length === 1) {
      map.setView([fitTo[0].lat, fitTo[0].lng], zoom);
    } else {
      map.fitBounds(
        L.latLngBounds(fitTo.map((p) => [p.lat, p.lng] as [number, number])),
        { padding: [40, 40] },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);

  return (
    <div className={className ?? 'map-host'}>
      <div ref={hostRef} className="map-canvas" />
      {tileError && tileSource !== 'none' && (
        <div className="map-tile-warning">
          Imagery tiles failed to load. Geometry and every number below still work —
          nothing in the model depends on the picture. Try another source, or switch to
          "No imagery".
        </div>
      )}
    </div>
  );
}
