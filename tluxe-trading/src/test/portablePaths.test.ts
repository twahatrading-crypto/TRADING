import { describe, expect, it } from 'vitest';

/**
 * Windows and macOS file systems are case-insensitive: two modules whose paths
 * differ only by case (or only by .ts vs .tsx) resolve to the same file there
 * and break the build (e.g. `app/ServicesContext` → `app/servicesContext.ts`).
 */
const paths = Object.keys(import.meta.glob('../**/*.{ts,tsx,css}'));

describe('portable module paths', () => {
  it('has no two modules that collide on a case-insensitive file system', () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const p of paths) {
      const key = p.toLowerCase().replace(/\.(tsx?)$/, '');
      const other = seen.get(key);
      if (other) collisions.push(`${other} ↔ ${p}`);
      else seen.set(key, p);
    }
    expect(collisions).toEqual([]);
  });
});
