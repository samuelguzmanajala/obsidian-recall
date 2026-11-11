# Recall: backend independiente

## Qué cambia

```text
Obsidian ── notas Markdown y respuestas ─┐
                                      ├── API Recall ── SQLite
Android ── consultas, respuestas, voz ──┘       │
                                         FSRS + historial
```

El backend es la única autoridad del aprendizaje: interpreta las tarjetas, construye
mazos, calcula intervalos y guarda respuestas. El plugin de Obsidian es solo un cliente:
muestra mazos y repasos del servidor y, si lo activas, publica tus notas. Ya no existe el
antiguo modo local: el plugin no abre `recall-data` (tampoco lo borra ni lo modifica), no
reproduce historiales ni sirve la API de voz. Android funciona aunque Obsidian esté cerrado,
siempre que el servidor esté disponible.

En Recall Settings solo se configuran la URL del backend, el token y la publicación de notas.
Los cambios de URL o token se aplican al recargar el plugin; mientras falten, las vistas
indican que hay que configurar el backend. Tags, límites diarios, umbral de sanguijuelas,
orden aleatorio y audio son variables de entorno del servidor (`RECALL_TAGS`,
`RECALL_DAILY_NEW`, `RECALL_DAILY_REVIEW`, `RECALL_LEECH_THRESHOLD`, `RECALL_SHUFFLE`,
`RECALL_TTS_*`, `RECALL_LLM_*`). Las claves antiguas de `data.json` (proveedores, API de voz,
tags…) se conservan sin usarse; si las necesitas, pásalas al entorno del backend.

Es una instalación personal (una cuenta y un vault), no un SaaS multiusuario. Todas las
peticiones autenticadas acceden al mismo conjunto de datos. No hay autenticación de usuarios,
roles ni aislamiento entre vaults. Usa otra instancia para otro vault.

## Arranque local

1. Instala Node 24 y ejecuta `npm ci` y `npm run build:server`.
2. Crea `.env` siguiendo `.env.example`. Genera un secreto con `openssl rand -hex 32`
   y ponlo en `RECALL_TOKEN`. No publiques ese archivo.
3. Arranca con `node --env-file=.env dist/server/main.cjs`.
4. Comprueba `http://127.0.0.1:27124/api/v1/health`.

La respuesta incluye `service: "recall-backend"` y `protocol: 2`. El prefijo sigue siendo
`/api/v1` para reutilizar las rutas del cliente anterior, pero los nuevos comandos de repaso
exigen metadatos de concurrencia. Un Android antiguo no puede enviar respuestas válidas
al backend nuevo: instala el APK compilado desde esta rama.

