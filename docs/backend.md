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

El esquema actual es la versión 4. **Antes de actualizar, detén el servidor y haz una copia
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
Las pruebas del backend usan bases temporales; no importan ni modifican tu vault real.
