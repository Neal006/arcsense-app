import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import type { Services } from './services';

const Ctx = createContext<Services | null>(null);

export function ServicesProvider({
  services,
  children,
}: {
  services: Services;
  children: ReactNode;
}) {
  return <Ctx.Provider value={services}>{children}</Ctx.Provider>;
}

export function useServices(): Services {
  const s = useContext(Ctx);
  if (!s) throw new Error('useServices must be used inside <ServicesProvider>');
  return s;
}

/** Re-render every `ms` while `active` (session timers). */
export function useTicker(ms: number, active: boolean): void {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setN((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms, active]);
}
