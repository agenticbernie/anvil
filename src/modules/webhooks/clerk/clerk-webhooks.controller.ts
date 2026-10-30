import { Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ClerkWebhookService } from './clerk-webhook.service.js';

@ApiTags('Webhooks')
@Controller('webhooks/clerk')
export class ClerkWebhooksController {
  constructor(private readonly webhooks: ClerkWebhookService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Receive a signed Clerk webhook event', description: 'Verifies Svix signature and idempotently provisions a tenant for a new Clerk user.' })
  @ApiBody({ description: 'Raw Clerk webhook JSON payload', schema: { type: 'object', example: { type: 'user.created', data: { id: 'user_example', email_addresses: [] } } } })
  @ApiOkResponse({ description: 'Webhook event was processed or had already been processed.' })
  async receive(@Req() request: RawBodyRequest<Request>): Promise<{ received: true }> {
    await this.webhooks.handle(request.rawBody, {
      id: header(request, 'svix-id'),
      timestamp: header(request, 'svix-timestamp'),
      signature: header(request, 'svix-signature'),
    });
    return { received: true };
  }
}

function header(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
