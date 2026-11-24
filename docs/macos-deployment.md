# Instalacion local de Samuel — 6 de septiembre de 2026

## Estado

Backend instalado en el disco interno, independiente del repositorio y del vault:

`/Users/samuelguzman/Library/Application Support/Recall Backend/`

- `server/`: codigo desplegado y utilidad de copias.
- `data/recall.sqlite`: base de datos activa; nunca se sincroniza con Obsidian.
- `backend.env`: configuracion y secretos; permisos 600. No compartir ni versionar.
- `backups/`: instantaneas SQLite verificadas.
- `logs/`: registros del servidor y de las copias.
- `migration-input/`: copia de trabajo de la migracion, no es la base activa.
- `migration-index-repair.json`: informe de referencias antiguas corregidas.

La instancia escucha solo en `127.0.0.1:27124`. Obsidian utiliza esa direccion.
Android debe utilizar `https://mac-mini-de-samuel.tail431e85.ts.net:8443` con Tailscale conectado.
Se conserva el token anterior. El proxy es privado, sin Funnel, y no sustituye el servicio
preexistente de Tailscale en el puerto 443.

## Datos verificados

- Respaldo previo: `/Volumes/Disk2/Documentos/SamuelGuzman-backup-recall-backend-20260906-meb3RM`.
- 4.718 archivos en el respaldo; 4.711 pertenecen a `recall-data`.
- El indice antiguo tenia referencias ausentes en 93 notas. Solo se depuro el indice en
  la copia de trabajo; entidades y repasos se importaron sin modificaciones.
- Importacion: 2.885 conceptos, 3.980 tarjetas, 76 mazos y 14.597 repasos.
- Publicacion inicial de las 2.181 notas: 4.291 tarjetas, incluidas 311 adicionales.
- Las 3.980 tarjetas anteriores conservan exactamente su estado; no se ha eliminado ninguna.
- Historial: siguen los 14.597 eventos. No se introdujeron respuestas ficticias para probar.
- Se trasladaron 2.777 audios y 1.920 textos de la cache, conservando los originales.
- Interfaz real de Obsidian, carga de tarjetas y respuesta MP3 comprobadas.

## Inicio automatico y energia

LaunchAgents registrados:

- `com.samuelguzman.recall-backend`: arranca al iniciar sesion y se reinicia si termina.
- `com.samuelguzman.recall-backup`: copia al cargar el agente y diariamente a las 04:15.

El backend usa `caffeinate -i` mientras esta activo para impedir suspension automatica por
inactividad. No impide apagar el Mac, suspenderlo manualmente o cerrar la sesion. No se han
cambiado los ajustes generales de energia. El servicio no arranca antes de iniciar sesion.

Node esta fijado a `/Users/samuelguzman/.nvm/versions/node/v24.16.0/bin/node`.
Si eliminas esa version de Node, actualiza los dos plist antes de reiniciar los servicios.

Consultar estado:

```sh
launchctl print gui/501/com.samuelguzman.recall-backend
launchctl print gui/501/com.samuelguzman.recall-backup
curl http://127.0.0.1:27124/api/v1/health
```

Para detener el backend:

```sh
launchctl bootout gui/501/com.samuelguzman.recall-backend
```

El cierre del grupo de procesos puede tardar hasta 30 segundos. Espera a que `launchctl print`
indique que ya no existe antes de volver a cargarlo; un bootstrap inmediato puede fallar.

```sh
launchctl bootstrap gui/501 /Users/samuelguzman/Library/LaunchAgents/com.samuelguzman.recall-backend.plist
```

## Copias y recuperacion

La utilidad usa el backup consistente de SQLite y comprueba `integrity_check` y SHA-256.
Guarda una copia en el disco interno y otra en `/Volumes/Disk2/Documentos/Recall-backend-backups`.
Si Disk2 no esta disponible, conserva la copia interna y registra que falta la externa.
No elimina automaticamente ninguna copia.

Copia manual:

```sh
node --env-file='/Users/samuelguzman/Library/Application Support/Recall Backend/backend.env' \
  '/Users/samuelguzman/Library/Application Support/Recall Backend/server/backup.mjs'
```

