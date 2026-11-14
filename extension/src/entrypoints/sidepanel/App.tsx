import { useEffect, useState, type FormEvent } from 'react';
import { LensClient, type LensError } from '@/lens-client';
import type { Hello } from '@/protocol/Hello';
import type { Observation } from '@/protocol/Observation';

type Connection = { state: 'connecting' } | { state: 'ready'; hello: Hello } | { state: 'failed'; message: string };

export function App() {
  const [client, setClient] = useState<LensClient | null>(null);
  const [connection, setConnection] = useState<Connection>({ state: 'connecting' });
  const [observations, setObservations] = useState<Observation[]>([]);
  const [title, setTitle] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const fail = (error: LensError) => setConnection({ state: 'failed', message: error.message });
    const lens = new LensClient(fail);
    setClient(lens);
    Promise.all([lens.request({ method: 'hello' }), lens.request({ method: 'listObservations' })])
      .then(([hello, list]) => {
        setConnection({ state: 'ready', hello });
        setObservations(list);
      })
      .catch(fail);
    return () => lens.disconnect();
  }, []);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!client) return;
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      const observation = await client.request({
        method: 'createObservation',
        params: { title, url: tab?.url?.startsWith('http') ? tab.url : null },
      });
      setObservations((list) => [observation, ...list]);
      setTitle('');
      setProblem(null);
    } catch (error) {
      setProblem((error as Error).message);
    }
  }

  return (
    <main>
      <header>
        <h1>Lens</h1>
        <p className="status" data-state={connection.state} role="status">
          {connection.state === 'connecting' && 'Connecting…'}
          {connection.state === 'ready' && `Connected · Lens ${connection.hello.version}`}
          {connection.state === 'failed' && `Not connected: ${connection.message}`}
        </p>
      </header>
      {connection.state === 'ready' && (
        <>
          <form onSubmit={create}>
            <label htmlFor="title">New observation</label>
            <div className="row">
              <input id="title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What is wrong?" />
              <button type="submit" disabled={!title.trim()}>
                Add
              </button>
            </div>
            {problem && <p role="alert">{problem}</p>}
          </form>
          <ul aria-label="Observations">
            {observations.map((o) => (
              <li key={o.id}>
                <strong>{o.title}</strong>
                {o.url && <span className="url">{o.url}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
