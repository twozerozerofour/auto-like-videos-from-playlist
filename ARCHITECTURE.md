# Arquitectura de Playlist Auto-Liker

Documento técnico sobre el diseño, flujo de datos, máquina de estados y decisiones de implementación de la extensión.

---

## 1. Visión general del sistema

**Playlist Auto-Liker** es una extensión para navegadores basados en Chromium (Chrome, Edge, Brave, etc.) construida sobre **Manifest V3**. Funciona íntegramente en el cliente, interactuando con la interfaz pública web de YouTube (SPA) sin recurrir a APIs privadas ni servicios de terceros.

### Componentes principales

```
┌─────────────────────────────────────────────────────────────┐
│                    YouTube Tab (SPA)                        │
│                                                             │
│   ┌─────────────────────────────────────────────────────┐   │
│   │ Content Script (src/content.js)                     │   │
│   │                                                     │   │
│   │  - Máquina de estados y bucle de ejecución          │   │
│   │  - Detección de DOM (reproductor, panel, botones)   │   │
│   │  - Panel flotante (HUD en Shadow DOM aislado)       │   │
│   │  - Sincronización con chrome.storage.local          │   │
│   └──────────────────────┬──────────────────────────────┘   │
│                          ▲                                  │
│             postMessage /│ Runtime Messaging                │
│             chrome.tabs  │ (PAL_START, PAL_PAUSE, etc.)     │
│                          ▼                                  │
└──────────────────────────┼──────────────────────────────────┘
                           │
 ┌─────────────────────────┴─────────────┐    ┌──────────────────────────┐
 │ Popup (src/popup.html/css/js)         │    │ Shared Module            │
 │                                       │    │ (src/lib.js)             │
 │  - Configuración (modo, rango, dir)   │    │                          │
 │  - Controles (Iniciar, Pausar, Stop)  │◄───┤  - Normalización config  │
 │  - Snapshot de estado en tiempo real  │    │  - Cálculo de intervalos │
 └─────────────────────────┬─────────────┘    │  - Parseo de URLs/list   │
                           │                  │  - Regla de omisión      │
                           ▼                  └─────────────┬────────────┘
               ┌───────────────────────┐                    │
               │ chrome.storage.local  │◄───────────────────┘
               │  - pal.config         │
               │  - pal.history (5000) │
               └───────────────────────┘
```

---

## 2. Fuentes de verdad y distribución de responsabilidades

1. **Content script (`src/content.js`)**:
   - Es la **fuente de verdad operacional**. Mantiene el estado en memoria de la ejecución activa (`runtime`), controla el bucle principal, los timers y los clics sobre el DOM.
   - Sigue activo mientras la pestaña de YouTube permanezca abierta, independientemente de si el popup está abierto o cerrado.
   - Expone un snapshot estructurado de su estado mediante mensajes de `chrome.runtime`.

2. **Popup (`src/popup.js`)**:
   - Actúa como vista y panel de control ligero. No contiene lógica de temporización propia.
   - Envía comandos (`PAL_START`, `PAL_PAUSE`, `PAL_RESUME`, `PAL_STOP`) y consulta periódicamente (`PAL_GET_STATE`) el snapshot del content script para refrescar la UI.
   - Si la pestaña fue abierta antes de cargar la extensión, inyecta programáticamente `src/lib.js` y `src/content.js` usando `chrome.scripting`.

3. **Módulo compartido (`src/lib.js`)**:
   - Funciones puras universales (compatible con navegadores y CommonJS/Node.js).
   - Validaciones y saneamiento estricto de configuración (`normalizeConfig`), cálculo de números aleatorios en rango (`pickIntervalMs`), parseo de parámetros de URL (`parseVideoContext`) y formateo de tiempo (`formatSeconds`).

4. **Almacenamiento (`chrome.storage.local`)**:
   - `pal.config`: Almacena el modo (`fixed` | `range`), segundos configurados y dirección (`ascending` | `descending`).
   - `pal.history`: Almacena un mapa asociativo de IDs de videos confirmados con timestamp (`{ [videoId]: timestamp }`), con poda automática FIFO a un límite de 5.000 entradas para evitar sobrecarga de cuota.

---

## 3. Máquina de estados del Content Script

El ciclo de vida de un recorrido se gestiona a través de las siguientes fases:

