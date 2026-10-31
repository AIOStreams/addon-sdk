import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseBlocks, parseInline, plain } from '../ui/markdown.js';

const link = (href: string, ...children: unknown[]) => ({
  type: 'link',
  href,
  children,
});

describe('markdown in configure page text', () => {
  test('emphasis, code, links and images', () => {
    assert.deepEqual(
      parseInline('**Bold**, *em*, _em_, ***both***, ~~gone~~ and `a*b*c`'),
      [
        { type: 'strong', children: ['Bold'] },
        ', ',
        { type: 'em', children: ['em'] },
        ', ',
        { type: 'em', children: ['em'] },
        ', ',
        {
          type: 'strong',
          children: [{ type: 'em', children: ['both'] }],
        },
        ', ',
        { type: 'del', children: ['gone'] },
        ' and ',
        { type: 'code', text: 'a*b*c' },
      ]
    );
    assert.deepEqual(parseInline('*a **b** c*'), [
      {
        type: 'em',
        children: ['a ', { type: 'strong', children: ['b'] }, ' c'],
      },
    ]);
    assert.deepEqual(
      parseInline('[![TMDB](https://x.test/logo.svg)](https://themoviedb.org)'),
      [
        link('https://themoviedb.org', {
          type: 'image',
          src: 'https://x.test/logo.svg',
          alt: 'TMDB',
        }),
      ]
    );
    assert.deepEqual(parseInline('[**Docs**](https://x.test/a_(b) "Title")'), [
      link('https://x.test/a_(b)', { type: 'strong', children: ['Docs'] }),
    ]);
    assert.deepEqual(parseInline('``a ` b``'), [
      { type: 'code', text: 'a ` b' },
    ]);
  });

  test('only http(s) and mailto become links, and only http(s) images load', () => {
    assert.deepEqual(parseInline('[click](javascript:alert(1))'), ['click']);
    assert.deepEqual(parseInline('[x](JaVaScRiPt:alert(1))'), ['x']);
    assert.deepEqual(parseInline('[x](data:text/html,hi)'), ['x']);
    assert.deepEqual(parseInline('![logo](data:image/png;base64,AA)'), [
      'logo',
    ]);
    assert.deepEqual(parseInline('[Mail](mailto:a@b.test)'), [
      link('mailto:a@b.test', 'Mail'),
    ]);
    assert.deepEqual(parseInline('<script>alert(1)</script>'), [
      '<script>alert(1)</script>',
    ]);
  });

  test('addresses in the text are linked, without the punctuation after them', () => {
    assert.deepEqual(
      parseInline('Get one at https://x.test/api. Or (https://x.test/a_(b)).'),
      [
        'Get one at ',
        link('https://x.test/api', 'https://x.test/api'),
        '. Or (',
        link('https://x.test/a_(b)', 'https://x.test/a_(b)'),
        ').',
      ]
    );
    assert.deepEqual(parseInline('<https://x.test/a>'), [
      link('https://x.test/a', 'https://x.test/a'),
    ]);
    assert.deepEqual(parseInline('[https://x.test](https://y.test)'), [
      link('https://y.test', 'https://x.test'),
    ]);
  });

  test('ordinary text is left alone', () => {
    for (const text of [
      'snake_case_name and file_v2_final',
      '5 * 3 * 2',
      'Prices in USD*',
      '**not closed',
      'a ~ b ~ c',
      'C:\\path\\to',
      '[not a link] (spaced)',
    ]) {
      assert.deepEqual(parseInline(text), [text], text);
    }
    assert.deepEqual(parseInline('\\*not em\\*'), ['*not em*']);
  });

  test('blocks: paragraphs, line breaks, headings and lists', () => {
    assert.deepEqual(
      parseBlocks(
        '# Setup\nFirst line\nsecond line\n\n- one\n  continued\n* two\n\n3. three\n4) four\nAfter'
      ),
      [
        { type: 'heading', level: 1, children: ['Setup'] },
        {
          type: 'paragraph',
          children: ['First line', { type: 'br' }, 'second line'],
        },
        {
          type: 'list',
          ordered: false,
          start: 1,
          items: [['one', { type: 'br' }, 'continued'], ['two']],
        },
        { type: 'list', ordered: true, start: 3, items: [['three'], ['four']] },
        { type: 'paragraph', children: ['After'] },
      ]
    );
    assert.deepEqual(parseBlocks('Features:\n* **Fast**\n* Free'), [
      { type: 'paragraph', children: ['Features:'] },
      {
        type: 'list',
        ordered: false,
        start: 1,
        items: [[{ type: 'strong', children: ['Fast'] }], ['Free']],
      },
    ]);
    assert.deepEqual(parseBlocks('#hashtag and 2.5 GB'), [
      { type: 'paragraph', children: ['#hashtag and 2.5 GB'] },
    ]);
  });

  test('plain text for labels and menus', () => {
    assert.equal(
      plain('**API** key from [TMDB](https://x.test) `v3`'),
      'API key from TMDB v3'
    );
  });
});
