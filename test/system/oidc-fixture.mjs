import http from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { exportJWK, SignJWT } from 'jose';

export class OidcFixture {
  constructor({accountId,clientId,clientSecret}) {
    this.accountId=accountId;
    this.clientId=clientId;
    this.clientSecret=clientSecret;
    this.codes=new Map();
    this.refreshTokens=new Map();
    this.refreshCount=0;
    const pair=generateKeyPairSync('rsa',{modulusLength:2048});
    this.privateKey=pair.privateKey;
    this.publicKey=pair.publicKey;
    this.kid=`sync-system-${randomUUID()}`;
  }

  async start() {
    const jwk=await exportJWK(this.publicKey);
    this.jwk={...jwk,kid:this.kid,use:'sig',alg:'RS256'};
    this.server=http.createServer((request,response)=>void this.handle(request,response));
    await new Promise((resolve)=>this.server.listen(0,'127.0.0.1',resolve));
    const address=this.server.address();
    this.issuer=`http://127.0.0.1:${address.port}`;
    return this;
  }

  async close() {
    if(!this.server) return;
    await new Promise((resolve,reject)=>this.server.close((error)=>error?reject(error):resolve()));
  }

  async handle(request,response) {
    try {
      const url=new URL(request.url ?? '/',this.issuer ?? 'http://127.0.0.1');
      if(request.method==='GET' && url.pathname==='/.well-known/openid-configuration') {
        return json(response,200,{issuer:this.issuer,authorization_endpoint:`${this.issuer}/oauth/authorize`,
          token_endpoint:`${this.issuer}/oauth/token`,jwks_uri:`${this.issuer}/oauth/jwks`,
          userinfo_endpoint:`${this.issuer}/oidc/userinfo`,response_types_supported:['code'],
          grant_types_supported:['authorization_code','refresh_token'],code_challenge_methods_supported:['S256']});
      }
      if(request.method==='GET' && url.pathname==='/oauth/jwks') return json(response,200,{keys:[this.jwk]});
      if(request.method==='GET' && url.pathname==='/oauth/authorize') return this.authorize(url,response);
      if(request.method==='POST' && url.pathname==='/oauth/token') return this.token(request,response);
      if(request.method==='POST' && url.pathname==='/oauth/revoke') return this.revoke(request,response);
      if(request.method==='GET' && url.pathname==='/oidc/userinfo') {
        return json(response,200,{sub:this.accountId,name:'Sync System Fixture'});
      }
      return json(response,404,{error:'not_found'});
    } catch(error) {
      return json(response,500,{error:'fixture_error',error_description:error instanceof Error?error.message:'unknown'});
    }
  }

  authorize(url,response) {
    const clientId=url.searchParams.get('client_id');
    const redirectUri=url.searchParams.get('redirect_uri');
    const state=url.searchParams.get('state');
    const challenge=url.searchParams.get('code_challenge');
    if(clientId!==this.clientId || !redirectUri || !state || !challenge ||
       url.searchParams.get('response_type')!=='code' || url.searchParams.get('code_challenge_method')!=='S256') {
      return json(response,400,{error:'invalid_request'});
    }
    const code=opaque();
    this.codes.set(code,{challenge,redirectUri,expiresAt:Date.now()+60_000});
    const callback=new URL(redirectUri);
    callback.searchParams.set('code',code);
    callback.searchParams.set('state',state);
    response.writeHead(302,{location:callback.toString(),'cache-control':'no-store'});
    response.end();
  }

  async token(request,response) {
    const body=new URLSearchParams(await readBody(request));
    if(body.get('client_id')!==this.clientId || body.get('client_secret')!==this.clientSecret) {
      return json(response,401,{error:'invalid_client'});
    }
    if(body.get('grant_type')==='authorization_code') {
      const code=body.get('code');
      const record=code ? this.codes.get(code) : undefined;
      if(!record || record.expiresAt<=Date.now() || record.redirectUri!==body.get('redirect_uri') ||
         s256(body.get('code_verifier') ?? '')!==record.challenge) {
        return json(response,400,{error:'invalid_grant'});
      }
      this.codes.delete(code);
      return this.sendTokens(response);
    }
    if(body.get('grant_type')==='refresh_token') {
      const current=body.get('refresh_token');
      if(!current || !this.refreshTokens.delete(current)) return json(response,400,{error:'invalid_grant'});
      this.refreshCount+=1;
      return this.sendTokens(response);
    }
    return json(response,400,{error:'unsupported_grant_type'});
  }

  async sendTokens(response) {
    const accessToken=await new SignJWT({name:'Sync System Fixture',
      servicePermissions:[{serviceKey:'sync',permission:'member'}]})
      .setProtectedHeader({alg:'RS256',kid:this.kid})
      .setIssuer(this.issuer)
      .setAudience('service:sync')
      .setSubject(this.accountId)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(this.privateKey);
    const refreshToken=opaque(48);
    this.refreshTokens.set(refreshToken,true);
    return json(response,200,{access_token:accessToken,refresh_token:refreshToken,expires_in:600,token_type:'Bearer'});
  }

  async revoke(request,response) {
    const contentType=String(request.headers['content-type'] ?? '');
    const raw=await readBody(request);
    let token;
    if(contentType.includes('application/json')) token=JSON.parse(raw || '{}').token;
    else token=new URLSearchParams(raw).get('token');
    if(typeof token==='string') this.refreshTokens.delete(token);
    response.writeHead(200,{'cache-control':'no-store'});
    response.end();
  }
}

function json(response,status,value) {
  response.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});
  response.end(JSON.stringify(value));
}
function opaque(bytes=32) { return randomBytes(bytes).toString('base64url'); }
function s256(value) { return createHash('sha256').update(value).digest('base64url'); }
async function readBody(request) { let value=''; for await(const chunk of request) value+=chunk; return value; }
