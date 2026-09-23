import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
  // Per-test isolation for persisted UI preferences (timeframes, clocks, selection).
  localStorage.clear();
});
