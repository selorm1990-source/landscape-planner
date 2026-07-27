// ════════════════════════════════════════════════════════════════════
//  MULTIFUNCTIONAL LANDSCAPE PLANNER  ·  app.js
//  Classification sources: OSM (live tags) | ESRI Sentinel-2 Land Cover 2023 | ESA WorldCover 2021
//  Carbon/GHG/wood: GFW Data API via backend (/api/carbon/analyze, /api/wood/analyze)
//  Crop yields: SPAM via backend (/api/yield/analyze)
// ════════════════════════════════════════════════════════════════════

// ---------- 1. LAND-USE TAXONOMY ----------
const LU_CONFIG = {
  cropland:     { label:'Cropland',                color:'#c9a227', short:'Crop' },
  grassland:    { label:'Grassland',               color:'#7aa84a', short:'Grass' },
  shrubland:    { label:'Shrubland',               color:'#9aa15a', short:'Shrub' },
  agroforestry: { label:'Agroforestry',            color:'#4d8b57', short:'Agrofor' },
  forest:       { label:'Forest',                  color:'#2d5a27', short:'Forest' },
  wetland:      { label:'Wetland',                 color:'#1e5c7a', short:'Wetland' },
  water:        { label:'Water',                   color:'#4b9bd5', short:'Water' },
  bare:         { label:'Bare / sparse',           color:'#c8b89b', short:'Bare' },
  conservation: { label:'Conservation',            color:'#245c3a', short:'Conserv' },
  urban:        { label:'Built-up (excluded)',     color:'#7a7a78', short:'Urban' },
  unknown:      { label:'Unknown / unclassified',  color:'#b6b6b6', short:'Unknown' }
};

const EXCLUDED_LU      = ['urban', 'unknown'];
const DISPLAY_LAND_USES = Object.keys(LU_CONFIG);
const MODEL_LAND_USES   = DISPLAY_LAND_USES.filter(k => !EXCLUDED_LU.includes(k));
const SELECTABLE_LAND_USES = DISPLAY_LAND_USES.filter(k => k !== 'unknown');
const makeCounts = () => Object.fromEntries(DISPLAY_LAND_USES.map(k => [k, 0]));

const ESA_WORLDCOVER_2020 = {
  10: 'forest', 20: 'shrubland', 30: 'grassland', 40: 'cropland',
  50: 'urban',  60: 'bare',      70: 'bare',       80: 'water',
  90: 'wetland', 95: 'wetland',  100: 'bare'
};

const GEE_DYNAMIC_WORLD = {
  water: 'water', trees: 'forest', grass: 'grassland',
  flooded_vegetation: 'wetland', crops: 'cropland',
  shrub_and_scrub: 'shrubland', built: 'urban', bare: 'bare', snow_and_ice: 'bare'
};

const OSM_LANDUSE_MAPPING = {
  farmland:'cropland', farmyard:'cropland', allotments:'cropland',
  orchard:'agroforestry', vineyard:'agroforestry',
  meadow:'grassland', pasture:'grassland', grassland:'grassland',
  grass:'grassland', recreation_ground:'grassland',
  scrub:'shrubland', heath:'shrubland',
  forest:'forest', wood:'forest',
  wetland:'wetland', marsh:'wetland', swamp:'wetland',
  bog:'wetland', fen:'wetland', reedbed:'wetland',
  water:'water', reservoir:'water', river:'water', stream:'water', canal:'water',
  residential:'urban', commercial:'urban', industrial:'urban',
  retail:'urban', education:'urban', cemetery:'urban',
  protected_area:'conservation', nature_reserve:'conservation',
  conservation:'conservation', park:'conservation',
  agroforestry:'agroforestry'
};

function norm(v){
  return String(v ?? '').trim().toLowerCase()
    .replace(/[\s\-]+/g,'_').replace(/[^\w_]/g,'');
}

function inferLandUseFromProperties(props = {}){
  const building = norm(props.building);
  const landuse  = norm(props.landuse || props.land_use);
  const natural  = norm(props.natural);
  const leisure  = norm(props.leisure);
  const amenity  = norm(props.amenity);

  const numericCandidates = [
    props.esa_code, props.worldcover, props.world_cover, props.class_id,
    props.classId, props.code, props.value, props.label_id, props.classification
  ];
  for (const c of numericCandidates){
    const n = Number(c);
    if (Number.isFinite(n) && ESA_WORLDCOVER_2020[n]) return ESA_WORLDCOVER_2020[n];
  }

  const geeNumericCandidates = [props.gee_class, props.dw_class, props.dynamic_world, props.label];
  for (const c of geeNumericCandidates){
    const n = Number(c);
    if (Number.isFinite(n)){
      const map = { 0:'water',1:'forest',2:'grassland',3:'wetland',4:'cropland',
                    5:'shrubland',6:'urban',7:'bare',8:'bare' };
      if (map[n]) return map[n];
    }
  }

  if (props.building && building !== 'no') return 'urban';
  if (['residential','commercial','industrial','retail','education'].includes(landuse)) return 'urban';
  if (['school','college','university','hospital','parking'].includes(amenity)) return 'urban';

  if (norm(props.boundary) === 'protected_area' || props.protect_class ||
      props.protection_title || landuse === 'conservation' || leisure === 'nature_reserve')
    return 'conservation';

  if (['orchard','vineyard','agroforestry'].includes(landuse)) return 'agroforestry';
  if (['farmland','farmyard','allotments'].includes(landuse)) return 'cropland';
  if (['meadow','pasture','grass','grassland','recreation_ground'].includes(landuse)) return 'grassland';
  if (['forest','wood'].includes(landuse) || natural === 'wood') return 'forest';
  if (['scrub','heath'].includes(natural) || ['scrub','heath'].includes(landuse)) return 'shrubland';
  if (['wetland','marsh','swamp','bog','fen','reedbed'].includes(natural) || landuse === 'wetland') return 'wetland';
  if (['water','reservoir'].includes(natural) || props.waterway || landuse === 'reservoir') return 'water';
  if (landuse === 'bare' || ['sand','rock','stone','bare_rock','scree'].includes(natural)) return 'bare';
  const highway = norm(props.highway);
  if (highway && !['path','footway','cycleway','bridleway','steps','corridor','track'].includes(highway)) {
    return 'urban';
  }

  const railway = norm(props.railway);
  if (['station','yard','industrial'].includes(railway)) return 'urban';
  const aeroway = norm(props.aeroway);
  if (aeroway && aeroway !== 'no') return 'urban';

  const stringCandidates = [
    props.landcover, props.land_cover, props.type, props.category,
    props.cover, props.cover_type, props.class, props.classification_name,
    props.lu, props.source_class,
    props.landuse, props.natural, props.leisure, props.amenity,
    props.highway, props.railway, props.aeroway
  ].filter(v => v != null).map(norm);

  for (const val of stringCandidates){
    if (GEE_DYNAMIC_WORLD[val]) return GEE_DYNAMIC_WORLD[val];
  }
  for (const val of stringCandidates){
    if (OSM_LANDUSE_MAPPING[val]) return OSM_LANDUSE_MAPPING[val];
  }

  return null;
}

// ---------- 2. OSM / DRAWN-POLYGON CLASSIFICATION HELPERS ----------
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter'
];

const CLASS_PRIORITY = {
  urban:100, water:90, wetland:85, forest:80, agroforestry:75,
  cropland:70, grassland:60, shrubland:50, bare:40, conservation:10, unknown:0
};

function toFeature(input){
  if (!input) return null;
  if (input.type === 'Feature') return input;
  if (input.type === 'FeatureCollection') return input.features?.[0] || null;
  if (input.geometry) return { type:'Feature', geometry:input.geometry, properties:input.properties||{} };
  if (input.coordinates) return { type:'Feature', geometry:input, properties:{} };
  return null;
}

const polygonAreaHa = poly => turf.area(poly) / 10000;

