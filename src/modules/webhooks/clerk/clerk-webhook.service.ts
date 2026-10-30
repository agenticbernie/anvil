import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type { Pool } from 'pg';
import { PG_POOL } from '../../../infrastructure/database/postgres.tokens.js';
import { Inject } from '@nestjs/common';
import { verifyClerkWebhookSignature } from './clerk-webhook.signature.js';
import { ClerkOrganizationMetadataService } from './clerk-organization-metadata.service.js';

interface ClerkEvent {
  readonly type: string;
  readonly data: {
    readonly id?: string;
    readonly created_by?: string | null;
    readonly organization_id?: string;
    readonly role?: string;
    readonly public_user_data?: { readonly user_id?: string } | null;
    readonly user_id?: string;
    readonly email_addresses?: readonly { readonly id?: string; readonly email_address?: string; readonly verification?: { readonly status?: string } }[];
    readonly primary_email_address_id?: string | null;
    readonly name?: string;
  };
}

interface OrganizationMetadataSync {
  readonly organizationId: string;
  readonly tenantId: string;
}

@Injectable()
export class ClerkWebhookService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly config: ConfigService,
    @InjectPinoLogger(ClerkWebhookService.name) private readonly logger: PinoLogger,
    private readonly organizationMetadata: ClerkOrganizationMetadataService,
  ) {}

  async handle(rawBody: Buffer | undefined, headers: { id: string | undefined; timestamp: string | undefined; signature: string | undefined }): Promise<void> {
    const secret = this.config.get<string>('CLERK_WEBHOOK_SECRET') ?? '';
    if (!secret) throw new ServiceUnavailableException('Clerk webhook is not configured.');
    verifyClerkWebhookSignature(rawBody, headers, secret);

    let event: ClerkEvent;
    try { event = JSON.parse(rawBody!.toString('utf8')) as ClerkEvent; }
    catch { throw new BadRequestException('Webhook body is invalid JSON.'); }
    if (!headers.id || !event.type || !event.data || typeof event.data !== 'object') {
      throw new BadRequestException('Webhook event payload is invalid.');
    }
    if (!['user.created', 'organization.created', 'organization_membership.created'].includes(event.type)) {
      this.logger.info({ eventId: headers.id, eventType: event.type }, 'Ignoring unconfigured Clerk event type');
      return;
    }

    const client = await this.pool.connect();
    let organizationMetadataSync: OrganizationMetadataSync | undefined;
    let duplicate = false;
    try {
      await client.query('BEGIN');
      const claimed = await client.query(
        `INSERT INTO public.clerk_webhook_events (event_id, event_type)
         VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
        [headers.id, event.type],
      );
      if (claimed.rowCount === 0) {
        duplicate = true;
        if (event.type === 'organization.created' && event.data.id) {
          const existingTenant = await client.query<{ id: string }>(
            `SELECT id::text AS id FROM public.tenants
             WHERE provisioned_by_clerk_organization_id = $1 LIMIT 1`,
            [event.data.id],
          );
          const tenantId = existingTenant.rows[0]?.id;
          if (tenantId) organizationMetadataSync = { organizationId: event.data.id, tenantId };
        }
        await client.query('COMMIT');
      } else {
        if (event.type === 'user.created') await this.provisionUser(client, event);
        if (event.type === 'organization.created') organizationMetadataSync = await this.provisionOrganization(client, event);
        if (event.type === 'organization_membership.created') await this.provisionOrganizationMembership(client, event);
        await client.query('COMMIT');
      }
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Clerk webhook transaction and rollback both failed.');
      }
      this.logger.error({ eventId: headers.id, eventType: event.type, err: error }, 'Clerk webhook processing failed');
      throw error;
    } finally {
      client.release();
    }

    if (organizationMetadataSync) {
      await this.syncOrganizationTenantMetadata(organizationMetadataSync, headers.id, duplicate);
    }
    this.logger.info(
      { eventId: headers.id, eventType: event.type, duplicate },
      duplicate ? 'Duplicate Clerk webhook acknowledged' : 'Clerk webhook processed',
    );
  }

  private async provisionUser(client: import('pg').PoolClient, event: ClerkEvent): Promise<void> {
    const clerkUserId = event.data.id;
    const primaryEmail = event.data.email_addresses?.find(
      (email) => email.id === event.data.primary_email_address_id,
    )?.email_address;
    if (!clerkUserId || (primaryEmail && primaryEmail.length > 320)) {
      throw new BadRequestException('Clerk user payload is invalid.');
    }
    const user = await this.upsertClerkUser(client, clerkUserId);
    const userId = user.rows[0]?.id;
    if (!userId) throw new Error('Could not persist Clerk user mapping.');

    const tenantName = `${primaryEmail ?? 'New user'} tenant`.slice(0, 200);
    const tenant = await client.query<{ id: string }>(
      `INSERT INTO public.tenants (name, status, provisioned_by_clerk_user_id)
       VALUES ($1, 'active', $2)
       ON CONFLICT (provisioned_by_clerk_user_id) DO UPDATE SET name = EXCLUDED.name
       RETURNING id::text AS id`,
      [tenantName, clerkUserId],
    );
    const tenantId = tenant.rows[0]?.id;
    if (!tenantId) throw new Error('Could not persist tenant for Clerk user.');
    await client.query(
      `INSERT INTO public.memberships (tenant_id, user_id, role, status)
       VALUES ($1::uuid, $2::uuid, 'tenant_admin', 'active')
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role, status = 'active', deleted_at = NULL`,
      [tenantId, userId],
    );
  }

  private async provisionOrganization(client: import('pg').PoolClient, event: ClerkEvent): Promise<OrganizationMetadataSync> {
    const organizationId = event.data.id;
    const name = event.data.name?.trim();
    if (!organizationId || !name || name.length > 200) throw new BadRequestException('Clerk organization payload is invalid.');
    const tenant = await client.query<{ id: string }>(
      `INSERT INTO public.tenants (name, status, provisioned_by_clerk_organization_id)
       VALUES ($1, 'active', $2)
       ON CONFLICT (provisioned_by_clerk_organization_id) DO UPDATE SET name = EXCLUDED.name
       RETURNING id::text AS id`,
      [name, organizationId],
    );
    const tenantId = tenant.rows[0]?.id;
    if (!tenantId) throw new Error('Could not persist tenant for Clerk organization.');

    if (event.data.created_by) {
      const user = await this.upsertClerkUser(client, event.data.created_by);
      const userId = user.rows[0]?.id;
      if (!userId) throw new Error('Could not persist organization creator mapping.');
      await this.upsertMembership(client, tenantId, userId, 'tenant_admin');
    }
    return { organizationId, tenantId };
  }

  private async provisionOrganizationMembership(client: import('pg').PoolClient, event: ClerkEvent): Promise<void> {
    const organizationId = event.data.organization_id;
    const clerkUserId = event.data.public_user_data?.user_id ?? event.data.user_id;
    if (!organizationId || !clerkUserId) throw new BadRequestException('Clerk organization membership payload is invalid.');

    const tenant = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM public.tenants WHERE provisioned_by_clerk_organization_id = $1 LIMIT 1`,
      [organizationId],
    );
    const tenantId = tenant.rows[0]?.id;
    if (!tenantId) throw new ServiceUnavailableException('Tenant for Clerk organization is not available yet; retry webhook delivery.');

    const user = await this.upsertClerkUser(client, clerkUserId);
    const userId = user.rows[0]?.id;
    if (!userId) throw new Error('Could not persist Clerk member mapping.');
    const role = event.data.role === 'org:admin' ? 'tenant_admin' : 'viewer';
    await this.upsertMembership(client, tenantId, userId, role);
  }

  private async upsertClerkUser(client: import('pg').PoolClient, clerkUserId: string): Promise<{ rows: { id: string }[] }> {
    // Supabase UUIDs can arrive after Clerk webhooks; the Clerk mapping is sufficient
    // to safely create memberships now and attach auth_user_id when it becomes available.
    const identity = await client.query<{ user_id: string }>(
      `SELECT user_id::text AS user_id FROM auth.identities
       WHERE provider_id = $1 AND provider IN ('custom:clerk', 'clerk') LIMIT 1`,
      [clerkUserId],
    );
    return client.query<{ id: string }>(
      `INSERT INTO public.users (auth_user_id, clerk_user_id, status)
       VALUES ($1::uuid, $2, 'active')
       ON CONFLICT (clerk_user_id) DO UPDATE
       SET auth_user_id = COALESCE(EXCLUDED.auth_user_id, public.users.auth_user_id), status = 'active', deleted_at = NULL
       RETURNING id::text AS id`,
      [identity.rows[0]?.user_id ?? null, clerkUserId],
    );
  }

  private async upsertMembership(
    client: import('pg').PoolClient,
    tenantId: string,
    userId: string,
    role: 'tenant_admin' | 'viewer',
  ): Promise<void> {
    await client.query(
      `INSERT INTO public.memberships (tenant_id, user_id, role, status)
       VALUES ($1::uuid, $2::uuid, $3, 'active')
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role, status = 'active', deleted_at = NULL`,
      [tenantId, userId, role],
    );
  }

  private async syncOrganizationTenantMetadata(
    sync: OrganizationMetadataSync,
    eventId: string,
    duplicate: boolean,
  ): Promise<void> {
    try {
      await this.organizationMetadata.setTenantId(sync.organizationId, sync.tenantId);
    } catch (error) {
      this.logger.warn(
        { eventId, organizationId: sync.organizationId, tenantId: sync.tenantId, duplicate, err: error },
        'Tenant committed, but Clerk organization metadata sync failed; webhook retry can repair it',
      );
      throw new ServiceUnavailableException('Tenant was created, but Clerk organization metadata could not be updated. Retry the webhook.');
    }
  }
}
