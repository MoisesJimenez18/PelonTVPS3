// --- Arma un JSON por categoría con todo el catálogo (titulo, poster,
// timestamp). Corre desde GitHub Actions, no desde el dispositivo del
// usuario, así que estas lecturas las paga el robot, no cada usuario.
//
// SINCRONIZACIÓN INCREMENTAL: en vez de releer TODA la colección cada
// vez, le pedimos a Firestore solo los documentos con timestamp MAYOR
// al más nuevo que ya teníamos guardado de una corrida anterior. Así el
// costo por corrida depende de cuánto contenido agregaste ese día, no
// del tamaño total del catálogo. La primera vez (sin JSON previo) se
// hace una lectura completa, como antes. ---

const fs = require("fs");
const path = require("path");

const PROJECT_ID = "pelontv-91671";
const CATEGORIAS = ["peliculas", "series", "anime", "tv"];
const OUT_DIR = path.join(__dirname, "..", "output");
const CAMPOS = ["titulo", "portada", "backdrop", "timestamp"];

function unwrap(field) {
  if (!field) return null;
  if (field.stringValue !== undefined) return field.stringValue;
  if (field.integerValue !== undefined) return parseInt(field.integerValue, 10);
  if (field.doubleValue !== undefined) return field.doubleValue;
  if (field.booleanValue !== undefined) return field.booleanValue;
  return null;
}

function parseTimestamp(ts) {
  if (!ts) return 0;
  const recortado = ts.replace(/(\.\d{3})\d*$/, "$1");
  const t = Date.parse(recortado);
  return isNaN(t) ? 0 : t;
}

function docAItem(doc) {
  const f = doc.fields || {};
  const parts = doc.name.split("/");
  const slug = parts[parts.length - 1];
  return {
    slug,
    titulo: unwrap(f.titulo) || slug,
    poster: unwrap(f.portada) || unwrap(f.backdrop),
    timestamp: unwrap(f.timestamp)
  };
}

// --- Trae TODA la colección, paginando con pageToken (se usa solo la
// primera vez, cuando todavía no hay un JSON previo para esa categoría) ---
async function fetchColeccionCompleta(cat) {
  let docs = [];
  let pageToken = null;

  do {
    let url =
      `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}` +
      `/databases/(default)/documents/${cat}?pageSize=300` +
      CAMPOS.map((c) => `&mask.fieldPaths=${c}`).join("");
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Error leyendo ${cat}: ${resp.status} ${await resp.text()}`);
    const data = await resp.json();

    if (data.documents) docs = docs.concat(data.documents);
    pageToken = data.nextPageToken || null;
  } while (pageToken);

  return docs.map(docAItem);
}

// --- Trae SOLO los documentos con timestamp > cursor, usando una
// consulta estructurada (runQuery) en vez del listado simple. ---
async function fetchNuevosDesde(cat, cursorTimestamp) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`;
  const body = {
    structuredQuery: {
      from: [{ collectionId: cat }],
      where: {
        fieldFilter: {
          field: { fieldPath: "timestamp" },
          op: "GREATER_THAN",
          value: { stringValue: cursorTimestamp }
        }
      },
      orderBy: [{ field: { fieldPath: "timestamp" }, direction: "ASCENDING" }],
      select: { fields: CAMPOS.map((c) => ({ fieldPath: c })) }
    }
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!resp.ok) throw new Error(`Error en runQuery ${cat}: ${resp.status} ${await resp.text()}`);
  const rows = await resp.json();

  const docs = rows.filter((r) => r.document).map((r) => r.document);
  return docs.map(docAItem);
}

function leerJsonPrevio(cat) {
  const file = path.join(OUT_DIR, `${cat}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return null;
  }
}

// --- Resync completo: se dispara con la variable de entorno FULL_RESYNC=true
// (pensado para correrlo una vez por semana desde un segundo workflow de
// GitHub Actions). Relee TODA la colección y REEMPLAZA la lista entera, en
// vez de mergear. Esto es lo único que detecta borrados: si un doc ya no
// está en Firestore, al reemplazar la lista completa simplemente deja de
// aparecer. El modo incremental de todos los días NUNCA puede detectar
// borrados por sí solo, porque solo pregunta "qué hay nuevo", nunca "qué
// falta". ---
const FULL_RESYNC = process.env.FULL_RESYNC === "true";

// --- Colchón de seguridad: en vez de pedir "mayor al timestamp más nuevo
// que vimos", pedimos "mayor a ESE timestamp menos X horas". Esto cubre
// el caso de que el scraper escriba un documento con timestamp más viejo
// DESPUÉS de que el cursor ya avanzó por otro documento más nuevo (por
// ej. corridas del scraper en distinto orden, o timestamps que no quedan
// perfectamente ordenados). Sin esto, ese documento queda huérfano para
// siempre en el modo incremental, porque nunca es "mayor" al cursor. El
// costo extra es mínimo: solo se releen los documentos de esta ventana
// (no toda la colección), y como el merge es por slug, releer algo que
// ya teníamos no genera duplicados. ---
const BUFFER_MS = 48 * 60 * 60 * 1000; // 2 días de margen

async function buildCache() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const cat of CATEGORIAS) {
    const previo = leerJsonPrevio(cat);
    let items;

    if (FULL_RESYNC) {
      // Resync semanal: relectura completa, reemplaza todo (así se van
      // los borrados que el modo incremental nunca hubiera notado).
      items = await fetchColeccionCompleta(cat);
      console.log(`${cat}: resync completo, ${items.length} documentos (reemplaza la lista entera)`);
    } else if (previo && previo.items && previo.items.length > 0) {
      // Ya hay datos guardados: buscamos el timestamp más nuevo que
      // tenemos y le pedimos a Firestore solo lo posterior a eso.
      let cursor = previo.items[0].timestamp;
      for (const it of previo.items) {
        if (parseTimestamp(it.timestamp) > parseTimestamp(cursor)) cursor = it.timestamp;
      }

      // Le restamos el colchón de seguridad al cursor real antes de
      // consultar, para no perder documentos que llegaron "atrasados".
      const cursorConMargen = cursor
        ? new Date(parseTimestamp(cursor) - BUFFER_MS).toISOString()
        : cursor;

      const nuevos = cursor ? await fetchNuevosDesde(cat, cursorConMargen) : await fetchColeccionCompleta(cat);
      console.log(`${cat}: ${nuevos.length} documentos nuevos/actualizados desde la última corrida`);

      const porSlug = new Map(previo.items.map((it) => [it.slug, it]));
      for (const nuevo of nuevos) porSlug.set(nuevo.slug, nuevo);
      items = Array.from(porSlug.values());
    } else {
      // Primera vez para esta categoría: lectura completa.
      items = await fetchColeccionCompleta(cat);
      console.log(`${cat}: primera sincronización, ${items.length} documentos`);
    }

    items.sort((a, b) => parseTimestamp(b.timestamp) - parseTimestamp(a.timestamp));

    fs.writeFileSync(
      path.join(OUT_DIR, `${cat}.json`),
      JSON.stringify({ generated_at: new Date().toISOString(), items })
    );
  }
}

buildCache().catch((err) => {
  console.error(err);
  process.exit(1);
});