async function fetchOverpassJSON(query){
  let lastErr = null;
  for (const url of OVERPASS_ENDPOINTS){
    try{
      const res = await fetch(url, {
        method:'POST',
        headers:{ 'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8' },
        body:'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(300000)
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return await res.json();
    } catch(err){ lastErr = err; }
  }
  throw lastErr || new Error('Overpass request failed');
}

async function fetchOSMGeoJSON(poly){
  if (!window.osmtogeojson) throw new Error('osmtogeojson is not loaded');
  const [minX,minY,maxX,maxY] = turf.bbox(poly);
  const query = `
[out:json][timeout:25];
(
  way["building"](${minY},${minX},${maxY},${maxX});
  relation["building"](${minY},${minX},${maxY},${maxX});
  way["landuse"](${minY},${minX},${maxY},${maxX});
  relation["landuse"](${minY},${minX},${maxY},${maxX});
  way["natural"](${minY},${minX},${maxY},${maxX});
  relation["natural"](${minY},${minX},${maxY},${maxX});
  way["landcover"](${minY},${minX},${maxY},${maxX});
  relation["landcover"](${minY},${minX},${maxY},${maxX});
  way["leisure"](${minY},${minX},${maxY},${maxX});
  relation["leisure"](${minY},${minX},${maxY},${maxX});
  way["amenity"](${minY},${minX},${maxY},${maxX});
  relation["amenity"](${minY},${minX},${maxY},${maxX});
  way["boundary"="protected_area"](${minY},${minX},${maxY},${maxX});
  relation["boundary"="protected_area"](${minY},${minX},${maxY},${maxX});
  way["highway"](${minY},${minX},${maxY},${maxX});
  way["waterway"](${minY},${minX},${maxY},${maxX});
  way["barrier"="hedge"](${minY},${minX},${maxY},${maxX});
  way["natural"="tree_row"](${minY},${minX},${maxY},${maxX});
  way["produce"~"cork|nuts|fruit"](${minY},${minX},${maxY},${maxX});
);
out body geom;
`;
  const data = await fetchOverpassJSON(query);
  return osmtogeojson(data);
}

async function fetchOSMAgroForestry(poly){
  if (!window.osmtogeojson) return { features:[] };
  const [minX,minY,maxX,maxY] = turf.bbox(poly);
  const query = `
[out:json][timeout:25];
(
  way["barrier"="hedge"](${minY},${minX},${maxY},${maxX});
  way["natural"="tree_row"](${minY},${minX},${maxY},${maxX});
  way["landuse"="orchard"](${minY},${minX},${maxY},${maxX});
  relation["landuse"="orchard"](${minY},${minX},${maxY},${maxX});
  way["landuse"="vineyard"](${minY},${minX},${maxY},${maxX});
  way["landuse"="plant_nursery"](${minY},${minX},${maxY},${maxX});
  way["produce"~"cork|nuts|fruit|olives|coffee|cocoa"](${minY},${minX},${maxY},${maxX});
  node["natural"="tree"](${minY},${minX},${maxY},${maxX});
);
out body geom;
`;
  try {
    const data = await fetchOverpassJSON(query);
    return osmtogeojson(data);
  } catch(e){
    return { features:[] };
  }
}

function preprocessOSMAgroFeatures(features){
  return features.map(f => {
    const p = f.properties || {};
    let lu = null;

    if (p.barrier === 'hedge')                       lu = 'agroforestry';
    else if (p.natural === 'tree_row')               lu = 'agroforestry';
    else if (['orchard','vineyard','plant_nursery'].includes(p.landuse)) lu = 'agroforestry';
    else if (p.produce && /cork|nuts|fruit|olives|coffee|cocoa/i.test(p.produce)) lu = 'agroforestry';
    else if (p.natural === 'tree')                   lu = 'forest';

    if (!lu) return null;

    let feature = f;
    const gt = f.geometry?.type;
    try {
      if (gt === 'LineString' || gt === 'MultiLineString'){
        feature = turf.buffer(f, 0.015, { units:'kilometers' });
      } else if (gt === 'Point' || gt === 'MultiPoint'){
        feature = turf.buffer(f, 0.008, { units:'kilometers' });
      } else if (gt !== 'Polygon' && gt !== 'MultiPolygon'){
        return null;
      }
    } catch(e){ return null; }

    return { lu, feature, priority: CLASS_PRIORITY[lu] ?? 0 };
  }).filter(Boolean).sort((a,b) => b.priority - a.priority);
}

async function classifyBlend(feat, counts, areaHa){
  const esriCounts = makeCounts();
  await classifyPolygonRemote(feat, esriCounts, areaHa, 'esri');

  const agroGeo  = await fetchOSMAgroForestry(feat);
  const agroLayers = preprocessOSMAgroFeatures(agroGeo.features || []);

  if (!agroLayers.length){
    Object.assign(counts, esriCounts);
    counts.unknown = 0;
    return counts;
  }

  const samples = makeSamplePoints(feat);
  let agroHa = 0;
  if (samples.length && agroLayers.length){
    const haPerPt = areaHa / samples.length;
    for (const pt of samples){
      for (const layer of agroLayers){
        try {
          if (turf.booleanPointInPolygon(pt, layer.feature)){
            agroHa += haPerPt;
            break;
          }
        } catch(_){}
      }
    }
  }

  agroHa = Math.min(agroHa, areaHa * 0.60);

  if (agroHa <= 0){
    Object.assign(counts, esriCounts);
    counts.unknown = 0;
    return counts;
  }

  const remainder = areaHa - agroHa;
  const esriTotal = totalCountArea(esriCounts) || areaHa;
  const scale = remainder / esriTotal;

  DISPLAY_LAND_USES.forEach(k => {
    if (k !== 'unknown') counts[k] = (esriCounts[k] || 0) * scale;
  });
  counts.agroforestry = agroHa;
  counts.unknown = 0;

  setApiStatus('ready',
    `Blend · ESRI base + ${agroLayers.length} OSM agroforestry feature(s)`);
  return counts;
}

function preprocessOSMFeatures(features){
  return features.map(f => {
    const lu = inferLandUseFromProperties(f.properties || {});
    if (!lu) return null;
    let feature = f;
    const gt = f.geometry?.type;
    try{
      if (gt === 'LineString' || gt === 'MultiLineString'){
        if (f.properties?.highway){
          feature = turf.buffer(f, 0.012, { units:'kilometers' });
        } else if (f.properties?.waterway){
          feature = turf.buffer(f, 0.010, { units:'kilometers' });
        } else { return null; }
      } else if (gt === 'Point' || gt === 'MultiPoint'){
        if (f.properties?.building || norm(f.properties?.amenity) === 'school'){
          feature = turf.buffer(f, 0.006, { units:'kilometers' });
        } else { return null; }
      } else if (gt !== 'Polygon' && gt !== 'MultiPolygon'){ return null; }
    } catch(err){ return null; }
    return { lu, feature, priority: CLASS_PRIORITY[lu] ?? 0 };
  }).filter(Boolean).sort((a,b) => b.priority - a.priority);
}

function makeSamplePoints(poly){
  const areaKm2 = Math.max(turf.area(poly) / 1e6, 0.0001);
  let stepKm = 0.03;
  if (areaKm2 < 0.02) stepKm = 0.012;
  else if (areaKm2 < 0.10) stepKm = 0.02;
  else if (areaKm2 > 1) stepKm = 0.06;
  let pts = turf.pointGrid(turf.bbox(poly), stepKm,
    { units:'kilometers', mask:poly }).features;
  if (!pts.length) pts = [turf.pointOnFeature(poly)];
  return pts;
}

// ---------- 2a. REMOTE SENSING CLASSIFICATION APIs ----------
const RS_SOURCES = {
  osm:  { label:'OSM',  short:'OpenStreetMap',
          desc:'Live OpenStreetMap tags — building, landuse, natural, protected area',
          badge:'© OpenStreetMap contributors', icon:'◉' },
  esri: { label:'ESRI', short:'ESRI Sentinel-2 Land Cover 2023',
          desc:'Sentinel-2 10 m global land cover 2023 — ESRI / Impact Observatory',
          badge:'© Esri, Impact Observatory', icon:'⬡',
          url:'https://ic.imagery1.arcgis.com/arcgis/rest/services/Sentinel2_10m_LandCover/ImageServer' },
  esa:  { label:'ESA',  short:'ESA WorldCover 2021',
          desc:'ESA WorldCover 10 m global land cover 2021 — Terrascope WMS',
          badge:'© ESA WorldCover / Terrascope', icon:'⬢',
          url:'https://services.terrascope.be/worldcover/wms' }
};

const ESRI_LC_MAP = {
  1:'water', 2:'forest', 3:'grassland', 4:'wetland', 5:'cropland',
  6:'shrubland', 7:'urban', 8:'bare', 9:'bare',
  10:null, 11:'grassland'
};

const ESRI_STR_MAP = {
  water:'water', trees:'forest', grass:'grassland',
  'flooded vegetation':'wetland', crops:'cropland',
  'scrub/shrub':'shrubland', scrub:'shrubland', shrubs:'shrubland',
  'built area':'urban', 'bare ground':'bare', 'snow/ice':'bare',
  rangeland:'grassland'
};

async function classifyPointESRI(lon, lat){
  const body = new URLSearchParams({
    geometry:        JSON.stringify({ x:lon, y:lat, spatialReference:{ wkid:4326 } }),
    geometryType:    'esriGeometryPoint',
    returnGeometry:  'false',
    returnCatalogItems: 'false',
    f:               'json'
  });

  try {
    const res = await fetch(`${RS_SOURCES.esri.url}/identify`, {
      method: 'POST',
      headers:{ 'Content-Type':'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) throw new Error(`ESRI HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'ESRI error');

    let raw = data.value;
    if (raw == null && data.properties) {
      raw = data.properties.Value
         ?? data.properties.Pixel
         ?? data.properties.ClassName
         ?? data.properties.Class_Name
         ?? data.properties.value
         ?? data.properties.class
         ?? data.properties.label;
    }
    if (raw == null || raw === '' || raw === 'NoData' || raw === 'null' || raw === 'None')
      return 'unknown';

    const n = Math.round(Number(raw));
    if (Number.isFinite(n)) {
      if (n === 10) return 'unknown';
      if (ESRI_LC_MAP[n]) return ESRI_LC_MAP[n];
    }

    const lower = String(raw).trim().toLowerCase();
    if (ESRI_STR_MAP[lower]) return ESRI_STR_MAP[lower];

    return 'unknown';
  } catch (err) {
    return 'unknown';
  }
}

async function classifyPointESA(lon, lat){
  const eps = 0.00045;
  const bbox = `${lon - eps},${lat - eps},${lon + eps},${lat + eps}`;

  const params = new URLSearchParams({
    SERVICE:'WMS', VERSION:'1.1.1', REQUEST:'GetFeatureInfo',
    BBOX: bbox, SRS:'EPSG:4326', WIDTH:'11', HEIGHT:'11',
    LAYERS:'WORLDCOVER_2021_MAP', QUERY_LAYERS:'WORLDCOVER_2021_MAP',
    INFO_FORMAT:'text/plain', I:'5', J:'5'
  });

  try {
    const res = await fetch(`${RS_SOURCES.esa.url}?${params}`, {
      signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) return 'unknown';
    const text = await res.text();
    if (text.includes('ServiceException')) return 'unknown';

    const m = text.match(/GRAY_INDEX\s*[=:]\s*(\d+)/i) ||
              text.match(/value\s*[=:]\s*(\d+)/i) ||
              text.match(/^\s*(\d{2,3})\s*$/m);

    if (m) {
      const n = parseInt(m[1]);
      if (Number.isFinite(n) && n in ESA_WORLDCOVER_2020) return ESA_WORLDCOVER_2020[n];
      if (n === 0 || n === 200) return 'unknown';
    }
    return 'unknown';
  } catch (err) {
    return 'unknown';
  }
}

function makeSamplePointsAPI(poly){
  const areaKm2 = Math.max(turf.area(poly) / 1e6, 0.0001);
  let stepKm = 0.10;
  if (areaKm2 < 0.02)     stepKm = 0.015;
  else if (areaKm2 < 0.1) stepKm = 0.03;
  else if (areaKm2 < 1)   stepKm = 0.06;
  else if (areaKm2 > 20)  stepKm = 0.30;

  let pts = turf.pointGrid(turf.bbox(poly), stepKm,
    { units:'kilometers', mask:poly }).features;
  if (!pts.length) pts = [turf.pointOnFeature(poly)];

  const maxPts = areaKm2 > 5 ? 40 : 100;
  if (pts.length > maxPts){
    const stride = Math.ceil(pts.length / maxPts);
    pts = pts.filter((_,i) => i % stride === 0).slice(0, maxPts);
  }
  return pts;
}

async function runConcurrent(tasks, concurrency = 4){
  const results = new Array(tasks.length);
  let head = 0;
  async function worker(){
    while (head < tasks.length){
      const i = head++;
      results[i] = await tasks[i]().catch(() => 'unknown');
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

async function classifyPolygonRemote(feat, counts, areaHa, source){
  const pts = makeSamplePointsAPI(feat);
  if (!pts.length){
    counts.unknown = Math.max(areaHa, 0.0001);
    return counts;
  }

  const src = RS_SOURCES[source];
  const classifyFn =
    source === 'esri' ? (lo, la) => classifyPointESRI(lo, la) :
    source === 'esa'  ? (lo, la) => classifyPointESA(lo, la)  :
    () => Promise.resolve('unknown');

  const tasks = pts.map(pt => () => {
    const [lo, la] = pt.geometry.coordinates;
    return classifyFn(lo, la).catch(() => 'unknown');
  });

  setApiStatus('loading',
    `Querying <strong>${src?.label || source}</strong> — ${pts.length} sample points…`);

  const labels = await runConcurrent(tasks, 4);
  const knownLabels = labels.filter(l => l !== 'unknown');

  if (knownLabels.length === 0) {
    counts.unknown = Math.max(areaHa, 0.0001);
  } else {
    const freq = {};
    knownLabels.forEach(lu => { freq[lu] = (freq[lu] || 0) + 1; });
    const totalKnown = knownLabels.length;

    const forestFrac = (freq.forest || 0) / totalKnown;
    const cropFrac   = (freq.cropland || 0) / totalKnown;
    const grassFrac  = (freq.grassland || 0) / totalKnown;

    if (forestFrac >= 0.20 && (cropFrac >= 0.20 || grassFrac >= 0.20)) {
      const smaller   = Math.min(forestFrac, Math.max(cropFrac, grassFrac));
      const agroFrac  = Math.min(smaller * 1.5, 0.60);
      freq.agroforestry = (freq.agroforestry || 0) + agroFrac * totalKnown;
      const denom = forestFrac + Math.max(cropFrac, grassFrac);
      const reduceForest = agroFrac * (forestFrac / denom);
      const reduceOther  = agroFrac * (Math.max(cropFrac, grassFrac) / denom);
      if (freq.forest)    freq.forest    -= reduceForest * totalKnown;
      if (freq.cropland)  freq.cropland  -= (cropFrac >= grassFrac ? reduceOther : 0) * totalKnown;
      if (freq.grassland) freq.grassland -= (grassFrac > cropFrac  ? reduceOther : 0) * totalKnown;
    }

    DISPLAY_LAND_USES.filter(k => k !== 'unknown').forEach(k => {
      counts[k] = areaHa * ((freq[k] || 0) / totalKnown);
    });
    counts.unknown = 0;
  }

  const known = knownLabels.length;
  setApiStatus('ready',
    `${src?.label || source} · ${known}/${pts.length} pts classified · <em>${src?.badge || ''}</em>`);
  return counts;
}

async function classifyPolygon(poly){
  const feat = toFeature(poly);
  const counts = makeCounts();
  if (!feat || !feat.geometry) return counts;

  const areaHa = polygonAreaHa(feat);
  const props  = feat.properties || {};

  const explicit = inferLandUseFromProperties(props);
  if (explicit && explicit in counts){
    counts[explicit] = Math.max(areaHa, 0.0001);
    return counts;
  }

  const src = state.rsSource || 'osm';

  if (src !== 'osm'){
    try {
      return await classifyPolygonRemote(feat, counts, areaHa, src);
    } catch(err){
      console.warn(`${src} classification failed — falling back to OSM:`, err);
      setApiStatus('error',
        `${RS_SOURCES[src]?.label || src} error — falling back to OSM. ${err.message}`);
    }
  }

  setApiStatus('loading', 'Querying OpenStreetMap…');
  try{
    const osmGeo = await fetchOSMGeoJSON(feat);
    const layers = preprocessOSMFeatures(osmGeo.features || []);
    const samples = makeSamplePoints(feat);

    if (!samples.length || !layers.length){
      counts.unknown = Math.max(areaHa, 0.0001);
      setApiStatus('ready', RS_SOURCES.osm.badge);
      return counts;
    }

    const haPerSample = areaHa / samples.length;
    for (const pt of samples){
      let chosen = null;
      for (const layer of layers){
        try{
          if (turf.booleanPointInPolygon(pt, layer.feature)){ chosen = layer.lu; break; }
        } catch(_){}
      }
      counts[chosen || 'unknown'] += haPerSample;
    }

    const knownSum = DISPLAY_LAND_USES
      .filter(k => k !== 'unknown')
      .reduce((a, k) => a + (counts[k] || 0), 0);

    if (counts.unknown > 0 && knownSum > 0) {
      const scale = areaHa / knownSum;
      DISPLAY_LAND_USES.filter(k => k !== 'unknown').forEach(k => {
        counts[k] = (counts[k] || 0) * scale;
      });
      counts.unknown = 0;
    } else if (counts.unknown > 0 && knownSum === 0) {
      counts.bare = counts.unknown;
      counts.unknown = 0;
    }

    setApiStatus('ready', RS_SOURCES.osm.badge);
    return counts;
  } catch(err){
    console.warn('OSM classification failed; returning unknown.', err);
    counts.unknown = Math.max(areaHa, 0.0001);
    setApiStatus('error', `OSM query failed: ${err.message}`);
    return counts;
  }
}

// ---------- 3. ECOSYSTEM-SERVICE WEIGHTS ----------
const ECO_WEIGHTS = {
  cropland:     [1.0, 1.0, 1.0, 5.0, 1.5],
  grassland:    [3.0, 2.5, 3.0, 2.5, 3.0],
  shrubland:    [2.0, 1.8, 2.2, 1.2, 2.0],
  agroforestry: [4.0, 4.0, 3.8, 3.8, 3.5],
  forest:       [4.5, 5.0, 4.0, 0.8, 4.5],
  wetland:      [4.8, 3.5, 5.0, 1.0, 4.0],
  water:        [4.0, 1.0, 5.0, 0.0, 4.5],
  bare:         [0.5, 0.2, 0.2, 0.0, 0.3],
  conservation: [5.0, 4.8, 4.2, 0.5, 4.5],
  urban:        [0.0, 0.0, 0.0, 0.0, 0.0],
  unknown:      [0.0, 0.0, 0.0, 0.0, 0.0]
};
const ECO_LABELS = ['Biodiversity','Carbon','Water','Food','Recreation'];

// ---------- 4. PER-HECTARE INDICATORS (FALLBACK) ----------
const INDICATORS = {
  food_t:{ label:'Food yield', unit:'t/yr', dir:'pos', agg:'sum',
    v:{ cropland:6.0,grassland:0.4,shrubland:0.1,agroforestry:3.0,forest:0.05,
        wetland:0.05,water:0.0,bare:0.0,conservation:0.0,urban:0.0,unknown:0.0 }},
  wood_m3:{ label:'Wood / NTFP', unit:'m³/yr', dir:'pos', agg:'sum',
    v:{ cropland:0.0,grassland:0.0,shrubland:0.1,agroforestry:2.5,forest:6.0,
        wetland:0.5,water:0.0,bare:0.0,conservation:1.0,urban:0.0,unknown:0.0 }},
  c_seq:{ label:'C sequestration', unit:'t CO₂e/yr', dir:'pos', agg:'sum',
    v:{ cropland:0.4,grassland:1.5,shrubland:1.0,agroforestry:5.0,forest:8.0,
        wetland:4.0,water:0.5,bare:0.1,conservation:6.5,urban:0.0,unknown:0.0 }},
  ghg_emit:{ label:'GHG emissions', unit:'t CO₂e/yr', dir:'neg', agg:'sum',
    v:{ cropland:3.5,grassland:2.5,shrubland:1.0,agroforestry:0.8,forest:0.2,
        wetland:1.5,water:0.0,bare:0.0,conservation:0.1,urban:0.0,unknown:0.0 }},
  water_demand:{ label:'Water demand', unit:'m³/yr', dir:'neg', agg:'sum',
    v:{ cropland:4500,grassland:600,shrubland:250,agroforestry:1500,forest:300,
        wetland:0,water:0,bare:0,conservation:0,urban:0,unknown:0 }},
  water_retent:{ label:'Green-water ret.', unit:'avg index 0–100', dir:'pos', agg:'mean',
    v:{ cropland:20,grassland:55,shrubland:35,agroforestry:75,forest:85,
        wetland:95,water:100,bare:5,conservation:90,urban:0,unknown:0 }},
  erosion:{ label:'Erosion risk', unit:'avg index 0–100', dir:'neg', agg:'mean',
    v:{ cropland:75,grassland:35,shrubland:45,agroforestry:20,forest:10,
        wetland:5,water:0,bare:90,conservation:8,urban:95,unknown:0 }},
  biodiv:{ label:'Biodiversity', unit:'avg index 0–100', dir:'pos', agg:'mean',
    v:{ cropland:15,grassland:50,shrubland:40,agroforestry:70,forest:78,
        wetland:90,water:80,bare:5,conservation:95,urban:2,unknown:0 }},
  pollination:{ label:'Pollination', unit:'avg index 0–100', dir:'pos', agg:'mean',
    v:{ cropland:25,grassland:55,shrubland:30,agroforestry:80,forest:65,
        wetland:60,water:20,bare:0,conservation:85,urban:0,unknown:0 }}
};

// ---------- 5. INTERACTIONS ----------
const LU_INTERACTIONS = {
  cropland:{
    functions:['Food production'],
    services:['Food, fodder, fibre [Provisioning]','Pollination & biocontrol [Regulating]','Soil fertility cycling [Supporting]','Soil C storage [Regulating]','Erosion control via cover crops [Regulating]'],
    synergies:['Cover crops & rotations build soil microbial activity, aggregates and biopores; reduce runoff.','Adjacent hedgerows / trees act as shelterbelts (wind protection, erosion control).','Pollinator spillover from conservation & agroforestry directly raises yield.','Adjacent wetlands & riparian buffers absorb nutrient and pesticide runoff.','Manure from neighbouring pastures supplies fertility.'],
    tradeoffs:['Food vs Biodiversity — high-yield monoculture suppresses habitat & cycling species.','Food vs Water quality — fertiliser & pesticide runoff degrades waterways.','Food vs Soil C — conventional tillage releases stored soil carbon.','Food vs GHG — irrigation & mechanisation energy partially offset on-farm gains.']
  },
  grassland:{
    functions:['Livestock production','Support biodiversity','Support water regulation'],
    services:['Meat, milk, manure, fodder [Provisioning]','Soil C storage [Regulating]','Habitat for ground-nesting species [Supporting]','Flood / erosion control [Regulating]','Green-water retention [Regulating]'],
    synergies:['Closed manure → grass → livestock loop sustains fertility on-site.','Permanent pastures build SOM and drought resilience.','Pastures intercept runoff from adjacent crop or forest blocks.','Rotational grazing in agroforestry understorey aids weed control.','Pastures support habitat connectivity to agroforestry & conservation patches.'],
    tradeoffs:['Livestock yield vs Biodiversity — intensification & fertiliser cut species richness.','Livestock yield vs GHG — enteric methane and manure N₂O grow with intensity.','Overgrazing degrades soil structure and releases stored carbon.']
  },
  shrubland:{
    functions:['Browse / grazing support','Early-successional habitat','Wind protection'],
    services:['Browse / forage [Provisioning]','Habitat connectivity [Supporting]','Wind / erosion buffering [Regulating]','Carbon storage in woody biomass [Regulating]'],
    synergies:['Shrub belts reduce wind erosion and trap sediment.','Provides transitional habitat between grassland and forest.','Can support pollinators and small fauna when patches are connected.'],
    tradeoffs:['If unmanaged, shrub encroachment can reduce grazing area.','May complicate mechanised land management.']
  },
  agroforestry:{
    functions:['Food production','Timber, fodder, fuelwood','Climate buffering','Water regulation','Biodiversity','Soil improvement'],
    services:['Food + timber + fuelwood [Provisioning]','Pollination & biocontrol [Regulating]','Flood & drought mitigation [Regulating]','Erosion control & windbreaks [Regulating]','Microclimate cooling [Regulating]','Above- & below-ground C [Regulating]','Habitat connectivity [Supporting]','Water filtration [Regulating]'],
    synergies:['N-fixing trees and legumes enrich soil for understorey crops.','Multi-storey canopy slows runoff, traps sediment & nutrients before waterways.','Shade lowers evapotranspiration, buffers heat-stress for crops & livestock.','Pollination, biocontrol, and water regulation extend into adjacent croplands.','Acts as ecological corridor linking conservation areas to woodlots.'],
    tradeoffs:['Tree shading reduces light to understorey crops (species/spacing matters).','Tree rows can limit mechanisation, raising operational costs.','Trees take years to mature → forgone short-term food production.','May harbour pests affecting both system and adjacent crops.']
  },
  forest:{
    functions:['Timber, fodder, fuelwood, biomass','Climate buffering','Water regulation','Biodiversity'],
    services:['Timber, firewood, NTFPs [Provisioning]','Long-term C sequestration [Regulating]','Flood & drought mitigation [Regulating]','Pollinator source populations [Regulating]','Microclimate cooling [Regulating]','Habitat for woodland species [Supporting]','Air purification [Regulating]','Groundwater recharge [Regulating]'],
    synergies:['Multistorey vegetation slows water and traps sediments before waterways.','Woodland corridors connect conservation areas across the landscape.','Reduces runoff, protecting adjacent cropland & grassland from erosion.','Provides foraging area for livestock — increases feed diversity.'],
    tradeoffs:['Timber harvest disrupts habitat; monocultures support fewer species.','Harvest interrupts C sequestration and may release stored carbon.','Can harbour pests affecting nearby food production.']
  },
  wetland:{
    functions:['Water storage, flood & drought mitigation','Water-quality regulation','Habitat for aquatic & wetland species','Carbon storage'],
    services:['Water quantity & quality [Regulating]','Flood control & drought mitigation [Regulating]','Habitat for aquatic species [Supporting]','Irrigation & livestock water supply [Provisioning]','Evaporative microclimate cooling [Regulating]'],
    synergies:['Vegetation strips strip nutrients from inflowing water before open water.','Wetland soils accumulate organic matter, building C stocks.','Filters runoff & nutrient loads from cropland and pasture.','Ponds support pollinators that service surrounding cropland.','Provides overflow storage protecting cropland & pastures from floods.'],
    tradeoffs:['C storage vs Methane — waterlogged soils sequester C but emit CH₄.']
  },
  water:{
    functions:['Water storage','Aquatic habitat','Flood buffering'],
    services:['Water supply [Provisioning]','Flood regulation [Regulating]','Aquatic habitat [Supporting]','Cooling / microclimate buffering [Regulating]'],
    synergies:['Can store stormwater and provide local water security.','Supports aquatic biodiversity and downstream buffering.'],
    tradeoffs:['Open water contributes little to food production.','Standing water may raise evaporation losses in dry settings.']
  },
  bare:{
    functions:['Sparse cover','Disturbance / regeneration stage'],
    services:['Low provisioning [Provisioning]','Low biodiversity support [Supporting]','Low water retention [Regulating]'],
    synergies:['Can represent early restoration or recently disturbed land.','Potential seedbed for natural regeneration if protected.'],
    tradeoffs:['High erosion risk and low productivity.','Poor habitat quality if left exposed.']
  },
  conservation:{
    functions:['Biodiversity','Climate buffering & C sequestration','Water regulation','NTFP provision'],
    services:['Pollination & biocontrol [Regulating]','Flood & drought mitigation [Regulating]','Erosion control [Regulating]','Genetic biodiversity reservoir [Supporting]','Above- & below-ground C [Regulating]','Habitat connectivity [Supporting]','Groundwater recharge & filtration [Regulating]','NTFPs (fruits, nuts, gums, resins) [Provisioning]'],
    synergies:['Pollinators & natural enemies spill over into adjacent fields, lifting yield.','Enhances habitat connectivity for species in agroforestry & woodlots.','Provides mulching material and forage for livestock.','Filters runoff, regulating water flow to adjacent land uses.','Buffers climate extremes for proximate crops and pastures.'],
    tradeoffs:['Biodiversity conservation vs Food production — area is removed from production.','May harbour pests affecting adjacent food production.']
  },
  urban:{
    functions:['Built environment'],
    services:['Settlement / infrastructure [Excluded from ecosystem-service calculations]'],
    synergies:['Tracked for map context and display.','Useful for identifying built-up patches in the landscape.'],
    tradeoffs:['Excluded from ecosystem-service, indicator, and scenario calculations.']
  },
  unknown:{
    functions:['Unclassified'],
    services:['No factual land-cover source available'],
    synergies:['Use real ESA / OSM properties where available.'],
    tradeoffs:['Excluded from ecosystem-service, indicator and scenario calculations.']
  }
};

// ---------- 6. POLICY SCENARIOS ----------
const POLICY_SCENARIOS = [];

POLICY_SCENARIOS.push(
  { id:'rewild_forest', family:'featured',
    name:'Cropland rewilding (→ forest)',
    desc:'20% of cropland is converted to woodlots / forest, boosting biodiversity and carbon storage.',
    apply:s => convert(s,'cropland','forest',0.20) },
  { id:'wetland_restore', family:'featured',
    name:'Wetland restoration',
    desc:'15% of cropland and 10% of forest are restored to wetlands, improving water quality and flood control.',
    apply:s => { let n=convert(s,'cropland','wetland',0.15); return convert(n,'forest','wetland',0.10); } },
  { id:'agroforestry_30', family:'featured',
    name:'Agroforestry uptake (30%)',
    desc:'30% of cropland integrates trees, becoming agroforestry — combines food, biomass, microclimate, and biodiversity.',
    apply:s => convert(s,'cropland','agroforestry',0.30) },
  { id:'silvopasture', family:'featured',
    name:'Silvopasture (grassland → agroforestry)',
    desc:'25% of grassland integrates trees → silvopastoral agroforestry; livestock retained, with shade and C gain.',
    apply:s => convert(s,'grassland','agroforestry',0.25) },
  { id:'conservation_set', family:'featured',
    name:'Conservation set-aside (10%)',
    desc:'10% of cropland is set aside as semi-natural / conservation area for biodiversity & spillover services.',
    apply:s => convert(s,'cropland','conservation',0.10) }
);

POLICY_SCENARIOS.push(
  { id:'shrub_to_forest', family:'restoration',
    name:'Shrubland succession (→ forest)',
    desc:'20% of shrubland is allowed to succeed to forest, increasing C storage and habitat.',
    apply:s => convert(s,'shrubland','forest',0.20) },
  { id:'bare_to_grass', family:'restoration',
    name:'Bare land revegetation (→ grassland)',
    desc:'20% of bare land is revegetated to grassland, improving stability and productivity.',
    apply:s => convert(s,'bare','grassland',0.20) },
  { id:'water_to_wetland', family:'restoration',
    name:'Water-edge wetland restoration',
    desc:'10% of water edges are converted to wetland habitat to improve filtration and buffering.',
    apply:s => convert(s,'water','wetland',0.10) }
);

for (let p=5; p<=30; p+=5){
  const pct = p/100;
  POLICY_SCENARIOS.push({ id:`crop_to_forest_${p}`, family:'cropland transitions',
    name:`${p}% cropland → forest`, desc:`${p}% of cropland is converted to woodlots / planted forest.`,
    apply:s => convert(s,'cropland','forest',pct) });
}

for (let p=5; p<=30; p+=5){
  const pct = p/100;
  POLICY_SCENARIOS.push({ id:`crop_to_agro_${p}`, family:'cropland transitions',
    name:`${p}% cropland → agroforestry`, desc:`${p}% of cropland integrates trees as agroforestry.`,
    apply:s => convert(s,'cropland','agroforestry',pct) });
}

POLICY_SCENARIOS.push({ id:'intensify', family:'intensification',
  name:'Agricultural expansion (-)',
  desc:'15% of grassland and 10% of forest are converted to cropland (food gain, biodiversity & C loss).',
  apply:s => { let n=convert(s,'grassland','cropland',0.15); return convert(n,'forest','cropland',0.10); }
});

function convert(stock, from, to, pct){
  const n = { ...stock };
  const moved = (n[from] || 0) * pct;
  n[from] = (n[from] || 0) - moved;
  n[to]   = (n[to]   || 0) + moved;
  return n;
}

// ---------- 7. APP STATE ----------
const state = {
  counts: null,
  totalHa: 0,
  radarChart: null,
  customConversions: [],
  scenarioFilter: 'all',
  rsSource: 'osm',
  editDebounce: null,
  selectedLayer: null,
  spam: null,
  carbon: null,   // { biomass, change, emissions, interpretation_note, ... }
  wood: null,     // { annualWoodVolume_m3_yr, avgHarvestableVolume_m3_ha_yr, assumptions, ... }
  hydro: null     // { precipitation_mm_yr, runoffCoefficient, annualRunoff_mm_yr, ... }
};

// ---------- 8. MAP ----------
const map = L.map('map').setView([59.33, 18.06], 11);
const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  { attribution:'© OpenStreetMap contributors', maxZoom: 25 });
const esriImagery = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  attribution: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics',
  maxZoom: 20
});

osmLayer.addTo(map);
L.control.layers({
  'OpenStreetMap': osmLayer,
  'Satellite (Esri)': esriImagery
}, null, { position: 'topright', collapsed: true }).addTo(map);

const drawn = new L.FeatureGroup();
map.addLayer(drawn);

new L.Control.Draw({
  edit:{ featureGroup:drawn },
  draw:{
    polygon:{ shapeOptions:{ color:'#2d5a27', fillOpacity:0.2, weight:2 } },
    rectangle:{ shapeOptions:{ color:'#2d5a27', fillOpacity:0.2, weight:2 } },
    polyline:false, marker:false, circle:false, circlemarker:false
  }
}).addTo(map);

map.on('mousemove', e => {
  const lat = e.latlng.lat.toFixed(4);
  const lon = e.latlng.lng.toFixed(4);
  document.getElementById('coordDisplay').textContent =
    `${Math.abs(lat)}°${lat>=0?'N':'S'} ${Math.abs(lon)}°${lon>=0?'E':'W'}`;
});

addSearchControl(map);

map.on('draw:deletestart', () => {
  if (state.selectedLayer) {
    clearSelectedPolygon();
    setTimeout(() => {
      const removeBtn = document.querySelector('.leaflet-draw-edit-remove');
      if (removeBtn) removeBtn.click();
    }, 0);
  }
});

// ========== 9. MAP EVENTS (SINGLE SOURCE OF TRUTH) ==========
let refreshTimeout = null;

map.on('draw:created', async e => {
  const layer = e.layer;
  drawn.addLayer(layer);
  bindSelectable(layer);
  setSelectedLayer(layer);
  const hintEl = document.getElementById('compositionBars');
  if(hintEl) hintEl.innerHTML = '<p class="hint">⏳ Analysing land cover + carbon/wood/crop…</p>';
  await updatePolygonLayer(layer);
});

map.on('draw:edited', e => {
  if(refreshTimeout) clearTimeout(refreshTimeout);
  refreshTimeout = setTimeout(() => {
    e.layers.eachLayer(layer => {
      if(drawn.getLayers().includes(layer)) {
        updatePolygonLayer(layer).catch(err => console.warn('Update failed:', err));
      }
    });
  }, 1000);
});

map.on('draw:editvertex', () => {
  clearTimeout(state.editDebounce);
  state.editDebounce = setTimeout(async () => {
    const promises = [];
    drawn.eachLayer(layer => {
      if (!layer.toGeoJSON) return;
      promises.push(updatePolygonLayer(layer));
    });
    await Promise.all(promises);
    refreshState();
  }, 600);
});

map.on('draw:deleted', () => {
  if(refreshTimeout) clearTimeout(refreshTimeout);
  refreshState();
});

map.on('click', async e => {
  if (drawn.getLayers().length > 0) return;
  const hintEl = document.getElementById('compositionBars');
  if(hintEl) hintEl.innerHTML = '<p class="hint">⏳ Sampling 1 km radius…</p>';
  try {
    const buf = turf.circle([e.latlng.lng, e.latlng.lat], 1, { units:'kilometers' });
    state.counts = await classifyPolygon(buf);
    state.totalHa = polygonAreaHa(buf);
      const { spam, carbon, wood, hydro } = await fetchBackendData(buf);
    state.spam = spam;
    state.carbon = carbon;
    state.wood = wood;
    state.hydro = hydro;
    renderAll();
    if(hintEl) hintEl.innerHTML = '<p class="hint">✅ Analysis complete</p>';
  } catch(err) {
    console.error('Click classification failed:', err);
    if(hintEl) hintEl.innerHTML = '<p class="hint" style="color:red">❌ Error processing click</p>';
  }
});

// ─── CORE POLYGON UPDATER (ALWAYS FETCHES BACKEND DATA) ──────────────
async function updatePolygonLayer(layer) {
  if(!layer || !layer.toGeoJSON) return;
  try {
    if(layer.setStyle) {
      layer.setStyle({ dashArray: '5, 5', opacity: 0.6 });
    }
    const geo = layer.toGeoJSON();
    const ha = polygonAreaHa(geo);

    const [classification] = await Promise.all([
      classifyPolygon(geo)
    ]);

    const { spam, carbon, wood, hydro } = await fetchBackendData(geo);

    layer.meta = { classification, ha, spam, carbon, wood, hydro };

    const dom = Object.entries(classification).sort((a,b)=>b[1]-a[1])[0];
    const color = LU_CONFIG[dom?.[0] || 'unknown']?.color || '#888';
    layer.setStyle({ color, fillColor: color, fillOpacity: 0.3, weight: 2, dashArray: null });

    incrementalRefreshState(layer);
  } catch(err) {
    console.warn('Layer update failed:', err);
  }
}

// ─── BACKEND CALLS (GFW + WOOD + SPAM) ───────────────────────────────

function normalizeWoodResponse(raw) {
  if (!raw) return null;
  if (raw.error) return raw;

  return {
    ...raw,

    meanAGB_Mg_per_ha:
      raw.biomass?.mean_Mg_per_ha ?? null,

    annualWoodVolume_m3_yr:
      raw.wood?.annual_sustainable_yield_m3_yr ?? null,

    avgHarvestableVolume_m3_ha_yr:
      raw.wood?.per_hectare?.annual_yield_m3_ha_yr ?? null,

    areaHa: raw.areaHa ?? null,

    assumptions: {
      woodDensity:
        raw.assumptions?.woodDensity_kg_m3 ?? 500,
      harvestFraction:
        raw.assumptions?.harvestFraction ?? 0.5,
      rotationYears:
        raw.assumptions?.rotationYears ?? 30
    }
  };
}

async function fetchBackendData(geometry) {
  const feature = toFeature(geometry);
  if (!feature || !feature.geometry)
    return { spam: null, carbon: null, wood: null, hydro: null };

  const [spamRes, carbonRes, woodRes, hydroRes] = await Promise.allSettled([
    fetch('https://landscape-backend-ob7d.onrender.com/api/yield/analyze', {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ geometry: feature }),
      signal: AbortSignal.timeout(300000)
    }),

    fetch('https://landscape-backend-ob7d.onrender.com/api/carbon/analyze', {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ geometry: feature }),
      signal: AbortSignal.timeout(300000)
    }),

    fetch('https://landscape-backend-ob7d.onrender.com/api/wood/analyze', {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ geometry: feature }),
      signal: AbortSignal.timeout(300000)
    }),

    fetch('https://landscape-backend-ob7d.onrender.com/api/hydro/analyze', {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ geometry: feature }),
      signal: AbortSignal.timeout(300000)
    })
  ]);

  let spam = null, carbon = null, wood = null, hydro = null;

  if (spamRes.status === 'fulfilled' && spamRes.value.ok) {
    spam = await spamRes.value.json();
  }

  if (carbonRes.status === 'fulfilled' && carbonRes.value.ok) {
    carbon = await carbonRes.value.json();
  }

  if (woodRes.status === 'fulfilled' && woodRes.value.ok) {
    const rawWood = await woodRes.value.json();
    wood = normalizeWoodResponse(rawWood);
  }

  if (hydroRes.status === 'fulfilled' && hydroRes.value.ok) {
    hydro = await hydroRes.value.json();
  }

  console.log('HYDRO DEBUG:', hydro);
  console.log('WOOD DEBUG:', wood);

  return { spam, carbon, wood, hydro };
}

