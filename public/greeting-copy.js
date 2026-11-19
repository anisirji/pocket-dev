// Every word of the setup greeting, in one file, so it is easy to rewrite or translate. The terminal (greeting.js) and
// the phone's first-login welcome (welcome.js) both read it. {name} and {computer} are filled in on this computer only.
export const COPY = {
  intro: [
    'Two minutes now saves you the usual problems later.',
    'Setup asks before every change and shows each command first. It never runs administrator commands itself and uses official packages only.',
    'It never reads, stores or sends your Claude, Codex or GitHub logins. Pocket Dev itself sends nothing about you anywhere. Its one online look-up is the newest version number on npm, which you can turn off.',
    'You can stop at any step with Ctrl+C and run pocket-dev setup again.',
  ],

  hello: { named: "Hi {name}, it's Ani.", sameName: "Hi {name}, it's Ani too.", plain: "Hi, it's Ani." },
  partOfDay: {
    morning: 'Good morning.',
    afternoon: 'Good afternoon.',
    evening: 'Good evening.',
    night: 'Still up? Fix it from bed.',
  },
  computer: { darwin: 'Mac', win32: 'Windows PC', linux: 'Linux box', other: 'computer' },
  pc: {
    laptop: 'I can see you are on a {computer} laptop.',
    desktop: 'I can see you are on a {computer} desktop.',
    other: 'I can see you are on a {computer}.',
  },
  congrats: 'Congratulations, you did it. Your {computer} is now in your pocket.',
  facts: {
    alwaysOn: 'Keep awake is on, so it stays reachable.',
    desktop: 'You can leave it under the desk and reach it from anywhere.',
    claude: 'Claude Code is ready to chat from your phone.',
    codex: 'Codex is ready to chat from your phone.',
    both: 'Claude Code and Codex are ready to chat from your phone.',
  },
  body: [
    'Thank you for trying Pocket Dev. I hope it helps you fit work around your life.',
    'This setup only did what you said yes to. The only thing Pocket Dev looks up online is whether a newer version exists, once a day, and you can turn that off.',
    'Next time a build is running while you are out, or the coffee line is long, check it from your phone. Go be where your life is. Your code will wait for you.',
    'Happy coding, and have a good one.',
  ],
  signature: 'Ani',

  creator: [
    'I built Pocket Dev because I wanted us to spend less time tied to a desk and more time living, without losing touch with our work.',
    'If it makes your day a little freer, share it with three people you’d love to see escape the PC cage too. If they find it useful, invite them to share it with three more.',
    'No pressure. Just something useful, passed from one person to another.',
  ],
  links: [
    { label: 'Let your AI help you set it up', url: 'https://www.theani.me/work/pocket-dev/prompts' },
    { label: 'Me and my other work', url: 'https://theani.me' },
    { label: 'Code, docs and help', url: 'https://github.com/anisirji/pocket-dev' },
    { label: 'Pocket Dev on YouTube', url: 'https://www.youtube.com/@afk_pocket_dev' },
    { label: 'Pocket Dev on Instagram', url: 'https://www.instagram.com/afk_pocket_dev' },
  ],

  madeHere: 'This message was made on your computer. Nothing was sent.',
  plainHint: 'For a greeting without your name or system: pocket-dev config set greeting plain',

  // The phone shows these one slide at a time, each replacing the last. A short slide stays briefly and a long one longer,
  // and Next always moves on at once. The last slide (the links) waits for Start. Emoji live here, not in the terminal copy.
  phone: {
    title: 'Welcome to Pocket Dev',
    next: 'Next',
    close: 'Start',
    slides: [
      "Hi, it's Ani 👋",
      'Congratulations, you did it! 🎉 Your computer is now in your pocket.',
      'Thank you for trying Pocket Dev 🙏 I hope it helps you fit work around your life.',
      'This setup only did what you said yes to. The only thing Pocket Dev looks up online is whether a newer version exists, once a day, and you can turn that off. 🔒',
      'Next time a build is running while you are out, or the coffee line is long, check it from your phone ☕ Go be where your life is. Your code will wait for you.',
      'Happy coding, and have a good one! 🚀 — Ani',
      'Pocket Dev is free and open source. I am anisirji (Ani), a developer who wanted to stay connected to his work without being tied to a desk. 💛',
    ],
  },
};
