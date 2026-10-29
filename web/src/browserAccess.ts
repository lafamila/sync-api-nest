import { decodeWire, SYNC_LIMITS } from "./generated/sync-wire";
import type { WireBrowserAccess, WireBrowserActivityState } from "./generated/sync-wire";
import { supportsV2 } from "./api";
import type { ConnectResponse, PublicConfig } from "./types";

/** One memory-only authority per browser remote session, never a reusable PIN grant. */
export class BrowserAccess {
  private offset = 0;
  private deadline: number;
  private absoluteExpiry: number;
  private token: string | null = null;
  private recoveryConsumed = false;
  private lastReportAt = -Infinity;
  private reporting = false;
  private active = true;
  private monotonicExpiry: number;
  private monotonicIdleDeadline: number;
  readonly serverEnforced: boolean;

  constructor(readonly config: PublicConfig, result: ConnectResponse, now = Date.now(), private readonly monotonicNow = () => performance.now()) {
    this.serverEnforced = supportsV2(config) && config.features.browserIdle;
    this.absoluteExpiry = Date.parse(result.session.expiresAt);
    if (!Number.isFinite(this.absoluteExpiry)) throw new Error("Invalid session expiry");
    this.deadline = Math.min(this.absoluteExpiry, now + SYNC_LIMITS.webIdleTimeoutSeconds * 1000);
    if (this.serverEnforced) {
      const access = this.readAccess(result.webAccess);
      this.offset = Date.parse(access.serverNow) - now;
      this.deadline = Math.min(this.absoluteExpiry, Date.parse(access.idleDeadline));
      this.token = access.activityToken;
    }
    const tick = this.monotonicNow();
    this.monotonicExpiry = tick + this.absoluteExpiry - (now + this.offset);
    this.monotonicIdleDeadline = Math.min(this.monotonicExpiry, tick + this.deadline - (now + this.offset));
    if (this.expired(now)) throw new Error("Remote access expired. Enter a new access code.");
  }

  expired(now = Date.now()): boolean {
    return !this.active || now + this.offset >= Math.min(this.deadline, this.absoluteExpiry)
      || this.monotonicNow() >= Math.min(this.monotonicExpiry, this.monotonicIdleDeadline);
  }

  clear(): void { this.active = false; this.token = null; this.recoveryConsumed = true; }

  recordActivity(now = Date.now()): string | null {
    if (this.expired(now)) return null;
    if (!this.serverEnforced) {
      this.deadline = Math.min(this.absoluteExpiry, now + SYNC_LIMITS.webIdleTimeoutSeconds * 1000);
      this.monotonicIdleDeadline = Math.min(this.monotonicExpiry, this.monotonicNow() + SYNC_LIMITS.webIdleTimeoutSeconds * 1000);
      return null;
    }
    if (!this.token || this.reporting || now - this.lastReportAt < 5000) return null;
    this.reporting = true;
    this.lastReportAt = now;
    return this.token;
  }

  finishActivity(state?: WireBrowserActivityState, now = Date.now()): boolean {
    this.reporting = false;
    if (this.expired(now)) return false;
    if (state) {
      const candidate = Date.parse(state.idleDeadline);
      const serverNow = Date.parse(state.serverNow);
      if (!Number.isFinite(candidate) || !Number.isFinite(serverNow) || candidate <= serverNow) return false;
      this.offset = serverNow - now;
      this.deadline = Math.min(candidate, this.absoluteExpiry);
      this.monotonicIdleDeadline = Math.min(this.monotonicExpiry, this.monotonicNow() + candidate - serverNow);
    }
    return !this.expired(now);
  }

  takeRecoveryToken(now = Date.now()): string | null {
    if (this.expired(now) || this.recoveryConsumed || !this.config.features.browserRecovery) return null;
    this.recoveryConsumed = true;
    return this.token;
  }

  recovered(result: ConnectResponse, now = Date.now()): void {
    if (this.expired(now)) throw new Error("Remote access expired. Enter a new access code.");
    const expiry = Date.parse(result.session.expiresAt);
    if (!Number.isFinite(expiry)) throw new Error("Invalid recovered session expiry");
    this.absoluteExpiry = Math.min(this.absoluteExpiry, expiry);
    if (this.serverEnforced) {
      const access = this.readAccess(result.webAccess);
      // Recovery may rotate authority but is never user activity or a deadline extension.
      this.deadline = Math.min(this.deadline, Date.parse(access.idleDeadline));
      this.offset = Date.parse(access.serverNow) - now;
      this.token = access.activityToken;
    }
    this.recoveryConsumed = false;
    this.reporting = false;
    const tick = this.monotonicNow();
    this.monotonicExpiry = Math.min(this.monotonicExpiry, tick + this.absoluteExpiry - (now + this.offset));
    this.monotonicIdleDeadline = Math.min(this.monotonicIdleDeadline, this.monotonicExpiry, tick + this.deadline - (now + this.offset));
    if (this.expired(now)) throw new Error("Remote access expired. Enter a new access code.");
  }

  private readAccess(value: WireBrowserAccess | undefined): WireBrowserAccess {
    const access = decodeWire<WireBrowserAccess>("WireBrowserAccess", value);
    if (Date.parse(access.lastActivityAt) > Date.parse(access.serverNow) || Date.parse(access.idleDeadline) <= Date.parse(access.lastActivityAt)) throw new Error("Invalid browser activity authority");
    return access;
  }
}
