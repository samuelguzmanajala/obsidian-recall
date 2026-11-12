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

En Recall Settings se configuran la URL del backend, el token y la publicación de notas.
Los cambios de URL o token se aplican al recargar el plugin; mientras falten, las vistas
indican que hay que configurar el backend. Con el backend configurado, la sección **Estudio**
de los mismos ajustes permite elegir los tags que se siguen, los límites diarios, el umbral
de sanguijuelas y el orden aleatorio; se guardan en el servidor (ver
[Ajustes de estudio](#ajustes-de-estudio)). Sus valores iniciales salen de las variables de
entorno del servidor (`RECALL_TAGS`, `RECALL_DAILY_NEW`, `RECALL_DAILY_REVIEW`,
`RECALL_LEECH_THRESHOLD`, `RECALL_SHUFFLE`). El audio solo se configura en el entorno
(`RECALL_TTS_*`, `RECALL_LLM_*`). Las claves antiguas de `data.json` (proveedores, API de voz,
tags…) se conservan sin usarse.

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
   (separados por comas, sin `#`; después puedes cambiarlos desde la sección **Estudio** de
   Recall Settings). Arranca el backend y comprueba mazos y estadísticas.
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

Cambiar los tags seguidos (desde **Estudio** o, sin ajustes guardados, cambiando `RECALL_TAGS`
y reiniciando) reindexa las notas que ya están publicadas. El historial se mantiene. Los elementos importados cuyo Markdown aún no se ha publicado no pueden reindexarse
hasta que se suba esa fuente. Los IDs siguen la convención previa basada en contenido, con
una excepción para las ediciones.

Editar una tarjeta conserva su historial cuando el cambio es claro. Al publicar una nota se
comparan las tarjetas que desaparecen de ella con las que aparecen en ella (solo dentro de esa
nota y de esa publicación). Una tarjeta desaparecida y una nueva se consideran la misma si
tienen la misma dirección (`::` o `:::`) y además:

1. una cara es idéntica y la otra cambió (se corrigió la pregunta o la respuesta, aunque la
   respuesta nueva sea completamente distinta), o
2. cambiaron las dos caras, pero cada una se parece al menos un 80 % a la anterior: como
   mucho una letra cambiada, añadida o quitada por cada cinco, sin contar espacios al inicio o
   al final ni espacios repetidos (mayúsculas y tildes sí cuentan). Las caras de más de 1000
   caracteres no se comparan así.

La tarjeta editada conserva su ID, sus repasos, su programación y sus mazos; los clientes que
la tenían en cola reciben un 409 y la recargan con el texto nuevo. En la duda, no se hereda
nada y la edición se trata como antes (la tarjeta vieja se elimina y la nueva empieza de
cero):

- si una tarjeta desaparecida encaja con varias nuevas, o una nueva con varias desaparecidas;
- si la tarjeta antigua también está en otra nota (es compartida);
- si el texto nuevo ya existe como tarjeta, en otra nota o como edición anterior (se enlaza a
  esa tarjeta, como siempre);
- si cambia la dirección (`::` ↔ `:::`);
- si la tarjeta se edita a la vez que se mueve a otra nota (solo se comparan tarjetas de la
  misma nota).

El servidor recuerda qué texto heredó cada historial. Si la tarjeta editada se borra y luego
se vuelve a añadir con el mismo texto (por ejemplo, al moverla a otra nota en dos pasos),
recupera su historial. Si se vuelve a escribir el texto de antes de la edición, es una
tarjeta nueva con IDs nuevos; nunca se mezcla con la editada.

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
| GET `/api/v1/proposals?status=pending` | Tarjetas propuestas desde el conector MCP (ver abajo) |
| POST `/api/v1/proposals/accept`, `/dismiss` | Aceptar o descartar una propuesta (idempotente) |
| GET `/api/v1/settings` | Ajustes de estudio vigentes, su origen y su revisión |
| POST `/api/v1/settings` | Cambio de ajustes de estudio (idempotente, con revisión y `dryRun`) |
| GET `/api/v1/tags` | Tags de las notas publicadas con notas y tarjetas que cubren |

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

Cada repaso guardado lleva su origen: `android` si el cliente HTTP se identifica como OkHttp,
`obsidian` si su agente contiene «obsidian» (Obsidian de escritorio; en móvil puede llegar como
`api`), `api` para cualquier otro cliente y `mcp` para el conector. Es solo una etiqueta: no
cambia la planificación ni el recibo, y el protocolo no cambia. Los repasos anteriores a la
versión 5 del esquema no tienen origen (`unknown`).

Para notas: `{operationId, path, content, expectedRevision}`; usa 0 solo para una ruta nueva.
Para renombrar: `{operationId, path, newPath, expectedRevision}`. Las rutas son relativas al
vault y terminan en `.md`. Un destino existente, incluso eliminado, bloquea el renombrado.

## Ajustes de estudio

Tags seguidos, límites diarios, umbral de sanguijuelas y orden aleatorio son estado del
servidor, en la tabla `meta` (clave `study-settings`, un JSON con la revisión y los cinco
valores); no hay migración de esquema. Reglas de precedencia:

- Mientras no se haya guardado nada, se aplican las variables de entorno (`RECALL_TAGS`,
  `RECALL_DAILY_NEW`, `RECALL_DAILY_REVIEW`, `RECALL_LEECH_THRESHOLD`, `RECALL_SHUFFLE`) y
  `GET /settings` devuelve `source: "environment"`. Arrancar no escribe nada.
- El primer `POST /settings` guarda **los cinco** valores (los que no se envían se copian de
  los vigentes). Desde entonces ganan los guardados (`source: "stored"`), también tras
  reiniciar; cambiar el entorno ya no tiene efecto hasta volver a él.
- Para volver al entorno: `POST /settings` con `"reset": true` (en Obsidian, **Volver a los
  valores del entorno**). Se guarda `settings: null` y la revisión sigue contando, así que
  un cliente con una revisión anterior sigue recibiendo 409.

Un cambio se aplica al instante, sin reiniciar, a HTTP, Android y MCP: la siguiente consulta
de `/due`, `/leeches` o una herramienta MCP usa los valores nuevos, y la siguiente nota
publicada usa el filtro de tags nuevo.

`GET /api/v1/settings` →
`{"settings":{"flashcardTags":["German"],"dailyNewLimit":20,"dailyReviewLimit":0,"leechThreshold":8,"shuffleReviews":true},"source":"environment","revision":0}`

`POST /api/v1/settings`:

```json
{"operationId":"uuid","expectedRevision":0,"settings":{"flashcardTags":["German","Spanish"],"dailyNewLimit":10},"dryRun":true}
```

- `settings`: uno o más de los cinco campos; un campo desconocido es un 400. `flashcardTags`:
  hasta 200 tags de 1–200 caracteres, sin `#` ni caracteres de control; se recortan espacios,
  se quitan duplicados y se ordenan. Una lista vacía sigue **todas** las notas con tarjetas.
  `dailyNewLimit` y `dailyReviewLimit`: enteros 0–100000 (0 = sin límite).
  `leechThreshold`: entero 0–1000. `shuffleReviews`: booleano.
- `reset: true` en lugar de `settings` vuelve al entorno; enviar ambos es un 400.
- `expectedRevision` es la `revision` leída; si otro cliente cambió los ajustes, 409
  (`Settings changed on another device; reload them`), también en un `dryRun`.
- `operationId` hace el cambio idempotente con el mismo mecanismo de recibos que repasos y
  notas: un reintento devuelve el resultado original; el mismo ID con otro contenido, 409.
- `dryRun: true` calcula exactamente lo mismo dentro de una transacción que siempre se
  revierte: no guarda ajustes, ni recibo, ni cambia revisiones, índice o mazos. La respuesta
  lleva `"dryRun": true`. Obsidian lo usa para pedir confirmación.

Respuesta: `{"settings":{…vigentes…},"source":"stored","revision":1,"impact":{"notes":3300,"cardsBefore":5500,"cardsAfter":3000,"cardsAdded":0,"cardsRemoved":2500,"decksBefore":10,"decksAfter":4}}`.
`notes` son las notas publicadas reindexadas (0 si los tags no cambian), `cards*` cuentan
tarjetas (cada dirección cuenta) y `decks*` los mazos con al menos una tarjeta (los mazos que
se quedan vacíos siguen en el árbol, como al reiniciar con otros `RECALL_TAGS`).

Qué hace un cambio de tags: en la misma transacción que guarda los ajustes se vuelve a
sincronizar cada nota publicada con el filtro nuevo, igual que el reindexado de arranque. Las
tarjetas que dejan de seguirse desaparecen de mazos y colas, pero el historial de repasos no
se toca; si se vuelve a seguir su tag, reaparecen con los mismos IDs y su estado
(se reproduce su historial). Las revisiones de las tarjetas afectadas suben, así que un
repaso en cola de una tarjeta retirada se rechaza (404/409) y los clientes refrescan. Las
tarjetas que aparecen encolan su audio en segundo plano tras confirmar, como al publicar una
nota. Con ~3300 notas y ~5500 tarjetas, el reindexado tarda unos 3–4 s (y otro tanto el
`dryRun`); mientras dura, el resto de peticiones espera su turno.

`GET /api/v1/tags` →
`{"tags":[{"tag":"German","notes":3,"cards":4,"selected":true,"followed":true},{"tag":"German/grammar","notes":1,"cards":3,"selected":false,"followed":true}],"untagged":{"notes":1,"cards":1,"followed":false}}`

- Cada tag del frontmatter de las notas publicadas, más sus antecesores (`German` aparece
  aunque solo haya `German/grammar`) y los tags seleccionados que ya no tiene ninguna nota.
  Orden por nombre (orden de código, mayúsculas antes).
- `notes` y `cards`: lo que cubre seguir ese tag (él y sus subtags), sea cual sea el filtro
  actual; `cards` cuenta las tarjetas que el parser encuentra en cada nota (`:::` cuenta 2).
  Una tarjeta repetida en dos notas cuenta dos veces.
- `selected`: está en `flashcardTags`. `followed`: sus notas se estudian con el filtro actual
  (él o un antecesor está seleccionado, o la lista está vacía).
- `untagged`: notas sin tags. Solo se estudian (mazo «Untagged») con la lista vacía; con
  cualquier tag seleccionado quedan fuera, igual que las notas cuyos tags no coinciden.
- Las notas se analizan una vez y se recuerdan por revisión: solo se vuelven a leer las que
  cambiaron (la primera consulta con ~3300 notas tarda unos 15 ms; las siguientes, ~3 ms).

## Conector MCP para ChatGPT (opcional)

El backend puede ofrecer un servidor MCP remoto (transporte Streamable HTTP) protegido con
OAuth, para usar Recall desde ChatGPT como conector personalizado; la idea es que ChatGPT (también
en modo voz) haga de tutor y lleve la conversación hacia lo que toca repasar o sigues fallando.
Por defecto todas las herramientas son de **solo lectura**: no registran repasos, no cambian la
planificación ni consumen los límites diarios. Preguntar una tarjeta en ChatGPT no cuenta como
repasarla. Con `RECALL_MCP_WRITE=true` se añaden herramientas de escritura (ver «Escritura desde
ChatGPT» más abajo).

| Herramienta | Argumentos | Devuelve |
| --- | --- | --- |
| `list_decks` | — | Árbol de mazos (`id`, `name`, totales, pendientes y nuevas), como `GET /api/v1/decks` |
| `get_due_cards` | `deckId?`, `limit?` | La cola de ahora: repasos pendientes (los más atrasados primero) y después nuevas, dentro de lo que permiten hoy los límites diarios, cada una con `next` (cuándo volvería según la nota); más los recuentos `reviewsDue`, `newCardsDue`, `reviewsLeftToday`, `newLeftToday` |
| `get_weak_cards` | `deckId?`, `limit?`, `days?` (1–90, 30) | Tarjetas flojas, de peor a mejor (ver abajo) |
| `get_leeches` | `deckId?`, `limit?` | Sanguijuelas: lapsos ≥ el umbral vigente (ajustes de estudio), como `GET /api/v1/leeches` |
| `search_cards` | `query`, `deckId?`, `limit?` | Tarjetas cuyo anverso o reverso contiene el texto, con cada dirección que estudias |
| `get_study_stats` | — | `GET /api/v1/stats` más lo que queda hoy de los límites diarios |

- `deckId` es el `id` de un mazo tal como lo devuelve `list_decks` (no el nombre, que puede
  repetirse en otra rama); incluye sus submazos. Un `id` desconocido es un error.
- `limit` va de 1 a 50 (20 por defecto). Argumentos desconocidos o de tipo incorrecto se rechazan
  con un error de herramienta (`isError`) que el modelo puede leer y corregir; `null` equivale a
  no pasar el argumento.
- Cada tarjeta trae `studyItemId`, `prompt` (lo que se pregunta) y `answer` (lo que hay que
  recordar) según la dirección, los mazos como ruta de etiqueta (`German/grammar`), `state`
  (`new` o `review`), `due` (solo repasos), `reps`, `lapses`, `revision` (la misma revisión que
  `GET /api/v1/due`; cambia al repasar o editar la tarjeta) y `next`: para cada nota (`again`,
  `hard`, `good`, `easy`), cuándo volvería la tarjeta si la valoraras ahora, como intervalo corto
  (`in`: `10m`, `5h`, `3d`) y fecha UTC al minuto (`due`). Sale de la misma vista previa del
  planificador que `preview` en `GET /api/v1/due` (desde un día, los mismos días; por debajo, en
  minutos u horas donde la API dice 0) y no escribe nada. Los lados son el Markdown tal cual,
  cortado a 500 caracteres con «…» y `truncated: true`. `search_cards` agrupa por tarjeta: `sideA`,
  `sideB` y `directions` (una entrada por dirección estudiada, con qué lado hace de pregunta y su
  `next`).
- La búsqueda es por subcadena, sin distinguir mayúsculas, acentos ni saltos de línea («adios»
  encuentra «Adiós»; «ß» no se convierte en «ss»). Recorre la tabla de conceptos, sin índice de
  texto completo: con unos miles de tarjetas tarda milisegundos.
- `get_weak_cards` usa solo datos ya guardados: tarjetas estudiadas con algún «Again» en los
  últimos `days` días, algún lapso o dificultad FSRS ≥ 7. Puntuación = 3 × «Again» recientes
  + 2 × lapsos + (dificultad − 5 si es positiva) + 1 si la estabilidad es menor de 2 días. Solo lee
  los repasos de esa ventana, no todo el historial.

Se sirve en **otro puerto**, pensado para publicarse en Internet con Tailscale Funnel. Ese puerto
solo atiende `/mcp`, `/oauth/*` y `/.well-known/oauth-*`; **nada de `/api/v1`**, que sigue siendo
privado en el puerto habitual. Sin estas variables el servidor se comporta exactamente como antes:

| Variable | Función |
| --- | --- |
| `RECALL_MCP_PORT` | Puerto del listener público (p. ej. `27125`); distinto de `RECALL_PORT` |
| `RECALL_MCP_PUBLIC_URL` | Origen HTTPS público, sin ruta (p. ej. `https://mac.tailnet.ts.net`). Es el emisor OAuth; el recurso es `<origen>/mcp` |
| `RECALL_MCP_HOST` | Interfaz de escucha (por defecto `127.0.0.1`) |
| `RECALL_MCP_OAUTH_DB` | Base SQLite de OAuth (por defecto `recall-oauth.sqlite` junto a `RECALL_DB`) |
| `RECALL_MCP_WRITE` | `true` añade las herramientas de escritura; `false` o sin definir, solo las seis de lectura. Otro valor impide arrancar |

Hay que definir las dos primeras o ninguna; si falta una, el servidor no arranca.

Funcionamiento:

- ChatGPT descubre los metadatos (RFC 9728 y RFC 8414), se registra solo (registro dinámico de
  clientes, RFC 7591) y abre la página de aprobación `/oauth/authorize`. Ahí escribes tu
  `RECALL_TOKEN` para aprobarlo. El token nunca sale de esa página ni se entrega al cliente.
- Código de autorización con PKCE S256, de un solo uso y válido 60 s; redirección solo a URIs
  registradas exactamente. Respuesta con `iss` (RFC 9207). Los tokens se emiten solo para el recurso
  `<origen>/mcp`; un token de otro recurso o tu `RECALL_TOKEN` no sirven en `/mcp`.
- Token de acceso de 1 h y token de refresco de 60 días que rota en cada uso. Reutilizar un token de
  refresco ya usado, o un código ya canjeado, revoca toda esa autorización: tendrás que volver a
  conectar.
- Un token incorrecto en la página de aprobación se responde tras 1 s; el correcto, al instante.
  No hay bloqueo tras varios fallos: detrás de Funnel todas las peticiones llegan desde el proxy
  local (Funnel sí añade `X-Forwarded-For` con la IP pública, pero no se usa), así que un bloqueo
  común permitiría a cualquiera dejarte fuera. Lo que hace inviable adivinar es que `RECALL_TOKEN`
  tenga al menos 32 caracteres aleatorios; el retardo solo frena scripts ingenuos.
- `recall-oauth.sqlite` guarda clientes registrados y **solo hashes SHA-256** de los tokens. No
  forma parte de la base de estudio ni de sus migraciones, y la copia de `scripts/backup-server.mjs`
  no la incluye: si la pierdes, basta con volver a conectar ChatGPT. El registro es anónimo: los
  clientes que nunca se aprobaron se eliminan al cabo de un día, y como mucho se guardan 100; al
  llegar a ese tope, cada registro nuevo expulsa al no aprobado más antiguo, así que nadie puede
  llenar la tabla e impedirte registrar uno (los aprobados no cuentan ni se expulsan). Si alguien
  registrara clientes sin parar justo mientras apruebas, el tuyo podría ser expulsado antes de
  aprobarlo: la página diría «Unknown client» y bastaría con volver a añadir el conector. Para
  revocar todos los accesos, detén el servidor y borra ese archivo (y sus `-wal`/`-shm`).

Pasos para conectar ChatGPT (manual, no se hace automáticamente):

1. Añade al entorno del backend `RECALL_MCP_PORT=27125` y
   `RECALL_MCP_PUBLIC_URL=https://<tu-máquina>.<tailnet>.ts.net`, y reinicia. Comprueba en
   local `curl http://127.0.0.1:27125/.well-known/oauth-protected-resource/mcp`.
2. Publica **solo ese puerto** con Funnel en el 443:
   `tailscale funnel --bg --https=443 http://127.0.0.1:27125`. **Usa el 443**: con Funnel en el
   10000 los servidores de ChatGPT no llegaron a hacer ninguna petición (el navegador sí llegaba,
   así que la página de aprobación se abría, pero el conector se quedaba cargando). **Nunca actives
   Funnel en el puerto que apunta a `RECALL_PORT`** (en esta instalación, 8443): publicaría
   `/api/v1` en Internet. Comprueba con `tailscale funnel status` qué se publica. La primera vez que
   se activa Funnel, el nombre tarda unos minutos en aparecer en el DNS público.
3. En ChatGPT, con el modo desarrollador activado, añade un conector o servidor MCP personalizado
   con la URL `https://<tu-máquina>.<tailnet>.ts.net/mcp` y autenticación OAuth. Elige el registro
   dinámico (DCR); el aviso de que CIMD no está disponible es normal, este servidor no admite
   *Client ID Metadata Documents*. ChatGPT abrirá la página de aprobación: escribe tu
   `RECALL_TOKEN` y pulsa Approve.
4. Pide en el chat «¿qué mazos tengo en Recall?» o «pregúntame lo que tengo pendiente de alemán».
   Al añadir herramientas nuevas, ChatGPT puede necesitar que actualices o vuelvas a conectar el
   conector para verlas. Para desconectar, elimina el conector en ChatGPT
   y desactiva Funnel (`tailscale funnel --https=443 off`).

El listener escribe una línea por petición en el registro del servidor (método, ruta sin
parámetros, estado y agente, y en `/mcp` también la cabecera `MCP-Protocol-Version`), con el
prefijo `[Recall MCP]`; sirve para seguir la conexión de un conector paso a paso. Si el puerto MCP
no está libre, se registra el error y la API privada sigue funcionando sin el conector.

Versiones del protocolo: el servidor implementa las revisiones con `initialize` (2025-03-26,
2025-06-18 y 2025-11-25). La revisión 2026-07-28 (sin estado, sin `initialize`) no está
implementada. Un cliente que hable ambas prueba primero con
`MCP-Protocol-Version: 2026-07-28`, recibe un 400 sin el error moderno
`UnsupportedProtocolVersionError` (-32022) y, como indica esa revisión, vuelve a `initialize` con
una versión anterior. Si el registro muestra un `POST /mcp 400` justo antes de que la conexión
funcione, mira su `mcp-protocol-version`: con `2026-07-28` es ese retroceso, esperado e inocuo.

### Escritura desde ChatGPT (`RECALL_MCP_WRITE=true`)

Desactivada por defecto: sin la variable, `tools/list` devuelve exactamente las seis herramientas
de lectura y las instrucciones de siempre. Con ella se añaden siete, y las instrucciones explican al
modelo cuándo registrar (solo después de que respondas y de decirte la nota en voz alta), cómo
corregir y que las propuestas necesitan tu aceptación en Obsidian. Tras activarla, actualiza o
vuelve a conectar el conector en ChatGPT para que vea las herramientas nuevas.

| Herramienta | Argumentos | Efecto |
| --- | --- | --- |
| `record_review` | `studyItemId`, `rating`, `revision` | Registra la nota por el mismo camino que `POST /reviews` (vencida, límites diarios, hermana ya repasada hoy…). Devuelve `reviewId`, `prompt`, `rating`, `due`, `in` y la nueva `revision` |
| `list_recent_reviews` | `hours?` (1–48, 48), `limit?` | Repasos recientes de cualquier origen (`mcp`, `android`, `obsidian`, `api`, `unknown`), del más nuevo al más antiguo, con `reviewId`, tarjeta, nota, `originalRating` si se corrigió, hora y origen; y `changes`, las correcciones de esa ventana con `changeId` |
| `amend_review` | `reviewId`, `rating` | Cambia la nota de un repaso y recalcula la tarjeta |
| `remove_review` | `reviewId` | Borra un repaso que no debía registrarse y recalcula la tarjeta |
| `revert_review_change` | `changeId` | Deshace una corrección (una enmienda vuelve a la nota anterior; un borrado se restaura con su mismo `reviewId`) |
| `propose_card` | `sideA`, `sideB`, `directionality`, `deck?`, `context?` | Guarda una propuesta de tarjeta; **no** crea la tarjeta |
| `list_card_proposals` | `status?` (`pending` por defecto, `accepted`, `dismissed`, `all`), `limit?` | Propuestas, de la más nueva a la más antigua, para no repetirlas |

Reintentos. Un modelo no genera ni reutiliza IDs de operación de forma fiable, y ChatGPT puede
repetir una llamada. `record_review` exige la `revision` que le dieron `get_due_cards` (o
`search_cards`, `get_weak_cards`, `get_leeches`) y usa como `operationId` el recibo
`mcp-review:<studyItemId>:<revision>`: repetir la misma llamada devuelve el mismo resultado sin
registrar dos veces (aunque la tarjeta vuelva a estar vencida, como tras un «Again»); la misma
revisión con otra nota se rechaza e indica usar `amend_review`; una revisión antigua (tarjeta
repasada o editada en otro dispositivo) se rechaza e indica pedir la tarjeta de nuevo. Las demás
son idempotentes por naturaleza: enmendar a la nota que ya tiene no hace nada (`changeId: null`),
borrar un repaso ya borrado o deshacer un cambio ya deshecho devuelve ese mismo cambio con
`alreadyDone: true`, y proponer los mismos lados (sin distinguir mayúsculas, acentos, espacios ni
orden) devuelve la propuesta pendiente con `duplicate: true`.

Correcciones:

- Solo repasos de los **últimos 2 días** (contados desde el repaso), comprobado en el servidor.
- `reviewId` es el número del repaso en el historial (`list_recent_reviews` o `record_review`).
  Nunca se reutiliza: el historial usa una clave `AUTOINCREMENT` desde la versión 5 del esquema.
- La tarjeta queda como si el historial corregido hubiera sido siempre ese: se reproduce desde
  justo antes del repaso corregido (con `StudyItem.replay`, el mismo mecanismo con el que
  `CreateStudyItem` reconstruye una tarjeta editada que vuelve) y se vuelven a aplicar los repasos
  posteriores. Cada repaso guarda desde la versión 5 el estado al que se aplicó (`prior`), así que
  el punto de partida es exacto también para tarjetas con estado importado sin historial. Para
  repasos anteriores a la versión 5 se reproduce desde cero. En ambos casos antes se comprueba que
  reproducir el historial actual da exactamente el estado guardado; si no (estado importado, o
  cambiado fuera del historial), la corrección se rechaza en lugar de adivinar.
- Contadores diarios: enmendar no cambia nada (el repaso existió). Borrar un repaso devuelve el
  cupo que consumió en su día (nueva o repaso); restaurarlo lo vuelve a consumir; si al borrar el
  primer repaso de una tarjeta otro posterior pasa a ser el primero, ese pasa de «repaso» a
  «nueva». Solo se ajustan los días con contador guardado (sin él se calculan del historial, que ya
  es correcto).
- La revisión de la tarjeta sube: Android y el plugin que la tengan en cola reciben un 409 y
  recargan la cola; si el borrado la deja vencida, vuelve a aparecer.
- Toda corrección queda en `review_changes`: repaso (id, tarjeta, hora, origen), acción (`amend`,
  `remove`, `restore`), nota anterior y nueva, quién y cuándo, y en un borrado el estado previo del
  repaso, para restaurarlo exacto. Deshacer es otra corrección (`reverts` apunta a la deshecha), y
  solo se puede deshacer el último cambio de cada repaso.

Propuestas de tarjetas. ChatGPT puede proponer una tarjeta (por ejemplo, tras confundir dos
palabras): cada lado en una línea, sin `::`, con dirección (`unidirectional` = `::`,
`bidirectional` = `:::`), un mazo sugerido como etiqueta (`german/vocabulary`, sin `#`) y un
contexto opcional. Se guarda en `card_proposals` y **nunca** se convierte sola en tarjeta. Una
propuesta igual a una tarjeta existente se rechaza. El panel «Card proposals» del plugin la
muestra; al aceptarla añade la tarjeta a la nota del mazo en la carpeta de entrada (ajuste del
plugin, `Recall inbox` por defecto: `Recall inbox/German/vocabulary.md` con el tag
`German/vocabulary`) y la publicación normal la convierte en tarjeta: el vault sigue siendo la
única fuente de tarjetas. API privada (mismo token y errores `{error}` que el
resto):

- `GET /api/v1/proposals?status=pending|accepted|dismissed|all` (por defecto `pending`) →
  `{"proposals":[{"id":1,"sideA":"die Biene","sideB":"the bee","directionality":"bidirectional","deck":"german","context":null,"status":"pending","origin":"mcp","createdAt":"…Z","decidedAt":null,"notePath":null}]}`,
  de la más antigua a la más nueva.
- `POST /api/v1/proposals/accept` con `{"id":1,"notePath":"German/Insects.md"}` (`notePath`
  opcional) y `POST /api/v1/proposals/dismiss` con `{"id":1}` → `{"proposal":{…}}`. Repetir la
  misma decisión devuelve la propuesta sin cambios (se conserva el primer `notePath`); la decisión
  contraria es un 409, un `id` desconocido un 404 y un cuerpo inválido un 400. Una propuesta
  descartada puede volver a proponerse.

Anotaciones. Ninguna herramienta de escritura declara `readOnlyHint`. Según la documentación de
OpenAI, ChatGPT trata como escritura toda herramienta sin `readOnlyHint: true` y pide confirmación
(se puede recordar la aprobación dentro de una conversación); `destructiveHint` es para resultados
irreversibles o difíciles de revertir. Ninguna lo declara: registrar y proponer solo añaden datos, y
cada corrección queda auditada y se puede deshacer. Además, hay informes de que la app de Android
de ChatGPT bloquea antes de llamar al servidor las herramientas con `destructiveHint: true`. Todas
declaran `idempotentHint: true` y `openWorldHint: false`. No está documentado cómo se muestran esas
confirmaciones en el modo de voz: hay que comprobarlo con una conexión real.

ChatGPT envía la lista de mazos a OpenAI al usarla. Las opciones y nombres de la interfaz de
ChatGPT cambian a menudo; la disponibilidad del modo desarrollador y de conectores en el modo de
voz depende del plan y no está garantizada.

## Voz y proveedores

Sin `RECALL_TTS_KEY`, Android utiliza su TTS local. Con esa clave el servidor genera el audio
(siempre MP3, `audio/mpeg`) y lo guarda en la caché de `RECALL_AUDIO_DIR`.

`RECALL_TTS_PROVIDER` elige el proveedor: `openai` (por defecto, para no cambiar instalaciones
existentes) o `gemini`. Cualquier otro valor impide arrancar. `RECALL_TTS_KEY`,
`RECALL_TTS_MODEL`, `RECALL_TTS_VOICE` y `RECALL_TTS_INSTRUCTIONS` valen para ambos:

| | `openai` | `gemini` |
|---|---|---|
| Modelo por defecto | `gpt-4o-mini-tts` | `gemini-3.8-flash-tts` |
| Voz por defecto | `alloy` | `Kore` |
| Instrucciones | las incorporadas, salvo `RECALL_TTS_INSTRUCTIONS` | ninguna, salvo `RECALL_TTS_INSTRUCTIONS` (va como `speech_metadata.style`) |

OpenAI retira `gpt-4o-mini-tts`, `tts-1` y `tts-1-hd` el 2027-01-06; el proveedor previsto es
Gemini. Al cambiar de proveedor revisa `RECALL_TTS_VOICE`/`RECALL_TTS_MODEL`: una voz de OpenAI
no existe en Gemini. Con `RECALL_TTS_PROVIDER=gemini` el servidor (y el comando de pregeneración)
se niega a arrancar si `RECALL_TTS_VOICE` es una voz de OpenAI (`alloy`, `ash`, `ballad`, `coral`,
`echo`, `fable`, `nova`, `onyx`, `sage`, `shimmer`, `verse`) o si `RECALL_TTS_MODEL` empieza por
`gpt-` o `tts-`: borra esas líneas o pon valores de Gemini. Las instrucciones incorporadas están escritas para OpenAI y no se envían a
Gemini; Google recomienda no dar estilo por defecto y no pedir acentos en él.

Gemini solo devuelve WAV, así que el servidor lo convierte a MP3 (mono, libmp3lame, VBR 4) con
`ffmpeg`, ejecutado sin shell y por tuberías, sin ficheros temporales. `RECALL_FFMPEG` indica el
ejecutable (por defecto `ffmpeg` del `PATH`). Con `gemini` el servidor comprueba al arrancar que
ffmpeg funciona y tiene libmp3lame, y si no, no arranca. Bajo launchd el `PATH` no incluye
`/opt/homebrew/bin`: usa una ruta absoluta (`RECALL_FFMPEG=/opt/homebrew/bin/ffmpeg`). La imagen
Docker ya incluye ffmpeg.

Cuotas observadas en Gemini con el nivel por defecto: unas 10 peticiones por minuto y 100 al
día para `gemini-3.8-flash-tts`, y cada tarjeta nueva consume una por cara. Ante un 429 o un 5xx
el servidor reintenta respetando el retraso que indica Google (como mucho 3 intentos y 30 s en
total, para que el móvil no espere más de la cuenta). Si se agota la cuota diaria no reintenta.
En cualquier fallo la petición responde 502 y Android usa su TTS local; el motivo queda en el
log del servidor (sin la clave).

La caché de audio distingue el proveedor: los MP3 ya generados con OpenAI conservan su nombre
y siguen sirviéndose, y los de Gemini se guardan aparte con otro hash. Las escrituras de caché
son atómicas (fichero temporal y renombrado), así que un fallo no deja audio a medias.

Antes de sintetizar, el servidor limpia la puntuación que no se lee bien con reglas fijas
(`preprocessForTts` en `src/server/audio/preprocess-text.ts`), iguales para OpenAI y Gemini, para
`GET /api/v1/audio`, la cola en segundo plano y la pregeneración:

- una barra con espacios a ambos lados separa alternativas y pasa a coma
  ("sorprendido / desconcertado" → "sorprendido, desconcertado");
- un paréntesis precedido de espacio (o al principio) pasa a inciso entre comas con las mismas
  palabras ("Característica (feature). Otros" → "Característica, feature. Otros"); tras un punto,
  antes de otra puntuación o al final no se añade coma, y "()" desaparece;
- una flecha con espacios (`→`, `->`, `=>`, `⇒`) pasa a coma ("der → den" → "der, den");
- se quitan las comillas dobles (rectas, “ ” o „ “) que solo envuelven un término o frase.

No tocan lo que va pegado a una palabra (`km/h`, `TCP/IP`, `1/2`, `and/or`, URLs, fechas,
`f(x)`, `getUser(id)`, `(re)encolar`, `a->b`), ni paréntesis anidados o sin cerrar, ni apóstrofos
o comillas simples (`don't`, `l'eau`), ni comillas sueltas (`5"`). Tampoco traducen, reordenan,
expanden abreviaturas ("Akk."), deletrean símbolos (`+`, `=`, `≥`) ni tocan números u ordinales.
Nunca dejan comas dobles o colgando, y el hueco "…" y la puntuación final quedan como estaban.
El marcador de bloque de código "(código)" se lee ahora como inciso (", código,").

El nombre del MP3 depende del texto final: cambiar estas reglas cambia el texto de las caras
afectadas, que se vuelven a sintetizar con otro nombre; los ficheros anteriores quedan huérfanos
(lístalos con `--orphans`, ver "Ficheros huérfanos" más abajo).

La reescritura posterior con un LLM es opcional y está desactivada por defecto:
`RECALL_LLM_PROVIDER` (por defecto `none`), `RECALL_LLM_KEY` y `RECALL_LLM_MODEL`. Con Gemini no se
recomienda: Gemini detecta los idiomas solo, y en una muestra de 24 caras el LLM tradujo una
glosa, etiquetó expresiones inglesas sueltas ("en inglés") y dio salidas distintas entre
ejecuciones, mientras que lo útil que hacía (la puntuación) ya lo hacen las reglas anteriores.
Si se activa, recibe el texto ya limpio, nunca anuncia ni etiqueta idiomas (sin excepciones),
mantiene los huecos como "…" y no traduce ni omite nada. La clave de la caché de reescrituras
incluye un hash de la instrucción: al cambiarla, las reescrituras guardadas dejan de usarse y se
regeneran (con coste del proveedor LLM). Las antiguas quedan en disco sin uso.

Las llamadas a proveedores tienen tiempo máximo (LLM 30 s, TTS de OpenAI 60 s, TTS de Gemini
30 s en total con reintentos); un proveedor colgado produce un error de audio en lugar de
bloquear la petición indefinidamente.

Activar estas opciones envía el texto de la tarjeta al proveedor correspondiente y puede
generar cargos. Ni las claves ni esas llamadas deben pasar por Obsidian o el móvil.

### Pregenerar el audio

Sin pregenerar, cada cara se sintetiza la primera vez que el móvil la pide. Con la cuota
interactiva de Gemini (unas 10 peticiones por minuto y **100 al día** para
`gemini-3.8-flash-tts`) no es posible generar miles de caras así; el comando de pregeneración usa
la **Batch API** de Gemini, que tiene límites propios (siguió funcionando con la cuota diaria
interactiva agotada) y cuesta la mitad.

El comando usa las mismas variables `RECALL_*` que el servidor y produce exactamente los
ficheros que sirve `GET /api/v1/audio` (mismo texto final, misma reescritura, mismo nombre). Abre
`RECALL_DB` **solo lectura**: puede ejecutarse con el servidor en marcha, nunca escribe en la base
ni la migra, y se niega a usarla si su versión de esquema no es la actual (arranca antes el
servidor nuevo una vez). En esta instalación, desde el directorio del backend:

```sh
node --env-file=/ruta/a/backend.env dist/server/pregenerate.cjs              # simulación
node --env-file=/ruta/a/backend.env dist/server/pregenerate.cjs --apply --max-usd=5
```

(`npm run pregenerate:audio -- …` es equivalente si exportas el entorno tú mismo.)

| Opción | Efecto |
| --- | --- |
| `--dry-run` | Por defecto. Sin llamadas a TTS ni a LLM: tarjetas, caras, textos distintos, ya en caché, ficheros copiables, pendientes, caracteres, segundos estimados y coste estimado (precio estándar y batch, hoy y desde el 2027-01-01). Con reescritura, cuántas reescrituras faltan: su texto final no se conoce hasta reescribirlas, así que la estimación usa el texto previo. |
| `--apply` | Genera. Exige `--max-usd`. |
| `--max-usd=X` | Tope de gasto de esta ejecución (estimado + real, en USD, solo TTS). No envía nada cuya estimación lo supere y se detiene en cuanto el gasto real lo alcanza. |
| `--mode=batch\|interactive` | Por defecto `batch` con Gemini e `interactive` con OpenAI. |
| `--limit=N` | Solo los N primeros textos pendientes (pruebas). |
| `--batch-size=N` | Textos por lote (150). Los resultados llegan dentro de la respuesta (~400 KB de base64 por clip) y no se han probado lotes de más de 11 clips: súbelo con cuidado. |
| `--concurrency=N` | Llamadas interactivas y reescrituras en paralelo (2). |
| `--wait-minutes=N` | Espera máxima por lote (60); después deja el lote anotado y termina. |
| `--discard-unconfirmed` | Olvida un envío interrumpido que el proveedor no lista (ver abajo). |
| `--orphans` / `--orphans-out=FICHERO` | Lista los MP3 huérfanos (ver abajo). No borra nada. |

Los textos idénticos (mismo proveedor, voz, modelo e instrucciones) se sintetizan una sola vez y
se escriben en todos los ficheros que los necesitan: el nombre incluye el ID de la tarjeta, así
que la cara A de una tarjeta `:::` la usan dos elementos de estudio. Si ya existe el fichero de
otro elemento con el mismo texto, se copia sin coste. Con reescritura configurada, las
reescrituras pendientes se hacen antes (con su caché y `--concurrency`); una reescritura fallida
se omite y se reintenta en la siguiente ejecución.

Modo batch: un lote cada vez. El estado vive en `RECALL_AUDIO_DIR/pregenerate-state.json`
(escritura atómica; `pregenerate.lock` impide dos ejecuciones a la vez). Antes de crear un lote
se anota el envío ("submitting", con su `displayName` único, textos y ficheros destino) y justo
después el nombre del trabajo (`batches/…`). Al relanzar el mismo comando:

- primero recoge el lote anotado (si sigue en curso, espera; si se agota `--wait-minutes`, sale con
  código 3 y basta relanzarlo);
- si el envío quedó interrumpido sin nombre, busca el lote por `displayName` en la lista de lotes y
  lo adopta; si no aparece, se detiene y explica qué hacer: comprueba en la consola de Google que
  no existe y relanza con `--discard-unconfirmed`. Nunca reenvía a ciegas, porque crear un lote no
  es idempotente;
- una caída a mitad de la recogida se repara volviendo a leer el lote y escribiendo solo los
  ficheros que faltan; el gasto se cuenta una vez;
- después continúa con lo que falta. Los ficheros ya en caché se saltan siempre.

Un error de una petición dentro de un lote se anota en `failures` del fichero de estado y se
informa; ese texto se reintenta en otro lote como mucho una vez más (2 intentos) y después se
deja (borra su entrada para reintentarlo). Si Google rechaza crear un lote por cuota o tokens
encolados, se divide el tamaño a la mitad (mínimo 10) y se reintenta; si aun así no cabe, se
detiene limpiamente indicando lo que queda.

Modo interactivo: usa el camino normal (`TtsCache`), respeta los retrasos de los 429 (hasta 6
intentos y 5 min por texto) y se detiene limpiamente si se agota la cuota diaria, indicando lo que
queda. Con Gemini consume esa cuota de 100 al día: para un lote grande usa batch. El coste se
estima con la duración medida del audio (la API interactiva no devuelve uso).

El resumen final muestra generados, copiados, saltados, fallidos, segundos de audio, tokens,
coste real (base batch y base estándar), lo que queda y la ruta del fichero de estado. La clave
nunca se imprime.

Precios (USD por millón de tokens, nivel de pago; el audio son 25 tokens por segundo; la tabla
está en `src/server/audio/tts-prices.ts`):

| `gemini-3.8-flash-tts` | Entrada (texto) | Salida (audio) | ≈ 10 s de audio |
| --- | --- | --- | --- |
| Estándar hasta 2026-12-31 | 0,50 | 9,00 | 0,00225 |
| Batch hasta 2026-12-31 | 0,25 | 4,50 | 0,001125 |
| Estándar desde 2027-01-01 | 1,00 | 18,00 | 0,0045 |
| Batch desde 2027-01-01 | 0,50 | 9,00 | 0,00225 |

Las estimaciones son deliberadamente altas (1 s + 1 s por cada 10 caracteres). El tope no cubre
el coste del LLM de reescritura.

### Audio en segundo plano al cambiar notas

Tras confirmar `POST /api/v1/notes` (alta o edición), el servidor encola las dos caras de las
tarjetas de esa nota en una cola en memoria: fuera de la transacción, sin retrasar la respuesta y
sin poder hacerla fallar. Procesa una cara cada vez, sin duplicados, por el camino normal
(reescritura y caché) y solo con audio remoto configurado. Si se agota la cuota diaria descarta lo
pendiente, escribe una sola línea en el log y no acepta trabajo nuevo durante una hora; esas caras
las cubren la ruta bajo demanda y la siguiente pregeneración. La cola no es persistente y al
apagar no se espera por ella (como mucho 2 s). Renombrar una nota no encola nada: los IDs de las
tarjetas no cambian y el nombre del fichero depende solo del ID y del texto. `GET /audio` sigue
generando bajo demanda lo que falte.

### Ficheros huérfanos

`--orphans` lista los MP3 de `RECALL_AUDIO_DIR` que ninguna cara actual usaría con la
configuración actual (tarjetas borradas o editadas, otra voz, otro proveedor: con Gemini, todos
los MP3 de OpenAI aparecen como huérfanos aunque volverían a servir si regresaras a OpenAI). Las
caras cuya reescritura aún no está en caché quedan fuera de la lista. **No borra nada.** Para
borrarlos a mano, con el servidor parado o no (las escrituras son atómicas), revisa la lista y:

```sh
node --env-file=/ruta/a/backend.env dist/server/pregenerate.cjs --orphans --orphans-out=/tmp/huerfanos.txt
# revisa /tmp/huerfanos.txt; después:
tr '\n' '\0' < /tmp/huerfanos.txt | xargs -0 rm --
```

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

El esquema actual es la versión 5. **Antes de actualizar, detén el servidor y haz una copia
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
- v3 → v4, en otra transacción: solo añade la tabla `card_aliases` (qué IDs heredó el texto
  de cada tarjeta editada) y un índice de tarjetas por contenido. Los datos existentes no
  cambian y no tienen alias; si falla, la base queda en v3.
- v4 → v5, en otra transacción: reconstruye la tabla `reviews` con las mismas filas y el mismo
  `seq` (comprobado antes de confirmar), ahora con clave `AUTOINCREMENT` (un id borrado no se
  reutiliza) y dos columnas nuevas que quedan vacías en los repasos existentes: `origin` y `prior`.
  Añade `review_changes` (auditoría de correcciones) y `card_proposals`. Con unos 15 000 repasos
  tarda una fracción de segundo. Si falla, la base queda en v4.

Tras migrar desde v1 o v2 ejecuta `VACUUM` para recuperar espacio (si falla, no es grave). Es
irreversible: un servidor anterior rechazará la base migrada (`schema is newer`), y este servidor
rechaza bases de una versión posterior. Para volver atrás, restaura la copia. Volver de v5 a un
servidor v4 **no** es posible sin esa copia: se perderían los repasos, correcciones y propuestas
registrados después de actualizar (rehacer una base v4 a mano no está soportado).

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
Las pruebas del backend usan bases temporales; no importan ni modifican tu vault real.
