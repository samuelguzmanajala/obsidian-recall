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
  operacion mientras el cliente siga abierto, sin duplicar la valoracion.
- Android actualiza mazos cada 10 segundos en primer plano y al volver a la app. Tras
  cada repaso confirmado reconstruye la cola con el backend, retirando tarjetas hermanas.
- Los fallos de conexion son visibles. Sigue siendo un sistema de estudio online: no hay
  una cola duradera de operaciones offline, ni actualizacion instantanea por WebSocket.

Verificacion: 221 pruebas TypeScript y 18 Android; compilaciones de ambos clientes.
En Obsidian real se observo una consulta automatica, DOM intacto sin cambios y conservacion
de tarjeta/respuesta al refrescar. No se introdujeron repasos para hacer estas pruebas.
Respaldo del plugin anterior al cambio: `backups/plugin-refresh-2026-09-06T12-05-32-131Z`.

## Actualizaciones

Modificar el repositorio no modifica automaticamente el servidor activo. Ejecuta pruebas y
`npm run build:server`, haz una copia, detiene el servicio y sustituye los bundles de `server/`;
despues vuelve a cargar el agente. Para el plugin, compila con `npm run build` y actualiza
`main.js` y `styles.css` con Obsidian cerrado. Conserva su configuracion y su manifiesto.

La comprobacion de interfaz uso CDP temporalmente en loopback; Obsidian se volvio a abrir sin
depuracion y el puerto 9223 quedo cerrado. No es necesario habilitar CDP para usar Recall.
