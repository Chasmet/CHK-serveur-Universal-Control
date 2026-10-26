const now = Date.now;
const clean = (v, n) => String(v ?? '').trim().slice(0, n);
export const BROWSER_NAME = 'CHK Agent Browser Android · Local 3';
const key = connector => connector || 'owner';
export function permitted(state, app, action, connector) {
  if (app?.name !== BROWSER_NAME || app.autonomy?.enabled !== true) return false;
  if (!app.capabilities.some(c => c.name === action)) return false;
  if (connector) {
    const connection = state.connectors[connector] || state.clients[connector];
    const client = state.clients[connection?.client_id || connector];
    if (!connection || connection.enabled === false || !client || client.enabled === false) return false;
    if ([connection.app_ids, client.app_ids].some(ids => ids != null && !ids.includes(app.id))) return false;
  }
  const grant = state.permissions?.[key(connector)]?.[app.id];
  return !grant || grant.enabled !== false && (grant.actions === null || grant.actions.includes(action));
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