Para recuperar, detiene el servicio y conserva primero una copia de la base actual y sus
archivos auxiliares. Restaura una instantanea verificada en una ubicacion nueva y configura
`RECALL_DB` para apuntar a ella. No sobreescribas una base abierta ni mezcles sus archivos WAL.

La instalacion antigua del plugin esta en `plugin/` dentro del respaldo previo; los archivos
originales `recall-data` tambien siguen en el vault, sin cambios. Si ya has repasado con el
backend, volver simplemente al plugin antiguo perderia los repasos posteriores: antes hay
que preservar/exportar el estado nuevo. No actives ambos motores como autoridades paralelas.

## Android: instalado y conectado

El APK actualizado esta en `android/app/build/outputs/apk/debug/app-debug.apk`.
Instalado en el Pixel 9a por USB, sin desinstalar ni borrar sus ajustes. Tailscale conectado,
URL HTTPS configurada y token original conservado. La prueba de conexion muestra
`Conectado ✓` y el navegador carga los cuatro grupos y las 4.291 tarjetas.

Se probo una pregunta hasta la fase de escucha y se comprobaron MP3 descargados en el
telefono. Se detuvo sin valorar; el contador permanecio en 5 repasos durante la prueba.
Esos 5 ya existian al empezar la comprobacion (14.602 eventos historicos en el respaldo).

Con el telefono conectado, autorizado y sin una sesion de repaso en marcha:

```sh
node scripts/install-android.mjs
node scripts/install-android.mjs --apply
```

El instalador guarda los datos privados y el APK anterior antes de actualizar, sin desinstalar.
Si no puede respaldar los datos, se detiene. Despues conecta Tailscale y configura Server URL
con la direccion HTTPS indicada arriba. El token anterior se conserva y sigue siendo valido.
La prueba no incluye valorar una tarjeta real: esa decision queda para el usuario.
La primera copia completa de Android esta en `backups/android-2026-09-06T09-30-11-706Z`
dentro del directorio interno de Recall Backend; las actualizaciones siguientes guardan
otra copia de los datos privados y el APK en su propia carpeta fechada.

## Refresco entre dispositivos

- Obsidian consulta mientras la vista esta visible cada 10 segundos y al recuperar el foco.
  Publicar notas o confirmar un repaso tambien notifica a las vistas del mismo cliente.
- El navegador compara mazos, estadisticas y leeches completos, no solo totales globales.
  Conserva el desplazamiento y no reconstruye el DOM cuando nada ha cambiado.
- La sesion reconcilia tarjetas con el backend: conserva la actual y su respuesta visible
  si no han cambiado; retira las ya repasadas o invalidadas y oculta respuestas modificadas.
- Las peticiones de refresco se agrupan; respuestas anteriores a una valoracion o al cierre
  de la vista se descartan. Una respuesta HTTP perdida se reconcilia con el mismo ID de
  operacion, tambien tras cerrar y volver a abrir el cliente, sin duplicar la valoracion.
- Android actualiza mazos cada 10 segundos en primer plano y al volver a la app. Tras
  cada repaso confirmado reconstruye la cola con el backend, retirando tarjetas hermanas.
- Los fallos de conexion son visibles. Hay diarios duraderos de publicaciones y valoraciones
  pendientes, pero no descarga completa de mazos para estudiar offline ni WebSocket.

Verificacion del refresco: 221 pruebas TypeScript y 18 Android; compilaciones de ambos clientes.
En Obsidian real se observo una consulta automatica, DOM intacto sin cambios y conservacion
de tarjeta/respuesta al refrescar. No se introdujeron repasos para hacer estas pruebas.
Respaldo del plugin anterior al cambio: `backups/plugin-refresh-2026-09-06T12-05-32-131Z`.

## Recuperacion de interrupciones

Actualizacion posterior: 228 pruebas TypeScript y 25 Android.

- Obsidian guarda los diarios por vault y URL del backend en almacenamiento local del
  dispositivo (`recall-pending-notes` y `recall-pending-reviews`). No forman parte de Sync
  ni del `data.json` del plugin. Contienen contenido pendiente de notas, pero no tokens.
  No borres el perfil local de Obsidian si hay operaciones por confirmar.
