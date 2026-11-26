// Use the existing Room transport, with an end-to-end device signature on the final destination.
export function peerHeaders(room, route, method, pathname, channelKey = '') {
  return { 'x-pocket-dev': '1', 'x-room-id': route.roomId, 'x-room-sender': route.sender,
    'x-room-from': room.deviceId(), 'x-room-secret': route.secret, ...room.signRequest(route.deviceId, method, pathname, channelKey) };
}
export async function peerJson(room, deviceId, pathname, { method = 'GET', body, timeout = 5000 } = {}) {
  const route = room.route(deviceId);
  let last;
  for (const address of route.addresses) {
    try {
      const response = await fetch(`${address}${route.relayTo ? `/m/${route.relayTo}` : ''}${pathname}`, {
        method, signal: AbortSignal.timeout(timeout), headers: { ...peerHeaders(room, route, method, pathname), ...(body && { 'content-type': 'application/json' }) },
        ...(body && { body: JSON.stringify(body) }),
      });
      const result = await response.json();
      if (!response.ok) throw Object.assign(new Error(result.error || 'The computer refused the request.'), { status: response.status });
      return result;
    } catch (err) { last = err; if (err.status) throw err; }
  }
  throw last || new Error('The computer is offline.');
}
