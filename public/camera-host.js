(() => {
  const $ = (id) => document.getElementById(id);
  const token = location.hash.slice(1);
  const validHost = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
  let socket, stream, microphone, timer, generation = 0, busy = false, jpegFps = 5, ready = false;
  const viewers = new Map();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  function send(message) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }
  function stop(message = 'Camera stopped.') {
    generation++; clearTimeout(timer); busy = false; ready = false;
    for (const viewer of viewers.values()) { viewer.peer?.close(); viewer.peer = null; viewer.candidates = []; viewer.audio?.pause(); if (viewer.audio) viewer.audio.srcObject = null; viewer.audio?.remove(); viewer.audio = null; }
    for (const track of stream?.getTracks() || []) track.stop();
    for (const track of microphone?.getTracks() || []) track.stop();
    microphone = null;
    $('speaker').hidden = true;
    stream = null; $('preview').srcObject = null; $('preview').hidden = true; $('stop').disabled = true;
    $('state').textContent = 'Camera off'; $('message').textContent = message;
  }
  async function connectViewer(id) {
    const viewer = viewers.get(id);
    if (!ready || !viewer || viewer.peer || !window.RTCPeerConnection) return;
    const peer = new RTCPeerConnection({ iceServers: viewer.iceServers });
    viewer.peer = peer; viewer.candidates = [];
    peer.onicecandidate = ({ candidate }) => { if (candidate && viewers.get(id)?.peer === peer) send({ type: 'signal', viewer: id, candidate: candidate.toJSON() }); };
    const media = { video: true, listen: false, talk: false, ...viewer.media };
    try {
    if (peer.addTransceiver) {
      const video = peer.addTransceiver('video', { direction: 'sendonly' });
      if (media.video && stream?.getVideoTracks()[0]) await video.sender.replaceTrack(stream.getVideoTracks()[0]);
      const audio = peer.addTransceiver('audio', { direction: 'sendrecv' });
      if (media.listen && microphone?.getAudioTracks()[0]) await audio.sender.replaceTrack(microphone.getAudioTracks()[0]);
      peer.ontrack = ({ track, streams }) => {
        if (track.kind !== 'audio' || !media.talk || viewers.get(id)?.peer !== peer) return;
        const audio = document.createElement('audio'); audio.autoplay = true; audio.srcObject = streams[0] || new MediaStream([track]);
        viewer.audio?.remove(); viewer.audio = audio; document.body.append(audio);
        audio.play().catch(() => { if (!ready || viewers.get(id)?.peer !== peer) return; $('speaker').hidden = false; send({ type: 'media-warning', kind: 'playback', message: 'On the computer camera tab, tap Enable speaker playback to hear push to talk.' }); });
      };
    }
    for (const track of (peer.addTransceiver ? [] : stream?.getVideoTracks() || [])) {
      const sender = peer.addTrack(track, stream);
      try {
        const parameters = sender.getParameters();
        if (!parameters.encodings?.length) parameters.encodings = [{}];
        parameters.encodings[0].maxBitrate = 1_500_000;
        parameters.encodings[0].maxFramerate = 24;
        await sender.setParameters(parameters);
      } catch { /* older browsers negotiate their own encoding limits */ }
    }
      if (viewers.get(id)?.peer !== peer) return;
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
  async function start(camera, given) {
    stop('Allow this browser to use the computer camera when prompted.');
    const run = generation;
    const media = { video: true, listen: false, talk: false, ...given };
    $('state').textContent = 'Waiting for camera permission…';
    $('error').hidden = true; $('stop').disabled = false;
    try {
      let permission = 'unknown';
      if (media.video) try { permission = (await navigator.permissions.query({ name: 'camera' })).state; } catch { /* not every browser exposes a camera permission query */ }
      if (run !== generation) return;
      send({ type: 'permission', state: permission });
      if (media.video) {
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 1280 }, height: { ideal: 720 },
        frameRate: { ideal: 24, max: 30 }, ...(camera && camera !== 'default' && { deviceId: { exact: camera } }) } });
      if (run !== generation) { for (const track of acquired.getTracks()) track.stop(); return; }
      stream = acquired;
      stream.getVideoTracks()[0].onended = () => { if (run === generation) report(new Error('The camera stopped or permission was revoked.')); };
      $('preview').srcObject = stream;
      $('preview').hidden = false;
      await $('preview').play();
      if (run !== generation) return;
      await publishDevices();
      if (run !== generation) return;
      }
      if (media.listen) {
        try {
          const acquired = await navigator.mediaDevices.getUserMedia({ video: false, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
          if (run !== generation) { acquired.getTracks().forEach((track) => track.stop()); return; }
          microphone = acquired;
          for (const track of microphone.getAudioTracks()) track.onended = () => {
            if (run !== generation) return;
            microphone?.getTracks().forEach((item) => item.stop()); microphone = null;
            for (const viewer of viewers.values()) viewer.peer?.getSenders().filter((sender) => sender.track?.kind === 'audio').forEach((sender) => sender.replaceTrack(null).catch(() => {}));
            $('state').textContent = `${stream ? 'Camera on' : 'Camera off'} · Microphone off`;
            send({ type: 'media-warning', message: 'The computer microphone stopped or its permission was revoked. Camera viewing can continue.' });
          };
        } catch (err) { if (run !== generation) return; const message = 'Computer microphone access was not allowed or no microphone is available. Allow microphone access in this tab, then turn Listen off and on from your phone.'; $('error').textContent = message; $('error').hidden = false; send({ type: 'media-warning', message }); }
      }
      if (run !== generation) return;
      ready = true;
      send({ type: 'media-ready', media: { video: Boolean(stream), listen: Boolean(microphone) } });
      $('state').textContent = [media.video ? 'Camera on' : 'Camera off', microphone ? 'Microphone on' : 'Microphone off'].join(' · ');
      $('message').textContent = media.talk ? 'Push to talk is available to authorized viewers. Stop here ends all camera and audio access.' : 'Sharing only the enabled camera and microphone. Stop here or from your phone.';
      for (const id of viewers.keys()) connectViewer(id);
      if (media.video) frame(run);
    } catch (err) { if (run === generation) report(err); }
  }
  $('stop').onclick = () => { stop('Stopped on this computer. Tap Start camera on your phone to continue.'); send({ type: 'stopped' }); };
  $('speaker').onclick = async () => { for (const viewer of viewers.values()) if (viewer.audio) await viewer.audio.play().catch(() => {}); $('speaker').hidden = true; };
  if (!validHost || !/^[0-9a-f]{64}$/.test(token) || !window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    $('state').textContent = 'Camera unavailable';
    $('message').textContent = 'Open the camera from Pocket Dev on your phone. This helper must run in a supported browser on the computer’s localhost address.';
    return;
  }
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/camera-host?token=${token}`);
  socket.onmessage = (event) => {
    let message; try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'start') start(message.camera, message.media);
    if (message.type === 'stop') stop('Ready for the next remote request. Start camera on your phone resumes capture automatically.');
    if (message.type === 'rate') jpegFps = [1, 5, 15].includes(message.fps) ? message.fps : 5;
    if (message.type === 'viewer') {
      viewers.get(message.viewer)?.peer?.close();
      const old = viewers.get(message.viewer); old?.audio?.pause(); old?.audio?.remove();
      viewers.set(message.viewer, { iceServers: message.iceServers || [], media: message.media, peer: null, candidates: [] });
      connectViewer(message.viewer);
    }
    if (message.type === 'viewer-left') { const old = viewers.get(message.viewer); old?.peer?.close(); old?.audio?.pause(); if (old?.audio) old.audio.srcObject = null; old?.audio?.remove(); viewers.delete(message.viewer); }
    if (message.type === 'signal') signalViewer(message);
  };
  socket.onclose = () => stop('Disconnected from Pocket Dev. Tap Start camera on your phone to open a new camera tab.');
  socket.onerror = () => stop('Could not connect to Pocket Dev. Tap Start camera on your phone to try again.');
  window.addEventListener('pagehide', () => { stop(); socket.close(); });
})();
