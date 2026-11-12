// Every word of the setup greeting, in one file, so it is easy to rewrite or translate. The terminal (greeting.js) and
// the phone's first-login welcome (welcome.js) both read it. {name} and {computer} are filled in on this computer only.
export const COPY = {
  intro: [
    'Two minutes now saves you the usual problems later.',
    'Setup asks before every change and shows each command first. It never runs administrator commands itself and uses official packages only.',
    'It never reads, stores or sends your Claude, Codex or GitHub logins. Pocket Dev itself sends nothing about you anywhere.',
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
  allSet: 'You are all set. Your {computer} is now in your pocket.',
  facts: {
    alwaysOn: 'Keep awake is on, so it stays reachable.',
    desktop: 'You can leave it under the desk and reach it from anywhere.',
    claude: 'Claude Code is ready to chat from your phone.',
    codex: 'Codex is ready to chat from your phone.',
    both: 'Claude Code and Codex are ready to chat from your phone.',
  },
  body: [
    'Thank you for trying Pocket Dev. I built it because I was tired of my work tying me to my desk, and I wanted my own computer to be in my pocket.',
    'This setup only did what you said yes to. Nothing leaves your computer.',
    'Next time a build is running while you are out, or the coffee line is long, check it from your phone. Go be where your life is. Your code will wait for you.',
    'Happy coding, and have a good one.',
  ],
  signature: 'Ani',

  creator: [
    'Pocket Dev is free and open source. I am anisirji (Ani), a developer who wanted to stay connected to his work without being tied to a desk.',
    'This guide only helps you set things up safely on your own computer. Nothing is installed or shared without your yes.',
  ],
  links: [
    { label: 'Me and my other work', url: 'https://theani.me' },
    { label: 'Code, docs and help', url: 'https://github.com/anisirji/pocket-dev' },
  ],

  madeHere: 'This message was made on your computer. Nothing was sent.',
  plainHint: 'For a greeting without your name or system: pocket-dev config set greeting plain',

  phone: { title: 'Welcome to Pocket Dev', close: 'Start' },
};
