const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const POSTER_W = 100;
const POSTER_H = 150;

async function convertirPoster(url, outPath) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`No se pudo bajar ${url}: ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());

  // Redimensiona a 100x150 y saca los bytes crudos en RGBA (4 bytes por pixel)
  const raw = await sharp(buffer)
    .resize(POSTER_W, POSTER_H, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer();

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, raw);
  console.log(`OK: ${outPath} (${raw.length} bytes, esperado ${POSTER_W * POSTER_H * 4})`);
}

// Prueba con el poster de Moana que ya vimos en el JSON
convertirPoster(
  "https://image.tmdb.org/t/p/w500/wC27PIEqSthbUhaVMdYEhaTzYmo.jpg",
  path.join(__dirname, "..", "output", "posters", "moana-2026.raw")
).catch((err) => {
  console.error(err);
  process.exit(1);
});