// ─── STATE AGGREGATION WITH BACKEND DATA ──────────────────────────────
function incrementalRefreshState(changedLayer = null) {
  if(refreshTimeout) clearTimeout(refreshTimeout);
  refreshTimeout = setTimeout(() => {
    const totals = makeCounts();
    let totalHa = 0;
    const spamAgg = {};
    let carbonAgg = null;
    let woodAgg = null;

    drawn.eachLayer(l => {
      if (!l.meta) return;
      DISPLAY_LAND_USES.forEach(k => { totals[k] += l.meta.classification?.[k] || 0; });
      totalHa += l.meta.ha || 0;

      if (l.meta.spam && l.meta.spam.crops) {
        l.meta.spam.crops.forEach(c => {
          if (!spamAgg[c.crop]) {
            spamAgg[c.crop] = { crop: c.crop, harvestedArea_ha: 0, production_t: 0, yieldSum: 0, yieldN: 0 };
          }
          const area = c.harvestedArea_ha || 0;
          spamAgg[c.crop].harvestedArea_ha += area;
          spamAgg[c.crop].production_t += c.production_t || 0;
          spamAgg[c.crop].yieldSum += (c.yield_t_ha || 0) * area;
          spamAgg[c.crop].yieldN += area;
        });
      }

      if (l.meta.carbon) {
        if (!carbonAgg) carbonAgg = { ...l.meta.carbon };
        else {
          const w = (l.meta.ha || 0) / (totalHa || 1);
          if (l.meta.carbon.biomass?.aboveground_biomass_Mg_per_ha != null && carbonAgg.biomass) {
            const prev = carbonAgg.biomass.aboveground_biomass_Mg_per_ha || 0;
            const next = l.meta.carbon.biomass.aboveground_biomass_Mg_per_ha || 0;
            carbonAgg.biomass.aboveground_biomass_Mg_per_ha = prev * (1 - w) + next * w;
          }
          if (l.meta.carbon.emissions?.gross_emissions_co2e_Mg != null && carbonAgg.emissions) {
            const prev = carbonAgg.emissions.gross_emissions_co2e_Mg || 0;
            const next = l.meta.carbon.emissions.gross_emissions_co2e_Mg || 0;
            carbonAgg.emissions.gross_emissions_co2e_Mg = prev * (1 - w) + next * w;
          }
          if (l.meta.carbon.interpretation_note) carbonAgg.interpretation_note = l.meta.carbon.interpretation_note;
        }
      }

      if (l.meta.wood) {
        if (!woodAgg) woodAgg = { ...l.meta.wood };
        else {
          const w = (l.meta.ha || 0) / (totalHa || 1);
          const prevVol = woodAgg.annualWoodVolume_m3_yr || 0;
          const nextVol = l.meta.wood.annualWoodVolume_m3_yr || 0;
          woodAgg.annualWoodVolume_m3_yr = prevVol * (1 - w) + nextVol * w;
          const prevPerHa = woodAgg.avgHarvestableVolume_m3_ha_yr || 0;
          const nextPerHa = l.meta.wood.avgHarvestableVolume_m3_ha_yr || 0;
          woodAgg.avgHarvestableVolume_m3_ha_yr = prevPerHa * (1 - w) + nextPerHa * w;
          woodAgg.assumptions = l.meta.wood.assumptions || woodAgg.assumptions;
        }
      }
      if (l.meta.hydro) {
        if (!state.hydro) state.hydro = { ...l.meta.hydro };
        else {
          // Aggregate water features
          const prev = state.hydro;
          const next = l.meta.hydro;
          if (next.waterFeatures) {
            prev.waterFeatures = prev.waterFeatures || {};
            prev.waterFeatures.riverCount = (prev.waterFeatures.riverCount || 0) + (next.waterFeatures.riverCount || 0);
            prev.waterFeatures.lakeCount = (prev.waterFeatures.lakeCount || 0) + (next.waterFeatures.lakeCount || 0);
            prev.waterFeatures.wetlandCount = (prev.waterFeatures.wetlandCount || 0) + (next.waterFeatures.wetlandCount || 0);
          }
          if (next.hydrology) {
            prev.hydrology = prev.hydrology || {};
            prev.hydrology.annualWaterYield_m3_yr = (prev.hydrology.annualWaterYield_m3_yr || 0) + (next.hydrology.annualWaterYield_m3_yr || 0);
          }
        }
      }
    });

    const spamCrops = Object.values(spamAgg).map(c => ({
      crop: c.crop,
      harvestedArea_ha: +c.harvestedArea_ha.toFixed(2),
      yield_t_ha: c.yieldN > 0 ? +(c.yieldSum / c.yieldN).toFixed(2) : 0,
      production_t: +c.production_t.toFixed(2)
    })).sort((a, b) => b.production_t - a.production_t);

    state.counts = totals;
    state.totalHa = totalHa;
    state.spam = spamCrops.length > 0 ? {
      totalYield_t: +spamCrops.reduce((s, c) => s + c.production_t, 0).toFixed(2),
      majorCrop: spamCrops[0]?.crop || null,
      crops: spamCrops
    } : null;
    state.carbon = carbonAgg || null;
    state.wood = woodAgg || null;
    if(totalHa > 0) renderAll();
  }, 150);
}

