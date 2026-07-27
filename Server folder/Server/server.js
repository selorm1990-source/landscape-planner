require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const turf = require('@turf/turf');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { fromFile, fromUrl } = require('geotiff');

// Use built-in fetch on Node 18+, otherwise fallback to node-fetch
const fetchFn = global.fetch
  ? global.fetch.bind(global)
  : (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();

// ─── Security & basics ─────────────────────────────────────────────────
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ─── Rate limiting ─────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);

const heavyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20
});
app.use('/api/carbon/analyze', heavyLimiter);
app.use('/api/wood/analyze', heavyLimiter);

// ─── Config ────────────────────────────────────────────────────────────
const GFW_DATA_API = process.env.GFW_DATA_API || 'https://data-api.globalforestwatch.org';
const GFW_TIMEOUT_MS = parseInt(process.env.GFW_TIMEOUT_MS || '60000', 10);
const CACHE_TTL_SECONDS = parseInt(process.env.CACHE_TTL_SECONDS || '3600', 10);
const GFW_API_KEY = process.env.GFW_API_KEY || null;
const PORT = parseInt(process.env.PORT || '3000', 10);

const GFW_WOOD_FEATURESERVER =
  'https://services2.arcgis.com/g8WusZB13b9OegfU/arcgis/rest/services/Aboveground_Live_Woody_Biomass_Density/FeatureServer/0';

const GFW_WOOD_DATASET_ID = 'whrc_aboveground_woody_biomass_stock_2000';
const GFW_WOOD_DATASET_VERSION = 'v1.4';

console.log('RUNNING FILE:', __filename);
if (!GFW_API_KEY) {
  console.warn('[WARN] GFW_API_KEY is not set. Outbound GFW calls will likely fail.');
} else {
  console.log('[INFO] GFW_API_KEY is present.');
}

// ─── SPAM local GeoTIFF config ─────────────────────────────────────────
const CROP_CONFIG = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'spamCrops.json'), 'utf8')
);

// ─── Simple in-memory cache ────────────────────────────────────────────
const cache = new Map();

function getCacheKey(prefix, geometry, params) {
  const stable = (obj) => JSON.stringify(obj, Object.keys(obj || {}).sort());
  const geoHash = crypto.createHash('sha1').update(stable(geometry)).digest('hex');
  const paramStr = stable(params || {});
  return `${prefix}:${geoHash}:${paramStr}`;
}

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function setCached(key, value, ttlSeconds) {
  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlSeconds * 1000
  });
}

// ─── Geometry helpers ──────────────────────────────────────────────────
function normalizeGeometry(input) {
  if (!input) throw new Error('Missing geometry');
  if (input.type === 'Feature' && input.geometry) input = input.geometry;
  if (input.type === 'FeatureCollection') {
    if (!input.features || !input.features.length || !input.features[0].geometry)
      throw new Error('Invalid FeatureCollection');
    input = input.features[0].geometry;
  }
  if (input.geometry && input.geometry.type) input = input.geometry;
  if (!input || !input.type) throw new Error('Missing geometry');
  if (input.type !== 'Polygon' && input.type !== 'MultiPolygon')
    throw new Error('Only Polygon and MultiPolygon are supported');
  if (!Array.isArray(input.coordinates) || input.coordinates.length === 0)
    throw new Error('Invalid geometry coordinates');

  const areaM2 = turf.area(input);
  if (!Number.isFinite(areaM2) || areaM2 <= 0) throw new Error('Geometry area is invalid');
  if (areaM2 > 1e9) throw new Error(`Geometry area too large (>${(1e9 / 10000).toFixed(0)} ha)`);

  return input;
}

function toFeature(input) {
  return { type: 'Feature', geometry: normalizeGeometry(input), properties: {} };
}

function getAreaHa(input) { return turf.area(normalizeGeometry(input)) / 10000; }

function fetchOptionsWithTimeout(ms, extra = {}) {
  return { ...extra, signal: AbortSignal.timeout(ms) };
}

function isTimeoutError(err) {
  return (
    err?.name === 'AbortError' ||
    err?.name === 'TimeoutError' ||
    err?.code === 'ETIMEOUT' ||
    err?.code === 'ETIMEDOUT' ||
    /timeout/i.test(String(err?.message || ''))
  );
}

// ─── Generic fetch helpers ─────────────────────────────────────────────
async function fetchJson(url, options = {}, timeoutMs = GFW_TIMEOUT_MS) {
  const res = await fetchFn(url, fetchOptionsWithTimeout(timeoutMs, options));
  const contentType = res.headers.get('content-type') || '';
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} (${contentType}): ${text.slice(0, 1000)}`);
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`Failed to parse JSON from ${url}: ${e.message}. Body: ${text.slice(0, 500)}`); }
}

// ─── GeoTIFF download + sample helpers ─────────────────────────────────
async function downloadToTempFile(url, requestId, suffix = '.tif') {
  // Biomass GeoTIFF tiles are large — use 3-minute timeout
  const WOOD_DOWNLOAD_TIMEOUT = 180000;
  const res = await fetchFn(url, fetchOptionsWithTimeout(WOOD_DOWNLOAD_TIMEOUT));
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Download failed ${res.status}: ${text.slice(0, 500)}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const tmpDir = path.join(__dirname, '.tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const filePath = path.join(tmpDir, `gfw-${requestId}-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

// Track which URLs we've already created sources for
const tiffSourceCache = new Map();

async function getRemoteTiffFromUrl(downloadUrl) {
  if (tiffSourceCache.has(downloadUrl)) return tiffSourceCache.get(downloadUrl);

  console.log(`[WOOD] creating COG source: ${downloadUrl.slice(0, 80)}…`);

  const tiff = await fromUrl(downloadUrl, {
    headers: GFW_API_KEY ? { 'x-api-key': GFW_API_KEY } : {},
    allowFullFile: false // use range requests only
  });

  const image = await tiff.getImage();
  const meta = {
    image,
    bbox: image.getBoundingBox(),
    w: image.getWidth(),
    h: image.getHeight(),
    nodata: image.getGDALNoData ? image.getGDALNoData() : null,
    localPath: null, // no temp file!
    url: downloadUrl
  };

  tiffSourceCache.set(downloadUrl, meta);
  return meta;
}

