import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MetaSchema, StreamSchema, type Stream } from '../src/index.js';

const problems = (stream: unknown) =>
  StreamSchema.safeParse(stream).error?.issues.map(
    (issue) => `${issue.path.join('.')}: ${issue.message}`
  ) ?? [];

test('a stream is checked as the source it names, the way clients pick one', () => {
  const valid: Stream[] = [
    { url: 'https://cdn.example/a.mkv', infoHash: 'a'.repeat(40), fileIdx: 2 },
    { infoHash: 'A'.repeat(40), fileIdx: 0, fileMustInclude: ['\\.mkv$'] },
    {
      nzbUrl: 'https://indexer.example/a.nzb',
      servers: ['nntps://u:p@news.example:563/8'],
    },
    {
      rarUrls: [
        ['https://files.example/a.part1.rar', 1000],
        ['https://files.example/a.part2.rar'],
      ],
    },
    { externalUrl: 'https://www.example.com/watch' },
  ];
  for (const stream of valid)
    assert.deepEqual(problems(stream), [], JSON.stringify(stream));

  assert.deepEqual(
    problems({ rarUrls: [{ url: 'https://files.example/a.rar' }] }),
    ['rarUrls.0: Invalid input: expected tuple, received object']
  );
  assert.deepEqual(problems({ infoHash: 'abc' }), [
    'infoHash: expected 40 hexadecimal characters',
  ]);
  assert.deepEqual(
    problems({ nzbUrl: 'https://indexer.example/a.nzb', servers: [] }),
    ['servers: Too small: expected array to have >=1 items']
  );
  assert.match(problems({ name: 'only a name' })[0], /a stream needs a source/);
});

test('an id the types allow to be undefined is accepted, as JSON leaves it out', () => {
  const meta = { id: 'tmdb:1', type: 'movie', name: 'A' };
  assert.ok(
    MetaSchema.safeParse({ ...meta, ids: { tmdb: 1, imdb: undefined } }).success
  );
  assert.ok(!MetaSchema.safeParse({ ...meta, ids: { imdb: '' } }).success);
});
