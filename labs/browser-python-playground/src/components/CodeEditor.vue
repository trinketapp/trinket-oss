<template>
  <div ref="hostRef" class="code-editor" data-testid="editor" />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { autocompletion, closeBrackets, completionKeymap, type CompletionContext } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, foldGutter, indentOnInput, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { python } from '@codemirror/lang-python';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { EditorState, type Extension } from '@codemirror/state';
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection
} from '@codemirror/view';

const props = defineProps<{
  modelValue: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();

const hostRef = ref<HTMLDivElement | null>(null);
let view: EditorView | null = null;
let syncingFromParent = false;

const pythonKeywords = [
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def',
  'del', 'elif', 'else', 'except', 'False', 'finally', 'for', 'from', 'global',
  'if', 'import', 'in', 'is', 'lambda', 'None', 'nonlocal', 'not', 'or', 'pass',
  'raise', 'return', 'True', 'try', 'while', 'with', 'yield'
];

const pythonBuiltins = [
  'abs', 'all', 'any', 'bool', 'dict', 'enumerate', 'filter', 'float', 'input',
  'int', 'len', 'list', 'map', 'max', 'min', 'open', 'print', 'range', 'round',
  'set', 'sorted', 'str', 'sum', 'tuple', 'type', 'zip'
];

const pygameCompletions = [
  'pygame.init', 'pygame.quit', 'pygame.display.set_mode', 'pygame.display.flip',
  'pygame.event.get', 'pygame.time.Clock', 'pygame.draw.circle', 'pygame.draw.rect',
  'pygame.draw.line', 'pygame.Surface', 'pygame.Rect', 'screen.fill',
  'clock.tick', 'asyncio.run', 'asyncio.sleep'
];

function pythonCompletionSource(context: CompletionContext) {
  const word = context.matchBefore(/[A-Za-z_][\w.]*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;

  return {
    from: word.from,
    options: [
      ...pythonKeywords.map(label => ({ label, type: 'keyword' })),
      ...pythonBuiltins.map(label => ({ label, type: 'function' })),
      ...pygameCompletions.map(label => ({ label, type: 'property' }))
    ],
    validFor: /^[A-Za-z_][\w.]*$/
  };
}

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: '#0f131b',
    color: '#e8edf5',
    fontSize: '14px'
  },
  '.cm-scroller': {
    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
    lineHeight: '1.55'
  },
  '.cm-content': {
    padding: '16px 0',
    caretColor: '#72b7ff'
  },
  '.cm-line': {
    padding: '0 16px'
  },
  '.cm-gutters': {
    backgroundColor: '#101722',
    color: '#68758a',
    borderRight: '1px solid #252b36'
  },
  '.cm-activeLine': {
    backgroundColor: '#182130'
  },
  '.cm-activeLineGutter': {
    backgroundColor: '#182130',
    color: '#d6e2f5'
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: '#254f86'
  },
  '.cm-tooltip': {
    backgroundColor: '#151b26',
    border: '1px solid #384152',
    color: '#e8edf5'
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: '#2f7df6',
    color: '#ffffff'
  }
});

const extensions: Extension[] = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  history(),
  foldGutter(),
  drawSelection(),
  dropCursor(),
  rectangularSelection(),
  crosshairCursor(),
  indentOnInput(),
  bracketMatching(),
  closeBrackets(),
  highlightActiveLine(),
  highlightSelectionMatches(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  python(),
  autocompletion({
    override: [pythonCompletionSource],
    activateOnTyping: true
  }),
  keymap.of([
    indentWithTab,
    ...completionKeymap,
    ...searchKeymap,
    ...historyKeymap,
    ...defaultKeymap
  ]),
  editorTheme,
  EditorView.lineWrapping,
  EditorView.updateListener.of(update => {
    if (!update.docChanged || syncingFromParent) return;
    emit('update:modelValue', update.state.doc.toString());
  })
];

onMounted(() => {
  if (!hostRef.value) return;

  view = new EditorView({
    parent: hostRef.value,
    state: EditorState.create({
      doc: props.modelValue,
      extensions
    })
  });
});

watch(() => props.modelValue, value => {
  if (!view) return;
  const current = view.state.doc.toString();
  if (value === current) return;

  syncingFromParent = true;
  view.dispatch({
    changes: { from: 0, to: current.length, insert: value }
  });
  syncingFromParent = false;
});

onBeforeUnmount(() => {
  view?.destroy();
  view = null;
});
</script>