const getRemoteTiffMeta = getRemoteTiffFromUrl;
async function sampleWoodBiomass(geometry, requestId) {
  const tiles = await queryWoodTileIndex(geometry);
  if (!tiles.length) return { error: 'No intersecting tiles found', tileCount: 0, tiles: [] };

  console.log(`[WOOD][${requestId}] FeatureServer returned ${tiles.length} tiles`);

  const tileInfos = tiles.map(t => ({
    tileId: t.tileId,
    downloadUrl: t.downloadMgHa || buildWoodDownloadUrl(t.tileId)
  }));

  const samplePoints = makeBiomassSamplePoints(geometry);
  console.log(`[WOOD][${requestId}] ${samplePoints.length} sample points`);

  // Load tile sources (range requests, not full downloads)
  const tileSources = [];
  for (const tile of tileInfos) {
    if (!tile.downloadUrl) continue;
    try {
      console.log(`[WOOD][${requestId}] loading tile source ${tile.tileId}…`);
      const meta = await getRemoteTiffFromUrl(tile.downloadUrl);
      tileSources.push({ tileId: tile.tileId, meta });
      console.log(`[WOOD][${requestId}]   ${meta.w}×${meta.h}, bbox=[${meta.bbox.map(v => v.toFixed(1)).join(',')}]`);
    } catch (e) {
      console.warn(`[WOOD][${requestId}]   failed: ${e.message}`);
    }
  }

  if (!tileSources.length)
    return { error: 'No tiles could be loaded', tileCount: tiles.length, tiles: tileInfos.map(t => t.tileId) };

  // Sample pixels
  const values = [];
  let sampleErrors = 0;

  for (const pt of samplePoints) {
    const [lon, lat] = pt.geometry.coordinates;
    for (const tile of tileSources) {
      try {
        const v = await samplePixel(tile.meta, lon, lat);
        if (v != null && Number.isFinite(v) && v > 0) {
          values.push(Number(v));
          break;
        }
      } catch (_) {
        sampleErrors++;
      }
    }
  }

  console.log(`[WOOD][${requestId}] ${values.length}/${samplePoints.length} valid pixels (${sampleErrors} errors)`);

  if (!values.length)
    return { error: 'No valid pixels sampled', sampleCount: 0, tileCount: tileSources.length, tiles: tileSources.map(t => t.tileId) };

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return {
    meanMgHa: +mean.toFixed(2),
    minMgHa: +Math.min(...values).toFixed(2),
    maxMgHa: +Math.max(...values).toFixed(2),
    sampleCount: values.length,
    attemptedSamples: samplePoints.length,
    tileCount: tileSources.length,
    tiles: tileSources.map(t => t.tileId)
  };
}

function cleanupTempFile(filePath) {
  if (!filePath) return;
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {}
}

// ─── SPAM GeoTIFF helpers ──────────────────────────────────────────────
const spamMetaCache = new Map();

async function getImageMeta(relPath) {
  const fullPath = path.join(__dirname, relPath);
  if (spamMetaCache.has(fullPath)) return spamMetaCache.get(fullPath);
  if (!fs.existsSync(fullPath)) { spamMetaCache.set(fullPath, null); return null; }
  try {
    const tiff = await fromFile(fullPath);
    const image = await tiff.getImage();
    const meta = {
      image,
      bbox: image.getBoundingBox(),
      w: image.getWidth(),
      h: image.getHeight(),
      nodata: image.getGDALNoData ? image.getGDALNoData() : null
    };
    spamMetaCache.set(fullPath, meta);
    return meta;
  } catch (e) {
    console.error('[SPAM] Cannot open ' + relPath + ':', e.message);
    spamMetaCache.set(fullPath, null);
    return null;
  }
}

async function samplePixel(meta, lon, lat) {
  if (!meta) return null;
  const [xmin, ymin, xmax, ymax] = meta.bbox;
  if (lon < xmin || lon > xmax || lat < ymin || lat > ymax) return null;
  const x = Math.floor(((lon - xmin) / (xmax - xmin)) * meta.w);
  const y = Math.floor(((ymax - lat) / (ymax - ymin)) * meta.h);
  if (x < 0 || y < 0 || x >= meta.w || y >= meta.h) return null;
  try {
    const data = await meta.image.readRasters({ window: [x, y, x + 1, y + 1], samples: [0] });
    const val = data[0][0];
    if (val === undefined || val === null) return null;
    if (typeof val === 'number' && Number.isNaN(val)) return null;
    const n = Number(val);
    if (!Number.isFinite(n)) return null;
    if (meta.nodata !== null && meta.nodata !== undefined && n === Number(meta.nodata)) return null;
    if (n <= 0) return null;
    return n;
  } catch (_) { return null; }
}

function makeSpamSamplePoints(input) {
  const geometry = normalizeGeometry(input);
  const poly = turf.feature(geometry);
  const areaKm2 = Math.max(turf.area(poly) / 1e6, 0.0001);
  let stepKm = 0.08;
  if (areaKm2 < 0.1) stepKm = 0.02;
  else if (areaKm2 < 1) stepKm = 0.05;
  else if (areaKm2 > 50) stepKm = 0.5;
  let pts = turf.pointGrid(turf.bbox(poly), stepKm, { units: 'kilometers', mask: poly }).features;
  if (!pts.length) pts = [turf.pointOnFeature(poly)];
  if (pts.length > 25) {
    const stride = Math.ceil(pts.length / 25);
    pts = pts.filter((_, i) => i % stride === 0).slice(0, 25);
  }
  return pts;
}

