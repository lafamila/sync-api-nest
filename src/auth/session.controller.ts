import { Body, Controller, Get, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthenticatedRequest } from '../common/request';
import { parseCookies } from '../common/request';
import { RequestSecurityService } from '../common/request-security.service';
import { SyncConfigService } from '../config/config.service';
import { OidcCompleteDto, OidcStartDto } from './session.dto';
import { SessionGuard } from './session.guard';
import { CallbackResult, oidcBindingCookieName, SessionService } from './session.service';

@Controller('session')
export class SessionController {
  constructor(
    private readonly sessions: SessionService,
    private readonly config: SyncConfigService,
    private readonly security: RequestSecurityService,
  ) {}

  @Post('oidc/start')
  async start(@Body() input: OidcStartDto, @Req() request: Request, @Res({passthrough:true}) response:Response) {
    if (input.platform === 'web') this.security.assertPublicWebOrigin(request);
    return this.startResponse(input,request,response);
  }

  @Get('oidc/start')
  async startGet(@Query() input: OidcStartDto, @Req() request: Request, @Res({passthrough:true}) response:Response) {
    if (input.platform === 'web') this.security.assertPublicWebOrigin(request);
    return this.startResponse(input,request,response);
  }

  @Get('oidc/callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Query('error_description') errorDescription: string | undefined,
    @Req() request:Request,
    @Res() response: Response,
  ): Promise<void> {
    const cookieName=state?oidcBindingCookieName(state):undefined;
    let result:CallbackResult;
    try {
      result = await this.sessions.callback({ code, state, error, errorDescription,
        browserBinding:cookieName?parseCookies(request)[cookieName]:undefined });
    } finally {
      if(cookieName) response.clearCookie(cookieName,{path:'/api/session/oidc/callback'});
    }
    if (result.platform === 'web') {
      if (result.error || !result.sessionToken || !result.csrfToken) {
        response.redirect('/?auth=failed'); return;
      }
      setSessionCookies(response, this.config, result.sessionToken, result.csrfToken);
      response.redirect('/'); return;
    }
    const target = new URL('sync://auth');
    target.searchParams.set('transactionId', result.transactionId);
    if (result.handoffCode) target.searchParams.set('handoffCode', result.handoffCode);
    if (result.error) target.searchParams.set('error', 'authentication_failed');
    response.redirect(target.toString());
  }

  private async startResponse(input:OidcStartDto,request:Request,response:Response) {
    await this.sessions.assertStartAllowed(request.ip ?? request.socket.remoteAddress ?? 'unknown');
    const result=await this.sessions.start(input);
    if(result.browserBinding) response.cookie(result.browserBinding.name,result.browserBinding.value,{
      httpOnly:true,secure:this.config.config.nodeEnv==='production',sameSite:'lax',
      path:'/api/session/oidc/callback',maxAge:this.config.config.loginTransactionTtlSeconds*1000,
    });
    return {authorizeUrl:result.authorizeUrl,transactionId:result.transactionId};
  }

  @Post('oidc/complete')
  complete(@Body() input: OidcCompleteDto) { return this.sessions.complete(input); }

  @Get('me')
  @UseGuards(SessionGuard)
  me(@Req() request: AuthenticatedRequest) { return { account: request.syncSession.account }; }

  @Post('logout')
  @UseGuards(SessionGuard)
  async logout(@Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) {
    this.security.assertMutation(request, request.syncSession);
    await this.sessions.logout(request.syncSession);
    clearSessionCookies(response, this.config);
    return { ok: true };
  }
}

function setSessionCookies(response: Response, config: SyncConfigService, session: string, csrf: string): void {
  const secure = config.config.nodeEnv === 'production';
  response.cookie(config.config.sessionCookieName, session, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: config.config.sessionTtlSeconds * 1000 });
  response.cookie(config.config.csrfCookieName, csrf, { httpOnly: false, secure, sameSite: 'strict', path: '/', maxAge: config.config.sessionTtlSeconds * 1000 });
}

function clearSessionCookies(response: Response, config: SyncConfigService): void {
  response.clearCookie(config.config.sessionCookieName, { path: '/' });
  response.clearCookie(config.config.csrfCookieName, { path: '/' });
}
