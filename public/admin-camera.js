'use strict';
// Local Admin setup verifies one camera frame, persists the result and stops the test capture.
function cameraOnState(state) {
  const camera = state.camera;
  $('camera').hidden = !camera;
  if (!camera) return;
  const testing = camera.state === 'testing';
  $('cameraPrepare').disabled = testing || !camera.enabled;
  $('cameraPrepare').disabled ||= state.remotePermissions?.cameraView === false;
  $('microphonePrepare').disabled = testing || !camera.enabled || state.remotePermissions?.microphoneView === false;
  $('microphoneDetail').textContent = camera.microphoneVerifiedAt ? `Microphone verified: ${new Date(camera.microphoneVerifiedAt).toLocaleString()}. Permission applies to this computer, not each remote connection.` : 'Prepare microphone access once. Choose persistent permission in the browser when offered.';
  $('cameraPrepare').textContent = testing ? 'Checking camera…' : camera.verifiedAt ? 'Test remote camera again' : 'Prepare remote camera';
  $('cameraState').textContent = !camera.enabled ? 'Disabled' : testing ? 'Waiting for browser permission' : camera.state === 'error' ? 'Needs attention' : camera.verifiedAt ? 'Camera verified' : 'Not prepared';
  $('cameraErr').textContent = camera.error || '';
  $('cameraDetail').textContent = testing
    ? 'Allow camera access in the browser tab that opens. Setup takes one test image, then stops the camera.'
    : camera.verifiedAt ? `Last test: ${new Date(camera.verifiedAt).toLocaleString()}. Use Start camera and Snapshot from your phone. Pocket Dev reopens the computer camera tab when needed.`
      : 'Run this check before leaving the computer. No camera helper installation is needed.';
}
$('cameraPrepare').onclick = async () => {
  $('cameraPrepare').disabled = true;
  $('cameraErr').textContent = '';
  try {
    const result = await api('POST', '/api/camera/prepare', {});
    cameraOnState({ camera: result, remotePermissions: state.remotePermissions });
  } catch (err) {
    $('cameraErr').textContent = err.message;
    $('cameraPrepare').disabled = false;
  }
};
$('microphonePrepare').onclick = async () => {
  $('microphonePrepare').disabled = true; $('cameraErr').textContent = '';
  try {
    const result = await api('POST', '/api/camera/prepare', { media: { video: false, listen: true, talk: false } });
    cameraOnState({ camera: result, remotePermissions: state.remotePermissions });
  } catch (error) { $('cameraErr').textContent = error.message; $('microphonePrepare').disabled = false; }
};
