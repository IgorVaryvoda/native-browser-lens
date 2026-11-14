import type { EvidenceBuffer } from './buffer';
import { isNoise } from './noise';

/**
 * Network metadata from webRequest, for browsers without the debugger API (Firefox). It observes
 * only; it never blocks or changes a request.
 */
export class LimitedCollector {
  constructor(
    private readonly buffer: EvidenceBuffer,
    private readonly collected: (tabId: number) => boolean,
  ) {}

  listen() {
    const filter = { urls: ['http://*/*', 'https://*/*'] };
    const web = browser.webRequest;
    web.onBeforeRequest.addListener((d) => {
      this.record(d.tabId, 'request', { requestId: d.requestId, url: d.url, method: d.method, resourceType: d.type });
      return undefined;
    }, filter);
    web.onCompleted.addListener(
      (d) =>
        this.record(d.tabId, 'response', {
          requestId: d.requestId,
          url: d.url,
          status: d.statusCode,
          fromCache: d.fromCache,
        }),
      filter,
    );
    web.onErrorOccurred.addListener(
      (d) => this.record(d.tabId, 'networkFailure', { requestId: d.requestId, url: d.url, errorText: d.error }),
      filter,
    );
  }

  private record(tabId: number, kind: string, data: Record<string, unknown>) {
    if (isNoise(String(data.url ?? ''), String(data.resourceType ?? ''))) return;
    if (tabId >= 0 && this.collected(tabId)) this.buffer.record(tabId, kind, { ...data, source: 'webRequest' });
  }
}
