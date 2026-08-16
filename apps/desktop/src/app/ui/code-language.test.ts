import { describe, expect, it } from 'vitest';

import { languageForPath } from './code-language';

describe('languageForPath', () => {
  it('maps common extensions to Monaco languages', () => {
    expect(languageForPath('/etc/nginx/nginx.conf')).toBe('ini');
    expect(languageForPath('/srv/app/main.ts')).toBe('typescript');
    expect(languageForPath('/srv/app/index.tsx')).toBe('typescript');
    expect(languageForPath('/srv/app/style.scss')).toBe('scss');
    expect(languageForPath('/srv/app/data.yaml')).toBe('yaml');
    expect(languageForPath('/home/deploy/notes.md')).toBe('markdown');
    expect(languageForPath('/home/deploy/.bashrc')).toBe('plaintext');
    expect(languageForPath('/opt/Dockerfile')).toBe('dockerfile');
    expect(languageForPath('/var/log/app.log')).toBe('plaintext');
  });
});
