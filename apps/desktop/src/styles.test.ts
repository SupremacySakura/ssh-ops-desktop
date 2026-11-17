/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const styles = readFileSync(
  fileURLToPath(new URL('./styles.css', import.meta.url)),
  'utf8',
);
const design = readFileSync(
  fileURLToPath(new URL('../DESIGN.md', import.meta.url)),
  'utf8',
);

const WARNING_BANNER_BACKGROUNDS = [
  '#F4EDE0',
  '#F4EBDD',
  '#F5EEE2',
];
const MINIMUM_CONTRAST = 4.5;

describe('Calibrated Panel contrast tokens', () => {
  const tokens = parseStyleTokens(styles);
  const designTokens = parseDesignTokens(design);

  it('keeps every shared token identical in DESIGN.md and styles.css', () => {
    expect(Object.keys(designTokens).length).toBeGreaterThan(0);
    for (const [name, value] of Object.entries(designTokens)) {
      expect(tokens[name], `styles.css is missing --color-${name}`).toBeDefined();
      expect(normalizeHex(tokens[name] as string))
        .toBe(normalizeHex(value));
    }
  });

  it('renders muted text at WCAG AA on the shell', () => {
    const contrast = contrastRatio(
      tokenColor(tokens, 'muted'),
      tokenColor(tokens, 'shell'),
    );
    expect(contrast).toBeGreaterThanOrEqual(MINIMUM_CONTRAST);
  });

  it('renders warning text at WCAG AA on every warning banner', () => {
    for (const background of WARNING_BANNER_BACKGROUNDS) {
      const contrast = contrastRatio(
        tokenColor(tokens, 'warning'),
        background,
      );
      expect(contrast, `warning on ${background}`)
        .toBeGreaterThanOrEqual(MINIMUM_CONTRAST);
    }
  });

  it('keeps muted and warning in the warm neutral / amber families', () => {
    const muted = rgb(tokenColor(tokens, 'muted'));
    expect(muted.r).toBeGreaterThanOrEqual(muted.g);
    expect(muted.g).toBeGreaterThanOrEqual(muted.b);

    const warning = rgb(tokenColor(tokens, 'warning'));
    expect(warning.r).toBeGreaterThan(warning.g);
    expect(warning.g).toBeGreaterThan(warning.b);
  });
});

function parseStyleTokens(css: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const match of css.matchAll(/--color-([a-z-]+):\s*(#[0-9a-f]{6})\s*;/giu)) {
    tokens[match[1] as string] = match[2] as string;
  }
  return tokens;
}

function parseDesignTokens(markdown: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const match of markdown.matchAll(/^\|\s*`([a-z-]+)`\s*\|\s*`(#[0-9a-f]{6})`/gimu)) {
    tokens[match[1] as string] = match[2] as string;
  }
  return tokens;
}

function tokenColor(tokens: Record<string, string>, name: string): string {
  const value = tokens[name];
  if (!value) throw new Error(`missing --color-${name}`);
  return value;
}

function normalizeHex(value: string): string {
  return value.toUpperCase();
}

function rgb(hex: string): { r: number; g: number; b: number } {
  const digits = hex.replace('#', '');
  return {
    r: Number.parseInt(digits.slice(0, 2), 16),
    g: Number.parseInt(digits.slice(2, 4), 16),
    b: Number.parseInt(digits.slice(4, 6), 16),
  };
}

function relativeLuminance(hex: string): number {
  const channels = rgb(hex);
  const [red, green, blue] = [channels.r, channels.g, channels.b].map((value) => {
    const channel = value / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
  const values = [relativeLuminance(foreground), relativeLuminance(background)]
    .sort((left, right) => right - left) as [number, number];
  return (values[0] + 0.05) / (values[1] + 0.05);
}