function refreshState(){
  incrementalRefreshState();
}

// ─── CLEAR ──────────────────────────────────────────────────
function clearAll(){
  drawn.clearLayers();
  state.counts = null;
  state.totalHa = 0;
  state.spam = null;
  state.carbon = null;
  state.wood = null;
  state.customConversions = [];
  if(refreshTimeout) clearTimeout(refreshTimeout);

  document.getElementById('compositionBars').innerHTML =
    '<p class="hint">Draw a polygon or click the map to analyse.</p>';
  ['radarSection','indicatorSection','areaStatWrap','clearBtn','carbonSidebarSection']
    .forEach(id => { const el = document.getElementById(id); if(el) el.style.display = 'none'; });
  document.getElementById('totalAreaBadge').textContent = '0 ha drawn';
  if(state.radarChart){ state.radarChart.destroy(); state.radarChart = null; }
  setApiStatus('info', `${RS_SOURCES[state.rsSource]?.icon || ''} Ready`);
  renderConversionList();
  renderCustomScenario();
  renderCarbonPanel();
  renderWoodPanel();
  renderCropAnalysis();
  renderCarbonSidebar();
}
window.clearAll = clearAll;

// ---------- 10. CORE COMPUTATIONS ----------
function totalCountArea(counts){
  return DISPLAY_LAND_USES.reduce((a,k) => a + (counts[k] || 0), 0) || 1;
}

function fractions(counts){
  const total = totalCountArea(counts);
  return Object.fromEntries(DISPLAY_LAND_USES.map(k => [k, (counts[k] || 0) / total]));
}

function computeEcoScores(counts){
  const f = fractions(counts);
  const dims = [0,0,0,0,0];
  MODEL_LAND_USES.forEach(k => {
    const w = ECO_WEIGHTS[k];
    if (!w) return;
    w.forEach((wi,i) => dims[i] += wi * f[k]);
  });
  return dims.map(v => Math.min(5, +v.toFixed(2)));
}

function computeIndicators(counts){
  const totalArea = totalCountArea(counts);
  const out = {};

  for (const [key, def] of Object.entries(INDICATORS)){
    let weighted = 0;
    DISPLAY_LAND_USES.forEach(k => {
      weighted += (def.v[k] || 0) * (counts[k] || 0);
    });
    out[key] = def.agg === 'mean' ? weighted / totalArea : weighted;
  }

  // FOOD → SPAM total
  if (state.spam && state.spam.totalYield_t > 0){
    out.food_t = state.spam.totalYield_t;
  }

  // WOOD → backend
  if (state.wood && state.wood.annualWoodVolume_m3_yr != null){
    out.wood_m3 = state.wood.annualWoodVolume_m3_yr;
  }

  // CARBON SEQUESTRATION → backend proxy
  if (state.carbon && state.carbon.sequestration?.sequestration_proxy_Mg_CO2e_yr != null){
    out.c_seq = state.carbon.sequestration.sequestration_proxy_Mg_CO2e_yr;
  }

  // GHG EMISSIONS → backend emissions total
  if (state.carbon && state.carbon.emissions?.gross_emissions_co2e_Mg != null){
    out.ghg_emit = state.carbon.emissions.gross_emissions_co2e_Mg;
  }

  return out;
}

const fmt = x => {
  if (x == null || !isFinite(Number(x))) return '—';
  const n = Number(x);
  return n >= 1000 ? Math.round(n).toLocaleString() :
         n >= 10   ? n.toFixed(0) :
         n >= 1    ? n.toFixed(1) :
                     n.toFixed(2);
};

// ---------- 11. RENDERERS ----------
function renderComposition(){
  const c = state.counts;
  if (!c) return;
  const total = totalCountArea(c);
  if (!total){
    document.getElementById('compositionBars').innerHTML =
      '<p class="hint">No classified area in this selection.</p>';
    return;
  }
  const ordered = DISPLAY_LAND_USES.map(k => [k, c[k] || 0]);
  document.getElementById('compositionBars').innerHTML = `
    <div class="bar-group">
      ${ordered.map(([k,v])=>{
        const pct = ((v / total) * 100).toFixed(1);
        const cfg = LU_CONFIG[k];
        return `<div class="bar-row">
          <span class="bar-name">${cfg.label}</span>
          <div class="bar-track">
            <div class="bar-fill" style="width:${pct}%;background:${cfg.color}"></div>
          </div>
          <span class="bar-val">${pct}%</span>
        </div>`;
      }).join('')}
    </div>`;
  document.getElementById('areaStat').textContent =
    `Total area: ${Math.round(state.totalHa).toLocaleString()} ha · ${Math.round(state.totalHa*2.47105).toLocaleString()} acres`;
  document.getElementById('areaStatWrap').style.display = '';
  document.getElementById('clearBtn').style.display = '';
  renderRadar(c);
  renderIndicators(c);
}

function renderRadar(counts){
  const scores = computeEcoScores(counts);
  document.getElementById('radarSection').style.display = '';
  if (state.radarChart){
    state.radarChart.data.datasets[0].data = scores;
    state.radarChart.update();
    return;
  }
  const ctx = document.getElementById('radar').getContext('2d');
  state.radarChart = new Chart(ctx,{
    type:'radar',
    data:{
      labels: ECO_LABELS,
      datasets:[{ label:'Current', data:scores,
        borderColor:'#2d5a27', backgroundColor:'rgba(45,90,39,0.15)',
        pointBackgroundColor:'#2d5a27', borderWidth:1.5, pointRadius:3 }]
    },
    options:{
      responsive:true, maintainAspectRatio:false,
      scales:{ r:{ min:0, max:5,
        ticks:{ stepSize:1, display:false },
        grid:{ color:'rgba(0,0,0,0.08)' },
        angleLines:{ color:'rgba(0,0,0,0.08)' },
        pointLabels:{ font:{ size:10, family:"'DM Mono', monospace" }, color:'#4a4a45' }
      }},
      plugins:{ legend:{ display:false } }
    }
  });
}

