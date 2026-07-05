/**
 * ProxyManager - lifecycle manager for the HTTP CONNECT proxy.
 *
 * Single interface for the rest of the system: start, stop, get env vars,
 * manage domains, subscribe to events.
 */
import type { NetworkConfig } from '../types.js';
import { HttpConnectProxy, type ProxyEvent } from './HttpConnectProxy.js';

export class ProxyManager {
  private proxy: HttpConnectProxy | null = null;
  private networkConfig: NetworkConfig;
  private eventHandlers = new Set<(event: ProxyEvent) => void>();

  constructor(networkConfig: NetworkConfig) {
    this.networkConfig = { ...networkConfig, allowedDomains: [...networkConfig.allowedDomains] };
  }

  async start(): Promise<void> {
    if (!this.networkConfig.enabled) return;
    if (this.proxy?.isRunning()) return; // idempotent

    this.proxy = new HttpConnectProxy({
      allowedDomains: this.networkConfig.allowedDomains,
    });

    // Forward events
    this.proxy.on('proxy-event', (event: ProxyEvent) => {
      for (const handler of this.eventHandlers) {
        handler(event);
      }
    });

    await this.proxy.start();
  }

  async stop(): Promise<void> {
    if (!this.proxy) return;
    await this.proxy.stop();
    this.proxy = null;
  }

  /**
   * Get proxy env vars for injecting into sandboxed processes.
   * Returns both upper and lowercase variants for maximum compatibility.
   */
  getProxyEnv(): Record<string, string> {
    if (!this.proxy?.isRunning()) return {};

    const port = this.proxy.getPort();
    if (!port) return {};

    const proxyUrl = `http://127.0.0.1:${port}`;
    const noProxy = 'localhost,127.0.0.1,::1';

    return {
      HTTP_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      https_proxy: proxyUrl,
      NO_PROXY: noProxy,
      no_proxy: noProxy,
    };
  }

  addAllowedDomain(domain: string): void {
    if (!this.networkConfig.allowedDomains.includes(domain)) {
      this.networkConfig.allowedDomains.push(domain);
      this.proxy?.updateAllowedDomains(this.networkConfig.allowedDomains);
    }
  }

  getAllowedDomains(): string[] {
    return [...this.networkConfig.allowedDomains];
  }

  isRunning(): boolean {
    return this.proxy?.isRunning() ?? false;
  }

  getPort(): number | null {
    return this.proxy?.getPort() ?? null;
  }

  /**
   * Subscribe to proxy events. Returns an unsubscribe function.
   */
  onEvent(handler: (event: ProxyEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }
}
