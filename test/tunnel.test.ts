import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stampCredential } from '../src/proxy/tunnel.js';
import { Upstream } from '../src/bar/upstream.js';

test('a dummy app token on the status socket is replaced with the Bar\'s', () => {
  const upstream = new Upstream({
    addr: 'http://192.168.0.186/',
    httpPassword: 'bar-secret',
  });
  const target = new URL('ws://127.0.0.1:4111/api/status/ws?x-api-token=managed-by-wm');

  stampCredential(target, upstream);

  assert.equal(target.searchParams.get('x-api-token'), 'bar-secret');
});
