# Playlist Auto-Liker
---
**Extensión local-first para navegadores Chromium que recorre playlists de YouTube y da Me Gusta automáticamente.**
100% privada por diseño: sin servidores, sin telemetría ni recopilación de datos. Auditada para máximo rendimiento y seguridad.

Español · [English](README.en.md)

## Privacidad y Seguridad

- **Local-first y privada por defecto**: no existe backend, base de datos externa ni llamadas de telemetría. Toda la lógica se ejecuta exclusivamente en el navegador del usuario.
- **Sin recopilación de datos personales**: ni contraseñas, ni tokens de sesión, ni credenciales de Google son leídos o almacenados. Las acciones se realizan sobre los controles accesibles estándar del DOM de YouTube.
- **Almacenamiento estrictamente local**: el historial de videos likeados y las preferencias de intervalo se guardan únicamente en `chrome.storage.local` dentro de tu máquina.
- **Código auditable**: arquitectura simple en JavaScript puro, sin dependencias externas ofuscadas ni paquetes de terceros en el código en producción.
- **Permisos mínimos**: solo solicita `storage` (preferencias e historial local), `scripting` (inyección en pestañas ya abiertas) y acceso al dominio `https://www.youtube.com/*`.

## Instalación

1. Descarga el repositorio:
   - Haz clic en el botón verde **Code** arriba a la derecha y selecciona **Download ZIP** (o clona el repositorio).
   - Descomprime el archivo ZIP descargado en tu ordenador.
2. Abre la página de extensiones de tu navegador:
   - Brave: `brave://extensions`
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
3. Activa **Modo de desarrollador** (interruptor en la esquina superior derecha).
4. Haz clic en **Cargar descomprimida** (Load unpacked).
5. Selecciona la carpeta **`extension`** dentro del repositorio descomprimido.
6. Fija la extensión en la barra de herramientas para tenerla a mano.

### Compatibilidad con navegadores (Brave, Chrome, Edge)

La extensión es 100% compatible con cualquier navegador basado en Chromium.
- **Brave**: totalmente compatible por defecto. Los escudos nativos (Brave Shields) bloquean anuncios de YouTube antes de la carga, haciendo que los recorridos sean aún más fluidos sin necesidad de esperar anuncios. Se recomienda mantener los escudos en su configuración estándar (no activar "Bloquear scripts" agresivo). Si ejecutas listas muy grandes en segundo plano, añade `youtube.com` a la lista de sitios protegidos contra suspensión en `brave://settings/system` ("Sitios que nunca se deben desactivar") para evitar que el navegador pause temporalmente los temporizadores de pestañas inactivas.
- **Chrome y Edge**: funcionamiento nativo estándar sin configuración adicional requerida.

## Uso

1. Abre un video que forme parte de una playlist de YouTube. La URL debe contener `list=`.
2. Haz clic en el icono de la extensión.
3. Elige la **dirección del recorrido**:
   - **Ascendente** (predeterminada): del video actual hacia el final, en el orden original de la playlist.
   - **Descendente**: del video actual hacia el inicio de la playlist.
4. Elige el intervalo:
   - **Fijo**: siempre el mismo número de segundos.
   - **Rango aleatorio**: se elige un valor entero entre el mínimo y el máximo.
5. Pulsa **Iniciar**.

La extensión empieza por el video actual y recorre la playlist en la dirección elegida:

- Si el video **ya tiene Me Gusta**, lo omite y avanza de inmediato, sin esperar.
- Si **no lo tiene**, espera el intervalo configurado, aplica el Me Gusta, lo verifica y avanza.
- Si el video ya fue likeado por esta extensión en una ejecución anterior, no vuelve a pulsar el botón.
- Se detiene al llegar al final (ascendente) o al inicio (descendente) de la playlist, o al pulsar **Detener**.

Durante la ejecución aparece un panel flotante en la esquina inferior izquierda de YouTube con el estado, la cuenta atrás y los botones **Pausar/Reanudar** y **Detener**. Se puede minimizar a una píldora.

**Pausar** congela el proceso y la cuenta atrás. **Reanudar** continúa exactamente donde se quedó. **Detener** finaliza la ejecución; puedes volver a iniciarla desde el video en el que estés.

La configuración se guarda automáticamente y se conserva entre sesiones. Si cambias el intervalo durante una ejecución, se aplica al temporizador en curso o al siguiente video. La dirección se aplica al iniciar cada recorrido; si la cambias con un proceso activo, se usará en el siguiente.

## Qué hace ante casos especiales

- **Anuncios**: espera a que termine el anuncio antes de leer o pulsar el botón de Me Gusta.
- **Carga lenta**: espera a que el DOM confirme el video actual; nunca pulsa sobre el video anterior.
- **Videos no disponibles**: los salta; tras varios fallos consecutivos se detiene con un mensaje claro.
- **Cambios de video**: si el video cambia durante la espera, descarta la acción pendiente y procesa el nuevo.
- **Video a punto de terminar**: si le queda menos tiempo que el intervalo (o la pestaña está en segundo plano), lo pausa temporalmente y lo reanuda después de aplicar el Me Gusta, para no perderlo por el autoplay.
- **Retroceso en descendente**: se navega usando el elemento anterior del panel de la playlist, no el botón Anterior del reproductor, porque ese botón reinicia el video actual cuando ya ha avanzado unos segundos.
- **Fin de playlist**: detecta el final real de la lista mediante el contador global de YouTube (incluso en listas de cientos de videos virtualizadas por YouTube), o cuando los controles de avance quedan deshabilitados.
- **Sin sesión iniciada**: si YouTube no confirma el Me Gusta, lo muestra como error y continúa.

## Estructura

```
extension/             Carpeta lista para cargar en el navegador
  manifest.json        Configuración de la extensión (Manifest V3)
  src/lib.js           Utilidades compartidas y validación de configuración
  src/content.js       Automatización, máquina de estados y panel flotante
  src/popup.html/css/js Interfaz de configuración y control
  icons/               Iconos de la extensión
tests/                 Pruebas unitarias y banco de pruebas DOM
ARCHITECTURE.md        Documento técnico de diseño, flujo y máquina de estados
CHANGELOG.md           Registro histórico de versiones y cambios
LICENSE                Licencia MIT
README.md              Documentación en español
README.en.md           Documentación en inglés
```

## Desarrollo

Las pruebas no necesitan dependencias externas:

```bash
node --test
```

También hay un banco de pruebas con un DOM de YouTube simulado. Sirve la raíz del proyecto (por ejemplo con `python -m http.server 8765`), abre `http://127.0.0.1:8765/tests/harness.html` y consulta `window.__TEST_RESULTS__` o el resultado en pantalla.

Para probar cambios manualmente, recarga la extensión desde `chrome://extensions` y recarga la pestaña de YouTube.

La automatización depende de la estructura del DOM público de YouTube (`aria-pressed` del botón de Me Gusta, panel de la playlist y botón siguiente). Si YouTube cambia esos elementos, los selectores de `src/content.js` pueden necesitar ajustes.

## Permisos

- `storage`: guardar el intervalo y el historial de videos ya likeados.
- `scripting`: inyectar el script si la pestaña de YouTube ya estaba abierta al instalar la extensión.
- Acceso a `https://www.youtube.com/*`: leer el estado del reproductor y pulsar los botones de la interfaz.
