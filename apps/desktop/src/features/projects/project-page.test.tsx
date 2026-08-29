// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { CoreClient } from '../../api/core';
import { ProjectsPage } from './project-page';

describe('ProjectsPage', () => {
  it('renders the project overview and real project cards', async () => {
    const core = {
      projects: async () => [
        { id: 'p1', serverId: 's1', name: 'ecommerce-backend', rootPath: '/srv/app', runtime: 'Node.js', deployStrategy: 'docker_compose', repositoryUrl: 'https://example.com/app.git' },
        { id: 'p2', serverId: 's1', name: 'marketing-site', rootPath: '/srv/site', runtime: 'Next.js', deployStrategy: 'release_symlink' },
      ],
    } as unknown as CoreClient;
    const connection = { server: { id: 's1', name: 'srv', host: 'h', port: 22, username: 'u', environment: 'production' as const, authType: 'password' as const, tagIds: [] }, connection: { serverId: 's1', connectionId: 'c1' } };

    render(<ProjectsPage connections={[connection]} core={core} />);

    expect(screen.getByRole('heading', { name: '项目' })).toBeVisible();
    expect(screen.getByText('管理代码仓库与部署配置')).toBeVisible();
    expect(screen.getByRole('button', { name: '导入仓库' })).toBeVisible();
    expect(screen.getByRole('button', { name: '新建项目' })).toBeVisible();

    expect(await screen.findByText('ecommerce-backend')).toBeVisible();
    expect(screen.getByText('marketing-site')).toBeVisible();
    expect(screen.getAllByRole('button', { name: '部署' })).toHaveLength(2);
  });
});