SQLite reside en `RECALL_DB` (por defecto `data/recall.sqlite`). Node proporciona el adaptador
[`node:sqlite`](https://nodejs.org/docs/latest-v24.x/api/sqlite.html); su estabilidad depende
de la versión de Node, por eso se fija la familia 24 y se prueba con ella. No requiere
Obsidian, ni acceso a tu vault, ni otra base de datos.

El servidor escucha en loopback por defecto. Para otros dispositivos, publica el servicio
mediante una VPN privada o un proxy HTTPS. El token viaja en cada petición: **no expongas
HTTP sin cifrar en Internet**. No hay CORS abierto ni panel web público. El token y las
copias de la base de datos deben tratarse como secretos.

## Migración conservadora desde `recall-data`

No se ha ejecutado automáticamente contra tu vault. El importador no modifica ni elimina
archivos de origen, y se niega a sobrescribir una base ya poblada.

1. Deja terminar la sincronización actual y los repasos pendientes de todos los dispositivos.
2. Detén el plugin antiguo (versión con modo local) y la app en todos los dispositivos. Haz una copia completa de
   `recall-data` y de la configuración del plugin. Trabaja con esa copia congelada.
3. Valida primero (no crea la base destino):

   ```sh
   npm run migrate:server -- /ruta/a/la/copia/recall-data /ruta/privada/recall.sqlite
   ```

4. Si la validación es correcta, importa explícitamente:

   ```sh
   npm run migrate:server -- /ruta/a/la/copia/recall-data /ruta/privada/recall.sqlite --apply
   ```

5. Configura `RECALL_DB` con ese destino y `RECALL_TAGS` con los tags que ya utilizabas
   (separados por comas, sin `#`). Arranca el backend y comprueba mazos y estadísticas.
6. Instala el plugin compilado (`main.js`, `manifest.json`, `styles.css`) y el nuevo APK.
   En Recall Settings introduce URL y token, y recarga el plugin. Repítelo en cada Obsidian
   que utilices. (El antiguo interruptor **Use standalone backend** ya no existe; si tu
   `data.json` lo conserva, se ignora.)
7. En Android configura la misma URL y el mismo token (sin `/api/v1` al final).
8. Solo después, activa **Publish Markdown notes** en el dispositivo editor y recarga.
   Ejecuta **Recall: Publish notes to backend** para subir las notas y crear su inventario.

Se importan conceptos, tarjetas, mazos, índice y todos los `reviews*.json`. Se deduplican
los eventos idénticos y se rechazan historiales contradictorios para la misma tarjeta y
marca temporal. El estado FSRS se conserva exactamente; no se reproduce implícitamente el
historial, porque puede haber estado importado desde SR sin eventos equivalentes. Una copia
de origen ya inconsistente debe resolverse antes de migrar; no se adivina qué dispositivo
tenía razón. Los comentarios SR que todavía no se habían importado al plugin no se convierten
automáticamente durante esta migración.

La importación no copia claves de proveedores ni configuración privada. Pasa esas claves al
entorno del backend si deseas audio remoto. Conserva la copia antigua, pero **no vuelvas a
instalar una versión antigua del plugin con motor local tras empezar a estudiar en el servidor**:
sería otra línea de historial.

## Notas y sincronización

Publicar notas es voluntario y sube contenido Markdown al backend configurado, incluidas
notas sin tarjetas; solo los tags permitidos y las tarjetas reconocidas generan material de
estudio. Las notas originales nunca se escriben desde el backend. El backend no sustituye
Obsidian Sync como sistema de archivos ni descarga/mezcla automáticamente cambios en Markdown.

Cada nota tiene una revisión y un hash. Los cursores del publicador se guardan en el
`localStorage` del dispositivo, no junto a los archivos de programación del vault.

- Crear/modificar/borrar una nota abierta en el editor produce una operación de publicación.
- Renombrar una nota publicada es una operación atómica y mantiene sus IDs e historial.
- Una primera subida idéntica a lo ya almacenado se reconoce sin duplicarlo.
- Un dispositivo sin cursor no puede sobrescribir una nota remota diferente.
- Una edición basada en una revisión antigua genera un conflicto visible; no gana el último
  en llegar. La eliminación conserva un tombstone para impedir resurrecciones obsoletas.
- El escaneo manual nunca deduce eliminaciones de archivos ausentes. Tras trabajar sin
  conexión, ejecútalo para publicar altas/cambios; elimina o renombra notas pendientes de
  forma explícita tras verificar el inventario remoto.
- Tras un fallo de publicación, no se cambia la nota local. Hay que volver a publicar cuando
  haya conexión. Esta versión no tiene una cola persistente de operaciones offline.

Para inspeccionar un conflicto, `GET /api/v1/note?path=...` devuelve contenido y revisión.
Puedes conservar ambas versiones y resolverlas manualmente. Para reanudar desde Obsidian,
publica primero una copia idéntica a la versión remota (reconoce su revisión), y después tu
edición combinada. No borres cursores para forzar una sobrescritura.

Cambiar `RECALL_TAGS` y reiniciar reindexa las notas que ya están publicadas. El historial se
mantiene. Los elementos importados cuyo Markdown aún no se ha publicado no pueden reindexarse
hasta que se suba esa fuente. Los IDs siguen la convención previa basada en contenido:
cambiar una pregunta/respuesta puede crear una tarjeta nueva; no hay fusión semántica automática.

## Garantías y protocolo

Cada comando se ejecuta en una transacción `BEGIN IMMEDIATE`, en una cola por instancia.
Estado, historial, contadores diarios y recibo de idempotencia se confirman juntos; ante un
fallo se revierte todo. [SQLite documenta estas transacciones](https://www.sqlite.org/lang_transaction.html).
WAL y `synchronous=FULL` están habilitados. Las lecturas también pasan por la cola para que
nunca observen una actualización parcial. No se mantiene una transacción mientras se llama
a un proveedor de voz.

Las versiones de tarjeta son independientes de `reps`, porque una nota puede cambiar sin
haber sido repasada. Las horas de revisión y los límites se deciden en el servidor, no con
el reloj del móvil. El día se delimita con `TZ`; los límites se comprueban al consultar y al
aceptar respuestas. Un reintento aceptado previamente sigue devolviendo éxito aunque ya se
haya alcanzado el límite.

Todas las rutas salvo health exigen `Authorization: Bearer <token>`.

| Método/ruta | Función |
| --- | --- |
| GET `/api/v1/health` | Disponibilidad e identificación del protocolo |
| GET `/api/v1/decks`, `/stats`, `/leeches` | Consultas de estudio |
| GET `/api/v1/due?deckId=...&limit=50` | Tarjetas, revisiones, intervalos y texto de voz |
| POST `/api/v1/reviews` | Respuestas idempotentes, resultado por elemento y cola opcional (`due`) |
| GET `/api/v1/notes` | Inventario, hashes, revisiones y tombstones |
| GET `/api/v1/note?path=...` | Contenido de una nota para reconciliar |
| GET `/api/v1/sources` | Índice de notas/líneas para abrir la fuente desde Obsidian |
| POST `/api/v1/notes` | Alta, edición o eliminación (`content: null`) |
| POST `/api/v1/notes/rename` | Renombrado sin sobrescribir el destino |
| GET `/api/v1/audio/:id/question` o `/answer` | Voz remota opcional |

Ejemplo de respuesta enviada por un cliente:

```json
{"reviews":[{"operationId":"uuid-del-intento-logico","studyItemId":"id-de-la-tarjeta","rating":"good","expectedRevision":7}]}
```

Reutiliza **la misma operación y la misma respuesta** si se pierde el acuse. El servidor
rechaza reutilizar ese ID con otro contenido. Dos comandos distintos basados en la revisión
7 no pueden incrementar ambos el estado. El segundo se rechaza y debe refrescar su cola.
`POST /reviews` devuelve HTTP 200 para un lote válido con `{applied, errors}`; cada error
incluye `idx`, `status` y `reason`. Una validación fallida no equivale a un repaso guardado.

El cuerpo admite además un campo opcional `"due": {"deckId": "...", "limit": 50}` (`deckId`
opcional y no vacío; `limit` obligatorio, entero 1–10000). Si está presente, la respuesta
añade `"due": {"items": [...]}` con la misma forma y reglas que `GET /due`, calculada después
de procesar todo el lote, aunque se rechacen algunos o todos los repasos. Un `due` inválido
rechaza la petición entera con 400 antes de aplicar ningún repaso. Sin `due`, la respuesta no
cambia. La cola no forma parte del acuse idempotente: al reintentar con el mismo `operationId`
se devuelve el mismo resultado del repaso y una cola recalculada en ese momento.
Los errores de conexión y los conflictos ya no se ocultan en los clientes.

Para notas: `{operationId, path, content, expectedRevision}`; usa 0 solo para una ruta nueva.
Para renombrar: `{operationId, path, newPath, expectedRevision}`. Las rutas son relativas al
vault y terminan en `.md`. Un destino existente, incluso eliminado, bloquea el renombrado.

## Voz y proveedores

Sin `RECALL_TTS_KEY`, Android utiliza su TTS local. Al configurar esa clave se reutilizan
los adaptadores y la caché de audio existentes. Opcionalmente configura `RECALL_LLM_PROVIDER`,
`RECALL_LLM_KEY` y `RECALL_LLM_MODEL` para la preparación multilingüe previa. Las instrucciones
de voz conservan el valor anterior y admiten `RECALL_TTS_INSTRUCTIONS`.

Las llamadas a proveedores tienen tiempo máximo (LLM 30 s, TTS 60 s); un proveedor colgado
produce un error de audio en lugar de bloquear la petición indefinidamente.

Activar estas opciones envía el texto de la tarjeta al proveedor correspondiente y puede
generar cargos. Ni las claves ni esas llamadas deben pasar por Obsidian o el móvil.

## Docker, copias y límites operativos

`docker compose up --build -d` utiliza `.env`, un volumen persistente y un puerto publicado
solo en loopback. No se ha desplegado automáticamente. Coloca delante tu acceso privado o
proxy HTTPS. El contenedor corre como usuario no root. Conserva el volumen entre despliegues.

Para una copia sencilla y consistente, detén el backend y copia la base SQLite y cualquier
archivo `-wal`/`-shm` que siga presente, o utiliza una herramienta de backup SQLite. No copies
solo el archivo principal mientras el servidor está escribiendo. La caché de audio es
prescindible y puede regenerarse, con posible coste del proveedor.

Los repositorios del dominio se implementan sobre tablas normalizadas de SQLite (conceptos,
tarjetas, mazos y sus elementos, historial de repasos, índice de notas, revisiones y
contadores diarios). Cada operación lee y escribe solo las filas que necesita: un repaso ya no
reescribe el historial completo, y el coste de las consultas no crece con los repasos
acumulados. Es apropiada para una instalación personal, no una promesa de escalado
horizontal: usa un único proceso primario y disco local persistente, no un SQLite sincronizado
por Obsidian/iCloud/NFS. Para usuarios independientes harían falta autenticación y aislamiento.
El historial se conserva sin caducidad. Los recibos de operaciones guardan solo el hash
SHA-256 del comando (nunca el Markdown publicado) y el resultado, y caducan a los
`RECALL_RECEIPT_DAYS` días (por defecto 90; `0` los conserva siempre). Se purgan al arrancar
y una vez al día. Es seguro: cada comando lleva `expectedRevision`, así que un reintento que
llegue tras caducar su recibo se reevalúa y se rechaza con 409 (o, en notas con contenido
idéntico, se reconoce) en lugar de aplicarse dos veces.

El esquema actual es la versión 3. **Antes de actualizar, detén el servidor y haz una copia
con `scripts/backup-server.mjs`.** Al arrancar, el servidor nuevo migra la base
automáticamente, encadenando los pasos necesarios:

- v1 → v2, en una transacción: sustituye cada payload de recibo por su hash (los reintentos
  pendientes siguen reconociéndose).
- v2 → v3, en otra transacción: convierte los documentos JSON (`concepts`, `study-items`,
  `decks`, `reviews`, `sync-state`, `index-tags`, `revision:*`, `budget:*`) en filas de
  tablas, conservando el orden en que la aplicación los recorría. Antes de borrar los
  documentos, vuelve a exportar las tablas al formato antiguo y comprueba que coinciden con
  lo que la aplicación veía (el historial de repasos deduplicado por tarjeta y marca temporal
  y ordenado por fecha, como ya hacía). Las referencias colgantes se conservan tal cual. Una
  clave desconocida, una fecha que no se pueda guardar en milisegundos exactos o cualquier
  diferencia anula la migración: la base queda intacta en v2 y el servidor no arranca.

Tras migrar ejecuta `VACUUM` para recuperar espacio (si falla, no es grave). Es irreversible:
un servidor anterior rechazará la base migrada (`schema is newer`), y este servidor rechaza
bases de una versión posterior. Para volver atrás, restaura la copia.

El estudio es online. No se simula que se guardó una respuesta sin confirmación. Android
reintenta fallos de transporte con el mismo ID; Obsidian conserva el intento en memoria para
reintentar. Cerrar la aplicación con operaciones pendientes no equivale a una cola offline
duradera. No hay fusión de repasos divergentes ni resolución automática de conflictos de texto.

## Comprobación

```sh
npm run typecheck
npm run test:run
npm run build
npm run build:server
cd android
./gradlew :app:testDebugUnitTest :app:assembleDebug
```

El APK actualizado se genera en `android/app/build/outputs/apk/debug/app-debug.apk`.
El archivo histórico `recall-voice-latest.apk` de la raíz no se sustituye automáticamente.
Las pruebas del backend usan bases temporales; no importan ni modifican tu vault real.
