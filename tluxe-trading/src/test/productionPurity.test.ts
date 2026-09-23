import { describe, expect, it } from 'vitest';

/**
 * Static guard: production modules (everything outside tests, fixtures and the
 * dev-only harness) must never import fixtures, test doubles or the harness,
 * and market-data code must not contain a random/simulated price source.
 */
const sources = import.meta.glob<string>('../**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true });

const production = Object.entries(sources)
  .map(([path, src]) => [path.replace(/^\.\.\//, ''), src] as const)
  .filter(([p]) => !/\.test\.tsx?$/.test(p) && !p.startsWith('test/') && !p.startsWith('dev/') && !p.includes('/fixtures/'));

describe('production purity', () => {
  it('scans the production modules', () => {
    const names = production.map(([p]) => p);
    expect(names).toContain('main.tsx');
    expect(names).toContain('services/mt5/Mt5Provider.ts');
  });

  it.each(production)('%s imports no fixtures, test doubles or dev harness', (_file, src) => {
    const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    expect(imports.filter((i) => /fixtures|\/test\/|\.test|\/dev\/|srHarness/.test(i))).toEqual([]);
  });

  it('no production market-data code generates random prices', () => {
    for (const [file, src] of production.filter(([f]) => f.startsWith('services/') || f.startsWith('engines/'))) {
      expect(src, file).not.toMatch(/Math\.random\(/);
    }
  });
});
