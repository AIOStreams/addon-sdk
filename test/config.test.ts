import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { z } from 'zod';
import { defineAddon, AddonDefinitionError } from '../src/index.js';
import { BASE, call, manifest } from './helpers.js';

const Settings = z.object({
  token: z.string().min(1),
  quality: z.enum(['hd', 'sd']).default('hd'),
});

function addonWith(
  config: Parameters<typeof defineAddon<z.output<typeof Settings>>>[0]['config']
) {
  const seen: unknown[] = [];
  const addon = defineAddon({
    manifest: (settings) =>
      manifest({
        name: settings ? `Test (${settings.quality})` : 'Test',
        behaviorHints: { configurable: true, configurationRequired: true },
      }),
    config,
    stream: async ({ config }) => {
      seen.push(config);
      return { streams: [] };
    },
    configure: ({ config }) => `<p>${config ? 'reconfigure' : 'new'}</p>`,
  });
  return { addon, seen };
}

describe('configuration', () => {
  test('a configuration survives the round trip through its URL, any characters included', async () => {
    const { addon, seen } = addonWith(Settings);
    const settings = { token: 'ünïcødé/+&=?#', quality: 'sd' as const };
    const url = await addon.manifestUrl(`${BASE}/`, settings);
    assert.match(url, /^http:\/\/addon\.test\/[A-Za-z0-9_-]+\/manifest\.json$/);

    const segment = new URL(url).pathname.split('/')[1];
    await call(addon, `/${segment}/stream/movie/tt1.json`);
    assert.deepEqual(seen, [settings]);
  });

  test('URL-encoded JSON, the older convention, is read too', async () => {
    const { addon, seen } = addonWith(Settings);
    const segment = encodeURIComponent(JSON.stringify({ token: 'abc' }));
    await call(addon, `/${segment}/stream/movie/tt1.json`);
    assert.deepEqual(seen, [{ token: 'abc', quality: 'hd' }]);
  });

  test('a sealed configuration cannot be read without its secret, nor altered', async () => {
    const secret = 's'.repeat(32);
    const { addon, seen } = addonWith({ schema: Settings, secret });
    const url = await addon.manifestUrl(BASE, {
      token: 'private',
      quality: 'hd',
    });
    const segment = new URL(url).pathname.split('/')[1];
    assert.ok(
      !atob(segment.replace(/-/g, '+').replace(/_/g, '/')).includes('private')
    );

    const other = addonWith({ schema: Settings, secret: 't'.repeat(32) }).addon;
    assert.equal(
      (await call(other, `/${segment}/stream/movie/tt1.json`)).status,
      400
    );

    const flipped =
      segment.slice(0, -2) +
      (segment.at(-2) === 'A' ? 'B' : 'A') +
      segment.at(-1);
    assert.equal(
      (await call(addon, `/${flipped}/stream/movie/tt1.json`)).status,
      400
    );

    assert.equal(
      (await call(addon, `/${segment}/stream/movie/tt1.json`)).status,
      200
    );
    assert.deepEqual(seen, [{ token: 'private', quality: 'hd' }]);
  });

  test('without a configuration, the schema decides: its defaults, or a clear refusal', async () => {
    const optional = defineAddon({
      manifest: manifest(),
      config: z.object({ quality: z.enum(['hd', 'sd']).default('hd') }),
      stream: async ({ config }) =>
        ({ streams: [], quality: config.quality }) as never,
      validation: 'off',
    });
    assert.deepEqual(
      await (await call(optional, '/stream/movie/tt1.json')).json(),
      {
        streams: [],
        quality: 'hd',
      }
    );

    const { addon } = addonWith(Settings);
    const res = await call(addon, '/stream/movie/tt1.json');
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'This addon needs to be configured');
  });

  test('a configured manifest can be installed, and its configure page still opens when broken', async () => {
    const { addon } = addonWith(Settings);
    const bare = await (await call(addon, '/manifest.json')).json();
    assert.equal(bare.behaviorHints.configurationRequired, true);

    const segment = new URL(
      await addon.manifestUrl(BASE, { token: 'a', quality: 'sd' })
    ).pathname.split('/')[1];
    const configured = await (
      await call(addon, `/${segment}/manifest.json`)
    ).json();
    assert.equal(configured.behaviorHints.configurationRequired, false);
    assert.equal(configured.name, 'Test (sd)');
    assert.deepEqual(configured.catalogs, []);

    assert.equal(
      await (await call(addon, `/${segment}/configure`)).text(),
      '<p>reconfigure</p>'
    );
    assert.equal(
      await (await call(addon, '/garbage/configure')).text(),
      '<p>new</p>'
    );
  });
});

