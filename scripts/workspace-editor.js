// Rebuild with: npm run build:editor. The browser uses the bundled local asset.
import { basicSetup, EditorView } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';

function language(path) {
  if (/\.[cm]?[jt]sx?$/i.test(path)) return javascript({ typescript: /\.[cm]?tsx?$/i.test(path), jsx: /\.[jt]sx$/i.test(path) });
  if (/\.py$/i.test(path)) return python();
  if (/\.html?$/i.test(path)) return html();
  if (/\.(css|scss)$/i.test(path)) return css();
  if (/\.json$/i.test(path)) return json();
  if (/\.(md|markdown)$/i.test(path)) return markdown();
  return [];
}
export function createEditor({ parent, onChange, onSave, onCursor }) {
  const theme = EditorView.theme({
    '&': { height: '100%', backgroundColor: 'var(--bg)', color: 'var(--text)', fontSize: '13px' },
    '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.65', overflow: 'auto' },
    '.cm-content': { padding: '12px 0', caretColor: 'var(--accent)' },
    '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--muted)', border: 'none', minWidth: '44px' },
    '.cm-lineNumbers .cm-gutterElement': { paddingRight: '14px' },
    '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--panel)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-cursor': { borderLeftColor: 'var(--accent)' },
    '.cm-panels, .cm-tooltip': { backgroundColor: 'var(--panel)', color: 'var(--text)', borderColor: 'var(--line)' },
    '.cm-searchMatch': { backgroundColor: 'var(--selection)' },
  }, { dark: true });
  const highlight = syntaxHighlighting(HighlightStyle.define([
    { tag: tags.keyword, color: 'var(--code-keyword)' },
    { tag: [tags.string, tags.regexp], color: 'var(--code-string)' },
    { tag: [tags.number, tags.bool, tags.null], color: 'var(--code-number)' },
    { tag: tags.comment, color: 'var(--muted)', fontStyle: 'italic' },
    { tag: [tags.function(tags.variableName), tags.tagName], color: 'var(--accent)' },
  ]));
  function state(content = '', path = '') {
    return EditorState.create({ doc: content, extensions: [
      keymap.of([{ key: 'Mod-s', run: () => { onSave(); return true; } }, indentWithTab]),
      basicSetup, theme, highlight, language(path), EditorState.lineSeparator.of(content.includes('\r\n') ? '\r\n' : '\n'),
      EditorView.contentAttributes.of({ 'aria-label': 'File editor', spellcheck: 'false', autocapitalize: 'off' }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChange(update.state.sliceDoc());
        if (update.selectionSet || update.docChanged) {
          const pos = update.state.selection.main.head, line = update.state.doc.lineAt(pos);
          onCursor?.(line.number, pos - line.from + 1);
        }
      }),
    ] });
  }
  const view = new EditorView({ parent, state: state() });
  return {
    open(file) { view.setState(file.state || state(file.content, file.path)); view.requestMeasure(); },
    state: () => view.state,
    text: () => view.state.sliceDoc(),
    focus: () => view.focus(),
    resize: () => view.requestMeasure(),
  };
}