- Android guarda `pending-reviews-<hash-backend>.json` en los archivos privados de la app.
  El instalador respalda estos archivos. Un fallo de escritura impide enviar la valoracion.
- El ID y el contenido de cada operacion enviada se conservan al reintentar. Si el servidor
  ya la habia guardado, devuelve el resultado anterior sin aplicar un segundo repaso.
- Obsidian revisa las notas al arrancar y recupera pendientes cada 30 segundos, al recuperar
  conexion/foco y con `Recall: Retry pending notes and reviews`.
- Los renombrados y borrados observados se registran explicitamente. Una ausencia detectada
  al arrancar NO se convierte en borrado automatico: podria faltar sincronizacion del vault.
- Un conflicto bloquea solo su nota y los renombrados dependientes; las notas independientes
  siguen publicandose. Una cola antigua cuya version final ya coincide con el backend se
  reconoce sin sobrescribir contenido. Un cambio de revision solo se reintenta automaticamente
  con una operacion nueva si el contenido de la version base sigue intacto.
  La barra de estado indica pendientes y su detalle.
  `Recall: Resolve note conflict using this vault version` pide confirmacion
  antes de publicar la version local. Si la version remota es la correcta, cancela y
  reconcilia las notas primero. Conflictos de rutas requieren reconciliacion manual.
- Las colas y versiones de referencia estan separadas por URL. Cambiar entre la direccion
  local y HTTPS no migra automaticamente las colas, aunque ambas apunten al mismo proceso.
  No mezclar diarios de servidores distintos. La recuperacion local del 9 de septiembre
  comprobo primero que ambos manifiestos coincidieran y proceso la cola antigua contra su
  endpoint original, manteniendo las comprobaciones de revision y sin forzar conflictos.
- Android recupera valoraciones antes de cargar mazos o empezar una sesion. Los rechazos
  definitivos se archivan en `rejected-reviews-<hash-backend>.json`, no se fuerzan con una
  revision nueva y quedan senalados en la pantalla de mazos.
- El silencio o un reconocimiento fallido ya NO producen Again/Good por defecto. Tras
  agotar la escucha de valoracion, queda en pausa. Puedes pulsar una valoracion o
  `Reanudar escucha`; salir sin valorar no registra un repaso.

Pruebas nuevas: reconstruccion de clientes con respuestas perdidas, fallo de almacenamiento,
borrado y renombrado pendientes, ediciones offline, conflicto entre dispositivos, cierre
con peticion en curso, separacion de servidores, diario corrupto y silencio sin valoracion.
Las pruebas que escriben repasos utilizan bases temporales, no la base personal.

Comprobacion fisica posterior en el Pixel: al mostrar una respuesta y dejar agotar la
escucha, la primera tarjeta permanecio en pausa sin enviar una valoracion. `Reanudar
escucha` volvio al reconocimiento en esa misma tarjeta. Se corrigio el encabezado para
que el mensaje largo de pausa no desplazara `Salir` fuera de pantalla; tras reinstalar,
ambos botones quedaron visibles y `Salir` regreso al navegador de mazos. El contador
permanecio en 5 repasos durante ambas pruebas. Las 25 pruebas Android siguen pasando.
La copia anterior a ese ajuste esta en `backups/android-2026-09-06T12-34-09-537Z`.

Copias previas de esta fase, dentro de Recall Backend:

- `backups/recall-2026-09-06T12-14-16-418Z.sqlite` (14.602 eventos; integridad verificada).
- `backups/plugin-refresh-2026-09-06T12-26-50-354Z`.
- `backups/android-2026-09-06T12-26-50-463Z`.

## Actualizaciones

### Correccion de publicaciones (2026-09-09)

Se recuperaron las seis operaciones de la cola local anterior y la cola HTTPS quedo
tambien vacia, sin conflictos ni repasos pendientes. La nota diaria siguio en revision 26;
Diagrama de caja, Diagrama de densidad y Exploracion visual de una distribucion pasaron
a revision 2, con contenido identico al vault. La nota de entrenamiento se publico en
revision 1. No se modificaron los Markdown del vault ni se forzaron versiones remotas.

