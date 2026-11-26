(() => {
  const $ = (id) => document.getElementById(id);
  const token = location.hash.slice(1);
  const validHost = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
  let socket, stream, timer, generation = 0, busy = false, jpegFps = 5;
  const viewers = new Map();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  function send(message) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }
  function stop(message = 'Camera stopped.') {
    generation++; clearTimeout(timer); busy = false;
    for (const viewer of viewers.values()) { viewer.peer?.close(); viewer.peer = null; viewer.candidates = []; }
    for (const track of stream?.getTracks() || []) track.stop();
    stream = null; $('preview').srcObject = null; $('stop').disabled = true;
    $('state').textContent = 'Camera off'; $('message').textContent = message;
  }
  async function connectViewer(id) {
    const viewer = viewers.get(id);
    if (!stream || !viewer || viewer.peer || !window.RTCPeerConnection) return;
    const peer = new RTCPeerConnection({ iceServers: viewer.iceServers });
    viewer.peer = peer; viewer.candidates = [];
    peer.onicecandidate = ({ candidate }) => { if (candidate) send({ type: 'signal', viewer: id, candidate: candidate.toJSON() }); };
    for (const track of stream.getVideoTracks()) {
      const sender = peer.addTrack(track, stream);
      try {
        const parameters = sender.getParameters();
        if (!parameters.encodings?.length) parameters.encodings = [{}];
        parameters.encodings[0].maxBitrate = 1_500_000;
        parameters.encodings[0].maxFramerate = 24;
        await sender.setParameters(parameters);
      } catch { /* older browsers negotiate their own encoding limits */ }
    }
    try {
      await peer.setLocalDescription(await peer.createOffer());
      if (viewers.get(id)?.peer === peer) send({ type: 'signal', viewer: id, description: peer.localDescription.toJSON() });
    } catch { if (viewers.get(id)?.peer === peer) send({ type: 'signal', viewer: id, candidate: null }); }
  }
  async function signalViewer(message) {
    const viewer = viewers.get(message.viewer), peer = viewer?.peer;
    if (!peer) return;
    try {
      if (message.description) {
        await peer.setRemoteDescription(message.description);
        for (const candidate of viewer.candidates.splice(0)) await peer.addIceCandidate(candidate);
      } else if ('candidate' in message) {
        if (peer.remoteDescription) await peer.addIceCandidate(message.candidate);
        else if (viewer.candidates.length < 100) viewer.candidates.push(message.candidate);
      }
    } catch { /* the phone switches to the relay if video negotiation fails */ }
  }
  function problem(err) {
    return ({ NotAllowedError: 'Camera access was blocked. Allow it for this localhost page in your browser and in the computer’s camera privacy settings, then try again.',
      NotFoundError: 'No camera was found on this computer. Connect a camera and try again.',
      NotReadableError: 'The camera could not be opened. Close other camera apps and check the computer’s camera privacy settings.',
      OverconstrainedError: 'The selected camera is unavailable. Choose another camera on your phone.' })[err.name] || `Could not start the computer camera. ${err.message || ''}`;
  }
  function report(err) {
    const message = problem(err); stop(message);
    $('error').textContent = message; $('error').hidden = false;
    send({ type: 'error', message, code: err.name });
  }
  async function publishDevices() {
    const all = await navigator.mediaDevices.enumerateDevices();
    send({ type: 'devices', cameras: all.filter((device) => device.kind === 'videoinput')
      .map((device, index) => ({ id: device.deviceId, name: device.label || `Camera ${index + 1}` })), activeId: stream?.getVideoTracks()[0]?.getSettings().deviceId });
  }
  async function frame(run) {
    if (run !== generation || !stream || socket?.readyState !== WebSocket.OPEN) return;
    if (!busy && $('preview').readyState >= 2 && socket.bufferedAmount < 512 * 1024) {
      busy = true;
      try {
        const video = $('preview');
        canvas.width = Math.min(640, video.videoWidth);
        canvas.height = Math.max(1, Math.round(video.videoHeight * canvas.width / video.videoWidth));
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const image = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', .6));
        if (image && run === generation && socket.readyState === WebSocket.OPEN) socket.send(image);
      } catch (err) { if (run === generation) report(err); }
      finally { busy = false; }
    }
    if (run === generation) timer = setTimeout(() => frame(run), 1000 / jpegFps);
  }
  async function start(camera) {
    stop('Allow this browser to use the computer camera when prompted.');
    const run = generation;
    $('state').textContent = 'Waiting for camera permission…';
    $('error').hidden = true; $('stop').disabled = false;
    try {
      let permission = 'unknown';
      try { permission = (await navigator.permissions.query({ name: 'camera' })).state; } catch { /* not every browser exposes a camera permission query */ }
      if (run !== generation) return;
      send({ type: 'permission', state: permission });
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 1280 }, height: { ideal: 720 },
        frameRate: { ideal: 24, max: 30 }, ...(camera && camera !== 'default' && { deviceId: { exact: camera } }) } });
      if (run !== generation) { for (const track of acquired.getTracks()) track.stop(); return; }
      stream = acquired;
      stream.getVideoTracks()[0].onended = () => { if (run === generation) report(new Error('The camera stopped or permission was revoked.')); };
      $('preview').srcObject = stream;
      await $('preview').play();
      if (run !== generation) return;
      await publishDevices();
      if (run !== generation) return;
      $('state').textContent = 'Camera on';
      $('message').textContent = 'Sharing this computer’s camera with Pocket Dev. Stop here or from your phone.';
      for (const id of viewers.keys()) connectViewer(id);
      frame(run);
    } catch (err) { if (run === generation) report(err); }
  }
  $('stop').onclick = () => { stop('Stopped on this computer. Tap Start camera on your phone to continue.'); send({ type: 'stopped' }); };
  if (!validHost || !/^[0-9a-f]{64}$/.test(token) || !window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    $('state').textContent = 'Camera unavailable';
    $('message').textContent = 'Open the camera from Pocket Dev on your phone. This helper must run in a supported browser on the computer’s localhost address.';
    return;
  }
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/camera-host?token=${token}`);
  socket.onmessage = (event) => {
    let message; try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'start') start(message.camera);
    if (message.type === 'stop') stop('Ready for the next remote request. Start camera on your phone resumes capture automatically.');
    if (message.type === 'rate') jpegFps = [1, 5, 15].includes(message.fps) ? message.fps : 5;
    if (message.type === 'viewer') {
      viewers.get(message.viewer)?.peer?.close();
      viewers.set(message.viewer, { iceServers: message.iceServers || [], peer: null, candidates: [] });
      connectViewer(message.viewer);
    }
    if (message.type === 'viewer-left') { viewers.get(message.viewer)?.peer?.close(); viewers.delete(message.viewer); }
    if (message.type === 'signal') signalViewer(message);
  };
  socket.onclose = () => stop('Disconnected from Pocket Dev. Tap Start camera on your phone to open a new camera tab.');
  socket.onerror = () => stop('Could not connect to Pocket Dev. Tap Start camera on your phone to try again.');
  window.addEventListener('pagehide', () => { stop(); socket.close(); });
})();
