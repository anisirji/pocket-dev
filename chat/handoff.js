// Carries a conversation to another engine. The history Pocket Dev keeps (chat.events) does not depend on an engine, so
// switching starts a fresh session on the new engine and sends it this transcript once, ahead of the next message.

// About 50,000 tokens. Above this, the oldest turns are dropped and the transcript says how many.
export const HANDOFF_MAX_CHARS = 200_000;
const ITEM_MAX = 8_000;
const EDIT_DIFF_MAX = 1_500;

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}… [shortened]` : s);

// One line or block per event worth keeping. Thinking, status lines, results, approval cards and unsent messages are
// not part of what was said, so they stay out.
function lineOf(ev, labelOf) {
  switch (ev.type) {
    case 'user-text': {
      if (ev.queued || ev.notSent) return null;
      const files = ev.attachments?.length ? `\n(attached: ${ev.attachments.join(', ')})` : '';
      return `User: ${clip(ev.text ?? '', ITEM_MAX)}${files}`;
    }
    case 'assistant-text':
      return ev.text ? `Assistant (${labelOf(ev.tool)}): ${clip(ev.text, ITEM_MAX)}` : null;
    case 'tool-run':
      return `[Tool ${ev.name ?? 'run'}${ev.summary ? `: ${clip(ev.summary, 300)}` : ''}${ev.status === 'error' ? ' (failed)' : ''}]`;
    case 'file-edit':
      return `[Edited ${ev.path || 'a file'}${ev.status === 'error' ? ' (failed)' : ''}${ev.diff ? `\n${clip(ev.diff, EDIT_DIFF_MAX)}` : ''}]`;
    default:
      return null;
  }
}

// Everything up to and including event `upToSeq`, newest kept first when the cap is hit.
export function buildTranscript(events, upToSeq, labelOf = (t) => t ?? 'assistant', maxChars = HANDOFF_MAX_CHARS) {
  const lines = events.filter((ev) => ev.seq <= upToSeq).map((ev) => lineOf(ev, labelOf)).filter(Boolean);
  const kept = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (size + lines[i].length > maxChars && kept.length) break;
    kept.unshift(lines[i]);
    size += lines[i].length + 2;
  }
  const dropped = lines.length - kept.length;
  return { text: kept.join('\n\n'), dropped };
}

export function wrapFirstMessage({ transcript, dropped, from, to, message }) {
  const omitted = dropped ? ` The ${dropped} oldest items are left out for length.` : '';
  return [
    `This conversation was started with ${from} and is now continued with ${to}. Below is what was said and done so far.${omitted} `
      + 'Carry on from it as if you had been part of it. Do not repeat or summarise it back; just answer the new message.',
    '',
    '--- Earlier in this conversation ---',
    transcript,
    '--- End of earlier conversation ---',
    '',
    message,
  ].join('\n');
}