function getIndicatorDetail(key, value){
  switch (key) {
    case 'food_t':
      if (state.spam && state.spam.crops && state.spam.crops.length) {
        return {
          detail: `${state.spam.majorCrop || 'Major crop'} · ${state.spam.crops.length} crop${state.spam.crops.length === 1 ? '' : 's'}`,
          clickable: true,
          tab: 'crops'
        };
      }
      return {
        detail: 'No crop breakdown',
        clickable: false,
        tab: null
      };

    case 'wood_m3':
      if (state.wood && state.wood.annualWoodVolume_m3_yr != null) {
        return {
          detail: `${fmt(state.wood.avgHarvestableVolume_m3_ha_yr || 0)} m³/ha/yr`,
          clickable: true,
          tab: 'wood'
        };
      }
      return {
        detail: 'Model estimate',
        clickable: false,
        tab: null
      };

    case 'c_seq':
      if (state.carbon && state.carbon.sequestration) {
        return {
          detail: `${fmt(state.carbon.sequestration.sequestration_proxy_Mg_CO2e_ha_yr || 0)} t CO₂e/ha/yr`,
          clickable: true,
          tab: 'carbon'
        };
      }
      return {
        detail: 'Proxy estimate',
        clickable: false,
        tab: null
      };

    case 'ghg_emit':
      if (state.carbon && state.carbon.emissions) {
        return {
          detail: `${fmt(state.carbon.emissions.gross_emissions_co2e_Mg_per_ha || 0)} t CO₂e/ha`,
          clickable: true,
          tab: 'carbon'
        };
      }
      return {
        detail: 'Loss-based emissions',
        clickable: false,
        tab: null
      };

    default:
      return {
        detail: '',
        clickable: false,
        tab: null
      };
  }
}

function resultBadgeHtml(kind, sourceText = ''){
  const map = {
    direct:   { cls:'badge-direct',   label: sourceText ? `Direct · ${sourceText}` : 'Direct' },
    derived:  { cls:'badge-derived',  label: sourceText ? `Derived · ${sourceText}` : 'Derived' },
    estimated:{ cls:'badge-estimated',label: sourceText ? `Estimated · ${sourceText}` : 'Estimated' },
    none:     { cls:'badge-none',     label: sourceText ? sourceText : 'No result' }
  };
  const item = map[kind] || map.none;
  return `<span class="result-badge ${item.cls}">${item.label}</span>`;
}

function safeNum(v){
  return (v == null || !isFinite(Number(v))) ? null : Number(v);
}

function calcRow(label, provenanceHtml, formulaText, valueText){
  return `
    <tr>
      <td style="width:28%">
        <strong>${label}</strong><br>
        ${provenanceHtml}
      </td>
      <td style="width:42%">
        <div class="formula">${formulaText}</div>
      </td>
      <td style="width:30%">
        <strong>${valueText}</strong>
      </td>
    </tr>
  `;
}

function getIndicatorMeta(key){
  switch (key) {
    case 'food_t':
      if (state.spam && state.spam.totalYield_t > 0) {
        return {
          kind: 'direct',
          source: 'SPAM',
          detail: `${state.spam.majorCrop || 'Major crop'} · ${state.spam.crops?.length || 0} crop${(state.spam.crops?.length || 0) === 1 ? '' : 's'}`,
          tab: 'crops'
        };
      }
      return {
        kind: 'estimated',
        source: 'fallback',
        detail: 'Land-use coefficient fallback',
        tab: 'crops'
      };

    case 'wood_m3':
      if (state.wood && state.wood.annualWoodVolume_m3_yr != null) {
        return {
          kind: 'estimated',
          source: 'GFW biomass model',
          detail: 'Biomass → wood conversion',
          tab: 'wood'
        };
      }
      return {
        kind: 'estimated',
        source: 'fallback',
        detail: 'No backend wood result',
        tab: 'wood'
      };

    case 'c_seq':
      if (state.carbon && state.carbon.sequestration?.sequestration_proxy_Mg_CO2e_yr != null) {
        return {
          kind: 'estimated',
          source: 'GFW biomass proxy',
          detail: 'AGB growth-rate proxy',
          tab: 'carbon'
        };
      }
      return {
        kind: 'estimated',
        source: 'fallback',
        detail: 'No sequestration proxy',
        tab: 'carbon'
      };

    case 'ghg_emit':
      if (state.carbon && state.carbon.emissions?.gross_emissions_co2e_Mg != null) {
        return {
          kind: 'direct',
          source: 'GFW',
          detail: 'gross_emissions_co2e',
          tab: 'ghg'
        };
      }
      return {
        kind: 'estimated',
        source: 'fallback',
        detail: 'Land-use coefficient fallback',
        tab: 'ghg'
      };

    default:
      return {
        kind: 'derived',
        source: '',
        detail: '',
        tab: null
      };
  }
}

function renderIndicators(counts){
  const ind = computeIndicators(counts);
  const grid = document.getElementById('indicatorGrid');
  grid.innerHTML = Object.entries(INDICATORS).map(([key,def])=>{
    const v = ind[key];
    const detail = getIndicatorDetail(key, v);
    const isSpam = (key === 'food_t' && state.spam && state.spam.totalYield_t > 0);
   return `
      <div class="metric-card indicator-card ${detail.clickable ? 'indicator-card--clickable' : ''}"
           data-indicator-key="${key}"
           data-indicator-tab="${detail.tab || ''}">
        <div class="metric-label">${def.label}</div>
        <div class="metric-value">${fmt(v)}</div>
        <div class="metric-unit">${def.unit}${isSpam ? ' · SPAM' : ''}</div>
        ${detail.detail ? `<div class="metric-detail">${detail.detail}</div>` : ''}
      </div>
    `;
  }).join('');

  // attach click handlers
  grid.querySelectorAll('.indicator-card--clickable').forEach(card => {
    card.style.cursor = 'pointer';
    card.title = 'Click to view detailed results';

    card.addEventListener('click', () => {
      const tab = card.dataset.indicatorTab;
      if (tab) openTab(tab);
    });
  });
  document.getElementById('indicatorSection').style.display = '';
}

// ═══════════════════════════════════════════════════════════════
//  ★  NEW: CARBON SIDEBAR SUMMARY
// ═══════════════════════════════════════════════════════════════
function renderCarbonSidebar(){
  const section = document.getElementById('carbonSidebarSection');
  const content = document.getElementById('carbonSidebarContent');
  if (!section || !content) return;

  if (!state.carbon){
    section.style.display = 'none';
    return;
  }

  const c = state.carbon;
  const biomass = c.biomass || {};
  const cover = c.forestCover || {};
  const change = c.change || {};
  const emissions = c.emissions || {};
  const seq = c.sequestration || {};

  const meanAGB = safeNum(biomass.aboveground_biomass_Mg_per_ha);
  const treeCoverDensity = safeNum(cover.tree_cover_density_percent);
  const lossHa = safeNum(change.tree_cover_loss_ha);
  const grossEmissions = safeNum(emissions.gross_emissions_co2e_Mg);
  const emissionsPerHa = safeNum(emissions.gross_emissions_co2e_Mg_per_ha);
  const seqProxy = safeNum(seq.sequestration_proxy_Mg_CO2e_yr);
  const seqPerHa = safeNum(seq.sequestration_proxy_Mg_CO2e_ha_yr);

  const netBalance = (seqProxy != null && grossEmissions != null)
    ? seqProxy - grossEmissions
    : null;

  const areaHa = safeNum(c.areaHa ?? state.totalHa);

  // Build compact sidebar cards
  let html = '';

  // Row 1: Biomass + Tree cover
  html += `
    <div class="metrics-grid-3" style="margin-bottom:8px">
      <div class="metric-card" style="cursor:pointer" onclick="openTab('carbon')">
        <div class="metric-label">Aboveground biomass</div>
        <div class="metric-value">${fmt(meanAGB)}</div>
        <div class="metric-unit">Mg/ha</div>
      </div>
      <div class="metric-card" style="cursor:pointer" onclick="openTab('carbon')">
        <div class="metric-label">Tree cover density</div>
        <div class="metric-value">${fmt(treeCoverDensity)}</div>
        <div class="metric-unit">%</div>
      </div>
      <div class="metric-card" style="cursor:pointer" onclick="openTab('carbon')">
        <div class="metric-label">Tree cover loss</div>
        <div class="metric-value">${fmt(lossHa)}</div>
        <div class="metric-unit">ha</div>
      </div>
    </div>
  `;

  // Row 2: Emissions + Sequestration + Net balance
  html += `
    <div class="metrics-grid-3" style="margin-bottom:8px">
      <div class="metric-card" style="cursor:pointer" onclick="openTab('ghg')">
        <div class="metric-label">Gross emissions</div>
        <div class="metric-value">${fmt(grossEmissions)}</div>
        <div class="metric-unit">Mg CO₂e</div>
        <div class="metric-detail">${emissionsPerHa != null ? fmt(emissionsPerHa) + ' Mg/ha' : ''}</div>
      </div>
      <div class="metric-card" style="cursor:pointer" onclick="openTab('carbon')">
        <div class="metric-label">Sequestration proxy</div>
        <div class="metric-value">${fmt(seqProxy)}</div>
        <div class="metric-unit">Mg CO₂e/yr</div>
        <div class="metric-detail">${seqPerHa != null ? fmt(seqPerHa) + ' Mg/ha/yr' : ''}</div>
      </div>
      <div class="metric-card" style="cursor:pointer" onclick="openTab('ghg')">
        <div class="metric-label">Net balance</div>
        <div class="metric-value">${fmt(netBalance)}</div>
        <div class="metric-unit">Mg CO₂e (${netBalance != null ? (netBalance >= 0 ? 'sink ↑' : 'source ↓') : '—'})</div>
      </div>
    </div>
  `;

  // Row 3: Wood (if available)
  if (state.wood && state.wood.annualWoodVolume_m3_yr != null){
    const woodVol = safeNum(state.wood.annualWoodVolume_m3_yr);
    const woodPerHa = safeNum(state.wood.avgHarvestableVolume_m3_ha_yr);
    const meanWoodAGB = safeNum(state.wood.meanAGB_Mg_per_ha);
    html += `
      <div class="metrics-grid-3" style="margin-bottom:8px">
        <div class="metric-card" style="cursor:pointer" onclick="openTab('wood')">
          <div class="metric-label">Annual wood volume</div>
          <div class="metric-value">${fmt(woodVol)}</div>
          <div class="metric-unit">m³/yr</div>
        </div>
        <div class="metric-card" style="cursor:pointer" onclick="openTab('wood')">
          <div class="metric-label">Wood productivity</div>
          <div class="metric-value">${fmt(woodPerHa)}</div>
          <div class="metric-unit">m³/ha/yr</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Area analysed</div>
          <div class="metric-value">${fmt(areaHa)}</div>
          <div class="metric-unit">ha</div>
        </div>
      </div>
    `;
  }

  // Interpretation note (if available)
  if (c.interpretation_note){
    html += `<div class="calc-note" style="margin-bottom:6px;font-size:10px">${c.interpretation_note}</div>`;
  }

  // Click-to-open hint
  html += `<div style="font-size:10px;color:var(--ink3);margin-top:2px;font-family:var(--font-mono)">
    Click any card to open the detailed <strong>Carbon</strong>, <strong>GHG</strong>, or <strong>Wood</strong> tab.
    Source: GFW Data API via backend.
  </div>`;

  content.innerHTML = html;
  section.style.display = '';
}

function setApiStatus(type, html){
  const el = document.getElementById('apiStatus');
  if (!el) return;
  el.innerHTML = html;
  el.className = `api-status api-status--${type}`;
  el.style.display = html ? '' : 'none';
}

function setSelectedLayer(layer){
  state.selectedLayer = layer || null;
  const btn = document.getElementById('clearSelectedBtn');
  if (btn) btn.style.display = layer ? '' : 'none';
}

function clearSelectedPolygon(){
  const layer = state.selectedLayer;
  if (!layer) return;
  drawn.removeLayer(layer);
  state.selectedLayer = null;
  const btn = document.getElementById('clearSelectedBtn');
  if (btn) btn.style.display = 'none';
  refreshState();
}
window.clearSelectedPolygon = clearSelectedPolygon;

function bindSelectable(layer){
  if (!layer) return;
  layer.on('click', e => {
    L.DomEvent.stopPropagation(e);
    setSelectedLayer(layer);
  });
  layer.on('mouseover', () => {
    if (layer.setStyle) layer.setStyle({ opacity: 0.8, weight: 3 });
  });
  layer.on('mouseout', () => {
    if (layer.meta) {
      const dom = Object.entries(layer.meta.classification).sort((a,b)=>b[1]-a[1])[0];
      const color = LU_CONFIG[dom?.[0] || 'unknown']?.color || '#888';
      layer.setStyle({ opacity: 0.3, weight: 2, fillColor: color, color: color });
    }
  });
}

function openTab(tabName){
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));

  const tab = document.querySelector(`[data-tab="${tabName}"]`);
  const panel = document.getElementById(`panel-${tabName}`);

  if (tab) tab.classList.add('active');
  if (panel) panel.classList.add('active');

  if (tabName === 'crops') renderCropAnalysis();
  if (tabName === 'wood') renderWoodPanel();
  if (tabName === 'carbon') renderCarbonPanel();
  if (tabName === 'ghg') renderGhgPanel();
  if (tabName === 'policy') renderPolicy();
  if (tabName === 'custom') {
    renderConversionList();
    renderCustomScenario();
  }
  if (tabName === 'interactions') renderLandUseNotes();
  if (tabName === 'about') renderAbout();
  if (tabName === 'hydro') renderHydroPanel();
}

// ---------- 11b. SOURCE SELECTOR ----------
function initSourceSelector(){
  const btns = document.querySelectorAll('[data-rs-source]');
  btns.forEach(btn => {
    btn.addEventListener('click', async () => {
      const newSource = btn.dataset.rsSource;
      if (state.rsSource === newSource && drawn.getLayers().length > 0) return;
      state.rsSource = newSource;
      btns.forEach(b => b.classList.toggle('src-btn--active', b === btn));
      const src = RS_SOURCES[state.rsSource];
      setApiStatus('info', `${src.icon} <strong>${src.short}</strong> — ${src.desc}`);
      if (drawn.getLayers().length > 0){
        document.getElementById('compositionBars').innerHTML = `<p class="hint">Re-analysing with ${src.short}…</p>`;
        const promises = [];
        drawn.eachLayer(layer => {
          if (!layer.toGeoJSON) return;
          promises.push(updatePolygonLayer(layer));
        });
        await Promise.all(promises);
        refreshState();
      }
    });
  });
  setApiStatus('info', `${RS_SOURCES.osm.icon} <strong>${RS_SOURCES.osm.short}</strong> — ${RS_SOURCES.osm.desc}`);
}

