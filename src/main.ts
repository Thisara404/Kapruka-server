import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { ValidationPipe } from '@nestjs/common';
import { json, urlencoded } from 'express';

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
  app.setGlobalPrefix('api');

  // Enable global validation rules
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  const port = process.env.BACKEND_PORT || 3001;
  await app.listen(, '0.0.0.0');
  console.log(`[NestJS] Backend running on http://localhost:${port}/api`);
}
bootstrap().catch((err) => console.error('Bootstrap failed:', err));
