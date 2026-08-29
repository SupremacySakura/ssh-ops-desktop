// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { CoreClient } from '../../api/core';
import { SettingsPage } from './model-settings';

afterEach(cleanup);

describe('SettingsPage', () => {
  it('renders the settings page structure from the design mockup', () => {
    const { container } = render(<SettingsPage core={{} as CoreClient} />);

    expect(screen.getByRole('heading', { name: '设置' })).toBeVisible();
    expect(screen.getByText('模型、账户与系统偏好')).toBeVisible();
    expect(screen.getByRole('button', { name: '保存更改' })).toBeVisible();
    expect(screen.getByRole('button', { name: '默认模型' })).toBeInTheDocument();
    expect(container.querySelector('select')).toBeNull();
    expect(container.querySelectorAll('.settings-section > .card.settings-group')).toHaveLength(3);
    expect(container.querySelectorAll('.toggle')).toHaveLength(5);
    expect(screen.getByRole('radiogroup', { name: '外观模式' })).toBeVisible();
  });
});
