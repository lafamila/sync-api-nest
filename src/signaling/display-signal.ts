import { SYNC_SIGNAL_DIRECTIONS, validateWire } from '../generated/sync-wire';

export function isDisplaySignal(type:unknown):boolean {
  return typeof type==='string' && Object.hasOwn(SYNC_SIGNAL_DIRECTIONS,type);
}

export function canonicalDisplaySignal(message:Record<string,unknown>):Record<string,unknown>|undefined {
  if(!validateWire('WireSignal',message)) return undefined;
  if(message.type==='get-displays') return keys(message,['type','sessionId'])?{...message}:undefined;
  if(message.type==='select-display') {
    return keys(message,['type','sessionId','displayId','inputEpoch','requestId'])?{...message}:undefined;
  }
  if(message.type==='display-error') {
    return keys(message,['type','sessionId','requestId','reason'])?{...message}:undefined;
  }
  if(message.type!=='displays' || !keys(message,['type','sessionId','displays','selectedDisplayId','inputEpoch','requestId']) ||
    !Array.isArray(message.displays)) return undefined;
  const ids=new Set<unknown>();
  for(const item of message.displays) {
    if(!item || typeof item!=='object' || Array.isArray(item)) return undefined;
    const display=item as Record<string,unknown>;
    if(ids.has(display.id)) return undefined;
    ids.add(display.id);
  }
  return ids.has(message.selectedDisplayId)?{...message}:undefined;
}

function keys(value:Record<string,unknown>,allowed:string[]) { return Object.keys(value).every((key)=>allowed.includes(key)); }
