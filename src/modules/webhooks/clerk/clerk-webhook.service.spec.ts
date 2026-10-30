import { createHmac } from 'node:crypto';
import { describe, expect, it, jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import type { Pool, PoolClient } from 'pg';
import type { PinoLogger } from 'nestjs-pino';
import { ClerkWebhookService } from './clerk-webhook.service.js';
import type { ClerkOrganizationMetadataService } from './clerk-organization-metadata.service.js';

const secret = `whsec_${Buffer.from('unit-test-signing-key').toString('base64')}`;
const tenantId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';

function signedEvent(event: unknown, id: string): { body: Buffer; headers: { id: string; timestamp: string; signature: string } } {
  const body = Buffer.from(JSON.stringify(event));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', Buffer.from(secret.slice('whsec_'.length), 'base64'))
    .update(`${id}.${timestamp}.${body.toString('utf8')}`).digest('base64');
  return { body, headers: { id, timestamp, signature: `v1,${signature}` } };
}

function setup(responses: { rows?: Record<string, unknown>[]; rowCount?: number }[]) {
  const query = jest.fn(async (_sql: string, _values?: readonly unknown[]) => responses.shift() ?? { rows: [], rowCount: 1 });
  const client = { query, release: jest.fn() } as unknown as PoolClient;
  const pool = { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
  const config = { get: jest.fn((key: string) => key === 'CLERK_WEBHOOK_SECRET' ? secret : 'sk_test_unit') } as unknown as ConfigService;
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as PinoLogger;
  const organizationMetadata = { setTenantId: jest.fn().mockResolvedValue(undefined) } as unknown as ClerkOrganizationMetadataService;
  return { service: new ClerkWebhookService(pool, config, logger, organizationMetadata), query, organizationMetadata };
}

describe('ClerkWebhookService provisioning', () => {
  it('creates an organization tenant and links its creator as tenant admin in one transaction', async () => {
    const { service, query, organizationMetadata } = setup([
      { rows: [], rowCount: null },
      { rows: [{ event_id: 'evt_org' }], rowCount: 1 },
      { rows: [{ id: tenantId }], rowCount: 1 },
      { rows: [], rowCount: 0 },
      { rows: [{ id: userId }], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);
    const message = signedEvent({ type: 'organization.created', data: { id: 'org_acme', name: 'Acme', created_by: 'user_creator' } }, 'evt_org');

    await service.handle(message.body, message.headers);

    expect(query.mock.calls.map(([sql]) => String(sql))).toEqual(expect.arrayContaining([
      expect.stringContaining('provisioned_by_clerk_organization_id'),
      expect.stringContaining('INSERT INTO public.memberships'),
      'COMMIT',
    ]));
    expect(query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO public.memberships'))?.[1])
      .toEqual([tenantId, userId, 'tenant_admin']);
    expect(organizationMetadata.setTenantId).toHaveBeenCalledWith('org_acme', tenantId);
    expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
  });

  it('creates membership for an existing Clerk user and assigns least privilege for org:member', async () => {
    const { service, query } = setup([
      { rows: [], rowCount: null },
      { rows: [{ event_id: 'evt_member' }], rowCount: 1 },
      { rows: [{ id: tenantId }], rowCount: 1 },
      { rows: [], rowCount: 0 },
      { rows: [{ id: userId }], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);
    const message = signedEvent({
      type: 'organization_membership.created',
      data: { organization_id: 'org_acme', public_user_data: { user_id: 'user_member' }, role: 'org:member' },
    }, 'evt_member');

    await service.handle(message.body, message.headers);

    expect(query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO public.memberships'))?.[1])
      .toEqual([tenantId, userId, 'viewer']);
    expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
  });
});
