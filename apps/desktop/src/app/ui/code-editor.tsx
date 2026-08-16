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

interface CodeEditorProps {
  'aria-label'?: string;
  language?: string;
  onChange(value: string): void;
  value: string;
}

export function CodeEditor({ 'aria-label': ariaLabel, language = 'plaintext', onChange, value }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const editor = monaco.editor.create(element, {
      ariaLabel,
      automaticLayout: true,
      fontFamily: 'SFMono-Regular, Consolas, monospace',
      fontSize: 13,
      language,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      theme: 'vs',
      value,
      wordWrap: 'on',
    });
    const subscription = editor.onDidChangeModelContent(() => onChangeRef.current(editor.getValue()));
    editorRef.current = editor;
    return () => {
      subscription.dispose();
      editor.dispose();
      editorRef.current = undefined;
    };
    // 编辑器只在挂载时创建一次；value/language 的后续变化由下面的 effect 同步。
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (editor && editor.getValue() !== value) editor.setValue(value);
  }, [value]);

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model && model.getLanguageId() !== language) monaco.editor.setModelLanguage(model, language);
  }, [language]);

  return <div aria-label={ariaLabel} className="code-editor-host" ref={host} role="presentation" />;
}
