import { COPY } from './public/greeting-copy.js';

// The greeting at the end of the guided setup (plan C12). Pure functions of facts read on this computer; nothing here
// reads files, runs programs or touches the network. The words live in public/greeting-copy.js.

// Account and machine names that are not a person's first name. An uncertain name means the plain greeting.
const NOT_NAMES = new Set(['user', 'users', 'admin', 'administrator', 'root', 'pc', 'desktop', 'laptop', 'owner', 'guest', 'default', 'test',
  'dev', 'developer', 'home', 'me', 'ubuntu', 'pi', 'runner', 'vagrant', 'docker', 'build', 'ci', 'mac', 'windows', 'linux', 'student', 'office', 'work', 'local', 'server']);

export function firstName(username) {
  const first = String(username ?? '').split(/[._\-\s]+|(?<=[a-z])(?=[A-Z])/)[0];
  if (!/^[A-Za-z]{2,12}$/.test(first) || !/[aeiouy]/i.test(first) || NOT_NAMES.has(first.toLowerCase())) return null;
  return first[0].toUpperCase() + first.slice(1).toLowerCase();
}

export function partOfDay(hour) {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'night';
}

// facts: { name, hour, platform, laptop, awake, claude, codex }. `plain` leaves out the name, the system, the time and
// what setup changed. Returns two lists of paragraphs, one per box, in the order a person would say them: hello, what
// they see on this computer, congratulations, what is ready, then the thanks.
export function greetingText(facts, { plain = false } = {}) {
  const computer = plain ? COPY.computer.other : COPY.computer[facts.platform] ?? COPY.computer.other;
  const fill = (text) => text.replace('{name}', facts.name).replace('{computer}', computer);
  const hello = plain || !facts.name ? COPY.hello.plain : facts.name === 'Ani' ? COPY.hello.sameName : COPY.hello.named;
  const pc = facts.laptop === true ? COPY.pc.laptop : facts.laptop === false ? COPY.pc.desktop : COPY.pc.other;
  const chat = facts.claude && facts.codex ? COPY.facts.both : facts.claude ? COPY.facts.claude : facts.codex ? COPY.facts.codex : null;
  const ready = plain ? [] : [facts.awake === 'always' && COPY.facts.alwaysOn, facts.awake === 'always' && !facts.laptop && COPY.facts.desktop, chat];
  return {
    greeting: [
      [fill(hello), plain ? null : COPY.partOfDay[partOfDay(facts.hour)]].filter(Boolean).join(' '),
      ...(plain ? [] : [fill(pc)]),
      fill(COPY.congrats),
      ...ready.filter(Boolean),
      ...COPY.body.slice(0, -1),
      `${COPY.body.at(-1)}\n${COPY.signature}`,
    ],
    creator: [...COPY.creator, COPY.links.map((l) => `${l.label}: ${l.url}`).join('\n')],
  };
}

function wrap(line, width) {
  const out = [];
  let current = '';
  for (const word of line.split(' ')) {
    if (current && current.length + 1 + word.length > width) { out.push(current); current = word; } else current = current ? `${current} ${word}` : word;
  }
  return [...out, current];
}

// A bordered box in three parts so the terminal can print it a paragraph at a time: the top edge, one list of rows per
// paragraph (a blank row apart from the one before), and the bottom edge. With colour: rounded corners in the warm
// accent. Without: plain ASCII, for terminals that show neither colour nor box characters.
export function boxParts(paragraphs, { color = false, width = 64 } = {}) {
  const groups = paragraphs.map((p, i) => [...(i ? [''] : []), ...p.split('\n').flatMap((l) => wrap(l, width))]);
  const w = Math.max(...groups.flat().map((l) => l.length));
  const [tl, tr, bl, br, h, v] = color ? ['╭', '╮', '╰', '╯', '─', '│'] : ['+', '+', '+', '+', '-', '|'];
  const edge = (t) => (color ? `\x1b[38;5;208m${t}\x1b[0m` : t);
  return {
    top: edge(tl + h.repeat(w + 2) + tr),
    beats: groups.map((rows) => rows.map((l) => `${edge(v)} ${l.padEnd(w)} ${edge(v)}`)),
    bottom: edge(bl + h.repeat(w + 2) + br),
  };
}

export function box(paragraphs, opts) {
  const { top, beats, bottom } = boxParts(paragraphs, opts);
  return [top, ...beats.flat(), bottom].join('\n');
}