function makeBiomassSamplePoints(input) {
  const geometry = normalizeGeometry(input);
  const poly = turf.feature(geometry);
  const areaKm2 = Math.max(turf.area(poly) / 1e6, 0.0001);
  let stepKm = 0.25;
  if (areaKm2 < 0.1) stepKm = 0.03;
  else if (areaKm2 < 1) stepKm = 0.08;
  else if (areaKm2 < 10) stepKm = 0.15;
  else if (areaKm2 > 50) stepKm = 0.5;
  let pts = turf.pointGrid(turf.bbox(poly), stepKm, { units: 'kilometers', mask: poly }).features;
  if (!pts.length) pts = [turf.pointOnFeature(poly)];
  if (pts.length > 120) {
    const stride = Math.ceil(pts.length / 120);
    pts = pts.filter((_, i) => i % stride === 0).slice(0, 120);
  }
  return pts;
}

// ─── GFW Carbon helper ─────────────────────────────────────────────────
async function analyzeWithGFW(inputGeometry, params = {}) {
  const feature = toFeature(inputGeometry);
  const geom = feature.geometry || feature;
  const {
    start_date = '2015-01-01',
    end_date = '2023-12-31',
    canopy_density = 30,
    timeout_ms = GFW_TIMEOUT_MS
  } = params;

  const headers = { 'Content-Type': 'application/json' };
  if (GFW_API_KEY) headers['x-api-key'] = GFW_API_KEY;

  const datasets = [
    {
      id: 'umd_tree_cover_density_2000',
      key: 'tree_cover_density_2000',
      sql: `SELECT AVG(umd_tree_cover_density_2000__percent) mean FROM results`
    },
    {
      id: 'whrc_aboveground_biomass_stock_2000',
      key: 'aboveground_biomass_2010',
      sql: `SELECT SUM(whrc_aboveground_biomass_stock_2000__Mg) biomass, SUM(area__ha) area FROM results`
    },
    {
      id: 'umd_tree_cover_loss',
      key: 'tree_cover_loss',
      sql: `SELECT SUM(area__ha) area_ha FROM results WHERE umd_tree_cover_loss__year >= ${start_date.slice(0,4)} AND umd_tree_cover_loss__year <= ${end_date.slice(0,4)}`
    },
    {
      id: 'gfw_forest_carbon_gross_emissions',
      key: 'gross_emissions_co2e',
      sql: `SELECT SUM(gfw_forest_carbon_gross_emissions__Mg_CO2e) total FROM results`
    }
  ];

  const results = {};

  for (const ds of datasets) {
    try {
      const url = `${GFW_DATA_API}/dataset/${ds.id}/latest/query`;
      const body = {
        geometry: { type: geom.type, coordinates: geom.coordinates },
        sql: ds.sql
      };

      console.log(`[GFW] Querying ${ds.id}...`);
      const res = await fetchFn(url, fetchOptionsWithTimeout(timeout_ms, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      }));

      if (res.ok) {
        const data = await res.json();
        const row = data?.data?.[0] || {};

        if (ds.key === 'tree_cover_density_2000') {
          results[ds.key] = { mean: row.mean ?? row.avg ?? row.value ?? null };
        } else if (ds.key === 'aboveground_biomass_2010') {
          const totalMg = row.biomass ?? null;
          const totalHa = row.area ?? null;
          const meanPerHa = (totalMg != null && totalHa > 0) ? totalMg / totalHa : null;
          results[ds.key] = { mean: meanPerHa != null ? +meanPerHa.toFixed(2) : null };
          console.log('[GFW] biomass raw:', row, '=> mean/ha:', meanPerHa);
        } else if (ds.key === 'tree_cover_loss') {
          results[ds.key] = { area_ha: row.area_ha ?? row.total ?? null };
        } else if (ds.key === 'gross_emissions_co2e') {
          results[ds.key] = { total: row.total ?? row.sum ?? null };
        }
        console.log(`[GFW] ${ds.id} OK:`, results[ds.key]);
      } else {
        const text = await res.text();
        console.warn(`[GFW] ${ds.id} failed ${res.status}: ${text.slice(0, 300)}`);
        results[ds.key] = null;
      }
    } catch (err) {
      console.warn(`[GFW] ${ds.id} error: ${err.message}`);
      results[ds.key] = null;
    }
  }

  return { data: results };
}

function pickMean(obj) { return obj?.mean ?? obj?.value ?? obj?.avg ?? undefined; }
function pickTotal(obj) { return obj?.total ?? obj?.sum ?? undefined; }
function pickAreaHa(obj) { return obj?.area_ha ?? obj?.areaHa ?? undefined; }

function estimateSequestrationProxy(agbMean, areaHa, lossAreaHa, opts = {}) {
  const {
    incrementFraction = 0.03, carbonFraction = 0.5, carbonToCO2e = 44 / 12,
    discountForLoss = true, minSequestration_Mg_CO2e_yr = 0
  } = opts;
  let seq = agbMean * incrementFraction * carbonFraction * carbonToCO2e * areaHa;
  if (discountForLoss && lossAreaHa != null && areaHa > 0)
    seq *= (1 - Math.min(lossAreaHa / areaHa, 1));
  seq = Math.max(seq, minSequestration_Mg_CO2e_yr);
  return {
    sequestration_proxy_Mg_CO2e_yr: +seq.toFixed(2),
    sequestration_proxy_Mg_CO2e_ha_yr: areaHa > 0 ? +(seq / areaHa).toFixed(2) : 0,
    assumptions: { incrementFraction, carbonFraction, carbonToCO2e, discountForLoss }
  };
}

// ════════════════════════════════════════════════════════════════════════
//  WOOD — ArcGIS FeatureServer tile index → GeoTIFF download → sample
// ════════════════════════════════════════════════════════════════════════
function geoJsonToEsriPolygon(geom) {
  // ArcGIS needs rings + spatialReference, not GeoJSON type/coordinates
  if (geom.type === 'Polygon') {
    return {
      rings: geom.coordinates,
      spatialReference: { wkid: 4326 }
    };
  }
  // MultiPolygon: flatten to rings
  if (geom.type === 'MultiPolygon') {
    return {
      rings: geom.coordinates.flatMap(p => p),
      spatialReference: { wkid: 4326 }
    };
  }
  return null;
}

