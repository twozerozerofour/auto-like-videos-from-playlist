# Changelog

Todas las modificaciones notables de este proyecto se documentan en este archivo.
El formato sigue las directrices de cambios semánticos basados en evidencia verificable.

---

## [1.1.2] - 2026-11-04

### Corregido
- **Falsa detección de fin de playlist en listas grandes**: en playlists extensas (+200 videos), YouTube solo renderiza una ventana parcial de elementos en el DOM (`ytd-playlist-panel-video-renderer`). La condición de fin anterior evaluaba el índice frente a los elementos en memoria, deteniendo erróneamente la ejecución al llegar al video 200. Ahora se extrae la posición global real del encabezado de YouTube (`.index-message`, ej. `"201 / 940"`) para gobernar `isAtEndOfRun` y `advance`.
- **Etiqueta de progreso en panel y popup**: la posición se informa ahora como `X de Y` relativo al total global de la playlist en lugar de la ventana renderizada.

### Añadido
- Verificación de posición global y preservación del avance en el banco de pruebas simulado (`tests/harness.html`), pasando de 21 a 22 comprobaciones de integración automáticas.
- Documento de arquitectura técnica del sistema (`ARCHITECTURE.md`).

---

## [1.1.1] - 2026-11-04

### Corregido
- **Reinicio en retroceso descendente**: en YouTube, hacer clic en el botón `.ytp-prev-button` del reproductor reinicia el video actual en lugar de retroceder al anterior si han transcurrido más de unos segundos de reproducción. La navegación en modo descendente se modificó para hacer clic prioritariamente en el enlace del elemento anterior del panel de la playlist (`ytd-playlist-panel-video-renderer`), relegando el botón nativo del reproductor a un respaldo secundario.

### Añadido
- Caso de prueba específico en `tests/harness.html` simulando un botón "Anterior" que reinicia la reproducción, comprobando que la navegación descendente completa la lista sin utilizar dicho botón.

---

## [1.1.0] - 2026-11-04

### Añadido
- **Selector de dirección de recorrido**: opción para recorrer la lista en sentido **Ascendente** (del video actual hacia el final, predeterminado) o **Descendente** (del video actual hacia el inicio).
- Selectores de radio en `src/popup.html` e indicador visual de dirección en el chip de estado del popup y en el panel flotante HUD.
- Validación y normalización de la propiedad `direction` en `PAL.normalizeConfig()` y helper `describeDirection()` en `src/lib.js`.
- Pruebas unitarias para la validación y descripción de la dirección en `tests/lib.test.cjs`.
- Fase 4 en `tests/harness.html` validando la ejecución completa del recorrido inverso y detección de parada en el inicio de la playlist.

---

## [1.0.0] - 2026-11-03

### Añadido
- Implementación inicial de la extensión para navegadores Chromium bajo Manifest V3.
- Detección automática de contexto de playlist de YouTube (`list=` y `/watch`).
- Configuración de intervalos en modo fijo (1–3600 s) o rango aleatorio uniforme (mín–máx).
- Detección precisa de estado de like mediante atributo accesible `aria-pressed="true"|"false"` sobre botones visibles.
- Salto instantáneo de videos ya likeados sin agotar el intervalo de espera.
- Almacenamiento local persistente (`chrome.storage.local`) de configuración e historial de likes (`pal.history`, límite FIFO de 5000 IDs).
- Panel flotante (HUD) inyectado en Shadow DOM con aislamiento de estilos, barra de estado, cuenta atrás en tiempo real y controles de Pausar, Reanudar y Detener.
- Manejo de casos de borde: detección y espera pasiva durante anuncios, pausa temporal del video nativo para evitar saltos prematuros por autoplay, recuperación ante cambios manuales de URL y descarte de videos no disponibles.
- Suite de pruebas unitarias (`tests/lib.test.cjs`) y entorno de simulación DOM en navegador (`tests/harness.html`).
