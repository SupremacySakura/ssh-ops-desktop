// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { CoreClient } from '../../api/core';
import { FileManagerPage } from './file-manager-page';

afterEach(cleanup);

const server = { id: 's1', name: 'web-01', host: 'h', port: 22, username: 'u', environment: 'production' as const, authType: 'password' as const, tagIds: [] };
const connection = { serverId: 's1', connectionId: 'c1' };

describe('FileManagerPage', () => {
  it('renders a single file list with .. navigation and opens an editor modal for files', async () => {
    const core = {
      listFiles: async () => [
        { path: '/etc/nginx', name: 'nginx', kind: 'directory' },
        { path: '/etc/nginx/nginx.conf', name: 'nginx.conf', kind: 'file', size: 100 },
      ],
      readFile: async () => ({
        path: '/etc/nginx/nginx.conf',
        bytes: [...new TextEncoder().encode('worker_processes 1;')],
        sha256: '0'.repeat(64),
        truncated: false,
      }),
    } as unknown as CoreClient;

    render(<FileManagerPage connections={[{ server, connection }]} core={core} />);

    expect(screen.getByRole('heading', { name: '文件' })).toBeVisible();
    expect(screen.getByText('浏览与编辑远程服务器文件')).toBeVisible();
    expect(screen.getByText('上传文件')).toBeVisible();
    expect(await screen.findByText('nginx.conf')).toBeVisible();
    // 根目录下不显示 ..
    expect(screen.queryByText('..')).not.toBeInTheDocument();

    // 点击目录进入，列表顶部出现 ..，可逐级返回上一级
    fireEvent.click(screen.getByRole('button', { name: 'nginx' }));
    expect(await screen.findByText('..')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '返回上一级' }));
    // /etc/nginx -> /etc：仍是子目录，.. 保留
    expect(await screen.findByText('/etc')).toBeVisible();
    expect(screen.getByText('..')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '返回上一级' }));
    // /etc -> /：回到根目录，.. 消失
    await waitFor(() => expect(screen.queryByText('..')).not.toBeInTheDocument());
    expect(screen.getByText('nginx.conf')).toBeVisible();

    // 点击文件打开编辑弹窗，可编辑并关闭
    fireEvent.click(screen.getByRole('button', { name: /nginx\.conf/ }));
    expect(await screen.findByRole('dialog', { name: '编辑远程文件' })).toBeVisible();
    expect(screen.getByLabelText('文件编辑内容')).toHaveValue('worker_processes 1;');
    expect(screen.getByRole('button', { name: '保存' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: '关闭编辑器' }));
    expect(screen.queryByRole('dialog', { name: '编辑远程文件' })).not.toBeInTheDocument();
  });
});