describe('generated configure page', () => {
  const Keys = z.object({
    apiKey: z.string().min(8).meta({ writeOnly: true }),
    region: z.enum(['eu', 'us']).default('eu'),
  });
  const addon = defineAddon({
    manifest: manifest(),
    config: { schema: Keys, secret: 'k'.repeat(32) },
    stream: async () => ({ streams: [] }),
  });
  const post = (path: string, values: unknown) =>
    call(addon, path, { method: 'POST', body: JSON.stringify({ values }) });

  test('a secret is never sent back to the browser, and a blank one keeps its saved value', async () => {
    const created = await (
      await post('/configure', { apiKey: 'sk-live-1234', region: 'us' })
    ).json();
    const segment = new URL(created.manifestUrl).pathname.split('/')[1];

    const page = await (await call(addon, `/${segment}/configure`)).text();
    assert.doesNotMatch(page, /sk-live-1234/);
    assert.match(page, /"region":"us"/);

    const updated = await (
      await post(`/${segment}/configure`, { region: 'eu' })
    ).json();
    const next = new URL(updated.manifestUrl).pathname.split('/')[1];
    const seen: unknown[] = [];
    const reader = defineAddon({
      manifest: manifest(),
      config: { schema: Keys, secret: 'k'.repeat(32) },
      stream: async ({ config }) => {
        seen.push(config);
        return { streams: [] };
      },
    });
    await call(reader, `/${next}/stream/movie/tt1.json`);
    assert.deepEqual(seen, [{ apiKey: 'sk-live-1234', region: 'eu' }]);
  });

  test('text from the manifest or a saved value cannot break out of the page', async () => {
    const hostile = '</script><script>alert(1)</script>';
    const page = defineAddon({
      manifest: manifest({ name: hostile }),
      config: z.object({ note: z.string().default('') }),
      stream: async () => ({ streams: [] }),
    });
    const segment = new URL(
      await page.manifestUrl(BASE, { note: hostile })
    ).pathname.split('/')[1];
    const body = await (await call(page, `/${segment}/configure`)).text();
    const embedded = body
      .split('<script type="application/json" id="data">')[1]
      .split('</script>')[0];
    const data = JSON.parse(embedded);
    assert.equal(data.manifest.name, hostile);
    assert.equal(data.values.note, hostile);
  });

  test('the footer reaches the page', async () => {
    const footer = 'Data from [TMDB](https://www.themoviedb.org)';
    const page = defineAddon({
      manifest: manifest(),
      stream: async () => ({ streams: [] }),
      footer,
    });
    const body = await (await call(page, '/configure')).text();
    const data = JSON.parse(
      body
        .split('<script type="application/json" id="data">')[1]
        .split('</script>')[0]
    );
    assert.equal(data.footer, footer);
  });

  test('in a list, a moved entry keeps its own saved secret, and a changed one keeps none', async () => {
    const Services = z.object({
      services: z.array(
        z.discriminatedUnion('service', [
          z.object({
            service: z.literal('debrid'),
            apiKey: z.string().min(1).meta({ writeOnly: true }),
          }),
          z.object({
            service: z.literal('cloud'),
            apiKey: z.string().min(1).meta({ writeOnly: true }),
          }),
          z.object({
            service: z.literal('usenet'),
            host: z.string(),
            password: z.string().min(1).meta({ writeOnly: true }),
          }),
        ])
      ),
    });
    const seen: unknown[] = [];
    const lists = defineAddon({
      manifest: manifest(),
      config: { schema: Services, secret: 'k'.repeat(32) },
      stream: async ({ config }) => {
        seen.push(config);
        return { streams: [] };
      },
    });
    const send = (path: string, services: unknown[]) =>
      call(lists, path, {
        method: 'POST',
        body: JSON.stringify({ values: { services } }),
      });
    const segmentOf = async (res: Response) =>
      new URL((await res.json()).manifestUrl).pathname.split('/')[1];

    const first = await segmentOf(
      await send('/configure', [
        { service: 'debrid', apiKey: 'debrid-key' },
        {
          service: 'usenet',
          host: 'news.example',
          password: 'usenet-password',
        },
      ])
    );
    const page = await (await call(lists, `/${first}/configure`)).text();
    assert.doesNotMatch(page, /debrid-key|usenet-password/);

    const swapped = await segmentOf(
      await send(`/${first}/configure`, [
        { service: 'usenet', host: 'news.example', $origin: 1 },
        { service: 'debrid', $origin: 0 },
      ])
    );
    await call(lists, `/${swapped}/stream/movie/tt1.json`);
    assert.deepEqual(seen.at(-1), {
      services: [
        {
          service: 'usenet',
          host: 'news.example',
          password: 'usenet-password',
        },
        { service: 'debrid', apiKey: 'debrid-key' },
      ],
    });

    const changed = await send(`/${first}/configure`, [
      { service: 'cloud', $origin: 0 },
    ]);
    assert.equal(changed.status, 400);
    assert.deepEqual((await changed.json()).issues[0].path, [
      'services',
      '0',
      'apiKey',
    ]);
  });

  test('problems come back per field, for the form to place', async () => {
    const res = await post('/configure', { apiKey: 'short', region: 'mars' });
    assert.equal(res.status, 400);
    const { issues } = await res.json();
    assert.deepEqual(
      issues.map((issue: { path: string[] }) => issue.path),
      [['apiKey'], ['region']]
    );
  });
});