Las 234 pruebas TypeScript, el chequeo de tipos y la compilacion pasaron. El bundle
instalado coincide con el compilado. Se verifico el refresco automatico de mazos sin
reemplazar el DOM cuando no hay cambios. Los 14.648 eventos de repaso de la copia inicial
siguen presentes sin modificaciones; hay diez repasos adicionales anteriores a instalar
el plugin, no generados por las pruebas.

Copias previas dentro de Recall Backend:

- `backups/recall-2026-09-09T19-15-18-561Z.sqlite` (integridad verificada y copia en Disk2).
- `backups/sync-conflict-2026-09-09T19-19-51-643Z` (perfil local y plugin; 13 archivos verificados).
- `backups/plugin-refresh-2026-09-09T19-19-51-694Z` (plugin previo).

`node scripts/backup-sync-state.mjs` respalda diarios, cursores y plugin con Obsidian
cerrado. Estas copias contienen datos privados y configuracion; no publicarlas.

### Procedimiento

Modificar el repositorio no modifica automaticamente el servidor activo. Ejecuta pruebas y
`npm run build:server`, haz una copia, detiene el servicio y sustituye los bundles de `server/`;
despues vuelve a cargar el agente. Para el plugin, compila con `npm run build` y actualiza
`main.js` y `styles.css` con Obsidian cerrado. Conserva su configuracion y su manifiesto.

La comprobacion de interfaz uso CDP temporalmente en loopback; Obsidian se volvio a abrir sin
depuracion y el puerto 9223 quedo cerrado. No es necesario habilitar CDP para usar Recall.

### Reconciliacion de notas tras una sesion larga (2026-11-11)

Se detectaron 60 notas del vault mas nuevas que el backend y 53 notas visibles nuevas sin
publicar. Obsidian llevaba abierto desde el 28 de octubre. El plugin hacia un escaneo
completo solo al arrancar y dependia de eventos `create`/`modify` el resto del tiempo;
las ediciones externas en lote del vault no llegaron todas al publicador. No hay evidencia
de que el backend haya modificado archivos Markdown locales.

Desde esta correccion, el plugin reconcilia el vault cada 10 minutos y al recuperar el foco
si han transcurrido al menos 2 minutos. La cola evita duplicados cuando una nota en conflicto
no ha cambiado. Se excluye `node_modules` de nuevas publicaciones: sus Markdown son
dependencias, no apuntes. La ausencia de una nota local sigue sin convertirse en borrado
automatico del backend. Ante un conflicto real, las notas del vault son la fuente de verdad
para esta instalacion, pero se conserva la revision y la proteccion CAS del backend.

Antes de reconciliar se guardo una copia SQLite verificada; se publicaron las 113 notas
pendientes sin borrar ninguna, y la comparacion posterior de las 2694 notas visibles dio
cero diferencias. El plugin instalado se actualizo con Obsidian cerrado y se hizo tambien
una copia de sus diarios/cursores locales antes de reiniciar.

### Esquema normalizado, herencia de historial y plugin solo cliente (2026-11-11, noche)

Desplegado desde la rama `feat/standalone-recall-backend-wt`, commit `06c0f94`, en dos pasos
(primero `b856083`, esquema v3; despues `06c0f94`, esquema v4). En ambos: servicio detenido,
copia en frio verificada, ensayo de la migracion sobre una copia de esa misma copia con Node
24.16.0 y, solo entonces, sustitucion de `server/main.cjs`, `server/migrate.cjs` y
`server/backup.mjs`.

- La base paso de v1 a v4: recibos de operacion con hash (ya no guardan el contenido de las
  notas), tablas normalizadas en lugar de documentos JSON y tabla de alias para tarjetas
  editadas. Tamano: 62 MB a 29 MB. Integridad correcta; 14.705 repasos, 4.705 tarjetas,
  3.460 conceptos y 100 mazos, igual que antes de migrar.
