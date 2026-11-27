export const FEATURE_STATES = Object.freeze(['ready', 'checking', 'setup-required', 'permission-required', 'unsupported', 'offline', 'failed']);
export function featureStatus(feature, given = {}) {
  const alias = { installing: 'checking', missing: 'setup-required', 'not-installed': 'setup-required', error: 'failed' }[given.state];
  const state = FEATURE_STATES.includes(given.state) ? given.state : alias || (given.available ? 'ready' : 'failed');
  return { ...given, feature, state, available: given.available ?? state === 'ready', recoverable: given.recoverable ?? state !== 'unsupported',
    action: given.action ?? ({ 'setup-required': 'open-setup', 'permission-required': 'open-permissions', offline: 'reconnect', failed: 'retry' })[state] ?? null };
}
export function featureError(feature, error) {
  const status = Number.isInteger(error?.status) ? error.status : 503;
  const code = error?.code || (status === 401 || status === 403 ? 'PERMISSION_REQUIRED' : error?.unsupported ? 'UNSUPPORTED' : status === 409 ? 'BUSY' : 'FEATURE_FAILED');
  return { error: error?.message || 'This feature could not start. Try again after checking the computer.', code, feature, recoverable: error?.recoverable ?? code !== 'UNSUPPORTED', action: error?.action || (['PERMISSION_REQUIRED', 'SECURE_SCREEN'].includes(code) ? 'open-permissions' : code === 'SETUP_REQUIRED' ? 'open-setup' : code === 'UNSUPPORTED' ? null : 'retry') };
}
// Lazy, bounded capability metadata inside the existing server. No polling, feature startup,
// retry execution or new service. Authorization stays at each existing HTTP entry point.
export function createFeatures(definitions, { now = Date.now, ttlMs = 10000 } = {}) {
  const cache = new Map(), pending = new Map(), revisions = new Map();
  async function check(feature, { fresh = false } = {}) {
    if (!Object.hasOwn(definitions, feature)) throw Object.assign(new Error('Unknown feature.'), { status: 404 });
    const stored = cache.get(feature);
    if (!fresh && stored && now() - stored.at < ttlMs) return stored.value;
    if (pending.has(feature)) return pending.get(feature);
    const revision = revisions.get(feature) || 0;
    const request = Promise.resolve().then(definitions[feature]).then((result) => {
      const value = featureStatus(feature, result);
      if (revision === (revisions.get(feature) || 0)) cache.set(feature, { at: now(), value });
      return value;
    }).catch((error) => {
      const failure = featureError(feature, error);
      const state = ['PERMISSION_REQUIRED', 'SECURE_SCREEN'].includes(failure.code) ? 'permission-required' : failure.code === 'UNSUPPORTED' ? 'unsupported' : failure.code === 'SETUP_REQUIRED' ? 'setup-required' : 'failed';
      return featureStatus(feature, { state, message: failure.error, ...failure });
    }).finally(() => { if (pending.get(feature) === request) pending.delete(feature); });
    pending.set(feature, request); return request;
  }
  function invalidate(feature) { for (const key of feature ? [feature] : Object.keys(definitions)) { cache.delete(key); revisions.set(key, (revisions.get(key) || 0) + 1); } }
  return { check, invalidate };
}
