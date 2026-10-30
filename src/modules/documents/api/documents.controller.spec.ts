import 'reflect-metadata';

import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { SupabaseAuthGuard } from '../../auth/supabase-auth.guard.js';
import { TenantContextGuard } from '../../auth/tenant-context.guard.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { DocumentService } from '../application/document.service.js';
import { CaseDocumentsController, DocumentsController } from './documents.controller.js';

describe('document route UUID validation', () => {
  let app: INestApplication;
  const documents = {
    presignUpload: jest.fn(),
    confirmUpload: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CaseDocumentsController, DocumentsController],
      providers: [
        { provide: DocumentService, useValue: documents },
      ],
    })
      .overrideGuard(SupabaseAuthGuard).useValue({ canActivate: () => true })
      .overrideGuard(TenantContextGuard).useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard).useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('v1');
    app.use((req: { tenantContext?: unknown }, _res: unknown, next: () => void) => {
      req.tenantContext = {
        tenantId: '00000000-0000-4000-8000-000000000001',
        actorId: '00000000-0000-4000-8000-000000000002',
        role: 'originator',
      };
      next();
    });
    await app.init();
  });

  afterAll(async () => { await app?.close(); });

  it('rejects a malformed caseId before requesting an upload reservation', async () => {
    await request(app.getHttpServer())
      .post('/v1/cases/not-a-uuid/documents/presign')
      .send({ contentType: 'application/pdf', sizeBytes: 1, sha256: 'a'.repeat(64) })
      .expect(400);
    expect(documents.presignUpload).not.toHaveBeenCalled();
  });

  it('rejects a malformed documentId before confirming an upload', async () => {
    await request(app.getHttpServer())
      .post('/v1/documents/not-a-uuid/confirm-upload')
      .send({ sha256: 'a'.repeat(64) })
      .expect(400);
    expect(documents.confirmUpload).not.toHaveBeenCalled();
  });
});
