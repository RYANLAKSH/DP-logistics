/**
 * Stands in for `virtual:pwa-register`, which only exists when the PWA plugin
 * is in the build. The demo has no service worker: caching a demonstration in
 * a sandboxed frame gains nothing and makes every republish look stale.
 */
export function registerSW(_options?: unknown): (reload?: boolean) => Promise<void> {
  void _options
  return async () => {}
}
