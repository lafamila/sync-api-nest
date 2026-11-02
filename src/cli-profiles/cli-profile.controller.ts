import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { CliProfileService } from './cli-profile.service';

@Controller('cli-profiles/v1')
export class CliProfileController {
  constructor(private readonly profiles:CliProfileService) {}

  @Get(':filename')
  async get(@Param('filename') filename:string,@Req() request:Request,@Res() response:Response):Promise<void> {
    const artifact=await this.profiles.artifact(filename);
    response.setHeader('Content-Type',artifact.contentType);
    response.setHeader('X-Content-Type-Options','nosniff');
    response.setHeader('Cache-Control','public, max-age=300, must-revalidate');
    response.setHeader('ETag',artifact.etag);
    const conditional=request.headers['if-none-match'];
    if(conditional===artifact.etag || conditional==='*') { response.status(304).end(); return; }
    response.setHeader('Content-Length',artifact.bytes.length);
    response.status(200).end(artifact.bytes);
  }
}
