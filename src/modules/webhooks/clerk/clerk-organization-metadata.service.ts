import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClerkClient } from '@clerk/backend';

@Injectable()
export class ClerkOrganizationMetadataService {
  constructor(private readonly config: ConfigService) {}

  async setTenantId(organizationId: string, tenantId: string): Promise<void> {
    const secretKey = this.config.get<string>('CLERK_SECRET_KEY') ?? '';
    if (!secretKey) throw new ServiceUnavailableException('CLERK_SECRET_KEY is not configured.');

    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const clerk = createClerkClient({ secretKey });
        await clerk.organizations.updateOrganizationMetadata(organizationId, {
          publicMetadata: { tenant_id: tenantId },
        });
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
      }
    }
    throw new ServiceUnavailableException('Clerk organization metadata update failed.', { cause: lastError });
  }
}
