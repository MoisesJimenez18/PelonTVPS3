(function(plugin) {

  var ID = plugin.getDescriptor().id;
  var PROJECT_ID = "pelontv-91671";
  var RESOLVER_URL = "https://pelontv-resolver.onrender.com/resolver_embed";

  // --- Filtramos por DOMINIO (no por nombre): el mismo dominio real puede
  // aparecer etiquetado con distinto "nombre" según la colección (ej.
  // minochinos.com aparece como "Vidhide" en peliculas y como "Moe" en
  // series). Lo confiable es el dominio que sabemos que resuelve sin
  // necesitar navegador (hglink.to necesita JS y por eso queda afuera).
  var WORKING_DOMAINS = ["vidhidepro.com", "minochinos.com", "callistanise.com", "vidhideplus.com", "streamwish.to"];

  // --- Canales de TV en vivo que NO usan el esquema P.A.C.K.E.R (son
  // paginas propias, cada una con su propio truco de ofuscacion). Se
  // resuelven con resolveLocalGenerico(), que prueba varias estrategias
  // genericas en orden (ver mas abajo). Confirmado con analizar_embed.py:
  //   - enlace.org: array `link = [...]` de Player.js, con anuncios viejos
  //     dejados comentados con '//' que hay que ignorar.
  //   - edge-apps.net (canal_luz, etc): JSON de configuracion metido en
  //     un atob("...") en base64, con el link real anidado adentro
  //     (asset.publishPoints.hls).
  var LIVE_TV_DOMAINS = ["enlace.org", "edge-apps.net", "streamx-hd.com", "stream-xhd.com"];

  // --- Mapeo de dominio -> etiqueta LIMPIA para mostrar. El campo "nombre"
  // que viene de la base es inconsistente (a veces dice "Vidhide", a veces
  // "Moe" para el mismo dominio real), así que ignoramos ese campo y
  // mostramos siempre el mismo nombre prolijo según el dominio detectado.
  var DOMAIN_LABELS = {
    "vidhidepro.com": "Vidhide",
    "minochinos.com": "Vidhide",
    "callistanise.com": "Vidhide",
    "vidhideplus.com": "Vidhide",
    "streamwish.to": "StreamWish",
    "enlace.org": "Enlace",
    "edge-apps.net": "TV Directo",
    "streamx-hd.com": "TV Directo",
    "stream-xhd.com": "TV Directo"
  };

  // --- Cuánto tiempo (en ms) consideramos "nuevo" un contenido para
  // mostrarle el badge 🆕. Tocá este número si querés cambiar la ventana. ---
  var NUEVO_MS = 5 * 24 * 60 * 60 * 1000; // 5 días

  function isLiveTvDomain(url) {
    if (!url) return false;
    for (var i = 0; i < LIVE_TV_DOMAINS.length; i++) {
      if (url.indexOf(LIVE_TV_DOMAINS[i]) >= 0) return true;
    }
    return false;
  }

  // --- URLs que YA son un m3u8 final (ej. Canal 26/telecentro), sin pagina
  // embed de por medio con JS ofuscado que desarmar. Se detectan por
  // extension en la ruta (ignorando query string), y saltan directo a
  // reproduccion -- ver resolveDirectM3u8 mas abajo.
  function esM3u8Directo(url) {
    if (!url) return false;
    return /\.m3u8(\?|$)/i.test(url);
  }

  function isAllowedServer(server) {
    if (!server || !server.url) return false;
    if (isLiveTvDomain(server.url)) return true;
    if (esM3u8Directo(server.url)) return true;
    for (var i = 0; i < WORKING_DOMAINS.length; i++) {
      if (server.url.indexOf(WORKING_DOMAINS[i]) >= 0) return true;
    }
    return false;
  }

  function labelForServer(server) {
    for (var dom in DOMAIN_LABELS) {
      if (server.url.indexOf(dom) >= 0) return DOMAIN_LABELS[dom];
    }
    if (esM3u8Directo(server.url)) return "TV Directo";
    return server.nombre || "Servidor";
  }

  plugin.createService("PelonTV", ID + ":start", "video", true, null);

  plugin.addURI(ID + ":start", function(page) {
    page.metadata.title = "PelonTV";
    page.type = "directory";
    page.loading = false;
    page.appendItem(ID + ":cat:peliculas", "directory", { title: "🎬 Peliculas" });
    page.appendItem(ID + ":cat:series", "directory", { title: "📺 Series" });
    page.appendItem(ID + ":cat:anime", "directory", { title: "🎌 Anime" });
    page.appendItem(ID + ":cat:tv", "directory", { title: "📡 TV" });
  });

  // --- Lista de categorías, usada como "tabs" arriba de cada grilla para
  // poder saltar de Peliculas a Series/Anime/TV sin pasar por un menú aparte ---
  var CATEGORIAS = [
    { id: "peliculas", label: "🎬 Peliculas" },
    { id: "series", label: "📺 Series" },
    { id: "anime", label: "🎌 Anime" },
    { id: "tv", label: "📡 TV" }
  ];

  function unwrap(field) {
    if (!field) return null;
    if (field.stringValue !== undefined) return field.stringValue;
    if (field.integerValue !== undefined) return parseInt(field.integerValue);
    if (field.doubleValue !== undefined) return field.doubleValue;
    if (field.booleanValue !== undefined) return field.booleanValue;
    if (field.arrayValue !== undefined) {
      var arr = [];
      var vals = (field.arrayValue.values || []);
      for (var i = 0; i < vals.length; i++) arr.push(unwrap(vals[i]));
      return arr;
    }
    if (field.mapValue !== undefined) {
      var obj = {};
      var mf = field.mapValue.fields || {};
      for (var k in mf) obj[k] = unwrap(mf[k]);
      return obj;
    }
    return null;
  }

  // --- Convierte el string ISO ("2026-07-01T21:30:48.630373") a millis.
  // JS no entiende bien los microsegundos (6 dígitos), así que lo recortamos
  // a milisegundos (3 dígitos) antes de parsear. ---
  function parseTimestamp(ts) {
    if (!ts) return 0;
    var recortado = ts.replace(/(\.\d{3})\d*$/, "$1");
    var t = Date.parse(recortado);
    return isNaN(t) ? 0 : t;
  }

  function esNuevo(ts) {
    var t = parseTimestamp(ts);
    if (!t) return false;
    return (Date.now() - t) <= NUEVO_MS;
  }

  // --- Trae los documentos (titulo, portada, timestamp) de una colección,
  // ya optimizado. Pedir un campo más NO consume lecturas extra: Firestore
  // cobra por documento leído, no por campo devuelto. ---
  // cacheTime: Movian guarda la respuesta HTTP en el propio dispositivo. Mientras estés
  // navegando/buscando dentro de esta ventana, no vuelve a pegarle a Firestore -> 0 lecturas nuevas.
  var CACHE_LISTA = 300;   // 5 min: listado de categoría / búsqueda (antes 1800; el cron ahora corre cada 15 min, así que no tiene sentido cachear más que eso en el dispositivo)
  var CACHE_DOC   = 900;   // 15 min: documento puntual (antes 300)

  // --- URL del cache estático generado por GitHub Actions (ver repo
  // pelontv-cache). Reemplazá TU_USUARIO/TU_REPO por los tuyos. Esto es
  // lo que reemplaza la consulta directa a Firestore para listar.
  //
  // Usamos raw.githubusercontent.com en vez de jsdelivr: jsdelivr cachea
  // agresivo y el purge falla seguido (a veces "éxito" pero sigue
  // sirviendo lo viejo, y encima limita cuántos purges aceptás por hora
  // para la misma URL). raw.githubusercontent actualiza solo, sin purge,
  // con un cache corto que combina bien con CACHE_LISTA de acá abajo. ---
  var CACHE_BASE_URL = "https://raw.githubusercontent.com/MoisesJimenez18/PelonTVPS3/main/output/";

  function fetchTitulos(cat) {
    var url = CACHE_BASE_URL + cat + ".json";
    var resp = showtime.httpReq(url, { caching: true, cacheTime: CACHE_LISTA });
    var data = JSON.parse(resp.toString());
    var items = data.items || [];

    // El orden (más nuevo primero) ya viene armado desde el cache;
    // acá solo calculamos el badge 🆕 relativo a "ahora".
    for (var i = 0; i < items.length; i++) {
      items[i].nuevo = esNuevo(items[i].timestamp);
    }

    return items;
  }

  // --- Título con badge si es contenido nuevo ---
  function tituloConBadge(item) {
    return (item.nuevo ? "🆕 " : "") + item.titulo;
  }

  // --- Normaliza rating a escala 0-1, que es lo que espera Movian para
  // pintar las estrellitas. Si el valor viene > 1 asumimos escala 0-10
  // (tipo IMDb) y lo convertimos. Si tu dato ya viene en 0-1, no toca nada.
  // AVISAME si tu campo real usa otra escala (ej. 0-100) y lo ajusto. ---
  function ratingNormalizado(v) {
    if (v === null || v === undefined || v === "") return undefined;
    v = Number(v);
    if (isNaN(v)) return undefined;
    if (v > 1) return v / 10;
    return v;
  }

  // --- Arma la metadata de un item de LISTADO (categoría/búsqueda) usando
  // los nombres de campo más probables de tu cache JSON. Si tu JSON usa
  // otros nombres (ej. "synopsis" en vez de "descripcion"), decime cuáles
  // son y los agrego a la lista de alias. Ningún campo faltante rompe nada,
  // simplemente no se muestra. ---
  function metaItemLista(item) {
    var meta = {
      title: tituloConBadge(item),
      icon: item.poster
    };

    var backdrop = item.backdrop || item.fondo || item.poster;
    if (backdrop) meta.background = backdrop;

    var desc = item.descripcion || item.sinopsis || item.synopsis || item.resumen;
    if (desc) meta.description = desc;

    var anio = item.anio || item.year;
    var genero = item.genero || item.genre;
    var tagline = anio ? (String(anio) + (genero ? " · " + genero : "")) : genero;
    if (tagline) meta.tagline = tagline;

    var rating = ratingNormalizado(item.rating || item.puntuacion || item.calificacion);
    if (rating !== undefined) meta.rating = rating;

    return meta;
  }

  // --- Trae el documento COMPLETO (siempre los mismos campos), pidiendo
  // una única combinación fija. Así, aunque el usuario navegue de "abrir"
  // a "temporada" a "capitulo" del mismo título, es siempre la MISMA url
  // -> Movian sirve todo desde su cache local sin volver a pegarle a
  // Firestore. Antes cada pantalla pedía una máscara de campos distinta
  // y eso invalidaba el cache entre pantallas del mismo título. ---
  var MASK_DOC_COMPLETO = [
    "servidores", "temporadas", "titulo", "portada", "backdrop",
    // Campos extra de metadata: si tu documento no los tiene, Firestore
    // simplemente no los devuelve (no rompe nada). Decime los nombres
    // reales si son distintos y los ajusto.
    "descripcion", "sinopsis", "anio", "genero", "rating",
    // Campos propios de la coleccion "tv" (canales en vivo): estructura
    // distinta a peliculas/series, por eso van aparte. Sin "embeds" en
    // esta lista, Firestore ni siquiera devuelve ese campo -> por eso
    // antes caia en "Formato de documento no reconocido".
    "embeds", "canal", "imagen", "generos", "anio_fundacion"
  ];

  function fetchDoc(cat, titulo) {
    var url = "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID +
               "/databases/(default)/documents/" + cat + "/" + encodeURIComponent(titulo);
    for (var i = 0; i < MASK_DOC_COMPLETO.length; i++) {
      url += (url.indexOf("?") >= 0 ? "&" : "?") + "mask.fieldPaths=" + MASK_DOC_COMPLETO[i];
    }
    var resp = showtime.httpReq(url, { caching: true, cacheTime: CACHE_DOC });
    return JSON.parse(resp.toString());
  }

  function appendServidores(page, servidoresRaw) {
    var servidores = [];
    for (var i = 0; i < servidoresRaw.length; i++) {
      if (isAllowedServer(servidoresRaw[i])) servidores.push(servidoresRaw[i]);
    }

    if (servidores.length === 0) {
      page.error("No hay servidores compatibles disponibles");
      return;
    }

    for (var j = 0; j < servidores.length; j++) {
      var s = servidores[j];
      var label = "▶ " + (s.idioma || "?") + " - " + labelForServer(s);
      var uri = ID + ":play:" + encodeURIComponent(s.url);
      page.appendItem(uri, "video", { title: label });
    }
  }

  // --- Formato de la colección "tv": en vez de "servidores" (con
  // .url/.idioma como peliculas/series), cada documento trae un array
  // "embeds" con .embed_url/.opcion/.tipo. Estructura distinta, asi que
  // va con su propia funcion en vez de forzarla dentro de appendServidores. ---
  function appendEmbeds(page, embedsRaw) {
    var embeds = [];
    for (var i = 0; i < embedsRaw.length; i++) {
      var e = embedsRaw[i];
      if (e && e.embed_url && isAllowedServer({ url: e.embed_url })) {
        embeds.push(e);
      }
    }

    if (embeds.length === 0) {
      page.error("No hay servidores compatibles disponibles");
      return;
    }

    for (var j = 0; j < embeds.length; j++) {
      var e2 = embeds[j];
      var label = "▶ " + (e2.opcion || labelForServer({ url: e2.embed_url }));
      var uri = ID + ":play:" + encodeURIComponent(e2.embed_url);
      page.appendItem(uri, "video", { title: label });
    }
  }

  // --- Le dice al skin nativo de Movian qué tipo de contenido es cada
  // categoría. Esto es lo que activa la vista en grilla de posters (en vez
  // de lista simple) y hace que el skin la reacomode solo según el tamaño
  // y orientación de la pantalla (vertical/horizontal). No es CSS nuestro,
  // es comportamiento nativo del skin al detectar este "contents". ---
  var CONTENTS_POR_CAT = {
    peliculas: "movies",
    series: "tvshows",
    anime: "tvshows",
    tv: "tvchannels"
  };

  // --- Lista una colección de Firestore (peliculas/series/etc) ---
  plugin.addURI(ID + ":cat:(.*)", function(page, cat) {
    page.metadata.title = cat;
    page.type = "directory";
    page.metadata.contents = CONTENTS_POR_CAT[cat] || "items";
    page.loading = true;

    // Barra de búsqueda arriba de todo. Al tocarla, Movian pide texto y
    // navega a ID + ":buscar:" + cat + ":" + <texto ingresado>.
    page.appendItem(ID + ":buscar:" + cat + ":", "search", {
      title: "🔍 Buscar en " + cat
    });

    try {
      var items = fetchTitulos(cat);

      if (items.length === 0) {
        page.error("No se encontró contenido en " + cat);
        page.loading = false;
        return;
      }

      // Usamos el poster del más nuevo como fondo de la página, si existe.
      if (items[0].poster) page.metadata.background = items[0].poster;

      for (var i = 0; i < items.length; i++) {
        var uri = ID + ":abrir:" + cat + ":" + encodeURIComponent(items[i].slug);
        page.appendItem(uri, "directory", metaItemLista(items[i]));
      }
    } catch (e) {
      showtime.print("ERROR PelonTV: " + e);
      page.error("Error: " + e);
    }

    page.loading = false;
  });

  // --- Búsqueda dentro de una categoría ---
  plugin.addURI(ID + ":buscar:([^:]+):(.*)", function(page, cat, queryEnc) {
    var query = decodeURIComponent(queryEnc || "").toLowerCase().trim();
    page.metadata.title = "Resultados: " + query;
    page.type = "directory";
    page.metadata.contents = CONTENTS_POR_CAT[cat] || "items";
    page.loading = true;

    if (!query) {
      page.error("Escribí algo para buscar");
      page.loading = false;
      return;
    }

    try {
      var items = fetchTitulos(cat);
      var encontrados = 0;

      for (var i = 0; i < items.length; i++) {
        if (items[i].titulo.toLowerCase().indexOf(query) >= 0) {
          var uri = ID + ":abrir:" + cat + ":" + encodeURIComponent(items[i].slug);
          page.appendItem(uri, "directory", metaItemLista(items[i]));
          encontrados++;
        }
      }

      if (encontrados === 0) {
        page.error("Sin resultados para \"" + query + "\"");
      }
    } catch (e) {
      showtime.print("ERROR buscar: " + e);
      page.error("Error: " + e);
    }

    page.loading = false;
  });

  // --- Abre un título: detecta si es película (servidores directo) o
  // serie/anime (temporadas -> capitulos -> servidores) ---
  plugin.addURI(ID + ":abrir:([^:]+):(.*)", function(page, cat, tituloEnc) {
    var slug = decodeURIComponent(tituloEnc);
    page.type = "directory";
    page.loading = true;

    try {
      var doc = fetchDoc(cat, slug);
      var f = doc.fields || {};
      page.metadata.title = unwrap(f.titulo) || slug;

      // Antes se usaba el mismo valor para icon Y background; separamos
      // poster (vertical, para el ícono) de backdrop (horizontal, para el
      // fondo), con fallback al poster si no hay backdrop propio. La
      // coleccion "tv" usa "imagen" en vez de "portada", por eso el fallback.
      var poster = unwrap(f.portada) || unwrap(f.imagen);
      var backdrop = unwrap(f.backdrop) || poster;
      if (poster) page.metadata.icon = poster;
      if (backdrop) page.metadata.background = backdrop;

      var descripcion = unwrap(f.descripcion) || unwrap(f.sinopsis);
      if (descripcion) page.metadata.description = descripcion;

      var anio = unwrap(f.anio);
      var genero = unwrap(f.genero);
      var tagline = anio ? (String(anio) + (genero ? " · " + genero : "")) : genero;
      if (tagline) page.metadata.tagline = tagline;

      var rating = ratingNormalizado(unwrap(f.rating));
      if (rating !== undefined) page.metadata.rating = rating;

      if (f.servidores) {
        // Formato película: servidores directo en el documento
        var servidoresRaw = unwrap(f.servidores) || [];
        appendServidores(page, servidoresRaw);
      } else if (f.embeds) {
        // Formato canal de TV en vivo: array "embeds" (.embed_url/.opcion)
        var embedsRaw = unwrap(f.embeds) || [];
        appendEmbeds(page, embedsRaw);
      } else if (f.temporadas) {
        // Formato serie: listamos temporadas
        var temporadas = unwrap(f.temporadas) || [];
        for (var t = 0; t < temporadas.length; t++) {
          page.appendItem(
            ID + ":temporada:" + cat + ":" + tituloEnc + ":" + t,
            "directory",
            { title: "Temporada " + (t + 1) }
          );
        }
        if (temporadas.length === 0) {
          page.error("No se encontraron temporadas");
        }
      } else {
        page.error("Formato de documento no reconocido");
      }
    } catch (e) {
      showtime.print("ERROR abrir: " + e);
      page.error("Error: " + e);
    }

    page.loading = false;
  });

  // --- Lista los capítulos de una temporada ---
  plugin.addURI(ID + ":temporada:([^:]+):([^:]+):(\\d+)", function(page, cat, tituloEnc, seasonIdxStr) {
    var seasonIdx = parseInt(seasonIdxStr);
    page.metadata.title = "Temporada " + (seasonIdx + 1);
    page.type = "directory";
    page.loading = true;

    try {
      var titulo = decodeURIComponent(tituloEnc);
      var doc = fetchDoc(cat, titulo);
      var f = doc.fields || {};
      var temporadas = unwrap(f.temporadas) || [];
      var capitulos = (temporadas[seasonIdx] && temporadas[seasonIdx].capitulos) || [];

      if (capitulos.length === 0) {
        page.error("No se encontraron capítulos en esta temporada");
        page.loading = false;
        return;
      }

      for (var c = 0; c < capitulos.length; c++) {
        var numero = capitulos[c].numero || (c + 1);
        page.appendItem(
          ID + ":capitulo:" + cat + ":" + tituloEnc + ":" + seasonIdx + ":" + c,
          "directory",
          { title: "Capítulo " + numero }
        );
      }
    } catch (e) {
      showtime.print("ERROR temporada: " + e);
      page.error("Error: " + e);
    }

    page.loading = false;
  });

  // --- Muestra los servidores de un capítulo puntual ---
  plugin.addURI(ID + ":capitulo:([^:]+):([^:]+):(\\d+):(\\d+)", function(page, cat, tituloEnc, seasonIdxStr, capIdxStr) {
    var seasonIdx = parseInt(seasonIdxStr);
    var capIdx = parseInt(capIdxStr);
    page.type = "directory";
    page.loading = true;

    try {
      var titulo = decodeURIComponent(tituloEnc);
      var doc = fetchDoc(cat, titulo);
      var f = doc.fields || {};
      var temporadas = unwrap(f.temporadas) || [];
      var capitulo = temporadas[seasonIdx] && temporadas[seasonIdx].capitulos &&
                     temporadas[seasonIdx].capitulos[capIdx];

      if (!capitulo) {
        page.error("No se encontró el capítulo");
        page.loading = false;
        return;
      }

      page.metadata.title = "T" + (seasonIdx + 1) + " - Cap " + (capitulo.numero || (capIdx + 1));

      // Si el capítulo trae su propia miniatura/descripción en Firestore,
      // la mostramos (no todos los formatos de serie la tienen, así que
      // es opcional y no rompe nada si falta).
      if (capitulo.portada) {
        page.metadata.icon = capitulo.portada;
        page.metadata.background = capitulo.portada;
      }
      if (capitulo.descripcion) page.metadata.description = capitulo.descripcion;

      var servidoresRaw = capitulo.servidores || [];
      appendServidores(page, servidoresRaw);
    } catch (e) {
      showtime.print("ERROR capitulo: " + e);
      page.error("Error: " + e);
    }

    page.loading = false;
  });

  // ===========================================================
  // Resolucion LOCAL GENERICA para canales de TV en vivo (Enlace,
  // Canal Luz, y cualquier otro que caiga en LIVE_TV_DOMAINS).
  //
  // Cada sitio de TV tiene su propio truco de ofuscacion (no hay un
  // "streamwish" unico como en peliculas), asi que en vez de un
  // parser por sitio, probamos varias estrategias GENERICAS en orden
  // -- el mismo enfoque que analizar_embed.py, ya validado a mano:
  //   1. atob("...") en base64 con JSON de configuracion adentro
  //      (busca .m3u8 recursivamente en cualquier profundidad).
  //   2. Player.js: `link = [{"title":..,"file":".."}, ...]`, IGNORANDO
  //      las lineas comentadas con '//' (asi no agarra anuncios/demos
  //      viejos dejados comentados en el codigo).
  //   3. Regex generico de .m3u8 sobre el codigo sin comentar, como
  //      ultimo recurso.
  // Si aparece mas de un candidato, se prueban EN ORDEN pidiendole a
  // cada uno el archivo real hasta encontrar el primero que responda
  // con una playlist valida (#EXTM3U) -- asi, si hay un candidato roto
  // o un demo mezclado, no nos quedamos pegados en el primero.
  // ===========================================================

  var B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  // Decodifica base64 estandar a texto UTF-8, sin depender de atob/Buffer
  // (por compatibilidad con el motor JS de Movian).
  function decodeBase64Utf8(b64) {
    b64 = b64.replace(/[^A-Za-z0-9+/=]/g, "");
    var bytes = [];
    var buffer = 0, bits = 0;
    for (var i = 0; i < b64.length; i++) {
      var c = b64.charAt(i);
      if (c === "=") break;
      var idx = B64_CHARS.indexOf(c);
      if (idx === -1) continue;
      buffer = (buffer << 6) | idx;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((buffer >> bits) & 0xFF);
      }
    }
    return utf8BytesToString(bytes);
  }

  function utf8BytesToString(bytes) {
    var result = "";
    var i = 0;
    while (i < bytes.length) {
      var b1 = bytes[i++];
      if (b1 < 0x80) {
        result += String.fromCharCode(b1);
      } else if (b1 >= 0xC0 && b1 < 0xE0 && i < bytes.length) {
        var b2 = bytes[i++];
        result += String.fromCharCode(((b1 & 0x1F) << 6) | (b2 & 0x3F));
      } else if (b1 >= 0xE0 && b1 < 0xF0 && i + 1 < bytes.length) {
        var b2b = bytes[i++], b3 = bytes[i++];
        result += String.fromCharCode(((b1 & 0x0F) << 12) | ((b2b & 0x3F) << 6) | (b3 & 0x3F));
      } else if (i + 2 < bytes.length) {
        var b2c = bytes[i++], b3b = bytes[i++], b4 = bytes[i++];
        var codepoint = ((b1 & 0x07) << 18) | ((b2c & 0x3F) << 12) | ((b3b & 0x3F) << 6) | (b4 & 0x3F);
        codepoint -= 0x10000;
        result += String.fromCharCode(0xD800 + (codepoint >> 10), 0xDC00 + (codepoint & 0x3FF));
      } else {
        i = bytes.length; // secuencia incompleta al final, cortamos
      }
    }
    return result;
  }

  // Saca lineas que son puramente un comentario de JS (arrancan con
  // '//' una vez sacado el espacio en blanco al principio). Deliberadamente
  // conservador: no toca '//' en medio de una linea de codigo real (ej.
  // dentro de una URL "https://..."), asi que no rompe codigo que si corre.
  function quitarComentariosJs(texto) {
    var lineas = texto.split(/\r?\n/);
    var limpias = [];
    for (var i = 0; i < lineas.length; i++) {
      if (lineas[i].replace(/^\s+/, "").indexOf("//") === 0) continue;
      limpias.push(lineas[i]);
    }
    return limpias.join("\n");
  }

  var ATOB_PATTERN = /atob\(\s*["']([A-Za-z0-9+/=]+)["']\s*\)/g;

  function extraerAtobBlobs(content) {
    var resultados = [];
    var m;
    ATOB_PATTERN.lastIndex = 0;
    while ((m = ATOB_PATTERN.exec(content)) !== null) {
      try {
        resultados.push(decodeBase64Utf8(m[1]));
      } catch (e) {
        // blob invalido, lo salteamos
      }
    }
    return resultados;
  }

  // Recorre un objeto JSON (obj/array) recursivamente buscando cualquier
  // string que contenga ".m3u8", sin asumir una estructura fija (sirve
  // para cualquier sitio que meta el link real anidado en cualquier
  // profundidad, como asset.publishPoints.hls en canal_luz).
  function buscarM3u8EnJsonAnidado(obj) {
    var encontrados = [];
    if (obj === null || obj === undefined) return encontrados;
    if (typeof obj === "string") {
      if (obj.indexOf(".m3u8") >= 0) encontrados.push(obj);
    } else if (Object.prototype.toString.call(obj) === "[object Array]") {
      for (var i = 0; i < obj.length; i++) {
        encontrados = encontrados.concat(buscarM3u8EnJsonAnidado(obj[i]));
      }
    } else if (typeof obj === "object") {
      for (var k in obj) {
        encontrados = encontrados.concat(buscarM3u8EnJsonAnidado(obj[k]));
      }
    }
    return encontrados;
  }

  var PLAYERJS_LINK_PATTERN = /\blink\s*=\s*(\[\s*\{[\s\S]*?\}\s*\])\s*;?/g;

  // Busca TODAS las asignaciones `link = [{"title":..,"file":".."}, ...]`
  // en el codigo YA SIN comentar. La ULTIMA que encuentra es la que
  // efectivamente queda vigente cuando el JS corre en el navegador (una
  // reasignacion pisa a la anterior), asi que se recorre al reves.
  function extractPlayerjsLinks(sinComentarios) {
    var resultados = [];
    var m;
    PLAYERJS_LINK_PATTERN.lastIndex = 0;
    while ((m = PLAYERJS_LINK_PATTERN.exec(sinComentarios)) !== null) {
      try {
        var data = JSON.parse(m[1]);
        if (Object.prototype.toString.call(data) === "[object Array]") {
          resultados.push(data);
        }
      } catch (e) {
        // no era JSON valido, lo salteamos
      }
    }
    return resultados;
  }

  function m3u8sDePlayerjsArray(arr) {
    var urls = [];
    for (var i = 0; i < arr.length; i++) {
      var entrada = arr[i];
      if (entrada && entrada.file && entrada.file.indexOf(".m3u8") >= 0) {
        urls.push(entrada.file);
      }
    }
    return urls;
  }

  function findM3u8GenericJs(text) {
    var regex = /https?:\\?\/\\?\/[^\s"'\\]+?\.m3u8[^\s"'\\]*/g;
    var matches = [];
    var m;
    regex.lastIndex = 0;
    while ((m = regex.exec(text)) !== null) {
      matches.push(m[0].replace(/\\\//g, "/"));
    }
    return matches;
  }

  // Esquema real de stream-xhd.com (portado de Teststreamxhd.py, PASO 3):
  // un array `VAR=[[idx,"b64"],[idx,"b64"],...]` (puede tener 100+
  // elementos) se ordena por indice, se calcula un offset k = fn1()+fn2()
  // (dos funciones declaradas en la misma pagina, cada una
  // `function fn(){return NUMERO;}`), y por cada bloque: se decodifica
  // el base64 (da basura tipo "Xt850146hj"), se le sacan SOLO los
  // digitos ("850146"), se les resta k, y el resultado es el codigo
  // ASCII de UN caracter. Concatenando todos los caracteres en orden de
  // indice se arma el string final (la URL real).
  //
  // IMPORTANTE: el array puede tener 100-150+ elementos. Un solo regex
  // gigante que intente matchear TODO el array de una (grupo repetido
  // con quantifier) puede colgar motores JS limitados (como el de
  // Movian en PS3) por backtracking catastrofico. Por eso el array se
  // corta A MANO contando corchetes (lineal, sin backtracking), y solo
  // se usan regex CHICOS y acotados a una ventana corta de texto para
  // el resto de la estructura.

  // Encuentra el indice donde arranca "[[" de la declaracion "VAR=[[".
  var CHAR_ARRAY_DECL_PATTERN = /(\w+)\s*=\s*\[\[/g;

  // Dado el indice del primer "[" de "[[...]]", devuelve el string
  // completo del array (incluyendo los corchetes externos) contando
  // profundidad de corchetes. El base64/JSON adentro no tiene '[' ni
  // ']' en su alfabeto, asi que contar a nivel de caracter es seguro.
  function cortarArrayLiteral(content, inicio) {
    var profundidad = 0;
    for (var i = inicio; i < content.length; i++) {
      var ch = content.charAt(i);
      if (ch === "[") profundidad++;
      else if (ch === "]") {
        profundidad--;
        if (profundidad === 0) return content.substring(inicio, i + 1);
      }
    }
    return null; // nunca cerro, HTML cortado o algo raro -- lo descartamos
  }

  function findFunctionReturn(content, fnName) {
    var re = new RegExp("function\\s+" + fnName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\(\\)\\{return\\s*(\\d+);\\}");
    var m = content.match(re);
    return m ? parseInt(m[1], 10) : null;
  }

  // Salta un bloque "(...)" balanceado a partir del indice del primer
  // "(" y devuelve la posicion JUSTO DESPUES del ")" que lo cierra.
  // Igual que cortarArrayLiteral pero para parentesis -- necesario
  // porque el ".sort(...)" puede traer una arrow function con sus
  // propios parentesis anidados (ej. ".sort((a,b)=>a[0]-b[0])"), y no
  // podemos asumir que el primer ")" que aparece es el que cierra.
  function saltarParentesis(content, inicioParen) {
    var profundidad = 0;
    for (var i = inicioParen; i < content.length; i++) {
      var ch = content.charAt(i);
      if (ch === "(") profundidad++;
      else if (ch === ")") {
        profundidad--;
        if (profundidad === 0) return i + 1;
      }
    }
    return -1;
  }

  function decodeCharArrayBlocks(content) {
    var resultados = [];
    var mDecl;
    CHAR_ARRAY_DECL_PATTERN.lastIndex = 0;

    while ((mDecl = CHAR_ARRAY_DECL_PATTERN.exec(content)) !== null) {
      var arrayVar = mDecl[1];
      // mDecl[0] es "VAR=[[", el primer "[" del array arranca 2
      // caracteres antes del final del match.
      var inicioArray = mDecl.index + mDecl[0].length - 2;

      var arrayLiteral = cortarArrayLiteral(content, inicioArray);
      if (!arrayLiteral) continue;

      var puntero = inicioArray + arrayLiteral.length;
      // Reanudamos la busqueda del PROXIMO "VAR=[[" justo despues de
      // este array, para no volver a escanear el mismo bloque.
      CHAR_ARRAY_DECL_PATTERN.lastIndex = puntero;

      // Esperamos ";" (con espacios opcionales) antes de ARRAYVAR.sort(
      var mPuntoYComa = content.substr(puntero, 20).match(/^\s*;\s*/);
      if (!mPuntoYComa) continue;
      puntero += mPuntoYComa[0].length;

      var prefijoSort = arrayVar + ".sort(";
      if (content.substr(puntero, prefijoSort.length) !== prefijoSort) continue;
      var finSort = saltarParentesis(content, puntero + prefijoSort.length - 1);
      if (finSort === -1) continue;

      // Ventana CHICA (no todo el documento) inmediatamente despues del
      // .sort(...), donde deberia estar "var k = fn1() + fn2(); ARRAYVAR.forEach(".
      // Regex acotado a 200 caracteres, asi que no hay riesgo de
      // backtracking largo aunque el patron no matchee.
      var ventana = content.substr(finSort, 200);
      var reResto = new RegExp(
        "^\\s*;\\s*var\\s+k\\s*=\\s*(\\w+)\\(\\)\\s*\\+\\s*(\\w+)\\(\\)\\s*;\\s*" +
        arrayVar.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\.forEach\\("
      );
      var mResto = ventana.match(reResto);
      if (!mResto) continue; // no matchea el resto del patron esperado

      var fn1 = mResto[1], fn2 = mResto[2];

      var pairs;
      try {
        pairs = JSON.parse(arrayLiteral);
      } catch (e) {
        continue;
      }
      pairs.sort(function(a, b) { return a[0] - b[0]; });

      var n1 = findFunctionReturn(content, fn1);
      var n2 = findFunctionReturn(content, fn2);
      if (n1 === null || n2 === null) continue;

      var k = n1 + n2;
      var decoded = "";
      var ok = true;
      for (var i = 0; i < pairs.length; i++) {
        try {
          var raw = decodeBase64Utf8(pairs[i][1]);
          var digits = raw.replace(/\D/g, "");
          var code = parseInt(digits, 10) - k;
          decoded += String.fromCharCode(code);
        } catch (e) {
          ok = false;
          break;
        }
      }
      if (ok) resultados.push(decoded);
    }
    return resultados;
  }

  function agregarCandidato(lista, url) {
    if (url && lista.indexOf(url) === -1) lista.push(url);
  }

  // Junta candidatos de las 4 estrategias, en orden de prioridad
  // (atob-JSON primero, despues base64 suelto, despues Player.js, y el
  // regex generico al final como red de seguridad).
  function candidatosDesdeEmbed(html) {
    var sinComentarios = quitarComentariosJs(html);
    var candidatos = [];

    var blobs = extraerAtobBlobs(html);
    for (var i = 0; i < blobs.length; i++) {
      try {
        var data = JSON.parse(blobs[i]);
        var urls = buscarM3u8EnJsonAnidado(data);
        for (var j = 0; j < urls.length; j++) agregarCandidato(candidatos, urls[j]);
      } catch (e) {
        var found = findM3u8GenericJs(blobs[i]);
        for (var k = 0; k < found.length; k++) agregarCandidato(candidatos, found[k]);
      }
    }

    var bloquesCharArray = decodeCharArrayBlocks(html);
    for (var s = 0; s < bloquesCharArray.length; s++) {
      if (bloquesCharArray[s].indexOf(".m3u8") >= 0) agregarCandidato(candidatos, bloquesCharArray[s]);
    }

    var arrays = extractPlayerjsLinks(sinComentarios);
    for (var a = arrays.length - 1; a >= 0; a--) {
      var urlsPjs = m3u8sDePlayerjsArray(arrays[a]);
      for (var u = 0; u < urlsPjs.length; u++) agregarCandidato(candidatos, urlsPjs[u]);
    }

    var genericos = findM3u8GenericJs(sinComentarios);
    for (var g = 0; g < genericos.length; g++) agregarCandidato(candidatos, genericos[g]);

    return candidatos;
  }

  // Pide el embed DESDE ESTE DISPOSITIVO, junta todos los candidatos
  // posibles, y los prueba EN ORDEN hasta encontrar uno que responda con
  // una playlist real. Devuelve { m3u8, referer } o null si ninguno anda.
  function resolveLocalGenerico(embedUrl) {
    // Movian manda el fragmento (#...) tal cual como parte de la request
    // HTTP -- a diferencia de un navegador, que lo corta antes de pedir
    // la pagina. Sitios como enlace.org (IIS) no reconocen esa ruta con
    // '#' y devuelven 404, asi que lo sacamos antes de pedir el embed.
    var embedUrlSinFragmento = embedUrl.replace(/#.*$/, "");

    var mOrigin = embedUrlSinFragmento.match(/^(https?:\/\/[^\/]+)/i);
    var referer = (mOrigin ? mOrigin[1] : embedUrlSinFragmento) + "/";

    var resp = showtime.httpReq(embedUrlSinFragmento, {
      headers: { "Referer": referer },
      caching: false
    });
    var html = resp.toString();

    var candidatos = candidatosDesdeEmbed(html);
    if (candidatos.length === 0) return null;

    for (var i = 0; i < candidatos.length; i++) {
      var m3u8 = resolveUrl(embedUrlSinFragmento, candidatos[i]);
      try {
        var test = showtime.httpReq(m3u8, {
          headers: { "Referer": referer },
          caching: false
        });
        var body = test.toString();
        if (body.indexOf("#EXTM3U") >= 0) {
          return { m3u8: m3u8, referer: referer };
        }
      } catch (e) {
        // este candidato fallo (red/403/etc), probamos el siguiente
      }
    }

    return null;
  }

  // ===========================================================
  // Resolucion LOCAL para StreamWish (sin pasar por Render).
  //
  // Por que: el CDN de streamwish (hgplaycdn.com) ata el link de video
  // a la red/IP de quien pidio la pagina del embed. Si Render (un
  // datacenter) es quien pide esa pagina, el link queda marcado y
  // el propio dispositivo (con IP residencial) lo recibe con 403
  // igual, aunque despues sea el que reproduce. La unica forma de que
  // ande es que el dispositivo mismo (Movian, con tu IP de casa)
  // pida la pagina del embed Y reproduzca el resultado.
  //
  // Esto es un port a JS del unpack_js / extract_links_dict que ya
  // tenias probado en Python (app.py). Misma logica, mismo algoritmo.
  // ===========================================================

  var ALPHABET_PACKER = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

  function unbasePacker(token, base) {
    if (base <= 36) return parseInt(token, base);
    var n = 0;
    for (var i = 0; i < token.length; i++) {
      n = n * base + ALPHABET_PACKER.indexOf(token.charAt(i));
    }
    return n;
  }

  // Decodifica escapes tipo \n \t \r \" \' \\ \/ que vienen literales
  // en el texto del payload empaquetado (equivalente a Python's
  // .decode('unicode_escape') para los casos que este empaquetador usa).
  function decodeUnicodeEscapes(str) {
    return str.replace(/\\(n|t|r|"|'|\\|\/)/g, function(full, ch) {
      if (ch === "n") return "\n";
      if (ch === "t") return "\t";
      if (ch === "r") return "\r";
      return ch; // \" \' \\ \/  ->  " ' \ /
    });
  }

  function unpackPackerJs(htmlOrJs) {
    var m = htmlOrJs.match(
      /eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\('([\s\S]*?)',\s*(\d+),\s*(\d+),\s*'([\s\S]*?)'\.split\('\|'\)/
    );
    if (!m) return null;

    var payload = decodeUnicodeEscapes(m[1]);
    var a = parseInt(m[2], 10);
    var k = m[4].split("|");

    return payload.replace(/\b\w+\b/g, function(word) {
      var idx = unbasePacker(word, a);
      return (idx < k.length && k[idx]) ? k[idx] : word;
    });
  }

  function extractLinksDict(unpackedJs) {
    var m = unpackedJs.match(/(?:var|let|const)\s+links\s*=\s*(\{.*?\});/);
    if (!m) return null;
    try {
      return JSON.parse(m[1]);
    } catch (e) {
      return null;
    }
  }

  // Resuelve una URL relativa contra una base, sin depender de la
  // clase URL (por compatibilidad con el motor JS de Movian).
  function resolveUrl(base, maybeRelative) {
    if (/^https?:\/\//i.test(maybeRelative)) return maybeRelative;
    var m = base.match(/^(https?:\/\/[^\/]+)/i);
    var origin = m ? m[1] : base;
    if (maybeRelative.charAt(0) === "/") return origin + maybeRelative;
    return origin + "/" + maybeRelative;
  }

  function pickBestHls(links, embedUrl) {
    var orden = ["hls4", "hls3", "hls2", "hls1"];
    for (var i = 0; i < orden.length; i++) {
      var key = orden[i];
      if (links[key]) return resolveUrl(embedUrl, links[key]);
    }
    return null;
  }

  function extractCode(url) {
    var m = url.match(/\/e\/([A-Za-z0-9]+)/) ||
             url.match(/\/v\/([A-Za-z0-9]+)/) ||
             url.match(/\/embed-([A-Za-z0-9]+)/) ||
             url.match(/\/embed\/([A-Za-z0-9]+)/);
    return m ? m[1] : null;
  }

  // Dominios "loader" que en realidad redirigen (por JS) a otro dominio
  // real. Streamwish.to no sirve el packer el mismo, hgplaycdn.com si.
  // Vidhide y sus dominios hermanos SI sirven el packer directo, sin
  // redirect -- no necesitan swap de dominio.
  var DOMAIN_SWAP = {
    "streamwish.to": "hgplaycdn.com"
  };

  function neededDomainSwap(embedUrl) {
    for (var loaderDom in DOMAIN_SWAP) {
      if (embedUrl.indexOf(loaderDom) >= 0) return DOMAIN_SWAP[loaderDom];
    }
    return null;
  }

  // Pide el embed DESDE ESTE DISPOSITIVO (IP residencial) -- valido
  // para cualquier proveedor de esta familia de CDN (confirmado que
  // tanto streamwish.to/hgplaycdn.com como Vidhide/minochinos.com
  // atan el link de video a la IP de quien pidio la pagina del embed;
  // Render, al ser datacenter, deja el link marcado y 403 igual
  // cuando el dispositivo intenta reproducirlo despues).
  // Devuelve { m3u8: "...", referer: "..." } o null si no se pudo.
  function resolveLocalPacker(embedUrl) {
    var fetchUrl = embedUrl;
    var referer = embedUrl;

    var realDomain = neededDomainSwap(embedUrl);
    if (realDomain) {
      var code = extractCode(embedUrl);
      if (!code) return null;
      fetchUrl = "https://" + realDomain + "/e/" + code;
      // El Referer que espera el CDN es el dominio original del loader,
      // no la URL completa del embed (confirmado para streamwish.to).
      var m = embedUrl.match(/^(https?:\/\/[^\/]+)/i);
      referer = (m ? m[1] : embedUrl) + "/";
    }

    var resp = showtime.httpReq(fetchUrl, {
      headers: { "Referer": referer },
      caching: false
    });
    var html = resp.toString();

    var unpacked = unpackPackerJs(html);
    if (!unpacked) return null;

    var links = extractLinksDict(unpacked);
    if (!links) return null;

    var m3u8 = pickBestHls(links, fetchUrl);
    if (!m3u8) return null;

    return { m3u8: m3u8, referer: referer };
  }

  // Cualquier dominio de WORKING_DOMAINS (streamwish, vidhide y
  // hermanos) resuelve LOCAL. Si el dia de mañana aparece un proveedor
  // nuevo que SI tolera datacenter, se puede excluir de esta lista y
  // va a seguir cayendo en la rama de Render mas abajo.
  function needsLocalResolve(embedUrl) {
    for (var i = 0; i < WORKING_DOMAINS.length; i++) {
      if (embedUrl.indexOf(WORKING_DOMAINS[i]) >= 0) return true;
    }
    return embedUrl.indexOf("hgplaycdn.com") >= 0;
  }

  // Confirma que la URL YA es una playlist m3u8 real (no una pagina embed
  // que por casualidad tiene ".m3u8" en el path) y la devuelve lista para
  // reproducir. Si el cuerpo no arranca con #EXTM3U, devuelve null para
  // que el llamador pruebe con resolveLocalGenerico como red de seguridad.
  function resolveDirectM3u8(url) {
    var mOrigin = url.match(/^(https?:\/\/[^\/]+)/i);
    var referer = (mOrigin ? mOrigin[1] : url) + "/";

    var resp = showtime.httpReq(url, {
      headers: { "Referer": referer },
      caching: false
    });
    var body = resp.toString();

    if (body.replace(/^\uFEFF/, "").indexOf("#EXTM3U") !== 0) return null;

    return { m3u8: url, referer: referer };
  }

  // --- Resuelve el embed elegido a m3u8 y reproduce ---
  plugin.addURI(ID + ":play:(.*)", function(page, encodedEmbed) {
    var embedUrl = decodeURIComponent(encodedEmbed);
    page.loading = true;

    try {
      var data;

      if (esM3u8Directo(embedUrl)) {
        // Ya es la playlist final (ej. Canal 26/telecentro): nada que
        // desarmar, se reproduce directo. Si resulta que el cuerpo no
        // era realmente un m3u8 (extension enganosa), probamos igual
        // con las estrategias genericas como red de seguridad.
        data = resolveDirectM3u8(embedUrl) || resolveLocalGenerico(embedUrl);
        if (!data) {
          page.error("No se pudo resolver el canal en vivo");
          page.loading = false;
          return;
        }
      } else if (isLiveTvDomain(embedUrl)) {
        // TV en vivo (Enlace, Canal Luz, etc): cada sitio tiene su propio
        // truco de ofuscacion, asi que probamos varias estrategias
        // genericas en orden (ver resolveLocalGenerico mas arriba).
        data = resolveLocalGenerico(embedUrl);
        if (!data) {
          page.error("No se pudo resolver el canal en vivo");
          page.loading = false;
          return;
        }
      } else if (needsLocalResolve(embedUrl)) {
        // Resolucion LOCAL: este dispositivo le pega directo al CDN,
        // sin pasar por Render (bloqueado por IP de datacenter,
        // confirmado tanto para StreamWish como para Vidhide).
        data = resolveLocalPacker(embedUrl);
        if (!data) {
          page.error("No se pudo resolver el video (local)");
          page.loading = false;
          return;
        }
      } else {
        // Reservado para futuros proveedores que SI toleren datacenter.
        var resp = showtime.httpReq(RESOLVER_URL + "?embed=" + encodeURIComponent(embedUrl), {});
        data = JSON.parse(resp.toString());

        if (data.error || !data.m3u8) {
          page.error("No se pudo resolver el video: " + (data.error || "sin m3u8"));
          page.loading = false;
          return;
        }
      }

      page.type = "video";
      page.source = "videoparams:" + JSON.stringify({
        sources: [{ url: data.m3u8, mimetype: "application/vnd.apple.mpegurl" }],
        request_headers: { "Referer": data.referer }
      });
    } catch (e) {
      showtime.print("ERROR resolviendo embed: " + e);
      page.error("Error resolviendo video: " + e);
    }

    page.loading = false;
  });

})(this);