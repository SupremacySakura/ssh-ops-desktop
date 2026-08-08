// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DetailPane, MetricCard, PageHeader, ProgressBar } from './layout';

afterEach(cleanup);

describe('desktop UI primitives', () => {
  it('renders a structured page heading and real metric context without inventing a trend', () => {
    render(
      <>
        <PageHeader
          actions={<button type="button">新增服务器</button>}
          description="实时运维状态"
          title="服务器总览"
        />
        <MetricCard detail="来自 Core" icon="server" label="在线服务器" value="3" />
      </>,
    );

    expect(screen.getByRole('heading', { name: '服务器总览' })).toBeVisible();
    expect(screen.getByRole('button', { name: '新增服务器' })).toBeVisible();
    expect(screen.getByText('来自 Core')).toBeVisible();
    expect(screen.queryByText(/趋势/u)).not.toBeInTheDocument();
  });

  it('closes a labelled detail pane and exposes progress semantics', () => {
    const onClose = vi.fn();

    render(
      <DetailPane onClose={onClose} title="web-01">
        <ProgressBar label="内存" value={42} />
      </DetailPane>,
    );

    expect(screen.getByRole('complementary', { name: 'web-01 详情' })).toBeVisible();
    expect(screen.getByRole('progressbar', { name: '内存' })).toHaveAttribute('aria-valuenow', '42');
    fireEvent.click(screen.getByRole('button', { name: '关闭 web-01 详情' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
