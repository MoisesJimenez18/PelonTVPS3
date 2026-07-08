(function(plugin) {

  var ID = plugin.getDescriptor().id;
  var PROJECT_ID = "pelontv-91671";
  var RESOLVER_URL = "https://pelontv-resolver.onrender.com/resolver_embed";

  // --- Filtramos por DOMINIO (no por nombre): el mismo dominio real puede
  // aparecer etiquetado con distinto "nombre" según la colección (ej.
  // minochinos.com aparece como "Vidhide" en peliculas y como "Moe" en
  // series). Lo confiable es el dominio que sabemos que resuelve sin
  // necesitar navegador (hglink.to necesita JS y por eso queda afuera).
  var WORKING_DOMAINS = ["vidhidepro.com", "minochinos.com"];

  // --- Mapeo de dominio -> etiqueta LIMPIA para mostrar. El campo "nombre"
  // que viene de la base es inconsistente (a veces dice "Vidhide", a veces
  // "Moe" para el mismo dominio real), así que ignoramos ese campo y
  // mostramos siempre el mismo nombre prolijo según el dominio detectado.
  var DOMAIN_LABELS = {
    "vidhidepro.com": "Vidhide",
    "minochinos.com": "Vidhide"
  };

  // --- Cuánto tiempo (en ms) consideramos "nuevo" un contenido para
  // mostrarle el badge 🆕. Tocá este número si querés cambiar la ventana. ---
  var NUEVO_MS = 5 * 24 * 60 * 60 * 1000; // 5 días

  function isAllowedServer(server) {
    if (!server || !server.url) return false;
    for (var i = 0; i < WORKING_DOMAINS.length; i++) {
      if (server.url.indexOf(WORKING_DOMAINS[i]) >= 0) return true;
    }
    return false;
  }

  function labelForServer(server) {
    for (var dom in DOMAIN_LABELS) {
      if (server.url.indexOf(dom) >= 0) return DOMAIN_LABELS[dom];
    }
    return server.nombre || "Servidor";
  }

  plugin.createService("PelonTV", ID + ":cat:peliculas", "video", true, null);

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

  function appendTabsCategoria(page, catActual) {
    for (var i = 0; i < CATEGORIAS.length; i++) {
      var c = CATEGORIAS[i];
      var marcador = (c.id === catActual) ? "● " : "";
      page.appendItem(ID + ":cat:" + c.id, "directory", { title: marcador + c.label });
    }
  }

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
  // lo que reemplaza la consulta directa a Firestore para listar. ---
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

  // --- Trae el documento COMPLETO (siempre los mismos campos), pidiendo
  // una única combinación fija. Así, aunque el usuario navegue de "abrir"
  // a "temporada" a "capitulo" del mismo título, es siempre la MISMA url
  // -> Movian sirve todo desde su cache local sin volver a pegarle a
  // Firestore. Antes cada pantalla pedía una máscara de campos distinta
  // y eso invalidaba el cache entre pantallas del mismo título. ---
  var MASK_DOC_COMPLETO = ["servidores", "temporadas", "titulo", "portada", "backdrop"];

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

    appendTabsCategoria(page, cat);

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
        page.appendItem(uri, "directory", {
          title: tituloConBadge(items[i]),
          icon: items[i].poster
        });
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
          page.appendItem(uri, "directory", {
            title: tituloConBadge(items[i]),
            icon: items[i].poster
          });
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

      var poster = unwrap(f.portada) || unwrap(f.backdrop);
      if (poster) {
        page.metadata.icon = poster;
        page.metadata.background = poster;
      }

      if (f.servidores) {
        // Formato película: servidores directo en el documento
        var servidoresRaw = unwrap(f.servidores) || [];
        appendServidores(page, servidoresRaw);
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

      var servidoresRaw = capitulo.servidores || [];
      appendServidores(page, servidoresRaw);
    } catch (e) {
      showtime.print("ERROR capitulo: " + e);
      page.error("Error: " + e);
    }

    page.loading = false;
  });

  // --- Resuelve el embed elegido a m3u8 y reproduce ---
  plugin.addURI(ID + ":play:(.*)", function(page, encodedEmbed) {
    var embedUrl = decodeURIComponent(encodedEmbed);
    page.loading = true;

    try {
      var resp = showtime.httpReq(RESOLVER_URL + "?embed=" + encodeURIComponent(embedUrl), {});
      var data = JSON.parse(resp.toString());

      if (data.error || !data.m3u8) {
        page.error("No se pudo resolver el video: " + (data.error || "sin m3u8"));
        page.loading = false;
        return;
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