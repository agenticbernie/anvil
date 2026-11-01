import 'reflect-metadata';

import { createCipheriv, createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import { Queue, QueueEvents } from 'bullmq';
import { Redis as RedisClient } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Pool } from 'pg';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PostgresUnitOfWork } from '../src/infrastructure/database/postgres-unit-of-work.js';
import { UNIT_OF_WORK } from '../src/infrastructure/database/postgres.tokens.js';
import { AUDIT_EVENT_REPOSITORY } from '../src/modules/audit/audit.tokens.js';
import { PostgresAuditEventRepository } from '../src/modules/audit/infrastructure/postgres-audit-event.repository.js';
import type { AuthenticatedUser } from '../src/modules/auth/tenant.types.js';
import { RolesGuard } from '../src/modules/auth/roles.guard.js';
import { SupabaseAuthGuard } from '../src/modules/auth/supabase-auth.guard.js';
import { TenantContextGuard } from '../src/modules/auth/tenant-context.guard.js';
import { PostgresCaseRepository } from '../src/modules/cases/infrastructure/postgres-case.repository.js';
import { CaseDocumentsController, DocumentsController } from '../src/modules/documents/api/documents.controller.js';
import { DocumentService } from '../src/modules/documents/application/document.service.js';
import type { DocumentProcessingPayload, StorageProvider } from '../src/modules/documents/application/document.types.js';
import type { ExtractionJobPayload } from '../src/modules/extraction/application/extraction.types.js';
import type { ExtractionService } from '../src/modules/extraction/application/extraction.service.js';
import type { MemoGenerationPayload } from '../src/modules/memos/application/memo.types.js';
import { PostgresDocumentRepository } from '../src/modules/documents/infrastructure/postgres-document.repository.js';
import { PostgresDocumentReservationMaintenanceRepository } from '../src/modules/documents/infrastructure/postgres-document-reservation-maintenance.repository.js';
import { PostgresOutboxRepository } from '../src/modules/documents/infrastructure/postgres-outbox.repository.js';
import { PostgresProcessingJobRepository } from '../src/modules/documents/infrastructure/postgres-processing-job.repository.js';
import { DocumentEncryptionService } from '../src/modules/documents/infrastructure/document-encryption.service.js';
import { DocumentTextCipherService } from '../src/modules/documents/infrastructure/document-text-cipher.service.js';
import { PostgresDocumentVersionRepository } from '../src/modules/documents/infrastructure/postgres-document-version.repository.js';
import {
  DOCUMENT_PARSE_DLQ_QUEUE_NAME, DOCUMENT_PARSE_QUEUE_NAME, DOCUMENT_EXTRACT_QUEUE_NAME,
  MEMO_GENERATE_QUEUE_NAME, NEEDS_MANUAL_REVIEW_QUEUE_NAME,
} from '../src/modules/jobs/queue.tokens.js';
import { DocumentParseWorker } from '../src/workers/document-parse.worker.js';
import { DocumentReservationCleanupWorker } from '../src/workers/document-reservation-cleanup.worker.js';
import { OutboxPublisherWorker } from '../src/workers/outbox-publisher.worker.js';
import { ExtractionWorker } from '../src/workers/extraction.worker.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const actorId = '00000000-0000-4000-8000-000000000011';
const caseId = '00000000-0000-4000-8000-000000000021';
const entityId = '00000000-0000-4000-8000-000000000031';
const objectBytes = Buffer.from('%PDF-1.7 Anvil phase 3 test fixture');
const objectSha256 = createHash('sha256').update(objectBytes).digest('hex');
let uploadedBytes = objectBytes;

