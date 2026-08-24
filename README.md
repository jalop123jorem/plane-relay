# plane-relay

Servicio chico (Node puro, sin dependencias) que recibe los webhooks de work items de
Plane (self-hosted, `tareas.orem.com.mx`) y los retransmite por Server-Sent Events a
las pestañas del navegador que tengan el tablero abierto, para que dejen de necesitar
un refresh manual.

No modifica el código ni el docker-compose de Plane — vive como servicio independiente,
así nunca lo pisa un update del template de Plane.

## Endpoints

- `GET /health` — 200 si está vivo.
- `POST /notify` — Plane llama aquí en cada evento de work item. Verifica
  `X-Plane-Signature` (HMAC-SHA256 sobre el body crudo) contra `PLANE_WEBHOOK_SECRET`.
  Ojo: esta instancia (Plane CE v1.4.1) manda `"event": "issue"` a secas — NO
  `"workitem.updated"` como documenta developers.plane.so/dev-tools/intro-webhooks.
  Confirmado con logging real el 2026-08-24. El server acepta ambos formatos.
- `GET /events` — SSE. El userscript de Tampermonkey (`tampermonkey/plane-live-refresh.user.js`)
  se conecta aquí.

## Variables de entorno

| Variable | Requerida | Descripción |
|---|---|---|
| `PLANE_WEBHOOK_SECRET` | sí | El secreto que Plane muestra una sola vez al crear el webhook. |
| `ALLOWED_PROJECT_ID` | no | Si se define, ignora eventos de otros proyectos (`0ade1f44-352a-42c1-a37e-617deac28515` para OREMI). |
| `ALLOWED_ORIGIN` | no | Origen permitido en el CORS de `/events`. Default `https://tareas.orem.com.mx`. |
| `PORT` | no | Default `4000`. |

## Deploy en Easypanel

1. En el proyecto donde vive `plane`, clic en **+ Service** → tipo **App** → fuente **Git**.
2. Repository URL: este repo. Branch: `main`. Build path: `/`. Dockerfile: `Dockerfile`.
3. Dominio: `plane-relay.orem.com.mx` (el wildcard de Cloudflare ya cubre cualquier
   subdominio nuevo de `orem.com.mx` — no hace falta tocar DNS).
4. Variables de entorno: las de la tabla arriba.
5. Deploy.

## Configurar el webhook en Plane

Workspace Settings → Developer → Webhooks → Agregar webhook:

- URL: `https://plane-relay.orem.com.mx/notify`
- Eventos: Work items (created/updated/archived/deleted) — el server ya filtra a
  `workitem.*` y opcionalmente a `ALLOWED_PROJECT_ID`, así que no hace falta afinar el
  filtro del lado de Plane si no lo soporta bien.
- El secreto se muestra una sola vez: copiarlo a `PLANE_WEBHOOK_SECRET` del servicio y
  guardarlo en Bitwarden (dev-harness, `tools/bws-seed.mjs seed`) con nota de uso.

## Instalar el userscript

Con Tampermonkey (u otra extensión de userscripts) instalada en Chrome: abrir
`tampermonkey/plane-live-refresh.user.js` → "Instalar". Muestra un banner (no recarga
solo) cuando detecta un cambio en el proyecto/ tablero abierto.
