import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';

export interface RevocationEvent {
  kind: 'session' | 'host' | 'device' | 'auth-session' | 'runtime';
  id: string;
  reason: string;
}

@Injectable()
export class RevocationBusService {
  private readonly emitter = new EventEmitter();
  emit(event: RevocationEvent): void { this.emitter.emit('revoke', event); }
  subscribe(listener: (event: RevocationEvent) => void): () => void {
    this.emitter.on('revoke', listener);
    return () => this.emitter.off('revoke', listener);
  }
}