async function queryWoodTileIndex(geometry) {
  const esriGeom = geoJsonToEsriPolygon(geometry);
  if (!esriGeom) {
    console.warn('[WOOD] Cannot convert geometry to ESRI format');
    return [];
  }

  // POST with form-encoded body (ArcGIS preferred)
  const body = new URLSearchParams();
  body.set('where', '1=1');
  body.set('outFields', '*');
  body.set('returnGeometry', 'true');
  body.set('spatialRel', 'esriSpatialRelIntersects');
  body.set('geometry', JSON.stringify(esriGeom));
  body.set('geometryType', 'esriGeometryPolygon');
  body.set('f', 'geojson');

  const url = `${GFW_WOOD_FEATURESERVER}/query`;
  console.log(`[WOOD] POST ${url} (ESRI geom: ${JSON.stringify(esriGeom).slice(0, 100)}…)`);

  const data = await fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  }, 30000);

  if (data?.error) {
    console.warn(`[WOOD] FeatureServer error:`, JSON.stringify(data.error));
    return [];
  }

  const features = Array.isArray(data?.features) ? data.features : [];
  console.log(`[WOOD] FeatureServer returned ${features.length} tiles`);

  if (features.length > 0) {
    console.log(`[WOOD] sample:`, JSON.stringify(features[0].properties).slice(0, 400));
  }

  return features.map(f => {
    const p = f.properties || {};
    return {
      tileId: p.tile_id ?? p.TILE_ID ?? p.ObjectId ?? null,
      downloadMgHa: p.Mg_ha_1_download ?? p.mg_ha_1_download ?? null,
      downloadMgPx: p.Mg_px_1_download ?? p.mg_px_1_download ?? null,
      allFields: p
    };
  });
}

function buildWoodDownloadUrl(tileId) {
  if (!tileId) return null;
  const url = new URL(
    `${GFW_DATA_API}/dataset/${GFW_WOOD_DATASET_ID}/${GFW_WOOD_DATASET_VERSION}/download/geotiff`
  );
  url.searchParams.set('grid', '10/40000');
  url.searchParams.set('tile_id', tileId);
  url.searchParams.set('pixel_meaning', 'Mg_ha-1');
  if (GFW_API_KEY) url.searchParams.set('x-api-key', GFW_API_KEY);
  return url.toString();
}

async function sampleWoodBiomass(geometry, requestId) {
  const tiles = await queryWoodTileIndex(geometry);
  if (!tiles.length) return { error: 'No intersecting tiles found', tileCount: 0, tiles: [] };

  console.log(`[WOOD][${requestId}] FeatureServer returned ${tiles.length} tiles`);
  if (tiles[0]) console.log(`[WOOD][${requestId}] sample fields:`, JSON.stringify(tiles[0].allFields).slice(0, 400));

  const tileInfos = tiles.map(t => ({
    tileId: t.tileId,
    downloadUrl: t.downloadMgHa || buildWoodDownloadUrl(t.tileId),
    directUrl: !!t.downloadMgHa
  }));

  const samplePoints = makeBiomassSamplePoints(geometry);
  const tileMetas = [];

  try {
    for (const tile of tileInfos) {
      if (!tile.downloadUrl) continue;
      console.log(`[WOOD][${requestId}] downloading tile ${tile.tileId}…`);
      console.log(`[WOOD][${requestId}] downloading tile ${tile.tileId} (${(tile.downloadUrl || '').slice(0, 60)}…)`);
const meta = await getRemoteTiffFromUrl(tile.downloadUrl, requestId);
      tileMetas.push({ tileId: tile.tileId, meta });
      console.log(`[WOOD][${requestId}]   loaded ${meta.w}×${meta.h} bbox=[${meta.bbox.map(v => v.toFixed(2)).join(',')}]`);
    }

    if (!tileMetas.length)
      return { error: 'No tiles could be downloaded', tileCount: tiles.length, tiles: tileInfos.map(t => t.tileId) };

    const values = [];
    for (const pt of samplePoints) {
      const [lon, lat] = pt.geometry.coordinates;
      for (const tile of tileMetas) {
        const v = await samplePixel(tile.meta, lon, lat);
        if (v != null && Number.isFinite(v) && v > 0) { values.push(Number(v)); break; }
      }
    }

    console.log(`[WOOD][${requestId}] ${values.length}/${samplePoints.length} valid pixels`);

    if (!values.length)
      return { error: 'No valid pixels', sampleCount: 0, tileCount: tileMetas.length, tiles: tileMetas.map(t => t.tileId) };

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return {
      meanMgHa: +mean.toFixed(2),
      minMgHa: +Math.min(...values).toFixed(2),
      maxMgHa: +Math.max(...values).toFixed(2),
      sampleCount: values.length,
      attemptedSamples: samplePoints.length,
      tileCount: tileMetas.length,
      tiles: tileMetas.map(t => t.tileId)
    };
  } finally {
    for (const t of tileMetas) cleanupTempFile(t.meta?.localPath);
  }
}

// ════════════════════════════════════════════════════════════════════════
//  ENDPOINTS
// ─── Health ────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  // If ?debug=wood, run the debug test
  if (req.query.debug === 'wood') {
    try {
      const metaUrl = `${GFW_WOOD_FEATURESERVER}?f=json`;
      const metaRes = await fetchFn(metaUrl, fetchOptionsWithTimeout(15000));
      const metaText = await metaRes.text();
      let meta;
      try { meta = JSON.parse(metaText); } catch(e) {
        return res.json({ error: 'meta parse fail', status: metaRes.status, raw: metaText.slice(0, 300) });
      }

      const testGeom = { type: 'Polygon', coordinates: [[[-73.0, -10.0], [-72.9, -10.0], [-72.9, -9.9], [-73.0, -9.9], [-73.0, -10.0]]] };
      const params = new URLSearchParams({
        where: '1=1', outFields: '*', returnGeometry: 'true',
        spatialRel: 'esriSpatialRelIntersects', geometryType: 'esriGeometryPolygon',
        inSR: '4326', f: 'geojson'
      });
      params.set('geometry', JSON.stringify(testGeom));
      const queryUrl = `${GFW_WOOD_FEATURESERVER}/query?${params.toString()}`;
      const queryRes = await fetchFn(queryUrl, fetchOptionsWithTimeout(30000));
      const queryText = await queryRes.text();
      let queryData;
      try { queryData = JSON.parse(queryText); } catch(e) {
        return res.json({ error: 'query parse fail', status: queryRes.status, raw: queryText.slice(0, 500) });
      }

      return res.json({
        meta: { name: meta.name, fields: (meta.fields || []).map(f => `${f.name} (${f.type})`) },
        query: { featureCount: queryData.features?.length || 0, sampleFields: queryData.features?.[0]?.properties || {}, error: queryData.error || null }
      });
    } catch (e) {
      return res.json({ error: e.message });
    }
  }

  res.json({ ok: true, service: 'server', time: new Date().toISOString() });
});

