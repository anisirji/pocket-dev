// What the phone shows when someone taps an engine that is not installed (or not signed in) in the model dropdown: the
// commands to run on the computer. These are the same official packages and sign-in commands `pocket-dev setup` uses.
// An engine without an entry here gets the generic advice, so adding an engine never breaks the dropdown.
const PM_NOTE = 'If npm says permission denied, see docs/INSTALL_BEGINNERS.md (install into your own folder).';

export const ENGINE_HELP = {
  claude: { install: ['npm install -g @anthropic-ai/claude-code'], login: 'claude auth login', note: PM_NOTE },
  codex: { install: ['npm install -g @openai/codex'], login: 'codex login', note: PM_NOTE },
  antigravity: { install: [], login: 'agy acp --login', note: 'Install the Antigravity CLI (agy) from Google, then sign in with your Google account. Support is experimental.' },
  copilot: { install: ['npm install -g @github/copilot'], login: 'copilot login', note: `${PM_NOTE} Needs a GitHub Copilot plan. Support is experimental.` },
};

export const GENERIC_HELP = { install: [], login: null, note: 'Run pocket-dev setup on your computer to see what is missing.' };

export const engineHelp = (tool) => ENGINE_HELP[tool] ?? GENERIC_HELP;
