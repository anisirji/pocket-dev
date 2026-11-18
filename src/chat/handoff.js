// Carries a conversation to another engine. The history Pocket Dev keeps (chat.events) does not depend on an engine, so
// switching starts a fresh session on the new engine and sends it this transcript once, ahead of the next message.

// Sizes are in characters; 4 characters are about one token.
// Up to HANDOFF_COMPACT_AT (about 30,000 tokens) the new engine gets the conversation word for word.
// Above it, the last HANDOFF_RECENT_CHARS stay word for word and every older turn becomes a short digest line.
// HANDOFF_MAX_CHARS (about 50,000 tokens) is the hard cap on the whole transcript; if it is still over, the oldest
// digest lines go first, then the oldest word-for-word items.
export const HANDOFF_COMPACT_AT = 120_000;
export const HANDOFF_RECENT_CHARS = 60_000;
export const HANDOFF_MAX_CHARS = 200_000;
const ITEM_MAX = 8_000;
const EDIT_DIFF_MAX = 1_500;
const DIGEST_ASK_MAX = 400;
const DIGEST_ANSWER_MAX = 600;
const DIGEST_LIST_MAX = 10;
const DIGEST_COMMAND_MAX = 80;
const DIGEST_KEEP = 500;
const COMMAND_TOOL = /bash|shell|command|exec/i;

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

// The conversation split into turns: each starts at a message the person sent and runs to the next one.
function turnsOf(events, upToSeq) {
  const turns = [];
  for (const ev of events) {
    if (ev.seq > upToSeq) break;
    const sent = ev.type === 'user-text' && !ev.queued && !ev.notSent;
    if (sent || !turns.length) turns.push({ first: ev.seq, last: ev.seq, events: [] });
    const turn = turns[turns.length - 1];
    turn.events.push(ev);
    turn.last = ev.seq;
  }
  return turns;
}

const oneLine = (s, n) => clip(String(s ?? '').replace(/\s+/g, ' ').trim(), n);
const uniq = (list) => [...new Set(list)];

// One short line for a turn: what was asked, the start of the answer, the files changed and the commands run.
function digestLine(turn, labelOf) {
  const ask = turn.events.find((ev) => ev.type === 'user-text');
  const answer = turn.events.find((ev) => ev.type === 'assistant-text' && ev.text);
  const files = uniq(turn.events.filter((ev) => ev.type === 'file-edit' && ev.path).map((ev) => ev.path));
  const runs = turn.events.filter((ev) => ev.type === 'tool-run');
  const commands = uniq(runs.filter((ev) => COMMAND_TOOL.test(ev.name ?? '') && ev.summary).map((ev) => oneLine(ev.summary, DIGEST_COMMAND_MAX)));
  const list = (items) => `${items.slice(0, DIGEST_LIST_MAX).join(', ')}${items.length > DIGEST_LIST_MAX ? ` and ${items.length - DIGEST_LIST_MAX} more` : ''}`;
  const parts = [];
  if (ask) parts.push(`Asked: ${oneLine(ask.text, DIGEST_ASK_MAX)}`);
  if (answer) parts.push(`Answered (${labelOf(answer.tool)}): ${oneLine(answer.text, DIGEST_ANSWER_MAX)}`);
  if (files.length) parts.push(`Changed: ${list(files)}`);
  if (commands.length) parts.push(`Ran: ${list(commands)}`);
  return parts.join(' | ') || null;
}

// What to send the new engine. Short conversations go word for word, exactly as buildTranscript gives them. Long ones
// keep the newest turns word for word and turn the rest into digest lines, extending `digest` (the earlier result,
// kept on the chat) instead of redoing it. No model is called, so it works while the old engine is rate limited.
// Returns { text, dropped, digestedTurns, digest }: `digest` is { upToSeq, entries: [{ seq, line }], omitted } or null.
export function buildHandoff(events, upToSeq, labelOf = (t) => t ?? 'assistant', digest = null, limits = {}) {
  const { compactAt = HANDOFF_COMPACT_AT, recentChars = HANDOFF_RECENT_CHARS, maxChars = HANDOFF_MAX_CHARS } = limits;
  const lineCount = (ev) => lineOf(ev, labelOf)?.length ?? 0;
  const total = events.reduce((n, ev) => (ev.seq <= upToSeq ? n + lineCount(ev) + 2 : n), 0);
  if (total <= compactAt) return { ...buildTranscript(events, upToSeq, labelOf, maxChars), digestedTurns: 0, digest };

  // Newest turns first, until the word-for-word budget is used. The newest turn always stays.
  const turns = turnsOf(events, upToSeq);
  let size = 0;
  let recentFrom = turns.length;
  while (recentFrom > 0) {
    const cost = turns[recentFrom - 1].events.reduce((n, ev) => n + lineCount(ev) + 2, 0);
    if (size + cost > recentChars && recentFrom < turns.length) break;
    size += cost;
    recentFrom--;
  }
  const older = turns.slice(0, recentFrom);
  const recentSeq = recentFrom < turns.length ? turns[recentFrom].first : upToSeq + 1;

  const known = digest && digest.upToSeq !== undefined ? digest : { upToSeq: 0, entries: [], omitted: 0 };
  const entries = known.entries.filter((e) => e.seq < recentSeq);
  for (const turn of older) {
    if (turn.last <= known.upToSeq) continue;
    const line = digestLine(turn, labelOf);
    if (line) entries.push({ seq: turn.last, line });
  }
  // The kept digest stays small: past DIGEST_KEEP lines the oldest are counted, not stored.
  let counted = known.omitted ?? 0;
  if (entries.length > DIGEST_KEEP) counted += entries.splice(0, entries.length - DIGEST_KEEP).length;
  const next = { upToSeq: older.length ? older[older.length - 1].last : known.upToSeq, entries, omitted: counted };

  // The hard cap: the oldest digest lines go first, then the oldest word-for-word items.
  const recent = buildTranscript(events.filter((ev) => ev.seq >= recentSeq), upToSeq, labelOf, Math.max(maxChars - 2_000, 1_000));
  let digestSize = 0;
  const shown = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    if (digestSize + entries[i].line.length + 2 > maxChars - recent.text.length - 500) break;
    shown.unshift(entries[i]);
    digestSize += entries[i].line.length + 2;
  }
  const omitted = counted + entries.length - shown.length;
  const head = shown.length
    ? [`Digest of the ${shown.length + omitted} earliest turns (background only, shortened${omitted ? `; ${omitted} older ones are left out` : ''}):`,
      ...shown.map((e) => `- ${e.line}`), '', 'Recent conversation, word for word:'].join('\n')
    : omitted ? `${omitted} earlier turns are left out for length.\n\nRecent conversation, word for word:` : '';
  return {
    text: head ? `${head}\n\n${recent.text}` : recent.text,
    dropped: recent.dropped,
    digestedTurns: shown.length + omitted,
    digest: next,
  };
}

export function wrapFirstMessage({ transcript, dropped, digestedTurns = 0, from, to, message }) {
  const omitted = (dropped ? ` The ${dropped} oldest items are left out for length.` : '')
    + (digestedTurns ? ' The oldest turns are shortened into a digest; use it as background, and the recent turns as exact.' : '');
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
