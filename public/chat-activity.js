// One presentation for confirmed task state in Chats and Workspace. Idle alone never means Completed.
(() => {
  const states = {
    working: ['Working', 'run'], 'awaiting-approval': ['Awaiting approval', 'wait'],
    'awaiting-input': ['Awaiting input', 'wait'], completed: ['Completed', 'idle'],
    interrupted: ['Interrupted', 'err'], ready: ['Ready', 'idle'],
  };
  globalThis.PocketChatActivity = {
    describe(chat) {
      const fallback = { running: 'working', 'waiting-permission': 'awaiting-approval', 'waiting-answer': 'awaiting-input', error: 'interrupted' };
      const key = Object.hasOwn(states, chat.activity) ? chat.activity : fallback[chat.status] || 'ready';
      return { key, label: states[key][0], style: states[key][1] };
    },
  };
})();
