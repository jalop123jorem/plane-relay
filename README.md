# plane-relay

Servicio chico (Node puro, sin dependencias) que recibe los webhooks de work items de
Plane (self-hosted, `tareas.orem.com.mx`) y los retransmite por Server-Sent Events a
las pestañas del navegador que tengan el tablero abierto, para que dejen de necesitar
un refresh manual.

No modifica el código ni el docker-compose de Plane — vive como servicio independiente,
así nunca lo pisa un update del template de Plane.

**Desde 2026-08-24 esto es automático para todos los usuarios**, sin instalar nada:
`plane-relay` es ahora el reverse-proxy de `tareas.orem.com.mx` (Easypanel apunta el
dominio aquí en vez de al servicio de Plane) y reescribe el único documento HTML que
Plane sirve para inyectarle el listener de SSE antes de `</body>`. Todo lo demás
(API, assets, websockets) pasa sin tocarse. El userscript de Tampermonkey sigue en el
repo como referencia/fallback pero ya no hace falta instalarlo.

## Endpoints

- `GET /health` — 200 si está vivo.
- `POST /notify` — Plane llama aquí en cada evento de work item. Verifica
  `X-Plane-Signature` (HMAC-SHA256 sobre el body crudo) contra `PLANE_WEBHOOK_SECRET`.
  Ojo: esta instancia (Plane CE v1.4.1) manda `"event": "issue"` a secas — NO
  `"workitem.updated"` como documenta developers.plane.so/dev-tools/intro-webhooks.
  Confirmado con logging real el 2026-08-24. El server acepta ambos formatos.
- `GET /events` (y alias `/__plane-relay/events`) — SSE. El script inyectado se
  conecta al alias (mismo origen que `tareas.orem.com.mx`); el userscript viejo usa
  la ruta corta.
- `GET /__plane-relay/inject.js` — el script que se inyecta en el HTML de Plane.
- Cualquier otra ruta — reverse proxy transparente hacia `PLANE_ORIGIN` (Plane real).
  Preserva el header `Host` tal cual llega (Plane valida `ALLOWED_HOSTS` /
  `CSRF_TRUSTED_ORIGINS` contra `tareas.orem.com.mx`), soporta upgrade de websocket
  (túnel TCP crudo), y solo reescribe el body cuando `Content-Type` es `text/html`.

## Variables de entorno

| Variable | Requerida | Descripción |
|---|---|---|
| `PLANE_WEBHOOK_SECRET` | sí | El secreto que Plane muestra una sola vez al crear el webhook. |
| `PLANE_ORIGIN` | no | A dónde reenviar todo lo que no es del relay. Default `http://plane_plane-proxy-1:80` (el proxy interno de Plane, mismo host, misma red overlay de Easypanel). |
| `ALLOWED_PROJECT_ID` | no | Si se define, ignora eventos de otros proyectos. **Sin definir en producción a propósito** desde 2026-08-24: cubre los 6 proyectos del workspace (OREMI, CAYS, AAC2, BACKLOG, VOBOS, CONTA), no solo uno. |
| `ALLOWED_ORIGIN` | no | Origen permitido en el CORS de `/events` (solo relevante para el userscript viejo, cross-origin). Default `https://tareas.orem.com.mx`. |
| `PORT` | no | Default `4000`. |

## Deploy en Easypanel

1. En el proyecto donde vive `plane`, clic en **+ Service** → tipo **App** → fuente **Git**.
2. Repository URL: este repo. Branch: `master`. Build path: `/`. Dockerfile: `Dockerfile`.
3. Dominio: agregar **`tareas.orem.com.mx`** (puerto 4000) directo en la app
   `plane-relay` — NO en la app `plane`. Easypanel no deja que dos apps compartan el
   mismo dominio, así que hay que borrar el dominio de la app `plane` primero (hay un
   hueco corto sin routing entre borrar y crear, es esperado). El campo "Compose
   Service" del editor de dominios de la app `plane` solo lista los servicios de SU
   propio compose (web/api/proxy/etc) — nunca va a ofrecer `plane-relay` ahí porque es
   una app aparte, por eso el dominio se mueve al nivel de app, no se "apunta" desde
   adentro de `plane`.
4. `plane-relay.orem.com.mx` (puerto 4000) se deja tal cual, sigue sirviendo
   `/notify` para el webhook.
5. *`*.orem.com.mx` NO es wildcard hacia este host* — cada dominio nuevo necesita su
   propio registro DNS A (grey-cloud, sin proxy de Cloudflare) apuntando al host.
6. Variables de entorno: las de la tabla arriba.
7. Deploy.

⚠️ **El botón "Deploy" de Easypanel a veces no repull-ea el commit nuevo** (visto
2026-08-24: dos clics seguidos, ambos con toast "App deployed", pero el checkout local
en `/etc/easypanel/projects/plane/plane-relay/code` se quedó en el commit viejo). Si
después de un deploy el contenedor no refleja el cambio, forzar a mano por SSH:
```
cd /etc/easypanel/projects/plane/plane-relay/code && git pull
docker build -t easypanel/plane/plane-relay:latest .
docker service update --force plane_plane-relay
```

## Configurar el webhook en Plane

Workspace Settings → Developer → Webhooks → Agregar webhook:

- URL: `https://plane-relay.orem.com.mx/notify`
- Eventos: Work items (created/updated/archived/deleted) — el server ya filtra a
  `workitem.*`/`issue` y opcionalmente a `ALLOWED_PROJECT_ID`, así que no hace falta
  afinar el filtro del lado de Plane si no lo soporta bien.
- El secreto se muestra una sola vez: copiarlo a `PLANE_WEBHOOK_SECRET` del servicio y
  guardarlo en Bitwarden (dev-harness, `tools/bws-seed.mjs seed`) con nota de uso.

## El userscript de Tampermonkey (obsoleto, se deja como referencia)

Antes de la inyección automática, cada usuario tenía que instalar
`tampermonkey/plane-live-refresh.user.js` a mano. Ya no hace falta — se deja en el
repo por si algún día se quiere volver a un modelo client-side (por ejemplo, si el
reverse-proxy da problemas y se prefiere apagar la inyección sin perder la función).