describe('Phase 3 outbox and worker integration', () => {
  let postgres: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let redis: Awaited<ReturnType<RedisContainer['start']>>;
  let pool: Pool;
  let unitOfWork: PostgresUnitOfWork;
  let documentRepository: PostgresDocumentRepository;
  let app: any;
  let parseQueue: Queue<DocumentProcessingPayload>;
  let dlqQueue: Queue<DocumentProcessingPayload>;
  let extractionQueue: Queue<ExtractionJobPayload>;
  let memoQueue: Queue<MemoGenerationPayload>;
  let reviewQueue: Queue<Record<string, string>>;
  let redisClient: RedisClient;
  let publisher: OutboxPublisherWorker;
  let parser: DocumentParseWorker;
  let storageReadCount = 0;
  let storageDeleteKeys: string[];
  let finalizedObjects: Map<string, Buffer>;
  let stagingObjects: Set<string>;
  let storage: StorageProvider;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer('postgres:16-alpine').start();
    redis = await new RedisContainer('redis:7-alpine').start();
    pool = new Pool({ connectionString: postgres.getConnectionUri() });
    await pool.query(`
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE SCHEMA auth;
      CREATE TABLE auth.users (id uuid PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      GRANT USAGE ON SCHEMA auth TO authenticated, service_role;
      GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, service_role;
    `);
    for (const migration of [
      '0001_init_schema.sql',
      '20261030120000_add_cases_and_idempotency.sql',
      '20261030130000_add_outbox_and_jobs.sql',
      '20261030140000_secure_document_uploads.sql',
      '20261030150000_harden_document_upload_lifecycle.sql',
      '20261030160000_add_extraction_and_memo_tables.sql',
      '20261030180000_bound_memo_generation_requests.sql',
    ]) {
      await pool.query(readFileSync(resolve(process.cwd(), 'supabase/migrations', migration), 'utf8'));
    }
    await pool.query('INSERT INTO auth.users (id) VALUES ($1)', [actorId]);
    await pool.query('INSERT INTO public.tenants (id, name) VALUES ($1, $2)', [tenantId, 'Phase 3 tenant']);
    await pool.query('INSERT INTO public.users (auth_user_id) VALUES ($1)', [actorId]);
    await pool.query(
      `INSERT INTO public.memberships (tenant_id, user_id, role)
       SELECT $1, id, 'originator' FROM public.users WHERE auth_user_id = $2`,
      [tenantId, actorId],
    );
    await pool.query(
      `INSERT INTO public.credit_cases (id, tenant_id, entity_id, case_number, status, currency)
       VALUES ($1, $2, $3, 'PHASE3-IT-CASE', 'draft', 'USD')`,
      [caseId, tenantId, entityId],
    );
    const legacyDocumentId = randomUUID();
    const legacyJobId = randomUUID();
    const nonce = Buffer.alloc(12, 3).toString('base64');
    const wrappedKey = `v1.${nonce}.${Buffer.alloc(48, 4).toString('base64')}`;
    await pool.query(
      `INSERT INTO public.documents (
         id, tenant_id, case_id, uploaded_by, object_key, content_type, size_bytes, storage_size_bytes,
         sha256, wrapped_data_key, encryption_nonce, encryption_key_version, status
       ) VALUES ($1, $2, $3, $4, $5, 'application/pdf', 1, 17, $6, $7, $8, 'v1', 'failed')`,
      [legacyDocumentId, tenantId, caseId, actorId,
        `tenants/${tenantId}/cases/${caseId}/documents/staging/${legacyDocumentId}`,
        'a'.repeat(64), wrappedKey, nonce],
    );
    await pool.query(
      `INSERT INTO public.processing_jobs (id, tenant_id, case_id, document_id, actor_id, job_type, last_error)
       VALUES ($1, $2, $3, $4, $5, 'document.parse', 'R2 diagnostic contained borrower-tax-id-12345')`,
      [legacyJobId, tenantId, caseId, legacyDocumentId, actorId],
    );
    await pool.query(readFileSync(resolve(process.cwd(), 'supabase/migrations/20261030190000_cleanup_finalized_staging_objects.sql'), 'utf8'));
    await pool.query(readFileSync(resolve(process.cwd(), 'supabase/migrations/20261030200000_tenant_document_storage_budget.sql'), 'utf8'));
    const scrubbedLegacyError = await pool.query<{ last_error: string }>(
      'SELECT last_error FROM public.processing_jobs WHERE tenant_id = $1 AND id = $2', [tenantId, legacyJobId],
    );
    expect(scrubbedLegacyError.rows[0]?.last_error).toBe('Document processing failed.');

    redisClient = new RedisClient(redis.getConnectionUrl(), {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    parseQueue = new Queue<DocumentProcessingPayload>(DOCUMENT_PARSE_QUEUE_NAME, { connection: redisClient });
    dlqQueue = new Queue<DocumentProcessingPayload>(DOCUMENT_PARSE_DLQ_QUEUE_NAME, { connection: redisClient });
    extractionQueue = new Queue<ExtractionJobPayload>(DOCUMENT_EXTRACT_QUEUE_NAME, { connection: redisClient });
    memoQueue = new Queue<MemoGenerationPayload>(MEMO_GENERATE_QUEUE_NAME, { connection: redisClient });
    reviewQueue = new Queue<Record<string, string>>(NEEDS_MANUAL_REVIEW_QUEUE_NAME, { connection: redisClient });

    unitOfWork = new PostgresUnitOfWork(pool);
    documentRepository = new PostgresDocumentRepository();
    const jobsRepository = new PostgresProcessingJobRepository();
    const outboxRepository = new PostgresOutboxRepository(pool);
    const casesRepository = new PostgresCaseRepository();
    const auditRepository = new PostgresAuditEventRepository();
    const encryption = new DocumentEncryptionService(new ConfigService({
      PII_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 29).toString('base64'),
      PII_ENCRYPTION_KEY_VERSION: 'v1',
    }));
    storageDeleteKeys = [];
    finalizedObjects = new Map();
    stagingObjects = new Set();
    storage = {
      presignPut: async (key, _type, _sha256, contentLengthBytes) => {
        stagingObjects.add(key);
        return ({
        uploadUrl: 'https://r2.test.invalid/presigned-put',
        requiredHeaders: {
          'content-length': String(contentLengthBytes), 'content-type': 'application/pdf', 'x-amz-meta-sha256': objectSha256,
        },
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      });
      },
      headObject: async () => ({ contentLength: uploadedBytes.length, contentType: 'application/pdf', sha256Metadata: objectSha256, eTag: '"phase3-test-etag"' }),
      finalizeUpload: async (_stagingKey, finalKey) => { finalizedObjects.set(finalKey, Buffer.from(uploadedBytes)); },
      deleteObject: async (objectKey) => {
        storageDeleteKeys.push(objectKey);
        stagingObjects.delete(objectKey);
        finalizedObjects.delete(objectKey);
      },
      getObjectStream: async (objectKey) => {
        storageReadCount += 1;
        const bytes = finalizedObjects.get(objectKey);
        if (!bytes) throw new Error('Worker attempted to read a non-finalized object.');
        return Readable.from([bytes]);
      },
    };
    const documentService = new DocumentService(
      documentRepository, jobsRepository, outboxRepository, casesRepository, storage, auditRepository, unitOfWork, encryption,
    );
    const builder = Test.createTestingModule({
      controllers: [CaseDocumentsController, DocumentsController],
      providers: [{ provide: DocumentService, useValue: documentService }],
    });
    builder.overrideGuard(SupabaseAuthGuard).useValue({ canActivate: () => true });
    builder.overrideGuard(TenantContextGuard).useValue({ canActivate: () => true });
    builder.overrideGuard(RolesGuard).useValue({ canActivate: () => true });
    const moduleRef = await builder.compile();
    app = moduleRef.createNestApplication();
    app.use((_req: any, _res: any, next: () => void) => {
      _req.user = { id: actorId, appMetadata: {} } satisfies AuthenticatedUser;
      _req.tenantContext = { tenantId, actorId, role: 'originator' };
      next();
    });
    app.setGlobalPrefix('v1');
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.init();

    publisher = new OutboxPublisherWorker(outboxRepository, unitOfWork, parseQueue, dlqQueue, extractionQueue, memoQueue, reviewQueue);
    const textCipher = new DocumentTextCipherService(new ConfigService({
      PII_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 29).toString('base64'), PII_ENCRYPTION_KEY_VERSION: 'v1',
    }));
    parser = new DocumentParseWorker(
      documentRepository, jobsRepository, outboxRepository, storage, encryption, unitOfWork,
      new PostgresDocumentVersionRepository(), textCipher, redisClient, new ConfigService({}),
    );
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await parseQueue?.close();
    await dlqQueue?.close();
    await extractionQueue?.close();
    await memoQueue?.close();
    await reviewQueue?.close();
    if (redisClient?.status !== 'end') await redisClient?.quit();
    await pool?.end();
    await redis?.stop();
    await postgres?.stop();
  });

  it('confirms upload, commits outbox and job, publishes BullMQ work, and processes it idempotently', async () => {
    const presign = await request(app.getHttpServer())
      .post(`/v1/cases/${caseId}/documents/presign`)
      .set('x-tenant-id', tenantId)
      .send({ contentType: 'application/pdf', sizeBytes: objectBytes.length, sha256: objectSha256 });
    if (presign.status !== 201) throw new Error(`Presign returned ${presign.status}: ${JSON.stringify(presign.body)}`);
    expect(presign.headers['cache-control']).toBe('no-store');
    const cipher = createCipheriv(
      'aes-256-gcm',
      Buffer.from(presign.body.encryption.keyBase64, 'base64'),
      Buffer.from(presign.body.encryption.nonceBase64, 'base64'),
    );
    cipher.setAAD(Buffer.from(presign.body.encryption.additionalDataBase64, 'base64'));
    uploadedBytes = Buffer.concat([cipher.update(objectBytes), cipher.final(), cipher.getAuthTag()]);
    expect(presign.body.requiredHeaders['content-length']).toBe(String(uploadedBytes.length));

    const confirmed = await request(app.getHttpServer())
      .post(`/v1/documents/${presign.body.documentId}/confirm-upload`)
      .set('x-tenant-id', tenantId)
      .send({ sha256: objectSha256 })
      .expect(202);
    expect(storageReadCount).toBe(0);
    const processingJobId = confirmed.body.job_id as string;

    const pending = await pool.query(
      `SELECT event.status, job.status AS job_status FROM public.outbox_events AS event
       JOIN public.processing_jobs AS job ON job.tenant_id = event.tenant_id AND job.id = (event.payload->>'processingJobId')::uuid
       WHERE event.tenant_id = $1 AND event.event_type = 'document.uploaded' AND event.payload->>'processingJobId' = $2`,
      [tenantId, processingJobId],
    );
    expect(confirmed.body.status).toBe('queued');
    expect(pending.rows).toEqual([{ status: 'pending', job_status: 'queued' }]);

    expect(await publisher.publishPendingBatch()).toBe(1);
    const queued = await parseQueue.getJob(processingJobId);
    expect(queued?.data).toMatchObject({ tenantId, actorId, documentId: presign.body.documentId, caseId });
    expect(queued?.opts.attempts).toBe(3);
    expect(queued?.opts.backoff).toEqual({ type: 'exponential', delay: 1_000 });

    await parser.processJob(queued!.data);
    await parser.processJob(queued!.data);

    const final = await pool.query(
      `SELECT job.status AS job_status, document.status AS document_status, event.status AS event_status
       FROM public.processing_jobs AS job
       JOIN public.documents AS document ON document.tenant_id = job.tenant_id AND document.id = job.document_id
       JOIN public.outbox_events AS event ON event.tenant_id = job.tenant_id AND event.payload->>'processingJobId' = job.id::text
       WHERE job.tenant_id = $1 AND job.id = $2 AND event.event_type = 'document.uploaded'`,
      [tenantId, processingJobId],
    );
    expect(final.rows).toEqual([{ job_status: 'succeeded', document_status: 'processed', event_status: 'published' }]);
    const extractedSource = await pool.query(
      `SELECT source_kind, source_page_count, octet_length(source_text_ciphertext) > 0 AS encrypted
       FROM public.document_versions WHERE tenant_id = $1 AND document_id = $2`,
      [tenantId, presign.body.documentId],
    );
    expect(extractedSource.rows).toEqual([{ source_kind: 'mock', source_page_count: 1, encrypted: true }]);
    expect(storageReadCount).toBe(1);
    expect(await dlqQueue.getJob(processingJobId)).toBeUndefined();

    const pendingExtraction = await pool.query<{ id: string; status: string }>(
      `SELECT id::text AS id, status FROM public.outbox_events
       WHERE tenant_id = $1 AND event_type = 'document.extract.requested' AND payload->>'processingJobId' = $2`,
      [tenantId, processingJobId],
    );
    expect(pendingExtraction.rows).toHaveLength(1);
    expect(pendingExtraction.rows[0]?.status).toBe('pending');
    const eventId = pendingExtraction.rows[0]!.id;
    const received: ExtractionJobPayload[] = [];
    const extractionService = { process: async (payload: ExtractionJobPayload) => { received.push(payload); return { status: 'succeeded', factCount: 0 }; } } as unknown as ExtractionService;
    const consumer = new ExtractionWorker(extractionService, redisClient);
    const queueEvents = new QueueEvents(DOCUMENT_EXTRACT_QUEUE_NAME, { connection: redisClient });
    try {
      await queueEvents.waitUntilReady();
      consumer.onApplicationBootstrap();
      expect(await publisher.publishPendingBatch()).toBe(1);
      const extractionJob = await extractionQueue.getJob(eventId);
      expect(extractionJob).toBeDefined();
      await extractionJob!.waitUntilFinished(queueEvents, 10_000);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ tenantId, actorId, caseId, documentId: presign.body.documentId, processingJobId });
      const published = await pool.query<{ status: string }>('SELECT status FROM public.outbox_events WHERE tenant_id = $1 AND id = $2', [tenantId, eventId]);
      expect(published.rows[0]?.status).toBe('published');
    } finally {
      await consumer.onApplicationShutdown();
      await queueEvents.close();
    }
  });

  it('expires abandoned upload reservations and removes their staging object', async () => {
    const presign = await request(app.getHttpServer())
      .post(`/v1/cases/${caseId}/documents/presign`)
      .set('x-tenant-id', tenantId)
      .send({ contentType: 'application/pdf', sizeBytes: objectBytes.length, sha256: objectSha256 })
      .expect(201);
    const documentId = presign.body.documentId as string;
    const expired = await pool.query<{ id: string; object_key: string }>(
      `INSERT INTO public.documents (
         id, tenant_id, case_id, uploaded_by, object_key, content_type, size_bytes, storage_size_bytes,
         sha256, wrapped_data_key, encryption_nonce, encryption_key_version, status, reservation_expires_at
       )
       SELECT gen_random_uuid(), tenant_id, case_id, uploaded_by, object_key || '/expired-fixture', content_type,
              size_bytes, storage_size_bytes, sha256, wrapped_data_key, encryption_nonce, encryption_key_version,
              'pending_upload', now() - interval '1 second'
       FROM public.documents WHERE tenant_id = $1 AND id = $2
       RETURNING id, object_key`,
      [tenantId, documentId],
    );
    const cleanup = new DocumentReservationCleanupWorker(
      new PostgresDocumentReservationMaintenanceRepository(pool), storage,
    );
    stagingObjects.add(expired.rows[0]!.object_key);

    expect(await cleanup.cleanupExpiredBatch()).toBe(1);
    expect(storageDeleteKeys).toContain(expired.rows[0]?.object_key);
    expect(stagingObjects.has(expired.rows[0]!.object_key)).toBe(false);
    const remaining = await pool.query<{ status: string; staging_cleanup_checked_at: Date | null }>(
      'SELECT status, staging_cleanup_checked_at FROM public.documents WHERE tenant_id = $1 AND id = $2',
      [tenantId, expired.rows[0]?.id],
    );
    expect(remaining.rows[0]).toMatchObject({ status: 'failed' });
    expect(remaining.rows[0]?.staging_cleanup_checked_at).toBeInstanceOf(Date);
    await pool.query('DELETE FROM public.documents WHERE tenant_id = $1 AND id = $2', [tenantId, documentId]);
  });

  it('removes only an expired confirmed document staging key and preserves its finalized object', async () => {
    const source = await pool.query<{ id: string }>(
      `INSERT INTO public.documents (
         tenant_id, case_id, uploaded_by, object_key, final_object_key, content_type, size_bytes, storage_size_bytes,
         sha256, wrapped_data_key, encryption_nonce, encryption_key_version, status, reservation_expires_at
       )
       SELECT tenant_id, case_id, uploaded_by, $2, $3, content_type, size_bytes, storage_size_bytes,
              sha256, wrapped_data_key, encryption_nonce, encryption_key_version, 'processed', now() - interval '1 second'
       FROM public.documents WHERE tenant_id = $1
       ORDER BY created_at DESC LIMIT 1
       RETURNING id`,
      [tenantId, `tenants/${tenantId}/cases/${caseId}/documents/staging/${randomUUID()}`,
        `tenants/${tenantId}/cases/${caseId}/documents/finalized/${randomUUID()}`],
    );
    const record = await pool.query<{ id: string; object_key: string; final_object_key: string }>(
      'SELECT id, object_key, final_object_key FROM public.documents WHERE tenant_id = $1 AND id = $2',
      [tenantId, source.rows[0]?.id],
    );
    const stagingKey = record.rows[0]!.object_key;
    const finalKey = record.rows[0]!.final_object_key;
    finalizedObjects.set(finalKey, Buffer.from('finalized ciphertext'));
    stagingObjects.add(stagingKey);
    storageDeleteKeys = [];
    const cleanup = new DocumentReservationCleanupWorker(
      new PostgresDocumentReservationMaintenanceRepository(pool), storage,
    );

    expect(await cleanup.cleanupExpiredBatch()).toBe(1);

    expect(storageDeleteKeys).toEqual([stagingKey]);
    expect(finalizedObjects.has(finalKey)).toBe(true);
    const state = await pool.query<{ staging_cleanup_checked_at: Date | null; final_object_key: string }>(
      'SELECT staging_cleanup_checked_at, final_object_key FROM public.documents WHERE tenant_id = $1 AND id = $2',
      [tenantId, source.rows[0]?.id],
    );
    expect(state.rows[0]?.staging_cleanup_checked_at).toBeInstanceOf(Date);
    expect(state.rows[0]?.final_object_key).toBe(finalKey);

    stagingObjects.add(stagingKey);
    const serviceClient = await pool.connect();
    try {
      await serviceClient.query('BEGIN');
      await serviceClient.query('SET LOCAL ROLE service_role');
      await serviceClient.query(
        `UPDATE public.documents SET staging_cleanup_checked_at = now() - interval '25 hours'
         WHERE tenant_id = $1 AND id = $2`, [tenantId, source.rows[0]?.id],
      );
      await serviceClient.query('COMMIT');
    } catch (error) {
      await serviceClient.query('ROLLBACK');
      throw error;
    } finally {
      serviceClient.release();
    }
    storageDeleteKeys = [];
    expect(await cleanup.cleanupExpiredBatch()).toBe(1);
    expect(storageDeleteKeys).toEqual([stagingKey]);
    expect(stagingObjects.has(stagingKey)).toBe(false);
    expect(finalizedObjects.has(finalKey)).toBe(true);
  });

  it('reclaims a reserved finalized object when an expired confirmation never committed', async () => {
    const staleFinalKey = `tenants/${tenantId}/cases/${caseId}/documents/finalized/${randomUUID()}`;
    const stale = await pool.query<{ id: string; object_key: string; final_object_key: string }>(
      `INSERT INTO public.documents (
         tenant_id, case_id, uploaded_by, object_key, final_object_key, content_type, size_bytes, storage_size_bytes,
         sha256, wrapped_data_key, encryption_nonce, encryption_key_version, status, reservation_expires_at
       )
       SELECT tenant_id, case_id, uploaded_by, $2, $3, content_type, size_bytes, storage_size_bytes,
              sha256, wrapped_data_key, encryption_nonce, encryption_key_version, 'pending_upload', now() - interval '1 second'
       FROM public.documents WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1
       RETURNING id, object_key, final_object_key`,
      [tenantId, `tenants/${tenantId}/cases/${caseId}/documents/staging/${randomUUID()}`, staleFinalKey],
    );
    const row = stale.rows[0]!;
    stagingObjects.add(row.object_key);
    finalizedObjects.set(row.final_object_key, Buffer.from('orphaned ciphertext'));
    storageDeleteKeys = [];
    const cleanup = new DocumentReservationCleanupWorker(
      new PostgresDocumentReservationMaintenanceRepository(pool), storage,
    );

    expect(await cleanup.cleanupExpiredBatch()).toBeGreaterThanOrEqual(1);

    expect(storageDeleteKeys).toContain(row.object_key);
    expect(storageDeleteKeys).toContain(row.final_object_key);
    expect(stagingObjects.has(row.object_key)).toBe(false);
    expect(finalizedObjects.has(row.final_object_key)).toBe(false);
    const status = await pool.query<{ status: string }>(
      'SELECT status FROM public.documents WHERE tenant_id = $1 AND id = $2', [tenantId, row.id],
    );
    expect(status.rows[0]?.status).toBe('failed');

    finalizedObjects.set(row.final_object_key, Buffer.from('late R2 copy completion'));
    const serviceClient = await pool.connect();
    try {
      await serviceClient.query('BEGIN');
      await serviceClient.query('SET LOCAL ROLE service_role');
      await serviceClient.query(
        `UPDATE public.documents SET staging_cleanup_checked_at = now() - interval '25 hours'
         WHERE tenant_id = $1 AND id = $2`, [tenantId, row.id],
      );
      await serviceClient.query('COMMIT');
    } catch (error) {
      await serviceClient.query('ROLLBACK');
      throw error;
    } finally {
      serviceClient.release();
    }
    storageDeleteKeys = [];

    expect(await cleanup.cleanupExpiredBatch()).toBeGreaterThanOrEqual(1);

    expect(storageDeleteKeys).toContain(row.final_object_key);
    expect(finalizedObjects.has(row.final_object_key)).toBe(false);
  });

  it('caps active per-actor upload reservations under repeated presign requests', async () => {
    const createReservation = () => request(app.getHttpServer())
      .post(`/v1/cases/${caseId}/documents/presign`)
      .set('x-tenant-id', tenantId)
      .send({ contentType: 'application/pdf', sizeBytes: objectBytes.length, sha256: objectSha256 });
    for (let index = 0; index < 10; index += 1) await createReservation().expect(201);
    await createReservation().expect(429);

    const pending = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.documents
       WHERE tenant_id = $1 AND status = 'pending_upload' AND reservation_expires_at > now()`,
      [tenantId],
    );
    expect(pending.rows[0]?.count).toBe('10');
  });

  it('serializes reservations at the tenant lifetime document-count limit', async () => {
    await pool.query(
      `UPDATE public.documents SET status = 'failed'
       WHERE tenant_id = $1 AND status = 'pending_upload'`,
      [tenantId],
    );
    const current = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM public.documents WHERE tenant_id = $1', [tenantId],
    );
    const missing = 999 - Number(current.rows[0]?.count ?? 0);
    expect(missing).toBeGreaterThanOrEqual(0);
    if (missing > 0) {
      await pool.query(
        `INSERT INTO public.documents (
           id, tenant_id, case_id, uploaded_by, object_key, content_type, size_bytes, storage_size_bytes,
           sha256, wrapped_data_key, encryption_nonce, encryption_key_version, status
         )
         SELECT ('10000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
                $1, $2, $3, 'tenant-quota-staging/' || series,
                'application/pdf', 1, 17, repeat('a', 64), 'v1.' || repeat('A', 16) || '.' || repeat('B', 64),
                repeat('A', 16), 'v1', 'failed'
         FROM generate_series(1, $4::integer) series`,
        [tenantId, caseId, actorId, missing],
      );
    }

    const reserve = (id: string) => unitOfWork.run({ tenantId, actorId }, (tx) => documentRepository.create(
      tenantId, actorId,
      {
        id, caseId, objectKey: `tenants/${tenantId}/cases/${caseId}/documents/staging/${id}`,
        contentType: 'application/pdf', sizeBytes: 1, storageSizeBytes: 17, sha256: 'b'.repeat(64),
        wrappedDataKey: `v1.${Buffer.alloc(12, 5).toString('base64')}.${Buffer.alloc(48, 6).toString('base64')}`,
        encryptionNonce: Buffer.alloc(12, 7).toString('base64'), encryptionKeyVersion: 'v1',
      }, tx,
    ));
    const attempts = await Promise.allSettled([reserve(randomUUID()), reserve(randomUUID())]);

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.find((attempt) => attempt.status === 'rejected'))
      .toMatchObject({ status: 'rejected', reason: { status: 409 } });
    const total = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM public.documents WHERE tenant_id = $1', [tenantId],
    );
    expect(total.rows[0]?.count).toBe('1000');
  });

  it('rejects a tenant upload when cumulative declared ciphertext exceeds 10 GiB', async () => {
    const secondTenant = '00000000-0000-4000-8000-000000000002';
    const secondCase = '00000000-0000-4000-8000-000000000022';
    const secondEntity = '00000000-0000-4000-8000-000000000032';
    await pool.query('INSERT INTO public.tenants (id, name) VALUES ($1, $2)', [secondTenant, 'Quota bytes tenant']);
    await pool.query(
      `INSERT INTO public.memberships (tenant_id, user_id, role)
       SELECT $1, id, 'originator' FROM public.users WHERE auth_user_id = $2`,
      [secondTenant, actorId],
    );
    await pool.query(
      `INSERT INTO public.credit_cases (id, tenant_id, entity_id, case_number, status, currency)
       VALUES ($1, $2, $3, 'QUOTA-BYTES-CASE', 'draft', 'USD')`,
      [secondCase, secondTenant, secondEntity],
    );
    await pool.query(
      `INSERT INTO public.documents (
         id, tenant_id, case_id, uploaded_by, object_key, content_type, size_bytes, storage_size_bytes,
         sha256, wrapped_data_key, encryption_nonce, encryption_key_version, status
       )
       SELECT ('20000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
              $1, $2, $3, 'tenant-bytes-staging/' || series,
              'application/pdf', 52428800, 52428816, repeat('c', 64),
              'v1.' || repeat('A', 16) || '.' || repeat('B', 64), repeat('A', 16), 'v1', 'failed'
       FROM generate_series(1, 205) series`,
      [secondTenant, secondCase, actorId],
    );

    await expect(unitOfWork.run({ tenantId: secondTenant, actorId }, (tx) => documentRepository.create(
      secondTenant, actorId,
      {
        id: randomUUID(), caseId: secondCase,
        objectKey: `tenants/${secondTenant}/cases/${secondCase}/documents/staging/over-limit`,
        contentType: 'application/pdf', sizeBytes: 1, storageSizeBytes: 17, sha256: 'd'.repeat(64),
        wrappedDataKey: `v1.${Buffer.alloc(12, 5).toString('base64')}.${Buffer.alloc(48, 6).toString('base64')}`,
        encryptionNonce: Buffer.alloc(12, 7).toString('base64'), encryptionKeyVersion: 'v1',
      }, tx,
    ))).rejects.toMatchObject({ status: 409 });
    const total = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM public.documents WHERE tenant_id = $1', [secondTenant],
    );
    expect(total.rows[0]?.count).toBe('205');
  });
});
