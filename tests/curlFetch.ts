// Pour les tests "LIVE" : fetch via curl (respecte le proxy de l'environnement).
import { execFileSync } from 'node:child_process';

export function installCurlFetch(): void {
  globalThis.fetch = (async (url: string) => {
    const out = execFileSync('curl', ['-sS', '-D', '-', String(url)], { maxBuffer: 1 << 28 });
    const sep = out.indexOf('\r\n\r\n', out.lastIndexOf('HTTP/'));
    const head = out.subarray(0, sep).toString();
    const body = out.subarray(sep + 4);
    const status = Number(/HTTP\/[\d.]+ (\d+)/g.exec(head.slice(head.lastIndexOf('HTTP/')))?.[1] ?? 0);
    const headers = new Headers();
    for (const line of head.slice(head.lastIndexOf('HTTP/')).split('\r\n').slice(1)) {
      const i = line.indexOf(':');
      if (i > 0) headers.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
    }
    return new Response(body, { status, headers });
  }) as typeof fetch;
}
