import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { defineEnv, EnvError } from '../src/index.js';

test('every bad variable is reported at once, and a blank one counts as unset', () => {
  assert.throws(
    () =>
      defineEnv(
        {
          SECRET: z.string().min(32),
          PORT: z.coerce.number().int().default(7000),
          LOG_LEVEL: z.enum(['debug', 'info']).default('info'),
        },
        { source: { SECRET: '', PORT: 'eighty', LOG_LEVEL: 'loud' } }
      ),
    (error: unknown) =>
      error instanceof EnvError &&
      error.problems.SECRET === 'required' &&
      /number/.test(error.problems.PORT) &&
      /debug|info/.test(error.problems.LOG_LEVEL)
  );

  const env = defineEnv(
    {
      PORT: z.coerce.number().default(7000),
      DEBUG: z.stringbool().default(false),
    },
    { source: { PORT: '', DEBUG: 'yes' } }
  );
  assert.deepEqual(env, { PORT: 7000, DEBUG: true });
});

test('a .env file fills in, but variables already set win', () => {
  const dir = mkdtempSync(join(tmpdir(), 'addon-sdk-env-'));
  const file = join(dir, '.env');
  writeFileSync(file, 'SDK_TEST_FROM_FILE=file\nSDK_TEST_BOTH=file\n');
  process.env.SDK_TEST_BOTH = 'process';
  try {
    const env = defineEnv(
      { SDK_TEST_FROM_FILE: z.string(), SDK_TEST_BOTH: z.string() },
      { file }
    );
    assert.deepEqual(env, {
      SDK_TEST_FROM_FILE: 'file',
      SDK_TEST_BOTH: 'process',
    });
    assert.doesNotThrow(() =>
      defineEnv({}, { file: join(dir, 'missing.env') })
    );
  } finally {
    delete process.env.SDK_TEST_BOTH;
    delete process.env.SDK_TEST_FROM_FILE;
  }
});