// ---------- 11c. CROP ANALYSIS (SPAM) ----------
function renderCropAnalysis(){
  const el = document.getElementById('cropAnalysisContent');
  if (!el) return;
  if (!state.spam || !state.spam.crops || !state.spam.crops.length){
    el.innerHTML = '<p class="hint">No SPAM crop data for this area. Draw a polygon over cropland.</p>';
    return;
  }
  const spam = state.spam;
  const top10 = spam.crops.slice(0, 10);
  const maxProd = Math.max(...top10.map(c => c.production_t), 1);
  el.innerHTML = `
    <div class="metric-card" style="margin-bottom:10px">
      <div class="metric-label">Major crop</div>
      <div class="metric-value" style="font-size:16px">${spam.majorCrop || '—'}</div>
      <div class="metric-unit">Total: ${fmt(spam.totalYield_t)} t/yr</div>
    </div>
    <div class="section-label" style="margin-top:8px">Top crops by production</div>
    <div class="bar-group">
      ${top10.map(c => {
        const pct = ((c.production_t / maxProd) * 100).toFixed(1);
        return `<div class="bar-row">
          <span class="bar-name">${c.crop}</span>
          <div class="bar-track">
            <div class="bar-fill" style="width:${pct}%;background:#c9a227"></div>
          </div>
          <span class="bar-val">${fmt(c.production_t)} t</span>
        </div>`;
      }).join('')}
    </div>
    <div class="section-label" style="margin-top:12px">Crop details</div>
    <table style="width:100%;font-size:11px;border-collapse:collapse;font-family:var(--font-mono)">
      <tr style="border-bottom:1px solid #e0e0e0;color:var(--ink3)">
        <th style="text-align:left;padding:4px">Crop</th>
        <th style="text-align:right;padding:4px">Area (ha)</th>
        <th style="text-align:right;padding:4px">Yield (t/ha)</th>
        <th style="text-align:right;padding:4px">Production (t)</th>
      </tr>
      ${spam.crops.map(c => `
        <tr style="border-bottom:1px solid #f0f0f0">
          <td style="padding:4px">${c.crop}</td>
          <td style="text-align:right;padding:4px">${fmt(c.harvestedArea_ha)}</td>
          <td style="text-align:right;padding:4px">${fmt(c.yield_t_ha)}</td>
          <td style="text-align:right;padding:4px">${fmt(c.production_t)}</td>
        </tr>
      `).join('')}
    </table>
    <div style="margin-top:8px;font-size:10px;color:var(--ink3);font-family:var(--font-mono)">
      Source: SPAM 2020 V2r0 · All production systems
    </div>
  `;
}

// ---------- 11d. CARBON PANEL (GFW via backend) ----------
function renderCarbonPanel(){
  const el = document.getElementById('panel-carbon-content');
  if (!el) return;

  if (!state.carbon){
    el.innerHTML = '<p class="hint">Draw a polygon (or click the map) to fetch GFW carbon/biomass results.</p>';
    return;
  }

  const c = state.carbon;
  const biomass = c.biomass || {};
  const cover = c.forestCover || {};
  const change = c.change || {};
  const seq = c.sequestration || {};

  const areaHa = safeNum(c.areaHa ?? state.totalHa);
  const meanAGB = safeNum(biomass.aboveground_biomass_Mg_per_ha);
  const totalBiomass = safeNum(biomass.aboveground_biomass_total_Mg);
  const treeCoverDensity = safeNum(cover.tree_cover_density_percent);
  const lossHa = safeNum(change.tree_cover_loss_ha);

  const seqAss = seq.assumptions || {};
  const incrementFraction = safeNum(seqAss.incrementFraction ?? 0.03);
  const carbonFraction = safeNum(seqAss.carbonFraction ?? 0.5);
  const carbonToCO2e = safeNum(seqAss.carbonToCO2e ?? (44 / 12));
  const discountForLoss = !!seqAss.discountForLoss;
  const lossFraction = (areaHa && lossHa != null) ? Math.min(lossHa / areaHa, 1) : 0;

  const annualBiomassIncrement = meanAGB != null ? meanAGB * incrementFraction : null;
  const annualCarbonIncrement = annualBiomassIncrement != null ? annualBiomassIncrement * carbonFraction : null;
  const annualCO2ePerHa = annualCarbonIncrement != null ? annualCarbonIncrement * carbonToCO2e : null;
  const seqBeforeDiscount = annualCO2ePerHa != null && areaHa != null ? annualCO2ePerHa * areaHa : null;
  const seqAfterDiscount = seq.sequestration_proxy_Mg_CO2e_yr ?? null;

  el.innerHTML = `
    <div class="metrics-grid-3">
      <div class="metric-card">
        <div class="metric-label">Aboveground biomass</div>
        <div class="metric-value">${fmt(meanAGB)}</div>
        <div class="metric-unit">Mg/ha</div>
        ${resultBadgeHtml('direct', 'GFW')}
      </div>

      <div class="metric-card">
        <div class="metric-label">Total biomass</div>
        <div class="metric-value">${fmt(totalBiomass)}</div>
        <div class="metric-unit">Mg</div>
        ${resultBadgeHtml('derived', 'From GFW')}
      </div>

      <div class="metric-card">
        <div class="metric-label">Tree cover density</div>
        <div class="metric-value">${fmt(treeCoverDensity)}</div>
        <div class="metric-unit">%</div>
        ${resultBadgeHtml('direct', 'GFW')}
      </div>

      <div class="metric-card">
        <div class="metric-label">Tree cover loss</div>
        <div class="metric-value">${fmt(lossHa)}</div>
        <div class="metric-unit">ha</div>
        ${resultBadgeHtml('direct', 'GFW')}
      </div>

      <div class="metric-card">
        <div class="metric-label">Sequestration proxy</div>
        <div class="metric-value">${fmt(seqAfterDiscount)}</div>
        <div class="metric-unit">Mg CO₂e/yr</div>
        ${resultBadgeHtml('estimated', 'Model')}
      </div>
    </div>

    <div class="detail-box">
      <div class="section-label">What came from GFW</div>
      <table class="calc-table">
        <tr>
          <th>Result</th>
          <th>Source / method</th>
          <th>Value</th>
        </tr>
        ${calcRow(
          'Aboveground biomass',
          resultBadgeHtml('direct', 'GFW'),
          'Returned by GFW layer aboveground_biomass_2010',
          `${fmt(meanAGB)} Mg/ha`
        )}
        ${calcRow(
          'Tree cover density',
          resultBadgeHtml('direct', 'GFW'),
          'Returned by GFW layer tree_cover_density_2000',
          `${fmt(treeCoverDensity)} %`
        )}
        ${calcRow(
          'Tree cover loss',
          resultBadgeHtml('direct', 'GFW'),
          `Returned by GFW layer tree_cover_loss for ${change.tree_cover_loss_period || 'requested period'}`,
          `${fmt(lossHa)} ha`
        )}
      </table>
    </div>

    <div class="detail-box">
      <div class="section-label">Calculations made</div>
      <table class="calc-table">
        <tr>
          <th>Result</th>
          <th>Formula</th>
          <th>Output</th>
        </tr>
        ${calcRow(
          'Total biomass',
          resultBadgeHtml('derived', 'From GFW'),
          `${fmt(meanAGB)} × ${fmt(areaHa)}`,
          `${fmt(totalBiomass)} Mg`
        )}
        ${calcRow(
          'Annual biomass increment / ha',
          resultBadgeHtml('estimated', 'Model'),
          `${fmt(meanAGB)} × ${fmt(incrementFraction)}`,
          `${fmt(annualBiomassIncrement)} Mg/ha/yr`
        )}
        ${calcRow(
          'Annual carbon increment / ha',
          resultBadgeHtml('estimated', 'Model'),
          `${fmt(annualBiomassIncrement)} × ${fmt(carbonFraction)}`,
          `${fmt(annualCarbonIncrement)} Mg C/ha/yr`
        )}
        ${calcRow(
          'Annual CO₂e / ha',
          resultBadgeHtml('estimated', 'Model'),
          `${fmt(annualCarbonIncrement)} × ${fmt(carbonToCO2e)}`,
          `${fmt(annualCO2ePerHa)} Mg CO₂e/ha/yr`
        )}
        ${calcRow(
          'Sequestration before loss discount',
          resultBadgeHtml('estimated', 'Model'),
          `${fmt(annualCO2ePerHa)} × ${fmt(areaHa)}`,
          `${fmt(seqBeforeDiscount)} Mg CO₂e/yr`
        )}
        ${calcRow(
          'Sequestration after loss discount',
          resultBadgeHtml('estimated', 'Model'),
          discountForLoss ? `${fmt(seqBeforeDiscount)} × (1 - ${fmt(lossFraction)})` : 'No loss discount',
          `${fmt(seqAfterDiscount)} Mg CO₂e/yr`
        )}
      </table>

      <div class="calc-note">
        Sequestration is not a direct GFW output in this app. It is a proxy estimated from biomass, a growth-rate assumption, carbon fraction, and optional discount for tree-cover loss.
      </div>
    </div>
  `;
}

// ---------- 11e. WOOD PANEL (backend) ----------
function renderWoodPanel(){
  const el = document.getElementById('panel-wood-content');
  if (!el) return;

  if (!state.wood){
    el.innerHTML = '<p class="hint">Draw a polygon (or click the map) to fetch wood production from the backend.</p>';
    return;
  }

  if (state.wood.error) {
    el.innerHTML = `
      <p class="hint" style="color:#b04040">
        ${state.wood.error}
      <p>${resultBadgeHtml('estimated', 'No backend result')}</p>
      <div style="font-size:10px;color:var(--ink3);font-family:var(--font-mono)">
        GFW biomass was not returned for this polygon.
      </div>
    `;
    return;
  }

  const w = state.wood;
  const assumptions = w.assumptions || {};
  const areaHa = safeNum(w.areaHa ?? state.totalHa);
  const meanAGB = safeNum(w.meanAGB_Mg_per_ha);
  const woodDensity = safeNum(assumptions.woodDensity ?? 500);
  const harvestFraction = safeNum(assumptions.harvestFraction ?? 0.6);
  const dryBiomassKgPerHa = meanAGB != null ? meanAGB * 1000 : null;
  const aboveGroundVolumePerHa = (dryBiomassKgPerHa != null && woodDensity) ? dryBiomassKgPerHa / woodDensity : null;
  const harvestableVolumePerHa = (aboveGroundVolumePerHa != null && harvestFraction != null)
    ? aboveGroundVolumePerHa * harvestFraction
    : null;
  const annualVolume = (harvestableVolumePerHa != null && areaHa != null)
    ? harvestableVolumePerHa * areaHa
    : null;

  el.innerHTML = `
    <div class="metrics-grid-3">
      <div class="metric-card">
        <div class="metric-label">Mean biomass</div>
        <div class="metric-value">${fmt(w.meanAGB_Mg_per_ha || 0)}</div>
        <div class="metric-unit">Mg/ha</div>
        ${resultBadgeHtml('direct', 'GFW')}
      </div>

      <div class="metric-card">
        <div class="metric-label">Annual wood volume</div>
        <div class="metric-value">${fmt(w.annualWoodVolume_m3_yr || 0)}</div>
        <div class="metric-unit">m³/yr</div>
        ${resultBadgeHtml('estimated', 'Model')}
      </div>

      <div class="metric-card">
        <div class="metric-label">Productivity</div>
        <div class="metric-value">${fmt(w.avgHarvestableVolume_m3_ha_yr || 0)}</div>
        <div class="metric-unit">m³/ha/yr</div>
        ${resultBadgeHtml('estimated', 'Model')}
      </div>
    </div>

    <div class="detail-box">
      <div class="section-label">Calculations made</div>
      <table class="calc-table">
        <tr>
          <th>Result</th>
          <th>Formula</th>
          <th>Output</th>
        </tr>
        ${calcRow(
          'Dry biomass / ha',
          resultBadgeHtml('derived', 'From AGB'),
          `${fmt(meanAGB)} × 1000`,
          `${fmt(dryBiomassKgPerHa)} kg/ha`
        )}
        ${calcRow(
          'Volume / ha',
          resultBadgeHtml('estimated', 'Model'),
          `${fmt(dryBiomassKgPerHa)} ÷ ${fmt(woodDensity)}`,
          `${fmt(aboveGroundVolumePerHa)} m³/ha`
        )}
        ${calcRow(
          'Harvestable volume / ha',
          resultBadgeHtml('estimated', 'Model'),
          `${fmt(aboveGroundVolumePerHa)} × ${fmt(harvestFraction)}`,
          `${fmt(harvestableVolumePerHa)} m³/ha/yr`
        )}
        ${calcRow(
          'Annual wood volume',
          resultBadgeHtml('estimated', 'Model'),
          `${fmt(harvestableVolumePerHa)} × ${fmt(areaHa)}`,
          `${fmt(annualVolume)} m³/yr`
        )}
      </table>
      <div class="calc-note">
        This is a model-based conversion from biomass to wood volume, not a direct GFW wood-production measurement.
      </div>
    </div>
  `;
}

