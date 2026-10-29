import { HttpException } from '@nestjs/common';
import { SYNC_CAPABILITIES, SYNC_MINIMUM_WEB_PROTOCOL_VERSION, SYNC_PROTOCOL_VERSION } from '../generated/sync-wire';

export interface EndpointFeatures { protocolVersion: number; capabilities: string[] }
export interface ActiveEndpoint extends EndpointFeatures { id: string }

export function endpointFeatures(input: { protocolVersion?: number; capabilities?: readonly string[] }): EndpointFeatures {
  return { protocolVersion: Math.min(input.protocolVersion ?? 1, SYNC_PROTOCOL_VERSION),
    capabilities: SYNC_CAPABILITIES.filter((capability) => input.capabilities?.includes(capability)) };
}

export function negotiate(host: EndpointFeatures, controller: EndpointFeatures): EndpointFeatures {
  const protocolVersion = Math.min(host.protocolVersion, controller.protocolVersion, SYNC_PROTOCOL_VERSION);
  if (protocolVersion < 2) return { protocolVersion, capabilities: [] };
  const capabilities = SYNC_CAPABILITIES.filter((capability) =>
    capability !== 'host-displays' && capability !== 'viewer-displays' &&
    host.capabilities.includes(capability) && controller.capabilities.includes(capability));
  if (host.capabilities.includes('host-displays') && controller.capabilities.includes('viewer-displays')) {
    capabilities.push('host-displays', 'viewer-displays');
  }
  return { protocolVersion, capabilities };
}

export function supportsSession(host: EndpointFeatures, session: EndpointFeatures, requireBoundedHosts=false): boolean {
  return (!requireBoundedHosts || host.capabilities.includes('bounded-lifetime')) &&
    host.protocolVersion >= session.protocolVersion && session.capabilities.every((capability) =>
    capability === 'viewer-displays' || host.capabilities.includes(capability));
}

export function requireBoundedHost(host:EndpointFeatures,required:boolean):void {
  // Compatibility declaration only: this is neither software attestation nor authorization.
  if(required && !host.capabilities.includes('bounded-lifetime')) {
    throw new HttpException({statusCode:426,error:'host-update-required',message:'Update the host app to support bounded session lifetime'},426);
  }
}

export function requireWebProtocol(protocolVersion?: number): void {
  if ((protocolVersion ?? 1) < SYNC_MINIMUM_WEB_PROTOCOL_VERSION) {
    throw new HttpException({ statusCode: 426, error: 'reload-required', message: 'Reload Sync to update the browser protocol' }, 426);
  }
}