- Ensayo de paridad: sobre copias de la base real, el servidor anterior y el nuevo devolvieron
  respuestas identicas byte a byte en 24 operaciones (mazos, cola general y por mazo, fuentes,
  estadisticas, leeches, inventario, repasos, edicion/borrado/renombrado de notas, conflicto y
  reintento idempotente). Un repaso paso de ~93 ms a ~3 ms.
- Un servidor anterior se niega a abrir una base v3/v4. Para volver atras hay que restaurar
  bundles Y base: bundles previos en `backups/server-2026-11-11T22-41-35Z` (v1) y
  `backups/server-2026-11-11T22-54-53Z` (v3); copias en frio
  `backups/recall-2026-11-11T22-41-10-744Z.sqlite` (v1) y
  `backups/recall-2026-11-11T22-54-36-433Z.sqlite` (v3), ambas tambien en Disk2.
- `server/backup.mjs` nuevo: cuenta repasos en la tabla `reviews` y sigue aceptando bases
  antiguas. Probado contra la base migrada.
- Plugin: instalado el bundle de `06c0f94` (solo cliente del backend; sin modo local ni
  dependencias de Node). Copias previas: `backups/plugin-refresh-2026-11-11T22-30-36-500Z` y
  `backups/plugin-refresh-2026-11-11T22-55-08-471Z`; diarios y cursores en
  `backups/sync-conflict-2026-11-11T22-30-36-433Z` y `...T22-55-08-398Z`.
  Comprobado en Obsidian real por CDP en loopback (puerto cerrado despues): mazos cargados
  desde el servidor nuevo, cinco comandos registrados, `sin operaciones pendientes`.
- Se elimino del almacenamiento local de Obsidian el diario huerfano de la URL anterior
  (`mac-mini-de-samuel`, sin `-2`): 659 operaciones y 5,5 MB, casi toda la cuota. Estaba
  obsoleto (vault y backend coincidian en inventario) y queda en la copia `sync-conflict` de
  las 22:30. El trabajo pendiente de `node_modules/fsevents/README.md` se descarta ahora al
  arrancar; el backend conserva su copia de esa nota.
- La carpeta `recall-data/` del vault no se ha tocado; el plugin ya no la lee.
- No se registraron repasos durante las comprobaciones. No se hizo ninguna peticion
  autenticada desde fuera de Obsidian (el token no se leyo).
- Android no se ha actualizado en este despliegue; el protocolo no cambia y `POST /reviews`
  acepta ya el campo opcional `due`.

### Conector MCP para ChatGPT (2026-11-12)

Desplegado desde la rama `worktree-agent-a14ba956bf3eba016`, commits `602bbb3` y `2d5e0ba`. Solo
cambia `server/main.cjs`; el esquema de la base no cambia (sigue en v4).

- `backend.env`: `RECALL_MCP_PORT=27125` y
  `RECALL_MCP_PUBLIC_URL=https://mac-mini-de-samuel-2.tail431e85.ts.net`.
- Tailscale Funnel activo en el 443 de `mac-mini-de-samuel-2`, apuntando solo a
  `http://127.0.0.1:27125`. El 8443 (API privada) y los servicios del nombre antiguo siguen solo
  en el tailnet. Primero se probo Funnel en el 10000: ChatGPT nunca llego a conectar por ese
  puerto y se desactivo.
- Comprobado por la entrada publica de Tailscale: metadatos OAuth 200, `/mcp` sin token 401 y
  `/api/v1/health` 404. ChatGPT se registro por DCR, canjeo el codigo y llamo a `/mcp` con exito.
- `data/recall-oauth.sqlite` guarda los clientes y los hashes de tokens; no entra en la copia
  diaria. Quedan dos clientes registrados a mano durante las pruebas, sin tokens emitidos.
- Copias previas: `backups/recall-2026-11-11T23-23-27-184Z.sqlite` (integridad correcta, 14.705
  repasos, tambien en Disk2) y `backups/server-2026-11-11T23-23-27Z` (bundles y `backend.env`
  anteriores). Para volver atras: restaurar `main.cjs` y `backend.env` de esa carpeta, reiniciar
  el servicio y `tailscale funnel --https=443 off`.

### Herramientas de lectura del conector MCP (2026-11-12, madrugada)