// Render GHG Panel
function renderGhgPanel(){
  const el = document.getElementById('panel-ghg-content');
  if (!el) return;

  if (!state.carbon || !state.carbon.emissions){
    el.innerHTML =
      '<p class="hint">Draw a polygon (or click the map) to fetch GHG emissions from GFW.</p>';
    return;
  }

  const emissions = state.carbon.emissions || {};
  const change = state.carbon.change || {};
  const seq = state.carbon.sequestration || {};

  const gross = emissions.gross_emissions_co2e_Mg ?? 0;
  const perHa = emissions.gross_emissions_co2e_Mg_per_ha ?? 0;

  const sequestration = seq.sequestration_proxy_Mg_CO2e_yr ?? 0;

  const netBalance = sequestration - gross;

  el.innerHTML = `
    <div class="metrics-grid-3">

      <div class="metric-card">
        <div class="metric-label">Gross emissions</div>
        <div class="metric-value">${fmt(gross)}</div>
        <div class="metric-unit">Mg CO₂e</div>
        ${resultBadgeHtml('direct', 'GFW')}
      </div>

      <div class="metric-card">
        <div class="metric-label">Emissions intensity</div>
        <div class="metric-value">${fmt(perHa)}</div>
        <div class="metric-unit">Mg CO₂e / ha</div>
        ${resultBadgeHtml('derived', 'From GFW')}
      </div>

      <div class="metric-card">
        <div class="metric-label">Annual sequestration</div>
        <div class="metric-value">${fmt(sequestration)}</div>
        <div class="metric-unit">Mg CO₂e / yr</div>
        ${resultBadgeHtml('estimated', 'Model')}
      </div>

      <div class="metric-card">
        <div class="metric-label">Net climate balance</div>
        <div class="metric-value">${fmt(netBalance)}</div>
        <div class="metric-unit">
          Mg CO₂e (${netBalance >= 0 ? 'sink' : 'source'})
        </div>
        ${resultBadgeHtml('derived', 'Sequestration − Emissions')}
      </div>

    </div>

    <div class="detail-box">
      <div class="section-label">Loss period</div>
      <div style="font-size:12px;font-family:var(--font-mono)">
        ${change.tree_cover_loss_period || 'Unknown period'}
      </div>
    </div>

    <div class="calc-note">
      Gross emissions are cumulative emissions from tree cover loss.
      Sequestration is an annual growth-based proxy derived from biomass.
      Net balance = annual sequestration − cumulative emissions.
    </div>
  `;
}
function renderHydroPanel(){
  const el = document.getElementById('panel-hydro-content');
  if (!el) return;

  if (!state.hydro){
    el.innerHTML = '<p class="hint">Draw a polygon to analyse water features and hydrology.</p>';
    return;
  }

  const h = state.hydro;
  const wf = h.waterFeatures || {};
  const hy = h.hydrology || {};
  const risks = h.risks || {};
  const rip = h.riparian || {};
  const wb = h.waterBalance || {};

  el.innerHTML = `
    <div class="metrics-grid-3">
      <div class="metric-card">
        <div class="metric-label">Rivers / streams</div>
        <div class="metric-value">${wf.riverCount || 0}</div>
        <div class="metric-unit">features</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Lakes / ponds</div>
        <div class="metric-value">${wf.lakeCount || 0}</div>
        <div class="metric-unit">features</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Wetlands</div>
        <div class="metric-value">${wf.wetlandCount || 0}</div>
        <div class="metric-unit">features</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Stream density</div>
        <div class="metric-value">${fmt(wf.streamDensity_km_per_km2)}</div>
        <div class="metric-unit">km/km²</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Dominant type</div>
        <div class="metric-value" style="font-size:13px">${wf.dominantWaterwayType || '—'}</div>
        <div class="metric-unit">waterway</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Flood risk</div>
        <div class="metric-value" style="font-size:13px">${risks.floodRisk || '—'}</div>
        <div class="metric-unit">estimate</div>
      </div>
    </div>

    <div class="detail-box" style="margin-top:12px">
      <div class="section-label">Water Balance</div>
      <table class="calc-table">
        <tr><th>Component</th><th>Value</th><th>Unit</th></tr>
        <tr><td>Precipitation</td><td>${fmt(hy.precipitation_mm_yr)}</td><td>mm/yr</td></tr>
        <tr><td>Annual runoff</td><td>${fmt(hy.annualRunoff_mm_yr)}</td><td>mm/yr</td></tr>
        <tr><td>Water yield</td><td>${fmt(hy.annualWaterYield_m3_yr)}</td><td>m³/yr</td></tr>
        <tr><td>Baseflow</td><td>${fmt(hy.annualBaseflow_m3_yr)}</td><td>m³/yr</td></tr>
        <tr><td>Baseflow index</td><td>${fmt(hy.baseflowIndex)}</td><td>—</td></tr>
        <tr><td>Runoff coefficient</td><td>${fmt(hy.runoffCoefficient)}</td><td>—</td></tr>
      </table>
    </div>

    ${wf.rivers && wf.rivers.length > 0 ? `
    <div class="detail-box" style="margin-top:12px">
      <div class="section-label">Rivers & Streams</div>
      <table class="calc-table">
        <tr><th>Name</th><th>Type</th><th>Notes</th></tr>
        ${wf.rivers.slice(0, 15).map(r => `
          <tr>
            <td>${r.name || 'Unnamed'}</td>
            <td>${r.type || '—'}</td>
            <td>${r.intermittent ? 'Intermittent' : r.seasonal ? 'Seasonal' : 'Perennial'}</td>
          </tr>
        `).join('')}
      </table>
    </div>` : ''}

    <div class="detail-box" style="margin-top:12px">
      <div class="section-label">Riparian Assessment</div>
      <div style="font-size:12px;line-height:1.6;font-family:var(--font-mono)">
        <div>Buffer length: ${fmt(rip.estimatedRiparianBuffer_km)} km</div>
        <div>Buffer area: ${fmt(rip.estimatedRiparianArea_ha)} ha</div>
        <div style="margin-top:6px">${rip.recommendation || ''}</div>
      </div>
    </div>

    <div class="detail-box" style="margin-top:12px">
      <div class="section-label">Risk Assessment</div>
      <div class="metrics-grid-3">
        <div class="metric-card">
          <div class="metric-label">Flood risk</div>
          <div class="metric-value" style="font-size:13px">${risks.floodRisk || '—'}</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Water quality risk</div>
          <div class="metric-value" style="font-size:13px">${risks.waterQualityRisk || '—'}</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Erosion risk</div>
          <div class="metric-value" style="font-size:13px">${risks.erosionRisk || '—'}</div>
        </div>
      </div>
    </div>

    <div class="calc-note" style="margin-top:8px">
      Water features from OpenStreetMap. Hydrology estimated from latitude-based climate model.
      ${h.note || ''}
    </div>
  `;
}

