import '@testing-library/jest-dom/vitest';

// Polyfill EventSource in JSDOM environment for Vitest
if (typeof globalThis.EventSource === 'undefined') {
  class MockEventSource {
    url: string;
    onopen: ((event: any) => void) | null = null;
    onerror: ((event: any) => void) | null = null;
    private listeners: Map<string, Function[]> = new Map();

    constructor(url: string) {
      this.url = url;
      setTimeout(() => {
        if (this.onopen) this.onopen({ type: 'open' });
      }, 0);
    }

    addEventListener(type: string, listener: Function) {
      if (!this.listeners.has(type)) {
        this.listeners.set(type, []);
      }
      this.listeners.get(type)!.push(listener);
    }

    removeEventListener(type: string, listener: Function) {
      const list = this.listeners.get(type);
      if (list) {
        this.listeners.set(
          type,
          list.filter((l) => l !== listener)
        );
      }
    }

    close() {
      this.listeners.clear();
      this.onopen = null;
      this.onerror = null;
    }
  }

  globalThis.EventSource = MockEventSource as any;
}
