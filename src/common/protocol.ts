import { HttpException } from '@nestjs/common';
import { SYNC_CAPABILITIES, SYNC_LIMITS, SYNC_MINIMUM_WEB_PROTOCOL_VERSION, SYNC_PROTOCOL_VERSION } from '../generated/sync-wire';

export interface EndpointFeatures { protocolVersion: number; capabilities: string[]; cliProtocolVersion?: number; cliChatProtocolVersion?: number }
export interface ActiveEndpoint extends EndpointFeatures { id: string }

export function endpointFeatures(input: { protocolVersion?: number; capabilities?: readonly string[]; cliProtocolVersion?: number; cliChatProtocolVersion?: number }): EndpointFeatures {
  return { protocolVersion: Math.min(input.protocolVersion ?? 1, SYNC_PROTOCOL_VERSION),
    capabilities: SYNC_CAPABILITIES.filter((capability) => input.capabilities?.includes(capability)),
    ...((input.protocolVersion ?? 1)>=2 && input.cliProtocolVersion===SYNC_LIMITS.cliProtocolVersion
      ? {cliProtocolVersion:SYNC_LIMITS.cliProtocolVersion}:{}),
    ...((input.protocolVersion ?? 1)>=2 && input.cliProtocolVersion===SYNC_LIMITS.cliProtocolVersion &&
      input.cliChatProtocolVersion===SYNC_LIMITS.cliChatProtocolVersion
      ? {cliChatProtocolVersion:SYNC_LIMITS.cliChatProtocolVersion}:{}) };
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
  return { protocolVersion, capabilities,
    ...(host.cliProtocolVersion===SYNC_LIMITS.cliProtocolVersion && controller.cliProtocolVersion===SYNC_LIMITS.cliProtocolVersion
      ? {cliProtocolVersion:SYNC_LIMITS.cliProtocolVersion}:{}),
    ...(host.cliProtocolVersion===SYNC_LIMITS.cliProtocolVersion && controller.cliProtocolVersion===SYNC_LIMITS.cliProtocolVersion &&
      host.cliChatProtocolVersion===SYNC_LIMITS.cliChatProtocolVersion && controller.cliChatProtocolVersion===SYNC_LIMITS.cliChatProtocolVersion
      ? {cliChatProtocolVersion:SYNC_LIMITS.cliChatProtocolVersion}:{}) };
}

export function supportsSession(host: EndpointFeatures, session: EndpointFeatures, requireBoundedHosts=false): boolean {
  return (!requireBoundedHosts || host.capabilities.includes('bounded-lifetime')) &&
    (session.cliProtocolVersion===undefined || (host.protocolVersion>=2 && host.cliProtocolVersion===session.cliProtocolVersion)) &&
    (session.cliChatProtocolVersion===undefined || (session.cliProtocolVersion===SYNC_LIMITS.cliProtocolVersion &&
      session.cliChatProtocolVersion===SYNC_LIMITS.cliChatProtocolVersion && host.cliProtocolVersion===SYNC_LIMITS.cliProtocolVersion &&
      host.cliChatProtocolVersion===session.cliChatProtocolVersion)) &&
    host.protocolVersion >= session.protocolVersion && session.capabilities.every((capability) =>
    capability === 'viewer-displays' || host.capabilities.includes(capability));
}

export function requireCliProtocol(features:EndpointFeatures,host:EndpointFeatures=features,requireBoundedHosts=false):void {
  if(features.protocolVersion<2 || features.cliProtocolVersion!==SYNC_LIMITS.cliProtocolVersion ||
    (requireBoundedHosts && !host.capabilities.includes('bounded-lifetime'))) {
    throw new HttpException({statusCode:426,error:'cli-update-required',message:'Update both apps to support CLI sessions'},426);
  }
}

export function requireAccessCodeProtocol(features:EndpointFeatures):void {
  if(features.protocolVersion<2 || !features.capabilities.includes('access-code')) {
    throw new HttpException({statusCode:426,error:'access-code-update-required',message:'Update both apps to support access code lookup'},426);
  }
}

export function requireBoundedHost(host:EndpointFeatures,required:boolean):void {
  // Compatibility declaration only: this is neither software attestation nor authorization.
  if(required && !host.capabilities.includes('bounded-lifetime')) {
    throw new HttpException({statusCode:426,error:'host-update-required',message:'Update the host app to support bounded session lifetime'},426);
  }
}

export function requireCliChatProtocol(features:EndpointFeatures):void {
  if(features.protocolVersion<2 || features.cliProtocolVersion!==SYNC_LIMITS.cliProtocolVersion ||
    features.cliChatProtocolVersion!==SYNC_LIMITS.cliChatProtocolVersion) {
    throw new HttpException({statusCode:426,error:'cli-chat-update-required',message:'Update both apps to support CLI chat'},426);
  }
}

export function requireWebProtocol(protocolVersion?: number): void {
  if ((protocolVersion ?? 1) < SYNC_MINIMUM_WEB_PROTOCOL_VERSION) {
    throw new HttpException({ statusCode: 426, error: 'reload-required', message: 'Reload Sync to update the browser protocol' }, 426);
  }
}