Desplegado el commit `29ae69d` de la rama `worktree-agent-a14ba956bf3eba016`. Solo cambia
`server/main.cjs` (y `migrate.cjs`, recompilado); sin cambios de esquema ni de `backend.env`.

- Herramientas nuevas, todas de solo lectura: `get_due_cards`, `get_weak_cards`, `get_leeches`,
  `search_cards` y `get_study_stats`, con la prevision del proximo intervalo por valoracion.
- La pagina de aprobacion ya no se bloquea tras varios fallos y el registro de clientes ya no
  rechaza altas cuando la tabla esta llena.
- Ensayo previo sobre una copia de la base real en puertos temporales: las seis herramientas
  respondieron en menos de 30 ms. La copia de ensayo se borro.
- Tras el reinicio, por la entrada publica de Tailscale: metadatos OAuth 200, `/mcp` sin token 401
  y `/api/v1/health` 404. El conector de ChatGPT conserva su autorizacion (los tokens estan en
  `data/recall-oauth.sqlite`).
- Copias previas: `backups/recall-2026-11-12T00-03-47-588Z.sqlite` y
  `backups/server-2026-11-12T00-03-47Z` (bundles anteriores).

### Voz con Gemini y build combinado con MCP (2026-11-12, madrugada)

- Pregeneracion: 45 lotes de 150 por la API por lotes de Gemini (`gemini-3.8-flash-tts`, voz
  Kore, sin reescritura LLM), 6.618 textos distintos, 9.410 archivos, 0 fallos, 31.417 s de
  audio, 3 h 35 min. Coste 3,56 USD a precio de lotes (7,12 USD a precio normal; el descuento
  no aparece en los datos de consumo, solo en la facturacion). Estado en
  `data/audio/pregenerate-state.json`. Los ~2.900 MP3 anteriores de OpenAI siguen en la
  carpeta: `node --env-file=backend.env server/pregenerate.cjs --orphans` los lista sin borrar.
- `backend.env`: se anadio AL FINAL un bloque `# --- Gemini voice (2026-11-12)` con
  `RECALL_TTS_PROVIDER`, `RECALL_TTS_MODEL`, `RECALL_TTS_VOICE`, `RECALL_TTS_INSTRUCTIONS=''`,
  `RECALL_LLM_PROVIDER='none'`, `RECALL_FFMPEG` (ruta absoluta) y `RECALL_TTS_KEY` (clave de
  Google). En el parser de env-file de Node gana la ultima aparicion de cada clave; los
  valores anteriores de OpenAI/DeepSeek siguen mas arriba en el archivo. Copia previa del
  archivo en `backups/server-2026-11-12T06-09-08Z/backend.env`.
- Comprobado con peticiones autenticadas (el token se uso desde el entorno, sin mostrarlo):
  estadisticas, mazos, cola y 16 audios servidos desde la cache en ~1 ms, `audio/mpeg`.
- Incidencia: a las 07:09 se instalo un build de la rama de audio que NO incluia el listener
  MCP desplegado a la 01:03 desde otra rama; el conector MCP (puerto 27125) estuvo caido
  unos 3 minutos. A las 07:12 se instalo el build combinado, commit de fusion `2398598`
  (rama `feat/backend-with-mcp` = audio `5e9020a` + MCP `c724863`; un unico conflicto aditivo
  en `src/server/main.ts`; 482 pruebas). Ambos listeners verificados. Bundles anteriores:
  `backups/server-2026-11-12T06-09-08Z` (MCP sin audio) y `...T06-11-42Z` (audio sin MCP).
- Antes de desplegar, comprobar SIEMPRE que el bundle instalado no contiene trabajo que el
  nuevo no tenga (p. ej. `grep -c "Recall MCP" server/main.cjs`) y construir desde un commit
  que incluya todas las ramas desplegadas.

### Herramientas de escritura del conector MCP y esquema v5 (2026-11-12, 07:41)

Desplegado el commit `8a658f9` de la rama `worktree-agent-a77010419a7566ea3` (contiene
`feat/backend-with-mcp` `f233107`). Se sustituyeron `main.cjs`, `migrate.cjs` y `pregenerate.cjs`,
y se anadio `RECALL_MCP_WRITE=true` a `backend.env`.

