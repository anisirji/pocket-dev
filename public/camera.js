(() => {
  const { overlays } = window.pocketDev;
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };
  let ui, open = false, session = null, generation = 0, timer, supportTimer, controller, imageUrl, latestFrame, previousFocus, browserCapture = false, cameraPrepared = false, refreshedCameras = false;
  let viewer, peer, heartbeat, videoTimeout, rtcTimeout, rtcReady = false, candidates = [], pendingImage, drawing = false;
  let media = { video: true, listen: false, talk: false }, rtcConnected = false, rtcIceServers = [], microphone, micPending = false, talking = false, talkRun = 0;
  let mediaPermissions = { camera: true, microphone: true };
  const canTalk = () => mediaPermissions.microphone && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && !!window.RTCPeerConnection && !!window.RTCRtpSender?.prototype.replaceTrack;
  const chosenMedia = () => ({ video: !browserCapture || ui.cameraOn.checked, listen: browserCapture && ui.listen.checked, talk: browserCapture && canTalk() });
  function talkStatus(message) {
    if (!ui) return;
    ui.talkHint.textContent = message || (!mediaPermissions.microphone ? 'Microphone & audio are disabled in Admin.'
      : !window.isSecureContext ? 'Your phone microphone needs a secure HTTPS connection.'
      : !canTalk() ? 'This browser does not support microphone sharing.'
      : !rtcConnected ? 'Start the camera or audio connection to speak.' : 'Hold to speak. Release to mute.');
    ui.secure.hidden = !browserCapture || !mediaPermissions.microphone || window.isSecureContext;
  }
  function releaseTalk() {
    talking = false; talkRun++;
    for (const track of microphone?.getTracks() || []) { track.enabled = false; track.stop(); }
    microphone = null;
    const sender = peer?.getTransceivers?.().find((item) => item.receiver.track.kind === 'audio')?.sender;
    sender?.replaceTrack(null).catch(() => {});
    if (ui) { ui.talk.setAttribute('aria-pressed', 'false'); ui.talk.textContent = 'Hold to speak'; }
    talkStatus();
  }
  async function pressTalk(event) {
    if (!session || !rtcConnected || !canTalk() || micPending || (event?.button != null && event.button !== 0)) return;
    event?.preventDefault(); talking = true; const request = ++talkRun, run = generation, connection = peer;
    ui.talk.setAttribute('aria-pressed', 'true'); ui.talk.textContent = 'Allow microphone…'; micPending = true;
    try {
      const acquired = await navigator.mediaDevices.getUserMedia({ video: false, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      for (const track of acquired.getAudioTracks()) track.enabled = false;
      if (!talking || request !== talkRun || run !== generation || peer !== connection || !rtcConnected || viewer?.readyState !== WebSocket.OPEN) {
        acquired.getTracks().forEach((track) => track.stop());
        if (run === generation && open && peer === connection && rtcConnected) talkStatus('Microphone allowed. Hold to speak again.');
        return;
      }
      microphone = acquired;
      for (const track of acquired.getAudioTracks()) track.onended = () => { if (microphone === acquired) { releaseTalk(); error('The microphone stopped or its permission was revoked.'); } };
      const sender = connection.getTransceivers().find((item) => item.receiver.track.kind === 'audio')?.sender;
      if (!sender) throw new Error('Push to talk is not supported by this connection.');
      await sender.replaceTrack(acquired.getAudioTracks()[0]);
      if (!talking || request !== talkRun || run !== generation) return releaseTalk();
      acquired.getAudioTracks()[0].enabled = true; ui.talk.textContent = 'Speaking · release to mute'; talkStatus('Speaking to the computer. Release to mute.');
    } catch (failure) { releaseTalk(); error(failure.name === 'NotAllowedError' ? 'Microphone access was not allowed. Change this browser’s microphone permission to use push to talk.' : failure.message); }
    finally { micPending = false; }
  }

  async function request(path, body, extra = {}) {
    const res = await fetch(`/api/camera${path}`, {
      method: body === undefined ? 'GET' : 'POST', cache: 'no-store',
      headers: { 'x-pocket-dev': '1', ...(body !== undefined && { 'content-type': 'application/json' }) },
      ...(body !== undefined && { body: JSON.stringify(body) }), ...extra,
    });
    if (res.status === 401) location.replace('/login.html');
    if (res.status === 202) throw new Error((await res.json()).message || 'Camera start proposed. After approval, tap Start camera again.');
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `HTTP ${res.status}`);
    return res;
  }
  const release = (id) => request('/stop', { id }, { keepalive: true }).catch(() => {});
  function error(message) { ui.error.textContent = message; ui.error.hidden = !message; }
  function clearImage() {
    latestFrame = null;
    ui.snapshot.disabled = true;
    ui.image.hidden = true;
    ui.image.removeAttribute('src');
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = null;
    ui.video.hidden = true; ui.video.pause(); ui.video.srcObject = null;
    rtcReady = false; pendingImage = null;
    delete ui.root.dataset.streamTransport;
  }
  function stop(message = 'Camera stopped.') {
    const focusStart = ui && [ui.stop, ui.snapshot].includes(document.activeElement);
    generation++;
    releaseTalk(); rtcConnected = false; talkStatus();
    clearTimeout(timer);
    clearInterval(heartbeat); clearTimeout(videoTimeout); clearTimeout(rtcTimeout);
    const oldViewer = viewer, oldPeer = peer;
    viewer = null; peer = null; candidates = [];
    oldPeer?.close(); oldViewer?.close();
    controller?.abort();
    controller = null;
    if (session) release(session);
    session = null;
    if (!ui) return;
    clearImage();
    ui.remoteAudio.pause(); ui.remoteAudio.srcObject = null; ui.audioPlay.hidden = true; ui.talk.disabled = true;
    const selected = chosenMedia();
    ui.select.disabled = !selected.video || !ui.select.options.length;
    ui.start.disabled = selected.video ? !ui.select.options.length : !selected.listen && !selected.talk;
    ui.preview.hidden = !selected.video;
    ui.start.textContent = browserCapture && !ui.cameraOn.checked ? 'Start audio' : 'Start camera';
    ui.stop.disabled = true;
    ui.status.textContent = message;
    if (focusStart && open && !ui.start.disabled) ui.start.focus();
  }
  function refreshCameras(run) {
    if (!browserCapture || refreshedCameras) return;
    refreshedCameras = true;
    request('').then((reply) => reply.json()).then((data) => {
      if (run !== generation) return;
      const chosen = ui.select.value;
      ui.select.replaceChildren();
      for (const camera of data.cameras) { const option = el('option', null, camera.name); option.value = camera.id; ui.select.append(option); }
      if ([...ui.select.options].some((option) => option.value === chosen)) ui.select.value = chosen;
    }).catch(() => {});
  }
  async function showImage(blob, run) {
    if (run !== generation || rtcReady) return;
    pendingImage = blob;
    if (drawing) return;
    drawing = true;
    try {
      while (pendingImage && run === generation && !rtcReady) {
        const next = pendingImage; pendingImage = null;
        const url = URL.createObjectURL(next), old = imageUrl;
        imageUrl = url; latestFrame = next;
        ui.image.src = url;
        await ui.image.decode().catch(() => {});
        if (old) URL.revokeObjectURL(old);
        if (run !== generation || rtcReady) break;
        ui.image.hidden = false; ui.snapshot.disabled = false;
        ui.status.textContent = 'Live preview · Camera is on';
        ui.root.dataset.streamTransport = 'relay';
        clearTimeout(videoTimeout);
        refreshCameras(run);
      }
    } finally { drawing = false; }
  }
  function streamMessage(message) { if (viewer?.readyState === WebSocket.OPEN) viewer.send(JSON.stringify(message)); }
  function relay(run) {
    if (run !== generation) return;
    releaseTalk(); rtcConnected = false; ui.talk.disabled = true; ui.remoteAudio.pause(); ui.remoteAudio.srcObject = null;
    if (media.listen) { ui.listen.checked = false; media.listen = false; error('Audio needs a direct WebRTC connection. The camera can continue using image previews.'); }
    if (!media.video) { stop(); error('The direct audio connection failed. Reconnect and start the audio session again.'); return; }
    clearTimeout(rtcTimeout);
    rtcReady = false;
    const previous = peer; peer = null; previous?.close();
    ui.video.hidden = true; ui.video.srcObject = null;
    streamMessage({ type: 'fallback' });
    if (latestFrame) showImage(latestFrame, run);
  }
  function readyVideo(run) {
    if (run !== generation || rtcReady || !peer || ui.video.readyState < 2) return;
    rtcReady = true;
    clearTimeout(videoTimeout); clearTimeout(rtcTimeout);
    ui.video.hidden = false; ui.image.hidden = true; ui.snapshot.disabled = false;
    ui.status.textContent = 'Live video · Camera is on';
    ui.root.dataset.streamTransport = 'rtc';
    streamMessage({ type: 'rtc-ready' });
    refreshCameras(run);
  }
  function makePeer(iceServers, run) {
    if (!window.RTCPeerConnection) return relay(run);
    try {
      const connection = new RTCPeerConnection({ iceServers });
      rtcIceServers = iceServers;
      peer = connection; candidates = [];
      connection.onicecandidate = ({ candidate }) => { if (run === generation && candidate) streamMessage({ type: 'signal', candidate: candidate.toJSON() }); };
      connection.ontrack = ({ track, streams }) => {
        if (run !== generation) return;
        if (track.kind === 'audio') {
          if (!media.listen) return;
          ui.remoteAudio.srcObject = streams[0] || new MediaStream([track]);
          ui.remoteAudio.play().catch(() => { if (run === generation && peer === connection && media.listen) ui.audioPlay.hidden = false; }); return;
        }
        if (!media.video) return;
        ui.video.srcObject = streams[0] || new MediaStream([track]);
        ui.video.onloadeddata = () => readyVideo(run);
        ui.video.play().then(() => readyVideo(run)).catch(() => relay(run));
      };
      connection.onconnectionstatechange = () => {
        if (peer === connection && connection.connectionState === 'connected') {
          rtcConnected = true; ui.talk.disabled = !media.talk;
          talkStatus();
          if (!media.video) { clearTimeout(videoTimeout); clearTimeout(rtcTimeout); ui.root.dataset.streamTransport = 'rtc'; ui.status.textContent = 'Audio connection ready · Camera off'; streamMessage({ type: 'rtc-ready' }); }
        }
        if (peer === connection && ['failed', 'disconnected', 'closed'].includes(connection.connectionState)) relay(run);
      };
    } catch { relay(run); }
  }
  async function signal(message, run) {
    const connection = peer;
    if (run !== generation || !connection) return;
    try {
      if (message.description) {
        clearTimeout(rtcTimeout); rtcTimeout = setTimeout(() => relay(run), 8000);
        await connection.setRemoteDescription(message.description);
        for (const transceiver of connection.getTransceivers?.() || []) if (transceiver.receiver.track.kind === 'audio') transceiver.direction = media.talk ? 'sendrecv' : 'recvonly';
        for (const candidate of candidates.splice(0)) await connection.addIceCandidate(candidate);
        await connection.setLocalDescription(await connection.createAnswer());
        if (run === generation && peer === connection) streamMessage({ type: 'signal', description: connection.localDescription.toJSON() });
      } else if ('candidate' in message) {
        if (connection.remoteDescription) await connection.addIceCandidate(message.candidate);
        else if (candidates.length < 100) candidates.push(message.candidate);
      }
    } catch { relay(run); }
  }
  function stream(run) {
    const url = new URL(`/ws/camera-view?id=${encodeURIComponent(session)}`, location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url.href);
    viewer = socket;
    socket.binaryType = 'blob';
    let opened = false;
    videoTimeout = setTimeout(() => {
      if (run !== generation) return;
      stop(); error('No camera video arrived. Check the computer camera connection and try again.');
    }, 25_000);
    socket.onopen = () => {
      opened = true;
      heartbeat = setInterval(() => { if (run === generation) streamMessage({ type: 'keepalive' }); }, 5000);
    };
    socket.onmessage = (event) => {
      if (run !== generation) return;
      if (typeof event.data !== 'string') {
        showImage(event.data, run).finally(() => { if (run === generation && viewer === socket) streamMessage({ type: 'frame-ack' }); });
        return;
      }
      let message; try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'hello') makePeer(message.iceServers || [], run);
      if (message.type === 'media-reset') { releaseTalk(); rtcConnected = rtcReady = false; ui.talk.disabled = true; peer?.close(); ui.remoteAudio.pause(); ui.remoteAudio.srcObject = null; makePeer(rtcIceServers, run); }
      if (message.type === 'signal') signal(message, run);
      if (message.type === 'media-warning') error(message.message);
      if (message.type === 'error') { stop(); error(message.message); }
    };
    socket.onerror = () => {
      if (run !== generation || viewer !== socket || opened) return;
      viewer = null; clearTimeout(videoTimeout); socket.close();
      frame(run);
    };
    socket.onclose = () => {
      if (run !== generation || viewer !== socket) return;
      stop(); error('Camera connection closed. Tap Start camera to reconnect.');
    };
  }
  async function frame(run) {
    if (run !== generation || !session || !open) return;
    controller = new AbortController();
    try {
      const res = await request(`/frame?id=${encodeURIComponent(session)}`, undefined, { signal: controller.signal });
      const blob = await res.blob();
      if (run !== generation) return;
      const old = imageUrl;
      latestFrame = blob;
      imageUrl = URL.createObjectURL(blob);
      ui.image.src = imageUrl;
      ui.image.hidden = false;
      ui.snapshot.disabled = false;
      if (old) URL.revokeObjectURL(old);
      ui.status.textContent = 'Live · Camera is on';
      refreshCameras(run);
      timer = setTimeout(() => frame(run), 200);
    } catch (err) {
      if (run !== generation) return;
      stop();
      error(err.message);
    }
  }
  async function snapshot() {
    if (!open || !session || (!latestFrame && !rtcReady)) return;
    let picture = latestFrame;
    if (rtcReady) {
      const canvas = document.createElement('canvas');
      canvas.width = ui.video.videoWidth; canvas.height = ui.video.videoHeight;
      canvas.getContext('2d').drawImage(ui.video, 0, 0);
      picture = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', .9));
    }
    if (!picture) return;
    // A separate URL lets the download finish while preview frames continue to change.
    const url = URL.createObjectURL(picture);
    const link = el('a');
    link.href = url;
    link.download = `pocket-dev-camera-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  async function start() {
    if (!open || document.hidden) return;
    stop(browserCapture ? (cameraPrepared ? 'Starting the computer camera remotely…' : 'Opening the computer camera. Initial browser permission is required once on the computer.') : 'Starting camera. Check the computer for a permission prompt.');
    refreshedCameras = false;
    media = chosenMedia();
    ui.preview.hidden = !media.video;
    error('');
    const run = generation;
    controller = new AbortController();
    ui.start.disabled = ui.select.disabled = true;
    ui.stop.disabled = false;
    ui.start.textContent = 'Starting…';
    ui.stop.focus();
    try {
      const data = await (await request('/start', { camera: ui.select.value, ...(browserCapture && { media }) }, { signal: controller.signal })).json();
      if (run !== generation) { release(data.id); return; }
      session = data.id;
      ui.start.textContent = media.video ? 'Camera on' : 'Audio on';
      if (browserCapture && data.streaming) stream(run); else frame(run);
    } catch (err) {
      if (run !== generation) return;
      stop(); error(err.message);
    }
  }
  function paintSupport(data) {
    ui.setup.hidden = data.available;
    ui.install.disabled = data.state === 'installing' || !data.canInstall;
    ui.install.hidden = !data.canInstall;
    ui.install.textContent = data.state === 'installing' ? 'Installing…' : data.state === 'error' ? 'Retry installation' : 'Install camera support';
    ui.setupMessage.textContent = data.message;
    ui.progress.hidden = data.state !== 'installing';
    if (data.state === 'installing' && data.totalBytes) {
      ui.progress.value = data.receivedBytes / data.totalBytes;
      ui.setupMessage.textContent += ` ${Math.round(data.receivedBytes / data.totalBytes * 100)}%`;
    } else ui.progress.removeAttribute('value');
    ui.status.textContent = data.state === 'installing' ? 'Installing camera support on the computer…' : 'Camera support is needed before starting the camera.';
  }
  async function loadSupport(run) {
    clearTimeout(supportTimer);
    try {
      const data = await (await request('/support')).json();
      if (run !== generation || !open) return;
      browserCapture = data.captureMethod === 'browser';
      mediaPermissions = { camera: true, microphone: true, ...data.permissions };
      ui.cameraOn.disabled = !mediaPermissions.camera;
      if (!mediaPermissions.camera) ui.cameraOn.checked = false;
      if (!mediaPermissions.microphone) ui.listen.checked = false;
      ui.audioControls.hidden = !browserCapture;
      ui.listen.disabled = !browserCapture || !mediaPermissions.microphone || !window.RTCPeerConnection;
      ui.talk.title = canTalk() ? 'Microphone access is requested only when you press and hold.' : 'Phone microphone access requires HTTPS or another supported secure context.';
      talkStatus();
      cameraPrepared = data.setup?.state === 'verified';
      ui.note.textContent = browserCapture
        ? (cameraPrepared ? 'Camera verified. Start and Snapshot work remotely; the computer camera tab opens automatically.' : 'One-time setup: on the computer, open Admin → This computer → Remote camera → Prepare remote camera. Afterwards, control it from this phone.')
        : 'Video only. Snapshot saves the current image to your device. Closing this view or leaving the page stops this preview.';
      if (browserCapture) ui.note.textContent += !mediaPermissions.microphone ? ' Microphone and audio are disabled in Admin.' : canTalk() ? ' Microphone permission is saved by the browser when allowed. Hold to speak uses your microphone only while pressed. Nothing is recorded.' : ' Phone microphone access needs HTTPS or another supported secure context; camera viewing and listening can still work here.';
      paintSupport(data);
      if (data.state === 'installing') { supportTimer = setTimeout(() => loadSupport(run), 1000); return; }
      if (!data.available) return;
      ui.status.textContent = 'Looking for cameras on the computer…';
      const devices = await (await request('')).json();
      if (run !== generation || !open) return;
      ui.select.replaceChildren();
      for (const camera of devices.cameras) {
        const option = el('option', null, camera.name); option.value = camera.id; ui.select.append(option);
      }
      stop(devices.cameras.length ? (browserCapture ? (cameraPrepared ? 'Ready for remote camera access.' : 'Prepare the camera once before leaving the computer.') : 'Choose a camera, then tap Start camera.') : 'No cameras found. Connect a camera and reopen this view.');
    } catch (err) {
      if (run !== generation || !open) return;
      stop('Camera unavailable.'); error(err.message);
    }
  }
  async function installSupport() {
    const run = generation;
    error('');
    ui.install.disabled = true;
    ui.install.textContent = 'Installing…';
    ui.close.focus();
    try {
      await request('/install', {});
      if (run !== generation || !open) return;
      await loadSupport(run);
    } catch (err) {
      if (run !== generation || !open) return;
      ui.install.disabled = false;
      ui.install.textContent = 'Retry installation';
      error(err.message);
    }
  }
  function build() {
    const root = el('section', 'camera-sheet');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Device camera');
    const bar = el('div', 'camera-bar');
    const close = el('button', 'camera-btn', 'Close');
    close.type = 'button';
    close.onclick = () => overlays.close('camera');
    bar.append(el('h2', null, 'Device camera'), close);
    const controls = el('div', 'camera-controls');
    const select = el('select', 'camera-select');
    select.setAttribute('aria-label', 'Camera on the computer');
    const startBtn = el('button', 'camera-btn start', 'Start camera');
    const stopBtn = el('button', 'camera-btn', 'Stop');
    const snapshotBtn = el('button', 'camera-btn', 'Snapshot');
    startBtn.type = stopBtn.type = snapshotBtn.type = 'button';
    startBtn.onclick = start;
    stopBtn.onclick = () => stop();
    snapshotBtn.onclick = snapshot;
    snapshotBtn.disabled = true;
    controls.append(select, startBtn, stopBtn, snapshotBtn);
    const audioControls = el('div', 'camera-audio-controls'); audioControls.hidden = true;
    const cameraOn = el('input'); cameraOn.type = 'checkbox'; cameraOn.checked = true;
    const listen = el('input'); listen.type = 'checkbox'; listen.checked = false;
    const cameraLabel = el('label', '', 'Camera'), listenLabel = el('label', '', 'Listen'); cameraLabel.prepend(cameraOn); listenLabel.prepend(listen);
    const talk = el('button', 'camera-btn', 'Hold to speak'); talk.type = 'button'; talk.disabled = true; talk.setAttribute('aria-pressed', 'false');
    const talkHint = el('p', 'camera-talk-hint'); talkHint.id = 'camera-talk-status'; talkHint.setAttribute('role', 'status'); talk.setAttribute('aria-describedby', talkHint.id);
    const secure = el('button', 'camera-btn', 'Use secure connection'); secure.type = 'button'; secure.hidden = true;
    secure.onclick = async () => {
      secure.disabled = true; error('');
      try { await window.pocketDevNetwork.openSecureCamera(); }
      catch (failure) { error(failure.message); secure.disabled = false; }
    };
    talk.onpointerdown = (event) => { if (!talk.disabled) { talk.setPointerCapture(event.pointerId); pressTalk(event); } }; talk.onpointercancel = releaseTalk; talk.onlostpointercapture = releaseTalk;
    talk.oncontextmenu = (event) => event.preventDefault();
    talk.onkeydown = (event) => { if ([' ', 'Enter'].includes(event.key) && !event.repeat) pressTalk(event); }; talk.onkeyup = releaseTalk;
    const remoteAudio = el('audio'); remoteAudio.autoplay = true;
    const audioPlay = el('button', 'camera-btn', 'Play computer audio'); audioPlay.type = 'button'; audioPlay.hidden = true;
    audioPlay.onclick = () => remoteAudio.play().then(() => { audioPlay.hidden = true; }).catch(() => error('The browser could not play computer audio. Check its site audio permission.'));
    const changedMedia = () => { const active = Boolean(session); if (active) start(); else { startBtn.textContent = cameraOn.checked ? 'Start camera' : 'Start audio'; select.disabled = !cameraOn.checked; startBtn.disabled = !cameraOn.checked && !listen.checked && !canTalk(); } };
    cameraOn.onchange = listen.onchange = changedMedia;
    audioControls.append(cameraLabel, listenLabel, talk, secure, audioPlay, remoteAudio, talkHint);
    const setup = el('div', 'camera-setup');
    setup.hidden = true;
    const setupMessage = el('p');
    setupMessage.setAttribute('role', 'status');
    const install = el('button', 'camera-btn start', 'Install camera support');
    install.type = 'button'; install.onclick = installSupport;
    const progress = el('progress');
    progress.max = 1; progress.hidden = true;
    progress.setAttribute('aria-label', 'Camera support download');
    setup.append(setupMessage, el('p', 'camera-setup-note', 'Downloads a camera helper to this computer. No administrator access required.'), progress, install);
    const status = el('p', 'camera-status');
    status.setAttribute('role', 'status');
    const err = el('p', 'camera-error');
    err.setAttribute('role', 'alert'); err.hidden = true;
    const preview = el('div', 'camera-preview');
    const image = el('img', 'camera-image');
    image.alt = 'Live view from the computer camera'; image.hidden = true;
    const video = el('video', 'camera-video');
    video.autoplay = true; video.muted = true; video.playsInline = true; video.hidden = true;
    video.setAttribute('aria-label', 'Live video from the computer camera');
    preview.append(image, video);
    const note = el('p', 'camera-note');
    root.append(bar, setup, controls, audioControls, status, err, preview, note);
    root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); overlays.close('camera'); }
      if (event.key !== 'Tab') return;
      const buttons = [...root.querySelectorAll('button, select, input')].filter((n) => !n.disabled && n.getClientRects().length);
      const first = buttons[0], last = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    document.body.append(root);
    return { root, select, start: startBtn, stop: stopBtn, snapshot: snapshotBtn, status, error: err, preview, image, video, close, setup, setupMessage, install, progress, note, audioControls, cameraOn, listen, talk, talkHint, secure, remoteAudio, audioPlay };
  }
  window.openCameraSheet = async () => {
    if (open) return;
    previousFocus = document.activeElement;
    previousFocus?.blur();
    ui ??= build();
    ui.cameraOn.checked = true; ui.listen.checked = false;
    ui.root.hidden = false;
    open = true;
    ui.select.replaceChildren();
    ui.setup.hidden = true;
    stop('Looking for cameras on the computer…');
    error('');
    const run = generation;
    const closeSheet = () => {
      clearTimeout(supportTimer);
      open = false; stop(); ui.root.hidden = true; previousFocus?.focus();
    };
    if (!window.pocketDevSettings?.presentPanel(ui.root, 'camera', closeSheet)) {
      overlays.open('camera', closeSheet); ui.close.focus();
    }
    await loadSupport(run);
  };
  document.addEventListener('visibilitychange', () => { if (document.hidden && open && !ui.stop.disabled) stop('Preview paused. Tap Start camera to resume.'); });
  window.addEventListener('pointerup', releaseTalk); window.addEventListener('pointercancel', releaseTalk); window.addEventListener('blur', releaseTalk);
  window.addEventListener('pagehide', () => { if (open) stop(); });
})();
