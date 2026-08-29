// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ConnectionHandle, ServerSummary } from '@opspilot/contracts';
import type { CoreClient } from '../../api/core';
import { NginxPage } from './nginx-page';

describe('NginxPage', () => {
  it('renders the Nginx config editor without fake sites and loads remote config', async () => {
    const server = { id: 's1', name: 'web-01', host: 'example.com', port: 22, username: 'deploy', environment: 'production' as const, authType: 'ssh_agent' as const, tagIds: [] } as ServerSummary;
    const connection = { serverId: server.id, connectionId: 'c1' } as ConnectionHandle;
    const core = {
      nginxDiscover: async () => '/etc/nginx/nginx.conf',
      nginxRead: async () => [...new TextEncoder().encode('server {\n    listen 80;\n    server_name example.com;\n    return 301 https://$server_name$request_uri;\n}')],
    } as unknown as CoreClient;
    render(<NginxPage connections={[{ server, connection }]} core={core} />);

    expect(screen.getByRole('heading', { name: 'Nginx' })).toBeVisible();
    expect(screen.getByText('站点配置与 SSL 管理')).toBeVisible();
    expect(screen.getByRole('button', { name: '新建站点' })).toBeVisible();
    // 假站点卡片已移除
    expect(screen.queryByText('example.com')).not.toBeInTheDocument();
    expect(screen.queryByText('api.example.com')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存并重载' })).toBeDisabled();

    // 点击新建站点从远端读取配置到编辑器
    fireEvent.click(screen.getByRole('button', { name: '新建站点' }));
    await waitFor(() => {
      expect((screen.getByLabelText('Nginx 候选配置') as HTMLTextAreaElement).value).toContain('listen 80');
    });
  });
});
