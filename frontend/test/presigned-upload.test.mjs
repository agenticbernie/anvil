import { test } from 'node:test';
import assert from 'node:assert/strict';
import { putPresignedObject } from '../src/lib/api/presigned-upload.ts';

const signedHeaders = { 'content-length': '4', 'content-type': 'application/pdf', 'x-amz-meta-sha256': 'digest' };

test('uploads ciphertext with only the browser-settable signed headers', async (t) => {
  const ciphertext = new Uint8Array([1, 2, 3, 4]).buffer;
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }));
  await putPresignedObject('https://storage.example/signed', signedHeaders, ciphertext, 'application/pdf');
  const [url, request] = fetchMock.mock.calls[0].arguments;
  assert.equal(url, 'https://storage.example/signed');
  assert.equal(request.method, 'PUT');
  assert.equal(request.body, ciphertext);
  assert.equal(request.credentials, 'omit');
  assert.deepEqual([...request.headers.entries()], [
    ['content-type', 'application/pdf'], ['x-amz-meta-sha256', 'digest'],
  ]);
});

test('rejects a mismatched signed length or content type before making a request', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }));
  await assert.rejects(putPresignedObject('https://storage.example/signed', signedHeaders, new ArrayBuffer(3), 'application/pdf'), /length/);
  await assert.rejects(putPresignedObject('https://storage.example/signed', signedHeaders, new ArrayBuffer(4), 'image/png'), /content type/);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('does not expose storage response details on failure', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('sensitive storage details', { status: 403 }));
  await assert.rejects(putPresignedObject('https://storage.example/signed', signedHeaders, new ArrayBuffer(4), 'application/pdf'),
    { message: 'The signed file upload failed. Request a new upload URL and retry.' });
});
