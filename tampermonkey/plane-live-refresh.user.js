// ==UserScript==
// @name         Plane live refresh (Oremi)
// @namespace    orem.com.mx
// @version      1.0.0
// @description  Avisa cuando hay cambios en el work item / tablero abierto de Plane, via el relay de webhooks.
// @match        https://tareas.orem.com.mx/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
(function () {
  'use strict';

  const RELAY_EVENTS_URL = 'https://plane-relay.orem.com.mx/events';
  const OREMI_PROJECT_ID = '0ade1f44-352a-42c1-a37e-617deac28515';

  function currentProjectId() {
    const m = location.pathname.match(/projects\/([0-9a-f-]{36})/i);
    return m ? m[1] : null;
  }

  function showBanner() {
    if (document.getElementById('plane-relay-banner')) return;
    const bar = document.createElement('div');
    bar.id = 'plane-relay-banner';
    bar.textContent = 'Hay cambios nuevos en Plane — clic para actualizar';
    bar.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:99999',
      'background:#3b82f6', 'color:#fff', 'text-align:center',
      'padding:8px', 'font:14px sans-serif', 'cursor:pointer',
    ].join(';');
    bar.onclick = () => location.reload();
    document.body.appendChild(bar);
  }

  function connect() {
    const es = new EventSource(RELAY_EVENTS_URL);
    es.onmessage = (e) => {
      let payload;
      try {
        payload = JSON.parse(e.data);
      } catch {
        return;
      }
      const cur = currentProjectId();
      const relevant = !cur || payload.project_id === cur || payload.project_id === OREMI_PROJECT_ID;
      if (relevant) showBanner();
    };
    es.onerror = () => {
      es.close();
      setTimeout(connect, 5000);
    };
  }

  connect();
})();
