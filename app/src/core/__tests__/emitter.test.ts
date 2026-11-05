import { Emitter } from '../emitter';

type Events = { a: number; b: string };

describe('Emitter', () => {
  it('delivers to subscribers and supports unsubscribe', () => {
    const e = new Emitter<Events>();
    const got: number[] = [];
    const off = e.on('a', (n) => got.push(n));
    e.emit('a', 1);
    off();
    e.emit('a', 2);
    e.emit('b', 'ignored');
    expect(got).toEqual([1]);
    expect(e.listenerCount('a')).toBe(0);
  });

  it('isolates a throwing listener from the others', () => {
    const errors: unknown[] = [];
    const e = new Emitter<Events>((err) => errors.push(err));
    const got: string[] = [];
    e.on('b', () => {
      throw new Error('boom');
    });
    e.on('b', (s) => got.push(s));
    e.emit('b', 'x');
    expect(got).toEqual(['x']);
    expect(errors).toHaveLength(1);
  });

  it('allows a listener to unsubscribe itself during emit', () => {
    const e = new Emitter<Events>();
    const got: number[] = [];
    const off = e.on('a', (n) => {
      got.push(n);
      off();
    });
    e.emit('a', 1);
    e.emit('a', 2);
    expect(got).toEqual([1]);
  });

  it('reports listener errors to console by default', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const e = new Emitter<Events>();
    e.on('a', () => {
      throw new Error('x');
    });
    e.emit('a', 1);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
