// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CoreClient } from '../../api/core';
import { ServerListPage } from './server-list-page';

afterEach(cleanup);

const summary = {
  id: '00000000-0000-4000-8000-000000000001', name: 'web-01', host: 'example.com', port: 22,
  username: 'deploy', environment: 'production' as const, authType: 'password' as const, tagIds: [],
};

describe('ServerListPage', () => {
  it('creates a password server, stores its credential in Core, and clears the secret input', async () => {
    const core = {
      createServer: vi.fn(async () => summary),
      setServerCredential: vi.fn(async () => undefined),
    } as unknown as CoreClient;
    const created = vi.fn();
    render(<ServerListPage core={core} onCreated={created} servers={[]} />);

    fireEvent.click(screen.getByRole('button', { name: '新增服务器' }));
    fireEvent.change(screen.getByLabelText('服务器名称'), { target: { value: 'web-01' } });
    fireEvent.change(screen.getByLabelText('主机地址'), { target: { value: 'example.com' } });
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'deploy' } });
    const secret = screen.getByLabelText('密码');
    fireEvent.change(secret, { target: { value: 'fixture-password' } });
    fireEvent.click(screen.getByRole('button', { name: '保存服务器' }));

    expect(await screen.findByText('服务器与凭据已保存')).toBeVisible();
    await waitFor(() => expect(screen.queryByLabelText('密码')).not.toBeInTheDocument());
    expect(core.setServerCredential).toHaveBeenCalledWith({
      serverId: summary.id,
      secret: 'fixture-password',
    });
    expect(created).toHaveBeenCalledWith(summary);
  });

  it('shows unknown host fingerprint confirmation and blocks changed fingerprints', async () => {
    const connect = vi.fn()
      .mockResolvedValueOnce({ kind: 'host_key_required', prompt: {
        verificationId: '00000000-0000-4000-8000-000000000002', algorithm: 'ssh-ed25519',
        sha256: 'SHA256:fixture-new', expiresAt: '2026-08-08T12:00:00Z',
      } })
      .mockResolvedValueOnce({ kind: 'host_key_changed', expectedSha256: 'SHA256:old', actualSha256: 'SHA256:new' });
    const core = { connect } as unknown as CoreClient;
    const { rerender } = render(<ServerListPage core={core} onCreated={vi.fn()} servers={[summary]} />);

    fireEvent.click(screen.getByRole('button', { name: '连接 web-01' }));
    expect(await screen.findByRole('alertdialog', { name: '确认主机指纹' })).toHaveTextContent('SHA256:fixture-new');
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    rerender(<ServerListPage core={core} onCreated={vi.fn()} servers={[summary]} />);
    fireEvent.click(screen.getByRole('button', { name: '连接 web-01' }));
    expect(await screen.findByRole('alertdialog', { name: '主机指纹已变化' })).toHaveTextContent('SHA256:old');
    expect(screen.queryByRole('button', { name: '直接连接' })).not.toBeInTheDocument();
  });

  it('edits and explicitly deletes an existing server', async () => {
    const updated = { ...summary, name: 'web-primary' };
    const core = {
      updateServer: vi.fn(async () => updated),
      deleteServer: vi.fn(async () => undefined),
      serverGroups: async () => [],
    } as unknown as CoreClient;
    const onUpdated = vi.fn();
    const onDeleted = vi.fn();
    render(<ServerListPage
      core={core}
      onCreated={vi.fn()}
      onDeleted={onDeleted}
      onUpdated={onUpdated}
      servers={[summary]}
    />);

    fireEvent.click(screen.getByRole('button', { name: '编辑 web-01' }));
    fireEvent.change(screen.getByLabelText('服务器名称'), { target: { value: 'web-primary' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    expect(await screen.findByText('服务器配置已更新')).toBeVisible();
    expect(onUpdated).toHaveBeenCalledWith(updated);

    fireEvent.click(screen.getByRole('button', { name: '删除 web-01' }));
    expect(screen.getByRole('alertdialog', { name: '确认删除服务器' })).toHaveTextContent('不可撤销');
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(core.deleteServer).toHaveBeenCalledWith({
      serverId: summary.id,
      confirmed: true,
    }));
    expect(onDeleted).toHaveBeenCalledWith(summary.id);
  });

  it('previews and applies only selected valid import rows', async () => {
    const rowId = '00000000-0000-4000-8000-000000000010';
    const core = {
      previewServerImport: vi.fn(async () => ({
        importId: '00000000-0000-4000-8000-000000000011',
        sourceSha256: 'a'.repeat(64),
        rows: [{ rowId, status: 'valid', server: {
          name: summary.name,
          host: summary.host,
          port: summary.port,
          username: summary.username,
          environment: summary.environment,
          authType: summary.authType,
          tagIds: [],
        } }],
      })),
      applyServerImport: vi.fn(async () => ({ servers: [summary] })),
    } as unknown as CoreClient;
    const onCreated = vi.fn();
    render(<ServerListPage core={core} onCreated={onCreated} servers={[]} />);

    fireEvent.click(screen.getByRole('button', { name: '批量导入' }));
    fireEvent.change(screen.getByLabelText('导入内容'), {
      target: { value: 'name,host,port,username,environment,authType\nweb-01,example.com,22,deploy,production,password' },
    });
    fireEvent.click(screen.getByRole('button', { name: '预检' }));
    expect(await screen.findByText('web-01 · valid')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '应用有效行' }));
    await waitFor(() => expect(core.applyServerImport).toHaveBeenCalledWith({
      importId: '00000000-0000-4000-8000-000000000011',
      rowIds: [rowId],
    }));
    expect(onCreated).toHaveBeenCalledWith(summary);
  });

  it('filters the catalog and opens a non-destructive server detail pane', () => {
    render(<ServerListPage
      core={{ serverGroups: async () => [] } as unknown as CoreClient}
      onCreated={vi.fn()}
      servers={[summary]}
    />);

    fireEvent.click(screen.getByRole('button', { name: '查看 web-01 详情' }));
    expect(screen.getByRole('complementary', { name: 'web-01 详情' })).toHaveTextContent('example.com:22');
    fireEvent.click(screen.getByRole('button', { name: '环境筛选' }));
    fireEvent.click(screen.getByRole('option', { name: '开发环境' }));
    expect(screen.getByText('没有匹配的服务器')).toBeVisible();
  });
});
