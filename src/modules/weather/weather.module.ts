import { Module } from '@nestjs/common';

import { OpenMeteoClient } from './open-meteo.client.js';
import { WeatherService } from './weather.service.js';

/** Weather for the Holtrop path (Open-Meteo + Valkey cache + circuit breaker). */
@Module({
  providers: [OpenMeteoClient, WeatherService],
  exports: [WeatherService],
})
export class WeatherModule {}