- La base paso de v4 a v5 al arrancar: el registro de repasos se reconstruyo con identificadores
  estables y las columnas `origin` y `prior`, y hay dos tablas nuevas, `review_changes` (rastro de
  correcciones) y `card_proposals` (bandeja de tarjetas propuestas). Tras migrar: 14.728 repasos,
  mismo identificador maximo, integridad correcta.
- Ensayo previo sobre una copia de la base real: mismos repasos, y `/decks`, `/stats`, `/leeches`,
  `/sources`, `/settings` y `/tags` identicos byte a byte al servidor anterior. Sobre esa copia se
  guardo, corrigio, borro y restauro un repaso por MCP (las fechas coincidieron con la prevision),
  y se corrigieron y revirtieron 25 repasos reales de los dos ultimos dias sin rechazos. Las copias
  de ensayo se borraron; no se escribio ningun repaso en la base personal.
- Un servidor anterior se niega a abrir una base v5. Para volver atras hay que restaurar bundles Y
  base: `backups/server-2026-11-12T06-41-43Z` (bundles y `backend.env` previos) y la copia en frio
  `backups/recall-2026-11-12T06-41-43-252Z.sqlite` (tambien en Disk2). Se perderia lo repasado
  despues.
- Tras el reinicio: API privada correcta; por la entrada publica de Tailscale, metadatos OAuth 200,
  `/mcp` sin token 401 y `/api/v1/proposals` 404. El registro indica `write tools enabled`.
- Pendiente: el panel del plugin de Obsidian para aceptar o descartar las tarjetas propuestas, y
  comprobar en ChatGPT si las herramientas de escritura piden confirmacion en modo voz.

### OAuth del conector MCP en un paquete compartido (2026-11-24)

- Desplegada la rama `feat/shared-mcp-oauth-deployed`: el commit del refactor OAuth aplicado
  sobre `8aeeefa`, que es exactamente lo que estaba instalado (los tres bundles de un build de
  `8aeeefa` coincidian byte a byte con los de `server/`). Ojo: `8aeeefa` vive en la rama
  `worktree-agent-a77010419a7566ea3` (herramientas MCP de escritura, esquema v5, ajustes de
  estudio, panel de propuestas) y **no esta fusionada** en `feat/standalone-recall-backend`;
  la rama `feat/shared-mcp-oauth` (sobre `e0522a4`) se habria llevado todo eso por delante.
- El OAuth (servidor de autorizacion, almacen, pagina de aprobacion y rutas) vive ahora en
  `@samuelguzman/mcp-oauth` (`../mcp-oauth`), compartido con el gateway mcp-hub. Mismo
  comportamiento: 611/611 pruebas antes y despues, mismas herramientas en el bundle, mismo
  esquema; solo cambia `server/main.cjs` (`migrate.cjs` y `pregenerate.cjs` identicos).
- Copia previa de `server/` en `backups/server-2026-11-24T11-03-57Z`. Verificado: API 200,
  metadatos OAuth del 27125 y del 443 publico, 401 con el mismo desafio, "write tools enabled".
- Vuelta atras: detener el agente, copiar `backups/server-2026-11-24T11-03-57Z/main.cjs` a
  `server/` y volver a cargarlo.

### Acceso interno para mcp-hub y el 443 al gateway (2026-11-24)

- Desplegado `feat/internal-mcp-listener` (`8c67f4e`): listener interno en `127.0.0.1:27126` con
  secreto compartido (`RECALL_MCP_INTERNAL_*`, bloque al final de `backend.env`). Copia previa en
  `backups/server-2026-11-24T11-10-04Z` (bundles y `backend.env`).
- Funnel 443 ya **no** apunta al MCP público de Recall (27125) sino al gateway mcp-hub (27130), que
  usa Recall por el acceso interno. El listener público sigue corriendo en local, sin publicar; el
  conector de Recall en ChatGPT se sustituye por el de mcp-hub. Vuelta atrás: en el repositorio
  mcp-hub, `despliegue/cambiar-443.sh --deshacer`.