// ---------- 11f. SEARCH BAR (OSM + ESRI) ----------
function escapeHtml(str){
  return String(str ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
}

function formatBoundsFromNominatim(bb){
  if (!bb || bb.length !== 4) return null;
  const [south, north, west, east] = [Number(bb[0]), Number(bb[1]), Number(bb[2]), Number(bb[3])];
  if (![south, north, west, east].every(Number.isFinite)) return null;
  return L.latLngBounds([[south, west], [north, east]]);
}

function formatBoundsFromEsri(extent){
  if (!extent) return null;
  const xmin = extent.xmin ?? extent.west ?? extent.left;
  const ymin = extent.ymin ?? extent.south ?? extent.bottom;
  const xmax = extent.xmax ?? extent.east ?? extent.right;
  const ymax = extent.ymax ?? extent.north ?? extent.top;
  if (![xmin, ymin, xmax, ymax].every(v => Number.isFinite(Number(v)))) return null;
  return L.latLngBounds([[Number(ymin), Number(xmin)], [Number(ymax), Number(xmax)]]);
}

async function searchOSMFeatures(query, bounds){
  const params = new URLSearchParams({ format:'jsonv2', q:query, limit:'5', addressdetails:'1', namedetails:'1', extratags:'1' });
  if (bounds){ const b = bounds.pad(0.15); params.set('viewbox', `${b.getWest()},${b.getNorth()},${b.getEast()},${b.getSouth()}`); params.set('bounded','0'); }
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`);
  if (!res.ok) throw new Error(`OSM search HTTP ${res.status}`);
  const data = await res.json();
  return (data || []).map(item => ({
    source:'OSM', label:item.display_name || item.namedetails?.name || query,
    lat:Number(item.lat), lon:Number(item.lon), bounds:formatBoundsFromNominatim(item.boundingbox),
    score:Number(item.importance || 0), rawType:item.type || item.class || ''
  })).filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lon));
}

async function searchEsriFeatures(query, bounds){
  const params = new URLSearchParams({ f:'json', singleLine:query, maxLocations:'5', outFields:'Match_addr,PlaceName,Addr_type,Type', forStorage:'false' });
  if (bounds){ const b = bounds.pad(0.15); params.set('searchExtent', `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`); }
  const res = await fetch(`https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?${params.toString()}`);
  if (!res.ok) throw new Error(`ESRI search HTTP ${res.status}`);
  const data = await res.json();
  return (data.candidates || []).map(item => ({
    source:'ESRI', label:item.address || item.attributes?.PlaceName || item.attributes?.Match_addr || query,
    lat:Number(item.location?.y), lon:Number(item.location?.x), bounds:formatBoundsFromEsri(item.extent),
    score:Number(item.score || 0), rawType:item.attributes?.Addr_type || item.attributes?.Type || ''
  })).filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lon));
}

async function searchMajorFeatures(query){
  const bounds = map.getBounds();
  const [osmRes, esriRes] = await Promise.allSettled([ searchOSMFeatures(query, bounds), searchEsriFeatures(query, bounds) ]);
  const results = [];
  if (osmRes.status === 'fulfilled')  results.push(...osmRes.value);
  if (esriRes.status === 'fulfilled') results.push(...esriRes.value);
  const seen = new Set();
  const deduped = results.filter(r => { const key = `${r.label}|${r.lat.toFixed(4)}|${r.lon.toFixed(4)}`; if (seen.has(key)) return false; seen.add(key); return true; });
  return deduped.sort((a,b) => (b.score || 0) - (a.score || 0)).slice(0, 10);
}

function addSearchControl(map){
  const SearchControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function(){
      const div = L.DomUtil.create('div', 'map-search-control');
      div.innerHTML = `
        <div class="map-search-top">
          <button id="mapSearchBtn" type="button" class="map-search-topbtn">Search</button>
        </div>
        <input id="mapSearchInput" type="search" class="map-search-input" placeholder="Search OSM / ESRI…">
        <div id="mapSearchStatus" class="map-search-hint">Search a place or major feature</div>
      `;
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      return div;
    }
  });
  map.addControl(new SearchControl());

  setTimeout(() => {
    const input = document.getElementById('mapSearchInput');
    const btn = document.getElementById('mapSearchBtn');
    const status = document.getElementById('mapSearchStatus');
    let marker = null;

    function normalizeResult(r){
      if (!r) return null;
      let lat = Number(r.lat), lon = Number(r.lon);
      if ((!Number.isFinite(lat) || !Number.isFinite(lon)) && r.bounds && typeof r.bounds.getCenter === 'function'){
        const c = r.bounds.getCenter(); lat = Number(c.lat); lon = Number(c.lng);
      }
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      return { ...r, lat, lon };
    }

    function goToResult(r){
      const result = normalizeResult(r);
      if (!result) { status.textContent = 'No usable location found.'; return; }
      const latlng = [result.lat, result.lon];
      if (marker) map.removeLayer(marker);
      marker = L.circleMarker(latlng, { radius:8, color:'#2d5a27', fillColor:'#4d8b57', fillOpacity:0.9, weight:2 }).addTo(map);
      marker.bindPopup(`<strong>${escapeHtml(result.label)}</strong><br><small>${result.source}${result.rawType ? ' · ' + escapeHtml(result.rawType) : ''}</small>`).openPopup();
      if (result.bounds) { map.fitBounds(result.bounds.pad(0.20)); }
      else { map.setView(latlng, Math.max(map.getZoom(), 12)); }
    }

    async function runSearch(){
      const q = input.value.trim();
      if (!q) return;
      status.textContent = 'Searching OSM + ESRI…';
      try{
        const results = await searchMajorFeatures(q);
        const best = Array.isArray(results) ? results[0] : results;
        const result = normalizeResult(best);
        if (!result){ status.textContent = 'No results found.'; return; }
        goToResult(result);
        status.textContent = '';
      } catch(err){ status.textContent = `Search failed: ${escapeHtml(err.message)}`; }
    }
    btn.addEventListener('click', runSearch);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); });
  }, 0);
}

// ---------- 12. SHAPEFILE UPLOAD ----------
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
if (dropzone) {
  dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('drag'); });
  dropzone.addEventListener('dragleave', () => { dropzone.classList.remove('drag'); });
  dropzone.addEventListener('drop', e => {
    e.preventDefault(); dropzone.classList.remove('drag');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) handleShapefile(e.dataTransfer.files[0]);
  });
}
if (fileInput) {
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) handleShapefile(fileInput.files[0]);
  });
}

async function handleShapefile(file) {
  const status = document.getElementById('uploadStatus');
  if (!status) return;
  status.innerHTML = '<p class="hint">⏳ Reading shapefile…</p>';
  drawn.clearLayers();
  try {
    const buf = await file.arrayBuffer();
    let geojson;
    try { geojson = await shp(buf); } catch(parseErr){ throw new Error(`Failed to parse shapefile: ${parseErr.message}`); }
    const feats = geojson?.type === 'FeatureCollection' ? geojson.features : geojson?.type === 'Feature' ? [geojson] : Array.isArray(geojson) ? geojson : [];
    if (!feats || feats.length === 0) throw new Error('No valid features found in shapefile');
    let added = 0, errored = 0;
    const errors = [];
    const BATCH_SIZE = 5;
    for (let i = 0; i < feats.length; i += BATCH_SIZE) {
      const batch = feats.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async f => {
        try {
          if (!f || !f.geometry) { errored++; return; }
          const geomType = f.geometry.type;
          if (!['Polygon', 'MultiPolygon'].includes(geomType)) { errored++; return; }
          let layer;
          try { layer = L.geoJSON(f).getLayers()[0]; } catch(layerErr){ errored++; return; }
          if (!layer) { errored++; return; }
          drawn.addLayer(layer);
          let ha = 0;
          try { ha = polygonAreaHa(f); } catch(areaErr){ ha = 0; }
          let classification = makeCounts();
          try { classification = await classifyPolygon(f); } catch(classErr){ classification.unknown = Math.max(ha, 0.0001); }
          const { spam, carbon, wood } = await fetchBackendData(f);
          layer.meta = { classification, ha, spam, carbon, wood };
          const dom = Object.entries(classification).sort((a,b)=>b[1]-a[1])[0] || ['unknown', 0];
          layer.setStyle({ color: LU_CONFIG[dom[0]]?.color || '#888888', fillColor: LU_CONFIG[dom[0]]?.color || '#888888', weight: 2, fillOpacity: 0.3 });
          added++;
          status.innerHTML = `<p class="hint">✓ Imported ${added}/${feats.length} features...</p>`;
        } catch(featureErr) { errored++; errors.push(featureErr.message); }
      }));
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (added > 0 && drawn.getLayers().length > 0) {
      try { const bounds = drawn.getBounds(); if (bounds.isValid()) map.fitBounds(bounds, { padding: [50, 50] }); } catch(boundsErr){}
    }
    if (errored > 0 && added > 0) status.innerHTML = `<p class="hint" style="color:#d98000">✓ Imported ${added} of ${feats.length} features (${errored} skipped)</p>`;
    else if (added > 0) status.innerHTML = `<p class="hint">✓ Successfully imported ${added} feature(s)</p>`;
    else status.innerHTML = `<p class="hint" style="color:#b04040">✗ No valid features were imported</p>`;
    if (errors.length > 0) { console.group('Upload Errors'); errors.forEach(err => console.warn(err)); console.groupEnd(); }
    refreshState();
  } catch(err) {
    console.error('Shapefile upload failed:', err);
    status.innerHTML = `<p class="hint" style="color:#b04040">❌ Failed: ${err.message}</p>`;
    drawn.clearLayers();
  }
}

// ---------- 13. ALL-RENDER ----------
function renderAll(){
  document.getElementById('totalAreaBadge').textContent = `${Math.round(state.totalHa).toLocaleString()} ha drawn`;
  if (!state.counts) return;
  renderComposition();
  renderPolicy();
  renderLandUseNotes();
  renderCustomScenario();
  renderCropAnalysis();
  renderCarbonPanel();
  renderWoodPanel();
  renderGhgPanel();
  renderHydroPanel();
  renderCarbonSidebar();   // ★ NEW
}

// ---------- 15. SCENARIOS PANEL ----------
function populateScenarioFilter(){
  const sel = document.getElementById('scenarioFamilySelect');
  if (!sel || sel.dataset.populated) return;
  const families = ['all', ...new Set(POLICY_SCENARIOS.map(s=>s.family))];
  sel.innerHTML = families.map(f => `<option value="${f}">${f === 'all' ? 'All scenarios' : f}</option>`).join('');
  sel.dataset.populated = '1';
  sel.addEventListener('change', e => { state.scenarioFilter = e.target.value; renderPolicy(); });
}

function renderPolicy(){
  const counts = state.counts;
  const hint = document.getElementById('policyHint');
  const ctrls = document.getElementById('scenarioControls');
  const content = document.getElementById('policyContent');
  if (!counts){ hint.style.display=''; ctrls.style.display='none'; content.style.display='none'; return; }
  hint.style.display='none'; ctrls.style.display=''; content.style.display='flex';
  populateScenarioFilter();
  const beforeScores = computeEcoScores(counts);
  const beforeInd = computeIndicators(counts);
  const list = POLICY_SCENARIOS.filter(s => state.scenarioFilter === 'all' || s.family === state.scenarioFilter);
  content.innerHTML = list.map(sc => {
    const after = sc.apply(counts);
    const afterScores = computeEcoScores(after);
    const afterInd = computeIndicators(after);
    const ecoCells = ECO_LABELS.map((nm,i)=>{
      const d = afterScores[i] - beforeScores[i];
      const sign = d > 0 ? '+' : '';
      const cls = d > 0.05 ? 'delta-pos' : d < -0.05 ? 'delta-neg' : 'delta-neu';
      return `<div class="metric-card"><div class="metric-label">${nm}</div><div class="metric-value">${afterScores[i].toFixed(1)}</div><div class="metric-delta ${cls}">${sign}${d.toFixed(2)}</div></div>`;
    }).join('');
    const keyInds = ['food_t','c_seq','water_retent'];
    const indCells = keyInds.map(k=>{
      const def=INDICATORS[k], a=afterInd[k], b=beforeInd[k], d=a-b;
      const goodDir=def.dir==='pos';
      const cls=Math.abs(d)<1e-3?'delta-neu':((d>0)===goodDir?'delta-pos':'delta-neg');
      return `<div class="metric-card"><div class="metric-label">${def.label}</div><div class="metric-value">${fmt(a)}</div><div class="metric-unit">${def.unit}</div><div class="metric-delta ${cls}">${d>0?'+':''}${fmt(d)}</div></div>`;
    }).join('');
    return `<div class="policy-scenario">
      <div class="policy-header"><span style="font-size:14px">◈</span> ${sc.name}</div>
      <div class="policy-body">
        <p class="policy-desc">${sc.desc}</p>
        <div class="section-label" style="margin-top:10px">Ecosystem service profile (0–5)</div>
        <div class="metrics-grid">${ecoCells}</div>
        <div class="section-label" style="margin-top:12px">Key indicators</div>
        <div class="metrics-grid-3">${indCells}</div>
      </div>
    </div>`;
  }).join('');
}

// ---------- 16. CUSTOM CONVERSION PLANNER ----------
function populateConvSelectors(){
  ['convFrom','convTo'].forEach(id=>{
    const sel = document.getElementById(id);
    if (!sel || sel.dataset.populated) return;
    sel.innerHTML = SELECTABLE_LAND_USES.map(k => `<option value="${k}">${LU_CONFIG[k].label}</option>`).join('');
    sel.dataset.populated = '1';
  });
  document.getElementById('convFrom').value = 'cropland';
  document.getElementById('convTo').value = 'agroforestry';
}

function renderConversionList(){
  const el = document.getElementById('conversionList');
  if (!state.customConversions.length){ el.innerHTML = '<p class="hint">No conversions added yet.</p>'; return; }
  el.innerHTML = state.customConversions.map((c,i) =>
    `<div class="conv-item">
      <span>${(c.pct*100).toFixed(0)}% ${LU_CONFIG[c.from].label} → ${LU_CONFIG[c.to].label}</span>
      <button onclick="removeConversion(${i})">remove</button>
    </div>`
  ).join('');
}

window.removeConversion = i => { state.customConversions.splice(i,1); renderConversionList(); renderCustomScenario(); };

function applyCustomConversions(counts){
  let s = { ...counts };
  state.customConversions.forEach(c => { s = convert(s, c.from, c.to, c.pct); });
  return s;
}

function renderCustomScenario(){
  const el = document.getElementById('customScenarioResults');
  if (!state.counts){ el.innerHTML='<p class="hint">Draw an area first.</p>'; return; }
  if (!state.customConversions.length){ el.innerHTML='<p class="hint">Add at least one conversion to see projected outcomes.</p>'; return; }
  const before = state.counts;
  const after = applyCustomConversions(before);
  const beforeScores = computeEcoScores(before);
  const afterScores = computeEcoScores(after);
  const beforeInd = computeIndicators(before);
  const afterInd = computeIndicators(after);
  const total = totalCountArea(before);
  const compHTML = DISPLAY_LAND_USES.map(k=>{
    const b=(before[k]||0)/total*100, a=(after[k]||0)/total*100, d=a-b;
    if (b<0.5 && a<0.5) return '';
    const cls=d>0.05?'delta-pos':d<-0.05?'delta-neg':'delta-neu';
    return `<div class="bar-row">
      <span class="bar-name">${LU_CONFIG[k].label}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${a.toFixed(1)}%;background:${LU_CONFIG[k].color}"></div></div>
      <span class="bar-val ${cls}">${d>=0?'+':''}${d.toFixed(1)}%</span>
    </div>`;
  }).join('');
  const ecoCells = ECO_LABELS.map((nm,i)=>{
    const d=afterScores[i]-beforeScores[i];
    const cls=d>0.05?'delta-pos':d<-0.05?'delta-neg':'delta-neu';
    return `<div class="metric-card"><div class="metric-label">${nm}</div><div class="metric-value">${afterScores[i].toFixed(1)}</div><div class="metric-delta ${cls}">${d>0?'+':''}${d.toFixed(2)}</div></div>`;
  }).join('');
  const indCells = Object.entries(INDICATORS).map(([key,def])=>{
    const a=afterInd[key], b=beforeInd[key], d=a-b;
    const goodDir=def.dir==='pos';
    const cls=Math.abs(d)<1e-3?'delta-neu':((d>0)===goodDir?'delta-pos':'delta-neg');
    return `<div class="metric-card"><div class="metric-label">${def.label}</div><div class="metric-value">${fmt(a)}</div><div class="metric-unit">${def.unit}</div><div class="metric-delta ${cls}">${d>0?'+':''}${fmt(d)}</div></div>`;
  }).join('');
  const narrative = buildNarrative(state.customConversions);
  el.innerHTML = `<div class="policy-scenario">
    <div class="policy-header">▶ Custom scenario outcome</div>
    <div class="policy-body">
      <div class="summary-banner">${narrative}</div>
      <div class="section-label" style="margin-top:8px">Projected composition (Δ vs current)</div>
      <div class="bar-group">${compHTML}</div>
      <div class="section-label" style="margin-top:10px">Ecosystem service profile (0–5)</div>
      <div class="metrics-grid">${ecoCells}</div>
      <div class="section-label" style="margin-top:10px">Key indicators</div>
      <div class="metrics-grid-3">${indCells}</div>
    </div>
  </div>`;
}

function buildNarrative(convs){
  if (!convs.length) return '';
  const bits = convs.map(c => {
    const key = `${c.from}->${c.to}`;
    const lookup = {
      'cropland->forest':'rewilding cropland → forest gains C, biodiversity, water retention; loses food.',
      'cropland->agroforestry':'agroforestry retains food while gaining C, pollination, microclimate buffering.',
      'cropland->wetland':'wetland restoration sharply improves water quality & flood control; food loss.',
      'cropland->conservation':'set-aside maximises biodiversity & spillover services to remaining fields.',
      'cropland->grassland':'extensive pasture lifts soil C and habitat connectivity vs intensive cropping.',
      'grassland->agroforestry':'silvopasture keeps livestock while adding shade, C and biodiversity.',
      'grassland->forest':'afforestation boosts C and biodiversity at the expense of livestock output.',
      'forest->cropland':'expansion releases stored C and reduces habitat — strong negative on biodiversity & water.',
      'grassland->cropland':'intensification gains food but cuts biodiversity, soil C and water retention.',
      'shrubland->forest':'woody succession increases C, habitat and microclimate buffering.',
      'bare->grassland':'revegetation improves stability, erosion control and productivity.',
      'water->wetland':'shallower wetland edges improve habitat and nutrient retention.',
      'urban->conservation':'green infrastructure adds biodiversity and cooling but reduces built-up footprint.'
    };
    const f = LU_CONFIG[c.from].label.toLowerCase();
    const t = LU_CONFIG[c.to].label.toLowerCase();
    return lookup[key] || `${(c.pct*100).toFixed(0)}% of ${f} converted to ${t}.`;
  });
  return '<strong>Storyline.</strong> ' + bits.join(' ');
}

// ---------- 16. INTERACTIONS PANEL ----------
function renderLandUseNotes(){
  const c = state.counts;
  const hint = document.getElementById('interactionsHint');
  const cont = document.getElementById('luNotesContainer');
  if (!c){ hint.style.display=''; cont.innerHTML=''; return; }
  hint.style.display='none';
  const total = totalCountArea(c);
  cont.innerHTML = DISPLAY_LAND_USES.map(k => {
    const cfg = LU_CONFIG[k];
    const I = LU_INTERACTIONS[k];
    const pct = ((c[k] || 0) / total * 100).toFixed(1);
    return `<div class="lu-note" style="border-left-color:${cfg.color}">
      <div class="lu-note-title">${cfg.label} <span style="color:${cfg.color};font-family:var(--font-mono);font-size:11px">· ${pct}%</span></div>
      <div>${I.functions.map(f=>`<span class="tag tag-fn">${f}</span>`).join('')}</div>
      <p><strong>Primary services.</strong></p><ul>${I.services.map(s=>`<li>${s}</li>`).join('')}</ul>
      <p><span class="tag tag-syn">Synergies</span></p><ul>${I.synergies.map(s=>`<li>${s}</li>`).join('')}</ul>
      <p><span class="tag tag-trade">Trade-offs</span></p><ul>${I.tradeoffs.map(t=>`<li>${t}</li>`).join('')}</ul>
    </div>`;
  }).join('');
}

// ---------- 17. ABOUT PANEL ----------
function renderAbout(){
  const el = document.getElementById('frameworkContent');
  if (el.dataset.rendered) return;
  el.innerHTML = `
    <div class="section-label">About this tool</div>
    <p style="font-size:12px;line-height:1.6;color:var(--ink2)">
      The Multifunctional Landscape Planner classifies areas using four factual remote-sensing sources.
      Uploaded features with explicit ESA / GEE class properties are decoded directly.
      Manually drawn polygons are classified by the selected API source (OSM, ESRI, or ESA).
      Carbon/GHG and wood production are fetched from the <strong>GFW Data API</strong> via your backend, so the token stays server-side.
    </p>
    <div class="section-label" style="margin-top:14px">Backend endpoints used</div>
    <p style="font-size:12px;line-height:1.6;color:var(--ink2)">
      • <code>POST /api/carbon/analyze</code> — GFW polygon analysis (biomass stocks, loss, emissions)<br>
      • <code>POST /api/wood/analyze</code> — harvestable wood volume (model-based)<br>
      • <code>POST /api/yield/analyze</code> — SPAM crop yields
    </p>
    <div class="section-label" style="margin-top:14px">Classification sources</div>
    ${Object.entries(RS_SOURCES).map(([id, src])=>`
      <div class="legend-row" style="margin-bottom:6px;align-items:flex-start;gap:10px">
        <span style="font-size:16px;line-height:1">${src.icon}</span>
        <div>
          <strong style="font-size:12px">${src.short}</strong>
          <div style="font-size:11px;color:var(--ink3);margin-top:1px">${src.desc}</div>
          ${src.note ? `<div style="font-size:11px;color:#b08000;margin-top:2px">⚠ ${src.note}</div>` : ''}
          <div style="font-size:10px;font-family:var(--font-mono);color:var(--ink3);margin-top:2px">${src.badge || ''}</div>
        </div>
      </div>`).join('')}
    <div class="section-label" style="margin-top:14px">Land-use legend</div>
    ${DISPLAY_LAND_USES.map(k=>`
      <div class="legend-row">
        <div class="legend-swatch" style="background:${LU_CONFIG[k].color}"></div>
        <span><strong>${LU_CONFIG[k].label}.</strong> ${LU_INTERACTIONS[k]?.functions?.join(' · ') || ''}</span>
      </div>`).join('')}
    <div class="section-label" style="margin-top:14px">Indicators (per landscape, annual)</div>
    <div style="font-size:11.5px;color:var(--ink2);line-height:1.6">
      ${Object.values(INDICATORS).map(d => `<div>• <strong>${d.label}</strong> [${d.unit}] — ${d.dir==='pos'?'higher is better':'lower is better'}.</div>`).join('')}
    </div>
    <div class="section-label" style="margin-top:14px">Sources</div>
    <p style="font-size:11.5px;line-height:1.6;color:var(--ink2)">
      Land-use functions, services, synergies and trade-offs are adapted from the
      <em>Multifunctional Agricultural Landscapes — Integrated Benefits Framework</em>.
      Indicator categories follow the <em>WEAP / LEAP / LEAP-IBC</em> outcomes toolkit.
      Land cover classification uses ESRI Sentinel-2 Land Cover 2023, ESA WorldCover 2021,
      Google Dynamic World V1, and OpenStreetMap live tags. Carbon/biomass/emissions via GFW Data API.
    </p>`;
  el.dataset.rendered = '1';
}

// ---------- 18. INIT ----------
document.addEventListener('DOMContentLoaded', () => {
  populateConvSelectors();
  renderAbout();
  renderConversionList();
  initSourceSelector();
  document.getElementById('addConversionBtn').addEventListener('click', () => {
    const from = document.getElementById('convFrom').value;
    const to = document.getElementById('convTo').value;
    const pct = parseFloat(document.getElementById('convPercent').value);
    if (from === to) { alert('Source and target must differ.'); return; }
    if (!(pct > 0 && pct <= 100)) { alert('Percentage must be 1–100.'); return; }
    state.customConversions.push({ from, to, pct:pct/100 });
    renderConversionList();
    renderCustomScenario();
  });
  document.getElementById('clearConversionsBtn').addEventListener('click', () => {
    state.customConversions = [];
    renderConversionList();
    renderCustomScenario();
  });
  document.getElementById('runCustomBtn').addEventListener('click', renderCustomScenario);
  document.querySelectorAll('.tab').forEach(tab=>{
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
      tab.classList.add('active');
      const panelId = 'panel-' + tab.dataset.tab;
      const panel = document.getElementById(panelId);
      if (panel) panel.classList.add('active');
      if (tab.dataset.tab === 'policy') renderPolicy();
      if (tab.dataset.tab === 'custom') { renderConversionList(); renderCustomScenario(); }
      if (tab.dataset.tab === 'interactions') renderLandUseNotes();
      if (tab.dataset.tab === 'crops') renderCropAnalysis();
      if (tab.dataset.tab === 'wood') renderWoodPanel();
      if (tab.dataset.tab === 'carbon') renderCarbonPanel();
      if (tab.dataset.tab === 'ghg') renderGhgPanel();
      if (tab.dataset.tab === 'about') renderAbout();
    });
  });
});