const now = Date.now;
const clean = (v, n) => String(v ?? '').trim().slice(0, n);
export const BROWSER_NAME = 'CHK Agent Browser Android · Local 3';
const key = connector => connector || 'owner';
export const LESFAITS_NAME = 'LES FAITS — SYNC 30';
const REPORT_ACTIONS = new Set(['lesfaits_create','lesfaits_attach','lesfaits_detach','lesfaits_modifier','lesfaits_merge','lesfaits_archive','lesfaits_restore']);
const reportApp = app => app?.name === LESFAITS_NAME;
const allowedReportActions = app => app.capabilities.filter(c => c.readOnly === false && REPORT_ACTIONS.has(c.name)).map(c => c.name);

// General automation is limited to ordinary declared capabilities. Never grant
// system commands, financial transactions, credentials or destructive operations.
const sensitive = /(?:^|_)(?:delete|destroy|erase|purge|wipe|trash|remove|reset|exec|shell|terminal|command|script|install|uninstall|update_server|password|secret|token|credential|permission|grant|revoke|publish|send|transfer|withdraw|trade|order|buy|sell|payment|pay|sign|admin|shutdown|restart)(?:_|$)/i;
export function ordinaryAction(app, action) {
  if (!app || app.system || app.name === BROWSER_NAME || /crypto|binance|bybit|banque|bank|godot|finance|payment/i.test(app.name)) return false;
  const capability=app.capabilities.find(c=>c.name===action);
  if (!capability || capability.readOnly || sensitive.test(action)) return false;
  if (reportApp(app)) return REPORT_ACTIONS.has(action);
  return capability.automationSafe === true;
}
export function permitted(state, app, action, connector) {
  if (!app?.capabilities.some(c => c.name === action)) return false;
  if (connector) {
    const connection = state.connectors[connector] || state.clients[connector];
    const client = state.clients[connection?.client_id || connector];
    if (!connection || connection.enabled === false || !client || client.enabled === false) return false;
    if ([connection.app_ids, client.app_ids].some(ids => ids != null && !ids.includes(app.id))) return false;
  }
  const grant = state.permissions?.[key(connector)]?.[app.id];
  if (app.name === BROWSER_NAME) {
    if (app.autonomy?.enabled !== true) return false;
    return !grant || grant.enabled !== false && (grant.actions === null || grant.actions.includes(action));
  }
  if (!connector || !ordinaryAction(app,action) || grant?.enabled === false) return false;
  if (reportApp(app) && grant?.enabled === true && grant.source === 'owner_dashboard' && grant.actions?.includes(action)) return true;
  return state.connectors[connector]?.automatic_operations === true;

}
function reconcile(state, app, resume = {}) {
  for (const job of Object.values(state.jobs)) {
    if (job.app_id !== app.id || !['pending_approval', 'queued'].includes(job.state)) continue;
    if (permitted(state, app, job.action, job.connector_id)) {
      if (job.state === 'pending_approval' && resume.enabled && (job.connector_id || null) === (resume.connector || null)) {
        job.state = 'queued'; job.authorization = 'persistent'; job.updated_at = now();
      }
    } else if (job.state === 'queued' && job.authorization === 'persistent') {
      job.state = 'pending_approval'; job.updated_at = now();
    }
  }
}
export function permissionView(store, connector, allowed = null) {
  return { permissions: Object.values(store.state.apps).filter(app => app.name === BROWSER_NAME && (allowed === null || allowed.includes(app.id)))
    .map(app => ({ app_id: app.id, name: app.name, device_authorized: app.autonomy?.enabled === true,
      device_reported_at: app.autonomy?.updated_at || null, connector_id: connector || null,
      grant: store.state.permissions?.[key(connector)]?.[app.id] || null,
      automatic_actions: app.capabilities.filter(c => permitted(store.state, app, c.name, connector)).map(c => c.name),
      request_quota: null })), request_quota: null };
}
export async function deviceConsent(store, id, input) {
  const app = store.state.apps[id];
  if (app?.name !== BROWSER_NAME || typeof input.enabled !== 'boolean') throw Error('invalid_browser_consent');
  await store.change(s => {
    const app = s.apps[id];
    if (app.autonomy?.enabled !== input.enabled) {
      app.autonomy = { enabled: input.enabled, updated_at: now(), source: 'authenticated_android_settings', version: clean(input.version, 40) };
      (s.permission_events ||= []).push({ app_id: id, event: input.enabled ? 'device_granted' : 'device_revoked', at: now() });
    }
    reconcile(s, app);
  });
  return { ok: true, app_id: id, enabled: input.enabled, request_quota: null };
}
export async function connectorPermission(store, connector, id, input) {
  const app = store.state.apps[id];
  if (app?.name !== BROWSER_NAME || typeof input.enabled !== 'boolean') throw Error('invalid_browser_permission');
  if (input.enabled && !app.autonomy?.enabled) throw Error('device_authorization_required');
  const actions = input.actions ?? null;
  if (actions !== null && (!Array.isArray(actions) || actions.some(a => typeof a !== 'string' || !app.capabilities.some(c => c.name === a))))
    throw Error('invalid_permission_actions');
  let grant;
  await store.change(s => {
    ((s.permissions ||= {})[key(connector)] ||= {})[id] = grant = {
      enabled: input.enabled, actions: actions === null ? null : [...new Set(actions)], updated_at: now()
    };
    (s.permission_events ||= []).push({ app_id: id, connector_id: connector || null,
      event: input.enabled ? 'connector_granted' : 'connector_revoked', at: now() });
    reconcile(s, s.apps[id], {enabled:input.enabled && input.resume_pending === true, connector});
  });
  return { app_id: id, connector_id: connector || null, ...grant, request_quota: null };
}

