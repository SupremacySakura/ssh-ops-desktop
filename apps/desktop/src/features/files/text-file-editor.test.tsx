// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import type {
  ConnectionHandle,
  RemoteTextFile,
} from '@opspilot/contracts';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFakeCoreClient } from '../../test/fake-core';

vi.mock('./code-editor', () => ({
  CodeEditor: ({
    onChange,
    value,
  }: {
    onChange(value: string): void;
    value: string;
  }) => (
    <textarea
      aria-label="远程文件内容"
      onChange={(event) => onChange(event.target.value)}
      value={value}
    />
  ),
}));

import { TextFileEditor } from './text-file-editor';

const connection: ConnectionHandle = {
  serverId: '019c62b2-2970-7000-8000-000000000003',
  connectionId: '019c62b2-2970-7000-8000-000000000010',
};
const document: RemoteTextFile = {
  path: '/app.conf',
  text: 'hello\n',
  sha256: '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
  size: 6,
  modifiedAt: 1_700_000_100,
};

afterEach(() => cleanup());

function editorCore() {
  return createFakeCoreClient({
    files: {
      documents: {
        '/app.conf': document,
      },
    },
  });
}

describe('TextFileEditor', () => {
  it('saves the draft with the hash captured when the file was opened', async () => {
    const core = editorCore();
    const onSaved = vi.fn();
    render(
      <TextFileEditor
        connection={connection}
        core={core}
        document={document}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );

    const editor = screen.getByRole('textbox', { name: '远程文件内容' });
    fireEvent.change(editor, { target: { value: 'hello harbor\n' } });
    fireEvent.click(screen.getByRole('button', { name: '保存到远程' }));

    expect(await screen.findByRole('status')).toHaveTextContent('已保存到远程');
    expect(core.calls).toContainEqual({
      method: 'writeFile',
      args: [connection, '/app.conf', 'hello harbor\n', document.sha256],
    });
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({
      path: '/app.conf',
      size: 13,
    }));
    expect(editor).toHaveValue('hello harbor\n');
  });

  it('keeps the draft and offers reload/retry when the remote file changed', async () => {
    const core = createFakeCoreClient({
      files: {
        documents: {
          '/app.conf': document,
        },
      },
      overrides: {
        writeFile: async () => {
          throw Object.assign(new Error('远程文件已在别处修改，草稿保留'), {
            code: 'CONFLICT',
            retryable: false,
          });
        },
      },
    });
    const onClose = vi.fn();
    render(
      <TextFileEditor
        connection={connection}
        core={core}
        document={document}
        onClose={onClose}
        onSaved={vi.fn()}
      />,
    );

    const editor = screen.getByRole('textbox', { name: '远程文件内容' });
    fireEvent.change(editor, { target: { value: 'unsaved draft\n' } });
    fireEvent.click(screen.getByRole('button', { name: '保存到远程' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '远程文件已在别处修改，草稿保留',
    );
    expect(editor).toHaveValue('unsaved draft\n');
    expect(screen.getByRole('dialog', { name: '编辑 app.conf' })).toBeVisible();
    expect(screen.getByRole('button', { name: '重新加载远端内容' })).toBeVisible();
    expect(screen.getByRole('button', { name: '重试保存' })).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('reloads the latest remote text and replaces the conflict hash', async () => {
    const latest: RemoteTextFile = {
      ...document,
      text: 'remote change\n',
      size: 14,
      sha256: 'bc6f1f5b8d6e02be0c4ef2f7d86d42b8c04c7609fa535e0ee04f22f28412eea1',
    };
    const writeFile = vi.fn(async () => {
      throw Object.assign(new Error('远程文件已在别处修改，草稿保留'), {
        code: 'CONFLICT',
        retryable: false,
      });
    });
    const core = createFakeCoreClient({
      files: {
        documents: {
          '/app.conf': document,
        },
      },
      overrides: {
        writeFile,
        readFile: async () => latest,
      },
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(
      <TextFileEditor
        connection={connection}
        core={core}
        document={document}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const editor = screen.getByRole('textbox', { name: '远程文件内容' });
    fireEvent.change(editor, { target: { value: 'unsaved draft\n' } });
    fireEvent.click(screen.getByRole('button', { name: '保存到远程' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: '重新加载远端内容' }));

    await waitFor(() => expect(editor).toHaveValue('remote change\n'));
    fireEvent.change(editor, { target: { value: 'next save\n' } });
    fireEvent.click(screen.getByRole('button', { name: '保存到远程' }));

    await waitFor(() => {
      expect(writeFile).toHaveBeenCalledWith(
        connection,
        '/app.conf',
        'next save\n',
        latest.sha256,
      );
    });
    confirm.mockRestore();
  });
});
