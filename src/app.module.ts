import { AuditModule } from '@darmawanweb/ais-its-nest/audit';
import { AuthModule } from '@darmawanweb/ais-its-nest/auth';
import { DatabaseModule } from '@darmawanweb/ais-its-nest/db';
import { NatsModule } from '@darmawanweb/ais-its-nest/nats';
import { RedisModule } from '@darmawanweb/ais-its-nest/redis';
import { Module } from '@nestjs/common';

import { ConsumersModule } from './consumers/consumers.module.js';
import * as schema from './db/schema.js';
import { CiiModule } from './modules/cii/cii.module.js';
import { DcsModule } from './modules/dcs/dcs.module.js';
import { MethodologyModule } from './modules/methodology/methodology.module.js';
import { SeempModule } from './modules/seemp/seemp.module.js';

/**
 * Root module. `bootstrapService()` wraps it in the kit's platform root module
 * (configuration, logging, metrics, health, validation, problem details).
 * Nothing connects at construction time: connections, migrations and streams
 * are set up in lifecycle hooks before the HTTP port opens.
 */
@Module({
  imports: [
    // pg pool + drizzle (search_path=<DATABASE_SCHEMA>,public); migrations on boot.
    DatabaseModule.forRoot({ schema }),
    // Streams this service PRODUCES to (created / widened at boot): EMISSION
    // (emission.cii.updated.v1) and AUDIT (audit.recorded.v1). Consumed streams
    // (AIS_POSITION, FUEL, FLEET) are only created when missing.
    NatsModule.forRoot({ streams: ['EMISSION', 'AUDIT'] }),
    // Weather cache (0.25° cell × hour); readiness check `redis`.
    RedisModule.forRoot({ keyPrefix: 'emission:' }),
    // Global default-deny guard: every route needs a principal unless @Public().
    AuthModule.forRoot(),
    AuditModule,
    ConsumersModule,
    CiiModule,
    SeempModule,
    DcsModule,
    MethodologyModule,
  ],
})
export class AppModule {}