```
                  ┌──────────────┐
                  │     IDLE     │
                  └──────┬───────┘
                         │ (PAL_START)
                         ▼
                  ┌──────────────┐
                  │  PREPARING   │◄──────────────────────────┐
                  └──────┬───────┘                           │
                         │ (player listo)                    │
        ┌────────────────┴───────────────┐                   │
        │ [Ya tiene like o en historial] │ [No tiene like]   │
        ▼                                ▼                   │
 ┌──────────────┐                 ┌──────────────┐           │
 │   RUNNING    │                 │   WAITING    │           │
 │  (Omitido)   │                 │ (Cuenta atr.)│           │
 └──────┬───────┘                 └──────┬───────┘           │
        │                                │ (espera completa) │
        │                                ▼                   │
        │                         ┌──────────────┐           │
        │                         │    LIKING    │           │
        │                         │(Clic + verif)│           │
        │                         └──────┬───────┘           │
        │                                │ (confirmado/err)  │
        └────────────────┬───────────────┘                   │
                         ▼                                   │
                  ┌──────────────┐                           │
                  │  ADVANCING   │                           │
                  │ (Navegación) ├───────────────────────────┘
                  └──────┬───────┘ (siguiente video)
                         │ (fin de playlist o error no recuperable)
                         ▼
                  ┌──────────────┐
                  │ DONE / ERROR │
                  └──────────────┘
```

- **Fases especiales**:
  - `waiting_ad`: Si YouTube reproduce un anuncio, el flujo se desvía a esta fase hasta que el anuncio desaparece del DOM (límite de 10 min), retomando la preparación sin alterar los contadores de error.
  - `paused`: El temporizador calcula el tiempo restante acumulado (`run.intervalMs - elapsed`) y entra en un bucle pasivo de sondeo hasta recibir `PAL_RESUME`.

---

## 4. Detección y navegación sobre el DOM de YouTube

### 4.1. Selección del botón de Me Gusta
YouTube renderiza múltiples botones de like en el árbol DOM (versiones para pantalla completa, versiones responsive móviles y clones en menús contextuales).
- `findLikeButton()` busca primero en selectores prioritarios (`like-button-view-model button`, `#segmented-like-button button`, etc.).
- Filtra mediante `isVisible(el)` (comprobación de rectángulos y dimensiones activas) para interactuar **únicamente con el botón visible**.
- Verifica el atributo estándar `aria-pressed="true"|"false"`.
- Realiza **un solo clic** y espera hasta 6 s la confirmación por mutación de `aria-pressed`. Nunca realiza un segundo clic de reintento para evitar quitar el like por accidente.

### 4.2. Recorrido en listas grandes (Virtualización de panel)
En playlists de más de 200 videos, YouTube virtualiza los nodos `ytd-playlist-panel-video-renderer` y renderiza solo una ventana de elementos.
- La extensión lee la posición global desde el encabezado `.index-message` (ej. `"201 / 940"`).
- La detección de fin de playlist (`isAtEndOfRun`) se evalúa contra los contadores numéricos globales (`current >= total` o `current <= 1`) y no por el número de elementos cargados en memoria (`items.length`).

### 4.3. Navegación direccional
- **Ascendente**: Clic en `.ytp-next-button` como vía preferente, con respaldo del siguiente elemento en el panel. Permite a YouTube cargar de forma natural los siguientes bloques de videos virtualizados.
- **Descendente**: Clic preferente en el **elemento previo del panel** de la playlist (`ytd-playlist-panel-video-renderer`). No se utiliza el botón `.ytp-prev-button` del reproductor como vía primaria porque YouTube reinicia el video actual en lugar de retroceder cuando han transcurrido más de unos segundos de reproducción.

### 4.4. Pausa preventiva de reproducción
Si el video está reproduciéndose y el tiempo restante es inferior al intervalo configurado (`duration - currentTime < intervalMs + 2000`), o la pestaña se encuentra oculta (`document.hidden`), la extensión pausa temporalmente el elemento `<video>` nativo para impedir que el autoplay de YouTube salte al siguiente video antes de poder procesar el Me Gusta. Se reanuda al terminar el ciclo.

---

## 5. Aislamiento de Interfaz (Shadow DOM HUD)

El panel flotante en pantalla se monta en `#playlist-auto-liker-hud` utilizando **Shadow DOM en modo `open`**.
- Resetea estilos con `:host { all: initial; }` para evitar contaminación por reglas globales de CSS de YouTube.
- Utiliza variables del sistema y colores accesibles alineados con la estética oscura de YouTube.
- Expone controles manuales directos (Pausa/Reanudar, Detener, Minimizar) que ejecutan las mismas funciones internas que los mensajes del popup.

---

## 6. Pruebas y Validación

El proyecto cuenta con dos niveles de prueba automatizada sin dependencias de paquetes npm:
1. **Unit tests (`tests/lib.test.cjs`)**: Valida `PAL` con el runner nativo `node --test` (normalización de rangos, parsing de URLs válidas/inválidas, clamping, descarte por historial y cálculo determinista/estocástico de intervalos).
2. **Harness de integración (`tests/harness.html`)**: Emula el entorno DOM de YouTube (reproductor, panel con virtualización, listeners de `history.pushState`, mutación de atributos `aria-pressed` y simulación de fallos de botones) ejecutando directamente el script de producción `src/content.js`.
