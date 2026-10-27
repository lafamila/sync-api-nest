import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import express from 'express';
import { AppModule } from './app.module';
import { SyncConfigService } from './config/config.service';
import { SignalingService } from './signaling/signaling.service';

async function bootstrap():Promise<void> {
  const app=await NestFactory.create(AppModule,{bufferLogs:true,forceCloseConnections:true});
  const config=app.get(SyncConfigService);
  app.enableShutdownHooks();
  app.setGlobalPrefix('api');
  app.use((_:express.Request,response:express.Response,next:express.NextFunction)=>{
    response.setHeader('Content-Security-Policy',"default-src 'self'; connect-src 'self' wss: ws:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    response.setHeader('X-Frame-Options','DENY'); response.setHeader('X-Content-Type-Options','nosniff');
    response.setHeader('Referrer-Policy','no-referrer'); response.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    next();
  });
  app.enableCors({ credentials:true,origin:(origin:string|undefined,callback:(error:Error|null,allow?:boolean)=>void)=>callback(null,!origin || config.config.allowedOrigins.includes(origin)) });
  app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true,transformOptions:{enableImplicitConversion:false}}));
  const webDist=join(process.cwd(),'web','dist');
  if(existsSync(webDist)) {
    app.use(express.static(webDist,{index:'index.html',fallthrough:true}));
    app.use((request:express.Request,response:express.Response,next:express.NextFunction)=>{
      if(request.method==='GET' && !request.path.startsWith('/api/') && request.accepts('html')) response.sendFile(join(webDist,'index.html'));
      else next();
    });
  }
  await app.init();
  app.get(SignalingService).attach(app.getHttpServer());
  await app.listen(config.config.port,config.config.host);
}

bootstrap().catch((error)=>{ console.error(error); process.exitCode=1; });
