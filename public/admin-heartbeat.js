'use strict';
// Tells Pocket Dev this admin page is open. With "Keep connection open" off, phone access closes when the beats stop.
let timer = 0;
const beat = () => fetch('/api/heartbeat', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pocket-admin': '1' }, body: '{}' }).catch(() => {});
self.onmessage = (e) => {
  clearInterval(timer);
  beat();
  timer = setInterval(beat, e.data);
};
