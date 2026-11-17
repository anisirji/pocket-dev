// Some phone keyboards put the caret back at the start of a text box after every character, so a typed answer comes out
// backwards. If the caret sits at the very start while the text is unchanged since the last keystroke and the person has
// not touched the box or pressed an arrow key since, the caret is put back at the end before the next character lands.
globalThis.keepCaretAtEnd = (input) => {
  let end = null;
  let moved = false;
  input.addEventListener('pointerup', () => { moved = true; });
  input.addEventListener('keydown', (e) => { if (/^(Arrow|Home$|End$)/.test(e.key)) moved = true; });
  input.addEventListener('beforeinput', () => {
    const n = input.value.length;
    if (!moved && n > 0 && end === n && input.selectionStart === 0 && input.selectionEnd === 0) input.setSelectionRange(n, n);
  });
  input.addEventListener('input', () => {
    end = input.value.length;
    if (input.selectionStart === end) moved = false;
  });
};
