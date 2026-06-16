import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { json, urlencoded } from 'express';

const DEFAULT_LOCAL_PORT = 3001;
const HOST = '0.0.0.0';

function resolvePort(): number {
  const portValue = process.env.PORT;

  if (!portValue) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('PORT must be set in production environments');
    }

    return DEFAULT_LOCAL_PORT;
  }

  const port = Number(portValue);

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid PORT value: ${portValue}`);
  }

  return port;
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Increase body parser limits — chat history with product tool results
  // can grow well beyond the default 100KB limit
  app.use(json({ limit: '5mb' }));
  app.use(urlencoded({ extended: true, limit: '5mb' }));

  // Enable CORS for frontend requests
  app.enableCors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  // Set global endpoint prefix
  app.setGlobalPrefix('api', {
    exclude: [{ path: 'health', method: RequestMethod.GET }],
  });

  // Enable global validation rules
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  const port = resolvePort();
  await app.listen(port, HOST);
  console.log(`[NestJS] Backend running on http://${HOST}:${port}/api`);
}
bootstrap().catch((err) => console.error('Bootstrap failed:', err));
