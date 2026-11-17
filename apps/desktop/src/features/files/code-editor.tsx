import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import cssWorker from 'monaco-editor/language/css/css.worker.js?worker';
import htmlWorker from 'monaco-editor/language/html/html.worker.js?worker';
import jsonWorker from 'monaco-editor/language/json/json.worker.js?worker';
import tsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';
import { useEffect, useRef } from 'react';

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') return new jsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  },
};

let themeDefined = false;

function ensureTheme() {
  if (themeDefined) return;
  monaco.editor.defineTheme('harbor-paper', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#FAF9F6',
      'editor.foreground': '#1B1A17',
      'editorCursor.foreground': '#E85D04',
      'editorLineNumber.foreground': '#8E8A80',
      'editorLineNumber.activeForeground': '#1B1A17',
      'editor.selectionBackground': '#E85D0433',
      'editor.inactiveSelectionBackground': '#E85D041A',
      'editor.lineHighlightBackground': '#F0EDE6',
      'editorIndentGuide.background1': '#E4DFD5',
      'editorIndentGuide.activeBackground1': '#CFCAC0',
      'editorWidget.background': '#FAF9F6',
      'editorWidget.border': '#CFCAC0',
    },
  });
  themeDefined = true;
}

interface CodeEditorProps {
  'aria-label'?: string;
  language?: string;
  onChange(value: string): void;
  value: string;
}

export function CodeEditor({
  'aria-label': ariaLabel,
  language = 'plaintext',
  onChange,
  value,
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    ensureTheme();
    const editor = monaco.editor.create(element, {
      ariaLabel,
      automaticLayout: true,
      fontFamily: '"IBM Plex Mono", "SFMono-Regular", monospace',
      fontSize: 12,
      language,
      lineHeight: 19,
      minimap: { enabled: false },
      padding: { top: 10, bottom: 10 },
      renderLineHighlight: 'line',
      scrollBeyondLastLine: false,
      theme: 'harbor-paper',
      value,
      wordWrap: 'on',
    });
    const subscription = editor.onDidChangeModelContent(() => {
      onChangeRef.current(editor.getValue());
    });
    editorRef.current = editor;
    return () => {
      subscription.dispose();
      editor.dispose();
      editorRef.current = undefined;
    };
    // The editor is created once per mounted dialog; value/language sync below.
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (editor && editor.getValue() !== value) editor.setValue(value);
  }, [value]);

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model && model.getLanguageId() !== language) {
      monaco.editor.setModelLanguage(model, language);
    }
  }, [language]);

  return (
    <div
      aria-label={ariaLabel}
      className="h-full min-h-[280px] w-full"
      ref={host}
      role="presentation"
    />
  );
}