// ─── Debug: SPAM paths ─────────────────────────────────────────────────
app.get('/test-paths', (req, res) => {
  res.json(CROP_CONFIG.map(cfg => ({
    crop: cfg.crop,
    yield: cfg.yield,
    area: cfg.area || null,
    yieldExists: fs.existsSync(path.join(__dirname, cfg.yield)),
    areaExists: cfg.area ? fs.existsSync(path.join(__dirname, cfg.area)) : false
  })));
});

app.get('/test-maize', async (req, res) => {
  try {
    const cfg = CROP_CONFIG.find(c => c.crop === 'Maize');
    if (!cfg) return res.json({ error: 'Maize not in config' });
    const meta = await getImageMeta(cfg.yield);
    if (!meta) return res.json({ error: 'Cannot load raster', path: cfg.yield });
    const val = await samplePixel(meta, -1.5, 6.55);
    res.json({ crop: cfg.crop, path: cfg.yield, bbox: meta.bbox, size: [meta.w, meta.h], nodata: meta.nodata, pixelValue: val });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Debug: FeatureServer schema ───────────────────────────────────────
app.get('/test-wood-tiles', async (req, res) => {
  try {
    const metaRes = await fetchFn(`${GFW_WOOD_FEATURESERVER}?f=json`, fetchOptionsWithTimeout(15000));
    const meta = await metaRes.json();

    const testGeom = { type: 'Polygon', coordinates: [[[-73.0, -10.0], [-72.9, -10.0], [-72.9, -9.9], [-73.0, -9.9], [-73.0, -10.0]]] };
    const params = new URLSearchParams({
      where: '1=1', outFields: '*', returnGeometry: 'true', spatialRel: 'esriSpatialRelIntersects',
      geometryType: 'esriGeometryPolygon', inSR: '4326', f: 'geojson', resultRecordCount: '2'
    });
    params.set('geometry', JSON.stringify(testGeom));
    const queryData = await fetchJson(`${GFW_WOOD_FEATURESERVER}/query?${params.toString()}`, {}, 15000);

    res.json({
      service: {
        name: meta.name,
        fields: (meta.fields || []).map(f => ({ name: f.name, type: f.type, alias: f.alias }))
      },
      sampleQuery: {
        featureCount: queryData.features?.length || 0,
        sampleFields: queryData.features?.[0]?.properties || {}
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/carbon/analyze ──────────────────────────────────────────
app.post('/api/carbon/analyze', async (req, res) => {
  const requestId = crypto.randomUUID?.() || Date.now().toString(36);
  console.log(`[CARBON][${requestId}] start`, { hasGeometry: !!req.body?.geometry });

  try {
    const {
      geometry, start_date = '2015-01-01', end_date = '2023-12-31', canopy_density = 30,
      incrementFraction = 0.03, discountForLoss = true, ...extraParams
    } = req.body || {};

    let safeGeom;
    try { safeGeom = normalizeGeometry(geometry); }
    catch (e) { return res.status(400).json({ error: `Invalid geometry: ${e.message}`, requestId }); }

    const areaHa = getAreaHa(safeGeom);
    const cacheKey = getCacheKey('gfw-carbon', safeGeom, { start_date, end_date, canopy_density, incrementFraction, discountForLoss });
    const cached = getCached(cacheKey);
    if (cached) return res.json({ ...cached, cache: { hit: true, ttl_seconds: CACHE_TTL_SECONDS }, requestId });

    let gfwResult;
    try {
      gfwResult = await analyzeWithGFW(safeGeom, {
        layer_ids: ['tree_cover_density_2000', 'aboveground_biomass_2010', 'tree_cover_loss', 'gross_emissions_co2e'],
        start_date, end_date, canopy_density, ...extraParams
      });
    } catch (err) {
      if (isTimeoutError(err)) return res.status(504).json({ error: 'GFW request timed out', requestId });
      return res.status(502).json({ error: `Upstream GFW error: ${err.message}`, requestId });
    }

    const data = gfwResult?.data || {};
    const biomassMean = pickMean(data.aboveground_biomass_2010);
    const tcMean = pickMean(data.tree_cover_density_2000);
    const lossAreaHa = pickAreaHa(data.tree_cover_loss);
    const emissionsTotal = pickTotal(data.gross_emissions_co2e);

    if (biomassMean == null) {
      return res.status(502).json({ error: 'GFW response missing aboveground_biomass_2010 mean', raw: gfwResult, requestId });
    }

    const seq = estimateSequestrationProxy(biomassMean || 0, areaHa, lossAreaHa || 0, { incrementFraction, discountForLoss });

    const response = {
      source: 'GFW Data API', endpoint: `${GFW_DATA_API}/datasets`,
      request: { geometry: toFeature(safeGeom), params: { layer_ids: ['tree_cover_density_2000','aboveground_biomass_2010','tree_cover_loss','gross_emissions_co2e'], start_date, end_date, canopy_density } },
      areaHa: +areaHa.toFixed(2),
      biomass: { aboveground_biomass_Mg_per_ha: biomassMean, aboveground_biomass_total_Mg: +(biomassMean * areaHa).toFixed(2) },
      forestCover: { tree_cover_density_percent: tcMean },
      change: { tree_cover_loss_ha: lossAreaHa, tree_cover_loss_period: `${start_date} to ${end_date}` },
      emissions: { gross_emissions_co2e_Mg: emissionsTotal, gross_emissions_co2e_Mg_per_ha: emissionsTotal != null && areaHa > 0 ? +(emissionsTotal / areaHa).toFixed(2) : undefined },
      sequestration: seq, raw: gfwResult, requestId
    };

    setCached(cacheKey, response, CACHE_TTL_SECONDS);
    return res.json({ ...response, cache: { hit: false, ttl_seconds: CACHE_TTL_SECONDS } });
  } catch (err) {
    console.error(`[CARBON][${requestId}] UNHANDLED ERROR: ${err.message}`);
    return res.status(500).json({ error: err.message, requestId });
  }
});

// ─── POST /api/wood/analyze ────────────────────────────────────────────
app.post('/api/wood/analyze', async (req, res) => {
  const requestId = crypto.randomUUID?.() || Date.now().toString(36);
  console.log(`[WOOD][${requestId}] start`, { hasGeometry: !!req.body?.geometry });

  try {
    const {
      geometry, woodDensity = 500, harvestFraction = 0.5,
      carbonFraction = 0.47, rotationYears = 30
    } = req.body || {};

    let safeGeom;
    try { safeGeom = normalizeGeometry(geometry); }
    catch (e) { return res.status(400).json({ error: `Invalid geometry: ${e.message}`, requestId }); }

    const areaHa = getAreaHa(safeGeom);
    const cacheKey = getCacheKey('gfw-wood', safeGeom, { woodDensity, harvestFraction, carbonFraction, rotationYears });
    const cached = getCached(cacheKey);
    if (cached) return res.json({ ...cached, cache: { hit: true, ttl_seconds: CACHE_TTL_SECONDS }, requestId });

    const biomass = await sampleWoodBiomass(safeGeom, requestId);

    if (biomass.error) {
      return res.status(502).json({
        error: biomass.error, tileIndex: GFW_WOOD_FEATURESERVER,
        tilesChecked: biomass.tileCount, tilesAttempted: biomass.tiles, requestId
      });
    }

    const meanAGB = biomass.meanMgHa;
    const totalBiomassMg = meanAGB * areaHa;
    const carbonStockMgC = totalBiomassMg * carbonFraction;
    const woodVolumeM3 = (totalBiomassMg * 1000) / woodDensity;
    const harvestableM3 = woodVolumeM3 * harvestFraction;
    const annualYieldM3Yr = harvestableM3 / rotationYears;

    const response = {
      source: 'GFW ArcGIS FeatureServer → GeoTIFF tiles',
      dataset: {
        name: 'Aboveground Live Woody Biomass Density',
        provider: 'World Resources Institute / Global Forest Watch',
        originalProvider: 'Woods Hole Research Center (WHRC)',
        tileIndex: GFW_WOOD_FEATURESERVER,
        datasetId: GFW_WOOD_DATASET_ID, version: GFW_WOOD_DATASET_VERSION,
        pixelMeaning: 'Mg_ha-1', year: 2000, resolution: '30m'
      },
      request: { geometry: toFeature(safeGeom) },
      areaHa: +areaHa.toFixed(2),
      biomass: {
        mean_Mg_per_ha: meanAGB, min_Mg_per_ha: biomass.minMgHa, max_Mg_per_ha: biomass.maxMgHa,
        total_Mg: +totalBiomassMg.toFixed(2), carbon_stock_Mg_C: +carbonStockMgC.toFixed(2),
        sampleCount: biomass.sampleCount, attemptedSamples: biomass.attemptedSamples
      },
      wood: {
        total_volume_m3: +woodVolumeM3.toFixed(2),
        harvestable_volume_m3: +harvestableM3.toFixed(2),
        annual_sustainable_yield_m3_yr: +annualYieldM3Yr.toFixed(2),
        
        per_hectare: {
          biomass_Mg_ha: meanAGB,
          wood_volume_m3_ha: +((meanAGB * 1000) / woodDensity).toFixed(2),
          harvestable_m3_ha: +(((meanAGB * 1000) / woodDensity) * harvestFraction).toFixed(2),
          annual_yield_m3_ha_yr: +((((meanAGB * 1000) / woodDensity) * harvestFraction) / rotationYears).toFixed(2)
        }
      },
      tiles: { count: biomass.tileCount, tileIds: biomass.tiles },
      assumptions: {
        woodDensity_kg_m3: woodDensity, harvestFraction, rotationYears, carbonFraction,
        note: 'Volume = biomass ÷ density. Harvestable = volume × fraction. Annual = ÷ rotation.'
      },
      calculationSteps: [
        { step: 'Total biomass', formula: `${meanAGB} Mg/ha × ${areaHa.toFixed(1)} ha`, result: `${totalBiomassMg.toFixed(1)} Mg` },
        { step: 'Wood volume', formula: `${totalBiomassMg.toFixed(1)} Mg × 1000 ÷ ${woodDensity} kg/m³`, result: `${woodVolumeM3.toFixed(1)} m³` },
        { step: 'Harvestable', formula: `${woodVolumeM3.toFixed(1)} m³ × ${harvestFraction}`, result: `${harvestableM3.toFixed(1)} m³` },
        { step: 'Annual yield', formula: `${harvestableM3.toFixed(1)} m³ ÷ ${rotationYears} yr`, result: `${annualYieldM3Yr.toFixed(1)} m³/yr` },
        { step: 'Carbon stock', formula: `${totalBiomassMg.toFixed(1)} Mg × ${carbonFraction}`, result: `${carbonStockMgC.toFixed(1)} Mg C` }
      ],
      requestId
    };

    setCached(cacheKey, response, CACHE_TTL_SECONDS);
    return res.json({ ...response, cache: { hit: false, ttl_seconds: CACHE_TTL_SECONDS } });
  } catch (err) {
    console.error(`[WOOD][${requestId}] ERROR: ${err.message}`);
    console.error(err.stack);
    return res.status(500).json({ error: err.message, requestId });
  }
});

// ─── POST /api/yield/analyze ───────────────────────────────────────────
app.post('/api/yield/analyze', async (req, res) => {
  const requestId = crypto.randomUUID?.() || Date.now().toString(36);
  console.log(`[YIELD][${requestId}] start`, { hasGeometry: !!req.body?.geometry });

  try {
    const { geometry, crops: requestedCrops } = req.body || {};

    let safeGeom;
    try { safeGeom = normalizeGeometry(geometry); }
    catch (e) { return res.status(400).json({ error: `Invalid geometry: ${e.message}`, requestId }); }

    const areaHa = getAreaHa(safeGeom);

    let cropsToAnalyze = CROP_CONFIG;
    if (Array.isArray(requestedCrops) && requestedCrops.length) {
      cropsToAnalyze = CROP_CONFIG.filter(c => requestedCrops.some(r => r.toLowerCase() === c.crop.toLowerCase()));
    }

    const cacheKey = getCacheKey('spam-yield', safeGeom, { crops: cropsToAnalyze.map(c => c.crop).sort() });
    const cached = getCached(cacheKey);
    if (cached) return res.json({ ...cached, cache: { hit: true, ttl_seconds: CACHE_TTL_SECONDS }, requestId });

    const samplePoints = makeSpamSamplePoints(safeGeom);
    console.log(`[YIELD][${requestId}] ${samplePoints.length} pts × ${cropsToAnalyze.length} crops`);

    const startTime = Date.now();
    const cropResults = [];

    for (const cfg of cropsToAnalyze) {
      const yieldMeta = await getImageMeta(cfg.yield);
      if (!yieldMeta) { console.warn(`[YIELD][${requestId}] skip ${cfg.crop}`); continue; }

      const areaMeta = cfg.area ? await getImageMeta(cfg.area) : null;
      const yieldValues = [];
      const areaValues = [];

      for (const pt of samplePoints) {
        const [lon, lat] = pt.geometry.coordinates;
        const yv = await samplePixel(yieldMeta, lon, lat);
        if (yv != null && Number.isFinite(yv) && yv > 0) yieldValues.push(yv);
        if (areaMeta) {
          const av = await samplePixel(areaMeta, lon, lat);
          if (av != null && Number.isFinite(av) && av > 0) areaValues.push(av);
        }
      }

      if (!yieldValues.length) continue;

      const meanYieldKgHa = yieldValues.reduce((a, b) => a + b, 0) / yieldValues.length;
      const meanYieldTHa = meanYieldKgHa / 1000;
      const harvestedAreaHa = areaValues.length
        ? (areaValues.reduce((a, b) => a + b, 0) / areaValues.length) * areaHa
        : (yieldValues.length / samplePoints.length) * areaHa;
      const productionT = meanYieldTHa * harvestedAreaHa;

      console.log(`[YIELD][${requestId}] ${cfg.crop}: ${meanYieldTHa.toFixed(2)} t/ha, ${harvestedAreaHa.toFixed(1)} ha, ${productionT.toFixed(1)} t`);

      cropResults.push({
        crop: cfg.crop,
        harvestedArea_ha: +harvestedAreaHa.toFixed(2),
        yield_t_ha: +meanYieldTHa.toFixed(2),
        production_t: +productionT.toFixed(2)
      });
    }

    cropResults.sort((a, b) => b.production_t - a.production_t);
    const totalYield = cropResults.reduce((s, c) => s + c.production_t, 0);

    console.log(`[YIELD][${requestId}] done: ${cropResults.length} crops, total=${totalYield.toFixed(1)}t`);

    const response = {
      source: 'SPAM 2020 V2r0 · All production systems',
      areaHa: +areaHa.toFixed(2), totalYield_t: +totalYield.toFixed(2),
      majorCrop: cropResults[0]?.crop || null, crops: cropResults, requestId
    };

    setCached(cacheKey, response, CACHE_TTL_SECONDS);
    return res.json({ ...response, cache: { hit: false, ttl_seconds: CACHE_TTL_SECONDS } });
  } catch (err) {
    console.error(`[YIELD][${requestId}] ERROR: ${err.message}`);
    console.error(err.stack);
    return res.status(500).json({ error: err.message, requestId });
  }
});


app.get('/debug-wood', async (req, res) => {
  try {
    const metaUrl = `${GFW_WOOD_FEATURESERVER}?f=json`;
    const metaRes = await fetchFn(metaUrl, fetchOptionsWithTimeout(15000));
    const metaText = await metaRes.text();
    let meta;
    try { meta = JSON.parse(metaText); }
    catch(e) { return res.json({ step: 'meta_parse_fail', status: metaRes.status, raw: metaText.slice(0, 300) }); }

    const testGeom = { type: 'Polygon', coordinates: [[[-73.0, -10.0], [-72.9, -10.0], [-72.9, -9.9], [-73.0, -9.9], [-73.0, -10.0]]] };
    const params = new URLSearchParams({
      where: '1=1', outFields: '*', returnGeometry: 'true',
      spatialRel: 'esriSpatialRelIntersects', geometryType: 'esriGeometryPolygon',
      inSR: '4326', f: 'geojson'
    });
    params.set('geometry', JSON.stringify(testGeom));
    const queryUrl = `${GFW_WOOD_FEATURESERVER}/query?${params.toString()}`;
    const queryRes = await fetchFn(queryUrl, fetchOptionsWithTimeout(30000));
    const queryText = await queryRes.text();
    let queryData;
    try { queryData = JSON.parse(queryText); }
    catch(e) { return res.json({ step: 'query_parse_fail', status: queryRes.status, raw: queryText.slice(0, 500) }); }

    res.json({
      step: 'ok',
      meta: { name: meta.name, fields: (meta.fields || []).map(f => `${f.name} (${f.type})`) },
      query: { featureCount: queryData.features?.length || 0, sampleFields: queryData.features?.[0]?.properties || {}, error: queryData.error || null }
    });
  } catch (e) { res.json({ step: 'exception', error: e.message }); }
});

//hydrology analysis endpoint
app.post('/api/hydro/analyze', async (req, res) => {
  try {
    const geom = normalizeGeometry(req.body.geometry || req.body);
    if (!geom) return res.status(400).json({ error: 'Invalid geometry' });

    const ha = getAreaHa(geom);
    const feat = toFeature(geom);
    const center = turf.centroid(feat);
    const lat = center.geometry.coordinates[1];
    const lon = center.geometry.coordinates[0];
    const bboxArr = turf.bbox(feat);

    let osmWater = { rivers: [], lakes: [], wetlands: [] };
    try {
      const overpassQuery = `[out:json][timeout:25];(way["waterway"](${bboxArr[1]},${bboxArr[0]},${bboxArr[3]},${bboxArr[2]});relation["waterway"](${bboxArr[1]},${bboxArr[0]},${bboxArr[3]},${bboxArr[2]});way["natural"="water"](${bboxArr[1]},${bboxArr[0]},${bboxArr[3]},${bboxArr[2]});relation["natural"="water"](${bboxArr[1]},${bboxArr[0]},${bboxArr[3]},${bboxArr[2]});way["natural"="wetland"](${bboxArr[1]},${bboxArr[0]},${bboxArr[3]},${bboxArr[2]}););out body geom;`;

      const overpassRes = await fetchFn('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(overpassQuery)
      });

      if (overpassRes.ok) {
        const osmData = await overpassRes.json();
        (osmData.elements || []).forEach(el => {
          const tags = el.tags || {};
          if (tags.waterway) {
            osmWater.rivers.push({ name: tags.name || 'Unnamed', type: tags.waterway, intermittent: tags.intermittent === 'yes', seasonal: tags.seasonal === 'yes' });
          } else if (tags.natural === 'water' || tags.water) {
            osmWater.lakes.push({ name: tags.name || 'Unnamed', type: tags.water || 'water' });
          } else if (tags.natural === 'wetland') {
            osmWater.wetlands.push({ name: tags.name || 'Unnamed', type: tags.wetland || 'wetland' });
          }
        });
      }
    } catch (e) { console.warn('[HYDRO] OSM failed:', e.message); }

    const seen = new Set();
    osmWater.rivers = osmWater.rivers.filter(r => { const k = r.name+'|'+r.type; if (seen.has(k)) return false; seen.add(k); return true; });

    const absLat = Math.abs(lat);
    const precip = absLat<10?2000:absLat<20?1200:absLat<30?600:absLat<40?800:absLat<50?700:absLat<60?600:400;
    const rc = absLat<15?0.35:absLat<30?0.20:absLat<50?0.30:0.40;
    const runoff = +(precip * rc).toFixed(1);
    const areaM2 = ha * 10000;
    const waterYield = +(areaM2 * runoff / 1000).toFixed(0);
    const bfi = absLat<15?0.45:absLat<30?0.35:absLat<50?0.55:0.60;
    const areaKm2 = ha / 100;
    const sd = areaKm2 > 0 ? +((osmWater.rivers.length * 1.5) / Math.max(areaKm2, 0.01)).toFixed(2) : 0;
    const tc = {};
    osmWater.rivers.forEach(r => { tc[r.type] = (tc[r.type]||0)+1; });
    const domType = Object.entries(tc).sort((a,b)=>b[1]-a[1])[0]?.[0] || 'none';
    const floodRisk = sd>3?'high':sd>1.5?'moderate':sd>0.5?'low-moderate':'low';
    const ripBuf = osmWater.rivers.length > 0 ? +(osmWater.rivers.length * 0.05 * Math.sqrt(areaKm2)).toFixed(2) : 0;

    console.log(`[HYDRO] ${ha.toFixed(0)} ha | ${osmWater.rivers.length} rivers | ${osmWater.lakes.length} lakes | ${waterYield} m3/yr`);

    res.json({
      areaHa: +ha.toFixed(2),
      centroid: { lat: +lat.toFixed(4), lon: +lon.toFixed(4) },
      waterFeatures: {
        rivers: osmWater.rivers.slice(0, 20), riverCount: osmWater.rivers.length,
        lakes: osmWater.lakes.slice(0, 10), lakeCount: osmWater.lakes.length,
        wetlands: osmWater.wetlands.slice(0, 10), wetlandCount: osmWater.wetlands.length,
        dominantWaterwayType: domType, streamDensity_km_per_km2: sd
      },
      hydrology: {
        precipitation_mm_yr: precip, runoffCoefficient: rc, annualRunoff_mm_yr: runoff,
        annualWaterYield_m3_yr: waterYield, baseflowIndex: bfi,
        annualBaseflow_m3_yr: +(waterYield * bfi).toFixed(0)
      },
      risks: { floodRisk, waterQualityRisk: absLat<30?'moderate-high':'moderate', erosionRisk: sd>2?'elevated':'normal' },
      riparian: {
        estimatedRiparianBuffer_km: ripBuf, estimatedRiparianArea_ha: +(ripBuf * 3).toFixed(2),
        recommendation: osmWater.rivers.length > 0 ? 'Maintain 30m riparian buffers along all waterways.' : 'No significant waterways detected.'
      },
      waterBalance: {
        precipitation_m3_yr: +(areaM2 * precip / 1000).toFixed(0),
        evapotranspiration_m3_yr: +(areaM2 * precip * (1 - rc) / 1000).toFixed(0),
        runoff_m3_yr: waterYield, baseflow_m3_yr: +(waterYield * bfi).toFixed(0),
        surfaceRunoff_m3_yr: +(waterYield * (1 - bfi)).toFixed(0)
      },
      note: 'Water features from OSM. Hydrology estimated from latitude-based climate model.'
    });
  } catch (err) {
    console.error('[HYDRO] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[INFO] Server listening on port ${PORT}`);
});