describe('definition checks', () => {
  test('a manifest that contradicts the handlers fails at startup, naming every problem', () => {
    assert.throws(
      () =>
        defineAddon({
          manifest: manifest({
            resources: ['meta', 'watch_state'],
            catalogs: [{ type: 'movie', id: 'top', name: 'Top' }],
          }),
          stream: async () => ({ streams: [] }),
        }),
      (error: unknown) =>
        error instanceof AddonDefinitionError &&
        /"meta" but it has no handler/.test(error.message) &&
        /stream handler but resources does not list "stream"/.test(
          error.message
        ) &&
        /catalogs are listed/.test(error.message) &&
        /watchState block go together/.test(error.message)
    );
  });

  test('a version clients cannot parse is caught at startup', () => {
    assert.throws(
      () =>
        defineAddon({
          manifest: manifest({ version: 'v1.0' }),
          stream: async () => ({ streams: [] }),
        }),
      /semantic version/
    );
  });

  test('a resource a configuration does not declare answers 404', async () => {
    const addon = defineAddon({
      manifest: (config) =>
        manifest({
          resources: config?.streams ? ['stream', 'meta'] : ['meta'],
        }),
      config: z.object({ streams: z.boolean().default(false) }),
      meta: async () => null,
      stream: async () => ({ streams: [] }),
    });
    assert.equal((await call(addon, '/stream/movie/tt1.json')).status, 404);
    const segment = new URL(
      await addon.manifestUrl(BASE, { streams: true })
    ).pathname.split('/')[1];
    assert.equal(
      (await call(addon, `/${segment}/stream/movie/tt1.json`)).status,
      200
    );
  });
});
