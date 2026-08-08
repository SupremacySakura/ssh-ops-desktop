import { describe, expect, it } from 'vitest';

import { ProjectInputSchema, RuntimeTypeSchema } from './project.js';

describe('project contracts', () => {
  it('requires safe absolute roots and supported repository URLs', () => {
    const input = {
      serverId: '019c62b2-2970-7000-8000-000000000003',
      name: 'Web',
      rootPath: '/srv/web',
      repositoryUrl: 'git@example.com:team/web.git',
      runtime: 'node_js',
      deployStrategy: 'release_symlink',
    } as const;
    expect(ProjectInputSchema.parse(input)).toEqual(input);
    expect(ProjectInputSchema.safeParse({ ...input, rootPath: '../web' }).success).toBe(false);
    expect(RuntimeTypeSchema.parse('docker_compose')).toBe('docker_compose');
  });
});
