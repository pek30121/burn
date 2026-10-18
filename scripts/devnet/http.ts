/* Tiny HTTP + SSE client used by the Devnet scripts. */
import { request } from 'node:http';

export function getJson(url: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = request(url, (res) => {
      let t = '';
      res.on('data', (d) => (t += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: t ? JSON.parse(t) : null }));
    });
    req.on('error', reject);
    req.end();
  });
}

export interface Sse {
  frames: { id: string | null; event: string; data: any }[];
  close(): void;
  ended: Promise<void>;
}

export function openSse(url: string, lastEventId?: number): Promise<Sse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    if (lastEventId !== undefined) headers['Last-Event-ID'] = String(lastEventId);
    const req = request(url, { headers }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`stream refused: ${res.statusCode}`));
      const frames: Sse['frames'] = [];
      let buf = '';
      let done!: () => void;
      const ended = new Promise<void>((r) => (done = r));
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        buf += c;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let id: string | null = null;
          let event = 'message';
          let data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('id: ')) id = line.slice(4);
            else if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (data) frames.push({ id, event, data: JSON.parse(data) });
        }
      });
      res.on('close', done);
      res.on('error', done);
      resolve({ frames, close: () => req.destroy(), ended });
    });
    req.on('error', reject);
    req.end();
  });
}

export async function waitUntil(cond: () => boolean | Promise<boolean>, what: string, ms = 60_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}
