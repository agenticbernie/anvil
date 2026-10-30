import { Module } from '@nestjs/common';
import { ClerkWebhooksController } from './clerk-webhooks.controller.js';
import { ClerkWebhookService } from './clerk-webhook.service.js';

@Module({ controllers: [ClerkWebhooksController], providers: [ClerkWebhookService] })
export class ClerkWebhooksModule {}
