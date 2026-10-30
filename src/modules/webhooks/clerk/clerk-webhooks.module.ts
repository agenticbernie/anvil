import { Module } from '@nestjs/common';
import { ClerkWebhooksController } from './clerk-webhooks.controller.js';
import { ClerkWebhookService } from './clerk-webhook.service.js';
import { ClerkOrganizationMetadataService } from './clerk-organization-metadata.service.js';

@Module({ controllers: [ClerkWebhooksController], providers: [ClerkWebhookService, ClerkOrganizationMetadataService] })
export class ClerkWebhooksModule {}
