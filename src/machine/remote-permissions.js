const keys = ['screenView', 'screenControl', 'cameraView', 'microphoneView'];
export function remotePermissions(config) {
  const value = config.read();
  return { ...Object.fromEntries(keys.map((key) => [key, value[key] !== false])), screenControlApproved: value.screenControlApproved === true };
}
export function changeRemotePermissions(config, patch, { camera, screenControl, changed = () => {} } = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length || Object.entries(patch).some(([key, value]) => !keys.includes(key) || typeof value !== 'boolean')) {
    throw Object.assign(new Error('Choose a supported remote permission and an on/off value.'), { status: 400 });
  }
  const next = { ...remotePermissions(config), ...patch };
  const changes = { ...patch };
  if (patch.screenControl === true && !next.screenView) throw Object.assign(new Error('Enable screen viewing before screen control.'), { status: 400 });
  if (!next.screenView || !next.screenControl) changes.screenControlApproved = false;
  else if (patch.screenControl === true) changes.screenControlApproved = true;
  config.update(changes);
  if (!next.screenView || !next.screenControl) screenControl?.stop('Screen control was disabled in Admin.');
  camera?.reconcile();
  changed(changes);
  return remotePermissions(config);
}
