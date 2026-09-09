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