/** Owner dashboard only: explicit, app- and connector-specific consent. */
export async function ownerReportPermission(store, id, connector, input) {
  const app = store.state.apps[id];
  const connection = store.state.connectors[connector];
  const client = store.state.clients[connection?.client_id];
  if (!reportApp(app) || !connection || typeof input.enabled !== 'boolean') throw Error('invalid_report_permission');
  if (input.enabled && (connection.enabled === false || !client || client.enabled === false ||
    [connection.app_ids, client.app_ids].some(ids => ids != null && !ids.includes(id)))) throw Error('invalid_report_connector_scope');
  const actions = allowedReportActions(app);
  if (!actions.length) throw Error('invalid_report_capabilities');
  let grant;
  await store.change(s => {
    ((s.permissions ||= {})[key(connector)] ||= {})[id] = grant = {
      enabled: input.enabled, actions, updated_at: now(), source: 'owner_dashboard'
    };
    (s.permission_events ||= []).push({app_id:id,connector_id:connector,event:input.enabled?'report_granted':'report_revoked',at:now()});
    reconcile(s,s.apps[id],{enabled:input.enabled && input.resume_pending === true,connector});
  });
  return {app_id:id,connector_id:connector,...grant};
}
export function ownerReportPermissionView(store) {
  const apps = Object.values(store.state.apps).filter(reportApp).filter(a=>allowedReportActions(a).length);
  const connectors = Object.entries(store.state.connectors).map(([id,c])=>({id,name:c.label||c.client_name||'ChatGPT',enabled:c.enabled!==false,client_id:c.client_id,app_ids:c.app_ids??null}));
  return {apps:apps.map(a=>({id:a.id,name:a.name,registered_at:a.registered_at,last_seen:a.last_seen,actions:allowedReportActions(a),connectors:connectors.filter(c=>{
    const client=store.state.clients[c.client_id];
    return c.enabled && client && client.enabled!==false && [c.app_ids,client.app_ids].every(ids=>ids==null||ids.includes(a.id)) || store.state.permissions?.[key(c.id)]?.[a.id]?.source==='owner_dashboard';
  }).map(c=>({id:c.id,name:c.name,grant:store.state.permissions?.[key(c.id)]?.[a.id]||null}))}))};
}

/** Existing OAuth connections can opt into the same mode once in the owner dashboard. */
export async function ownerAutomaticOperations(store, connector, input) {
  const c=store.state.connectors[connector];
  if (!c || typeof input.enabled !== 'boolean') throw Error('invalid_automatic_operations');
  if (input.enabled && (c.enabled===false || store.state.clients[c.client_id]?.enabled===false || !store.state.clients[c.client_id])) throw Error('invalid_connector_scope');
  await store.change(s=>{
    s.connectors[connector].automatic_operations=input.enabled;
    (s.permission_events ||= []).push({connector_id:connector,event:input.enabled?'automatic_enabled':'automatic_disabled',at:now()});
    for(const app of Object.values(s.apps)) {
      if(app.name===BROWSER_NAME)continue;
      reconcile(s,app,{enabled:input.enabled&&input.resume_pending===true,connector});
    }
  });
  return {connector_id:connector,automatic_operations:input.enabled};
}
