require('dotenv').config();

const fs = require('fs');
const path = require('path');

const fetchFn = global.fetch
  ? global.fetch.bind(global)
  : (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const GFW_API_KEY = process.env.GFW_API_KEY;
const OUT_DIR = path.join(__dirname, 'data', 'biomass');

if (!GFW_API_KEY) {
  console.error('Missing GFW_API_KEY in .env');
  process.exit(1);
}

const TILE_INDEX_BASE =
  'https://services2.arcgis.com/g8WusZB13b9OegfU/arcgis/rest/services/Aboveground_Live_Woody_Biomass_Density/FeatureServer/0/query';

async function fetchJson(url) {
  const res = await fetchFn(url);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 1000)}`);
  }
  return JSON.parse(text);
}

async function getAllTiles() {
  let allFeatures = [];
  let resultOffset = 0;
  const resultRecordCount = 2000;

  while (true) {
    const params = new URLSearchParams({
      where: '1=1',
      outFields: 'tile_id,Mg_ha_1_download',
      returnGeometry: 'false',
      f: 'json',
      resultOffset: String(resultOffset),
      resultRecordCount: String(resultRecordCount)
    });

    const url = `${TILE_INDEX_BASE}?${params.toString()}`;
    console.log('Fetching tile index offset:', resultOffset);

    const json = await fetchJson(url);
    const features = json.features || [];
    allFeatures = allFeatures.concat(features);

    console.log(`Fetched ${features.length} features, total ${allFeatures.length}`);

    if (!json.exceededTransferLimit || features.length === 0) {
      break;
    }

    resultOffset += resultRecordCount;
  }

  return allFeatures.map((f) => {
    const a = f.attributes || {};
    return {
      tile_id: a.tile_id,
      download_url: (a.Mg_ha_1_download || '').replace(
        /x-api-key=[^&]+/,
        `x-api-key=${encodeURIComponent(GFW_API_KEY)}`
      )
    };
  }).filter(t => t.tile_id && t.download_url);
}

async function downloadFile(url, outPath) {
  const res = await fetchFn(url);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Download failed ${res.status}: ${text.slice(0, 500)}`);
  }

  const fileStream = fs.createWriteStream(outPath);

  await new Promise((resolve, reject) => {
    const body = res.body;
    if (!body) return reject(new Error('No response body'));

    if (typeof body.pipe === 'function') {
      body.pipe(fileStream);
      body.on('error', reject);
      fileStream.on('finish', resolve);
      fileStream.on('error', reject);
    } else {
      res.arrayBuffer()
        .then((ab) => {
          fs.writeFileSync(outPath, Buffer.from(ab));
          resolve();
        })
        .catch(reject);
    }
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const tiles = await getAllTiles();
  console.log(`Total tiles found: ${tiles.length}`);

  fs.writeFileSync(
    path.join(OUT_DIR, 'tiles.json'),
    JSON.stringify(tiles, null, 2)
  );

  for (const tile of tiles) {
    const outPath = path.join(OUT_DIR, `${tile.tile_id}.tif`);

    if (fs.existsSync(outPath)) {
      console.log(`Skipping existing ${tile.tile_id}.tif`);
      continue;
    }

    console.log(`Downloading ${tile.tile_id}...`);
    try {
      await downloadFile(tile.download_url, outPath);
      console.log(`Saved ${outPath}`);
    } catch (e) {
      console.error(`Failed ${tile.tile_id}: ${e.message}`);
    }
  }

  console.log('Done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});