import { Request, Response } from 'express';

export function supportsAccessCodeProjection(request?:Pick<Request,'headers'>):boolean {
  const value=request?.headers['x-sync-extensions'];
  return typeof value==='string' && value.length<=128 && value==='access-code';
}

export function setExtensionProjectionHeaders(response?:Pick<Response,'vary'|'setHeader'>):void {
  response?.vary('X-Sync-Extensions');
  response?.setHeader('Cache-Control','no-store');
}
