// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Select } from './select';

afterEach(cleanup);

const options = [
  { value: 'a', label: '服务器 A' },
  { value: 'b', label: '服务器 B' },
  { value: 'c', label: '服务器 C' },
];

describe('Select', () => {
  it('opens on click and emits the chosen option value', () => {
    const onChange = vi.fn();
    render(<Select aria-label="服务器" onChange={onChange} options={options} value="a" />);

    expect(screen.getByRole('button', { name: '服务器' })).toHaveTextContent('服务器 A');
    fireEvent.click(screen.getByRole('button', { name: '服务器' }));
    const listbox = screen.getByRole('listbox');
    expect(listbox).toBeVisible();
    fireEvent.click(screen.getByRole('option', { name: '服务器 C' }));

    expect(onChange).toHaveBeenCalledWith('c');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('supports keyboard navigation and closes on outside click', () => {
    const onChange = vi.fn();
    render(<div><Select aria-label="环境" onChange={onChange} options={options} value="" /><button type="button">外部</button></div>);

    const trigger = screen.getByRole('button', { name: '环境' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('c');

    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('button', { name: '外部' }));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('closes on Escape and shows the placeholder when nothing is selected', () => {
    render(<Select aria-label="模型" onChange={() => undefined} options={options} placeholder="请选择" value="" />);

    const trigger = screen.getByRole('button', { name: '模型' });
    expect(trigger).toHaveTextContent('请选择');
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
